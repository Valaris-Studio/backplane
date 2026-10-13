// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"archive/zip"
	"bytes"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxDeviceNameRunes = 80

func (s *Server) status(w http.ResponseWriter, r *http.Request) error {
	snapshot, err := s.config.Backend.Status(r.Context())
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, snapshot.Status)
	return nil
}

// mutated drops cached probes and schedules a status event after any change
// made through the API.
func (s *Server) mutated() {
	s.config.Backend.InvalidateProbes()
	s.hub.statusChanged()
}

func (s *Server) pause(paused bool) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		if err := s.config.Backend.SetPaused(r.Context(), paused); err != nil {
			return err
		}
		s.mutated()
		s.writeJSON(w, http.StatusOK, map[string]bool{"paused": paused})
		return nil
	}
}

func (s *Server) flushQueue(w http.ResponseWriter, r *http.Request) error {
	flush, err := s.config.Backend.FlushQueue(r.Context())
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, flush)
	return nil
}

func (s *Server) projects(w http.ResponseWriter, r *http.Request) error {
	projects, err := s.config.Backend.Projects(r.Context())
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, projects)
	return nil
}

func (s *Server) projectsChanged(r *http.Request) {
	s.mutated()
	if projects, err := s.config.Backend.Projects(r.Context()); err == nil {
		s.hub.publish("projects", projects)
	}
}

func decodePath(r *http.Request) (string, error) {
	var body struct {
		Path string `json:"path"`
	}
	if err := decodeBody(r, &body); err != nil {
		return "", err
	}
	if body.Path == "" || !filepath.IsAbs(body.Path) {
		return "", invalid("path must be absolute")
	}
	return body.Path, nil
}

func (s *Server) ignore(w http.ResponseWriter, r *http.Request) error {
	path, err := decodePath(r)
	if err != nil {
		return err
	}
	ignored, err := s.config.Backend.IgnoreProject(r.Context(), path)
	if err != nil {
		return err
	}
	s.projectsChanged(r)
	s.writeJSON(w, http.StatusOK, map[string]string{"ignored": ignored})
	return nil
}

func (s *Server) unignore(w http.ResponseWriter, r *http.Request) error {
	path, err := decodePath(r)
	if err != nil {
		return err
	}
	unignored, err := s.config.Backend.UnignoreProject(r.Context(), path)
	if err != nil {
		return err
	}
	s.projectsChanged(r)
	s.writeJSON(w, http.StatusOK, map[string]string{"unignored": unignored})
	return nil
}

// discover takes only the spelling a native picker gives: absolute and
// clean, so the path recorded is the one the user saw.
func (s *Server) discover(w http.ResponseWriter, r *http.Request) error {
	path, err := decodePath(r)
	if err != nil {
		return err
	}
	if filepath.Clean(path) != path {
		return invalid("path must be clean")
	}
	discovered, err := s.config.Backend.DiscoverProject(r.Context(), path)
	if err != nil {
		return err
	}
	s.projectsChanged(r)
	s.writeJSON(w, http.StatusOK, map[string]any{"discovered": discovered})
	return nil
}

func (s *Server) agents(w http.ResponseWriter, r *http.Request) error {
	agents, err := s.config.Backend.Agents(r.Context())
	if err != nil {
		return err
	}
	s.hub.agentsProbed(agents)
	s.writeJSON(w, http.StatusOK, agents)
	return nil
}

func (s *Server) agentAction(install bool) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		action := s.config.Backend.UninstallAgent
		if install {
			action = s.config.Backend.InstallAgent
		}
		report, err := action(r.Context(), id)
		if err != nil {
			return err
		}
		s.mutated()
		if agents, err := s.config.Backend.Agents(r.Context()); err == nil {
			s.hub.publish("agents", agents)
		}
		s.writeJSON(w, http.StatusOK, report)
		return nil
	}
}

// ValidDeviceName trims name and reports whether it is what the server
// stores: 1 to 80 printable characters.
func ValidDeviceName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxDeviceNameRunes {
		return "", false
	}
	for _, character := range name {
		if !unicode.IsPrint(character) {
			return "", false
		}
	}
	return name, true
}

func (s *Server) rename(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Name *string `json:"name"`
	}
	if err := decodeBody(r, &body); err != nil {
		return err
	}
	if body.Name == nil {
		return invalid("name is required")
	}
	name, ok := ValidDeviceName(*body.Name)
	if !ok {
		return invalid("name must be 1 to %d printable characters", maxDeviceNameRunes)
	}
	renamed, err := s.config.Backend.Rename(r.Context(), name)
	if err != nil {
		return err
	}
	s.mutated()
	s.writeJSON(w, http.StatusOK, map[string]string{"name": renamed})
	return nil
}

func (s *Server) disconnect(w http.ResponseWriter, r *http.Request) error {
	// A code still waiting for approval would connect again after sign-out.
	if s.config.Pairer != nil {
		if pending, ok := s.config.Pairer.Current(); ok {
			if err := s.config.Pairer.Cancel(pending.ID); err != nil && !errors.Is(err, ErrPairingNotFound) {
				return err
			}
		}
	}
	result, err := s.config.Backend.Disconnect(r.Context())
	s.mutated()
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, result)
	return nil
}

func (s *Server) version(w http.ResponseWriter, r *http.Request) error {
	version, err := s.config.Backend.Version(r.Context())
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, version)
	return nil
}

func (s *Server) diagnostics(w http.ResponseWriter, r *http.Request) error {
	files, err := s.config.Backend.Diagnostics(r.Context())
	if err != nil {
		return err
	}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	homes := homeSpellings(s.config.Home)
	for _, file := range files {
		entry, err := writer.Create(file.Name)
		if err != nil {
			return err
		}
		if _, err := entry.Write(Scrub(file.Data, homes, s.config.HomeCaseInsensitive)); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="backplane-companion-diagnostics.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	w.Write(archive.Bytes())
	return nil
}
