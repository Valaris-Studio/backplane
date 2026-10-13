// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package mcpentry edits the MCP server maps agents keep in their
// configuration, touching only the companion's own "backplane" entry, and
// names the other Backplane entries it finds without ever returning a value.
package mcpentry

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// Name is the entry the companion owns in every agent's MCP servers.
const Name = "backplane"

// Finding reasons, a stable contract with the desktop app.
const (
	ReasonNameTaken      = "mcp_name_taken"
	ReasonOtherBackplane = "other_backplane_entry"
	ReasonSameEndpoint   = "same_endpoint"
)

// ErrNameTaken means a foreign entry already uses Name; nothing is written.
var ErrNameTaken = errors.New(ReasonNameTaken)

// launcherArg is the companion subcommand an owned entry runs.
const launcherArg = "mcp"

// backplaneMarkers identify a server that runs Backplane's MCP by another
// name: the published package, its old name and its module.
var backplaneMarkers = []string{"backplane-mcp", "valaris-mcp", "valaris_mcp"}

const apiURLVariable = "VALARIS_API_URL"

// Finding names an entry and why it matters; never its command or env.
type Finding struct {
	EntryName string `json:"entry_name"`
	Reason    string `json:"reason"`
}

// BeforeWrite lets tests change a file between our read and our write.
var BeforeWrite func(path string)

// IsOwned reports whether entry runs the companion's MCP launcher, whichever
// companion executable it points at.
func IsOwned(entry any) bool {
	fields, ok := entry.(map[string]any)
	if !ok {
		return false
	}
	command, _ := fields["command"].(string)
	args, _ := fields["args"].([]any)
	if len(args) == 0 || args[0] != launcherArg {
		return false
	}
	base := command[strings.LastIndexAny(command, `/\`)+1:]
	return strings.HasPrefix(base, "backplane-companion")
}

// Put writes entry as Name unless a foreign entry holds that name.
func Put(servers map[string]any, entry map[string]any) (bool, error) {
	existing, present := servers[Name]
	if present && !IsOwned(existing) {
		return false, ErrNameTaken
	}
	if present && reflect.DeepEqual(normalized(existing), normalized(entry)) {
		return false, nil
	}
	servers[Name] = entry
	return true, nil
}

// normalized round-trips through JSON so an entry we build compares equal
// to the same entry decoded from a file.
func normalized(value any) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var decoded any
	json.Unmarshal(encoded, &decoded)
	return decoded
}

// Remove drops Name only when it is ours.
func Remove(servers map[string]any) bool {
	if !IsOwned(servers[Name]) {
		return false
	}
	delete(servers, Name)
	return true
}

// Repoint rewrites the command of our entry when the companion moved.
func Repoint(servers map[string]any, executable string) bool {
	entry, ok := servers[Name].(map[string]any)
	if !ok || !IsOwned(entry) || entry["command"] == executable {
		return false
	}
	entry["command"] = executable
	return true
}

// Scan names every entry that also serves Backplane, sorted by name.
func Scan(servers map[string]any, endpoint string) []Finding {
	findings := []Finding{}
	for name, value := range servers {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if name == Name {
			if !IsOwned(entry) {
				findings = append(findings, Finding{EntryName: name, Reason: ReasonNameTaken})
			}
			continue
		}
		if reason, found := backplaneReason(entry, endpoint); found {
			findings = append(findings, Finding{EntryName: name, Reason: reason})
		}
	}
	sort.Slice(findings, func(i, j int) bool { return findings[i].EntryName < findings[j].EntryName })
	return findings
}

func backplaneReason(entry map[string]any, endpoint string) (string, bool) {
	env, _ := entry["env"].(map[string]any)
	apiURL, hasAPIURL := env[apiURLVariable].(string)
	if hasAPIURL && sameOrigin(apiURL, endpoint) {
		return ReasonSameEndpoint, true
	}
	if hasAPIURL || mentionsBackplane(entry) {
		return ReasonOtherBackplane, true
	}
	return "", false
}

func mentionsBackplane(entry map[string]any) bool {
	texts := []string{}
	if command, ok := entry["command"].(string); ok {
		texts = append(texts, command)
	}
	args, _ := entry["args"].([]any)
	for _, arg := range args {
		if text, ok := arg.(string); ok {
			texts = append(texts, text)
		}
	}
	env, _ := entry["env"].(map[string]any)
	for _, value := range env {
		if text, ok := value.(string); ok {
			texts = append(texts, text)
		}
	}
	for _, text := range texts {
		for _, marker := range backplaneMarkers {
			if strings.Contains(text, marker) {
				return true
			}
		}
	}
	return false
}

func sameOrigin(left, right string) bool {
	origin := func(raw string) string {
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || parsed.Host == "" {
			return ""
		}
		return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
	}
	leftOrigin := origin(left)
	return leftOrigin != "" && leftOrigin == origin(right)
}

// Servers returns root[key] as an object, creating it when absent.
func Servers(root map[string]any, key string) (map[string]any, error) {
	value, present := root[key]
	if !present {
		servers := map[string]any{}
		root[key] = servers
		return servers, nil
	}
	servers, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: %s is not an object", agent.ErrConfigInvalid, key)
	}
	return servers, nil
}

// ReadJSON reads an agent's JSON configuration, refusing symlinks;
// os.ErrNotExist when it is absent.
func ReadJSON(path string) (map[string]any, error) {
	root, _, err := read(path)
	return root, err
}

// EditJSON applies edit to the JSON object at path and writes it only when
// edit reports a change, keeping the file's mode and every other member.
// A missing file is created (0600, parent 0700) only when create is set.
func EditJSON(path string, create bool, edit func(root map[string]any) (bool, error)) error {
	root, original, err := read(path)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return nil
		}
		root = map[string]any{}
	} else if err != nil {
		return err
	}
	changed, err := edit(root)
	if err != nil || !changed {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if BeforeWrite != nil {
		BeforeWrite(path)
	}
	return write(path, root, mode, original)
}

func read(path string) (map[string]any, []byte, error) {
	for _, candidate := range []string{filepath.Dir(path), path} {
		if err := store.RejectSymlink(candidate); err != nil {
			return nil, nil, errors.Join(agent.ErrConfigSymlink, err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil || root == nil || decoder.Decode(new(any)) != io.EOF {
		return nil, nil, agent.ErrConfigInvalid
	}
	return root, data, nil
}

func write(path string, root map[string]any, mode os.FileMode, original []byte) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(root); err != nil {
		return err
	}
	// Agents rewrite these files at any time (Claude Code on every start);
	// never replace a version we did not read. The caller retries later.
	return store.WriteFileAtomicIf(path, buffer.Bytes(), mode, func() error {
		current, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if !bytes.Equal(current, original) {
			return agent.ErrConfigChanged
		}
		return nil
	})
}
