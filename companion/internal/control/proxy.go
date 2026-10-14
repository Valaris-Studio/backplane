// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const maxSessionsLimit = 100

// upstreamError maps a Backplane answer to the envelope. Refusals the
// client can act on keep their meaning (not found, conflict, invalid);
// everything else is server_rejected with the upstream status and code.
func upstreamError(err error) *Error {
	var answered *uplink.StatusError
	switch {
	case errors.Is(err, uplink.ErrDeviceRevoked):
		return &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorizedDevice, Message: "Backplane revoked this device; connect it again."}
	case errors.As(err, &answered):
		detail := map[string]any{"status": answered.Status, "error_code": nullable(answered.Code)}
		switch answered.Status {
		case http.StatusNotFound:
			return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "Backplane has no such item for this device.", Detail: detail}
		case http.StatusConflict:
			return &Error{Status: http.StatusConflict, Code: CodeConflict, Message: "Backplane refused the change as conflicting.", Detail: detail}
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			return &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Backplane refused the request as invalid.", Detail: detail}
		}
		return &Error{Status: http.StatusBadGateway, Code: CodeServerRejected, Message: "Backplane refused the request.", Detail: detail}
	case errors.Is(err, uplink.ErrUnavailable):
		return &Error{Status: http.StatusBadGateway, Code: CodeServerUnreachable, Message: "Backplane could not be reached. Try again later."}
	case errors.Is(err, uplink.ErrInvalidResponse):
		return &Error{Status: http.StatusBadGateway, Code: CodeServerRejected, Message: "Backplane returned a response this companion cannot use."}
	}
	return nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// proxy runs call with the device client and answers its document.
func (s *Server) proxy(w http.ResponseWriter, r *http.Request, call func(context.Context, Device) (json.RawMessage, error)) error {
	device, err := s.config.Backend.Device(r.Context())
	if err != nil {
		return err
	}
	defer device.Close()
	document, err := call(r.Context(), device)
	if errors.Is(err, uplink.ErrDeviceRevoked) {
		s.mutated()
	}
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	w.Write(document)
	return nil
}

// policyWritten refreshes the cached policy after a change the server
// accepted, so capture follows it at once; a failed refresh leaves the
// daemon's own refresh to catch up.
func (s *Server) policyWritten(ctx context.Context, write PolicyWrite) {
	if err := s.config.Backend.ApplyPolicyWrite(ctx, write); err != nil {
		s.config.Logf("control_api_policy_apply: %v", err)
	}
	if err := s.config.Backend.RefreshPolicy(ctx); err != nil {
		s.config.Logf("control_api_policy_refresh: %v", err)
	}
	s.watcher.resync()
	s.mutated()
	s.hub.publish("policy.changed", struct{}{})
}

func (s *Server) boards(w http.ResponseWriter, r *http.Request) error {
	return s.proxy(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) { return device.Boards(ctx) })
}

func validContentLevel(level string) bool {
	_, err := privacy.ParseContentLevel(level)
	return level != "" && err == nil
}

func (s *Server) createMapping(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		WorkspaceID  string  `json:"workspace_id"`
		BoardID      string  `json:"board_id"`
		RootPath     *string `json:"root_path"`
		RepoURL      *string `json:"repo_url"`
		ContentLevel string  `json:"content_level"`
		Enabled      *bool   `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil {
		return err
	}
	request := uplink.MappingRequest{WorkspaceID: body.WorkspaceID, BoardID: body.BoardID, ContentLevel: body.ContentLevel, Enabled: body.Enabled}
	if body.RootPath != nil {
		request.RootPath = *body.RootPath
	}
	if body.RepoURL != nil {
		request.RepoURL = *body.RepoURL
	}
	switch {
	case request.WorkspaceID == "" || request.BoardID == "":
		return invalid("workspace_id and board_id are required")
	case request.RootPath == "" && request.RepoURL == "":
		return invalid("root_path or repo_url is required")
	case request.RootPath != "" && !filepath.IsAbs(request.RootPath):
		return invalid("root_path must be absolute")
	case !validContentLevel(request.ContentLevel):
		return invalid("content_level must be metadata, standard or full")
	}
	if request.RootPath != "" {
		request.RootPath = filepath.Clean(request.RootPath)
	}
	return s.proxyWrite(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		return device.CreateMapping(ctx, request)
	}, mappingWritten)
}

// proxyWrite proxies a policy change and, once accepted, applies the
// server's answer (written) and refreshes the policy before answering.
func (s *Server) proxyWrite(w http.ResponseWriter, r *http.Request, call func(context.Context, Device) (json.RawMessage, error), written func(json.RawMessage) PolicyWrite) error {
	return s.proxy(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		document, err := call(ctx, device)
		if err == nil {
			s.policyWritten(ctx, written(document))
		}
		return document, err
	})
}

func mappingWritten(document json.RawMessage) PolicyWrite { return PolicyWrite{Mapping: document} }

func settingsWritten(document json.RawMessage) PolicyWrite { return PolicyWrite{Settings: document} }

func (s *Server) updateMapping(w http.ResponseWriter, r *http.Request) error {
	var update uplink.MappingUpdate
	if err := decodeBody(r, &update); err != nil {
		return err
	}
	if update.ContentLevel == nil && update.Enabled == nil {
		return invalid("content_level or enabled is required")
	}
	if update.ContentLevel != nil && !validContentLevel(*update.ContentLevel) {
		return invalid("content_level must be metadata, standard or full")
	}
	id := r.PathValue("id")
	return s.proxyWrite(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		return device.UpdateMapping(ctx, id, update)
	}, mappingWritten)
}

func (s *Server) deleteMapping(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	return s.proxyWrite(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		if err := device.DeleteMapping(ctx, id); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]string{"deleted": id})
	}, func(json.RawMessage) PolicyWrite { return PolicyWrite{DeletedMappingID: id} })
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) error {
	var update uplink.SettingsUpdate
	if err := decodeBody(r, &update); err != nil {
		return err
	}
	if update.AutoMatchRepos == nil && update.EnabledAgents == nil && update.ExcludeGlobs == nil {
		return invalid("auto_match_repos, enabled_agents or exclude_globs is required")
	}
	return s.proxyWrite(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		return device.UpdateSettings(ctx, update)
	}, settingsWritten)
}

func (s *Server) sessions(w http.ResponseWriter, r *http.Request) error {
	values := r.URL.Query()
	query := uplink.SessionQuery{Status: values.Get("status"), Cursor: values.Get("cursor")}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > maxSessionsLimit {
			return invalid("limit must be between 1 and %d", maxSessionsLimit)
		}
		query.Limit = limit
	}
	return s.proxy(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) {
		return device.Sessions(ctx, query)
	})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	return s.proxy(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) { return device.Session(ctx, id) })
}

func (s *Server) sessionUsage(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	return s.proxy(w, r, func(ctx context.Context, device Device) (json.RawMessage, error) { return device.SessionUsage(ctx, id) })
}
