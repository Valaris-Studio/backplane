// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package hookfile edits agent hook configuration kept as JSON
// ({"hooks": {"<Event>": [{"hooks": [{"type": "command", ...}]}]}}), touching
// only companion-owned entries and preserving every other member and number.
package hookfile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// Owned reports whether a hook command belongs to the companion.
type Owned func(command string) bool

// beforeWrite lets tests change the file between our read and our write.
var beforeWrite func(path string)

// Validate rejects a parsed file the agent itself would refuse to load.
type Validate func(root map[string]any) error

// Edit applies edit to the hooks object of the JSON file at path and writes
// the file only if edit reports a change. A missing file is created only when
// create is set.
func Edit(path string, create bool, edit func(hooks map[string]any) (bool, error)) error {
	return EditValidated(path, create, nil, edit)
}

// EditValidated is Edit that first refuses, with ErrConfigInvalid, an
// existing file validate rejects.
func EditValidated(path string, create bool, validate Validate, edit func(hooks map[string]any) (bool, error)) error {
	original, _ := os.ReadFile(path)
	root, err := read(path)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return nil
		}
		root = map[string]any{}
	} else if err != nil {
		return err
	} else if validate != nil {
		if err := validate(root); err != nil {
			return errors.Join(agent.ErrConfigInvalid, err)
		}
	}
	hooks, err := hooksOf(root)
	if err != nil {
		return err
	}
	changed, err := edit(hooks)
	if err != nil || !changed {
		return err
	}
	if len(hooks) == 0 {
		delete(root, "hooks")
	} else {
		root["hooks"] = hooks
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if beforeWrite != nil {
		beforeWrite(path)
	}
	return write(path, root, mode, original)
}

// ReadHooks returns the hooks object; os.ErrNotExist when the file is absent.
func ReadHooks(path string) (map[string]any, error) {
	return ReadValidatedHooks(path, nil)
}

// ReadValidatedHooks is ReadHooks that reports ErrConfigInvalid for a file
// validate rejects.
func ReadValidatedHooks(path string, validate Validate) (map[string]any, error) {
	root, err := read(path)
	if err != nil {
		return nil, err
	}
	if validate != nil {
		if err := validate(root); err != nil {
			return nil, errors.Join(agent.ErrConfigInvalid, err)
		}
	}
	return hooksOf(root)
}

func read(path string) (map[string]any, error) {
	for _, candidate := range []string{filepath.Dir(path), path} {
		if err := store.RejectSymlink(candidate); err != nil {
			return nil, errors.Join(agent.ErrConfigSymlink, err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil || root == nil || decoder.Decode(new(any)) != io.EOF {
		return nil, agent.ErrConfigInvalid
	}
	return root, nil
}

func write(path string, root map[string]any, mode os.FileMode, original []byte) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(root); err != nil {
		return err
	}
	// The agent may rewrite this file at any time; never replace a version we
	// did not read. The caller retries on its next pass.
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

func hooksOf(root map[string]any) (map[string]any, error) {
	value, ok := root["hooks"]
	if !ok {
		return map[string]any{}, nil
	}
	hooks, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: hooks is not an object", agent.ErrConfigInvalid)
	}
	return hooks, nil
}

func EventEntries(hooks map[string]any, event string) ([]any, error) {
	value, ok := hooks[event]
	if !ok {
		return []any{}, nil
	}
	entries, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%w: %s is not a list", agent.ErrConfigInvalid, event)
	}
	return entries, nil
}

// OwnedPosition locates an owned hook as (group index, handler index).
type OwnedPosition struct {
	Command        string
	Group, Handler int
}

func OwnedHooks(entries []any, owned Owned) []OwnedPosition {
	var positions []OwnedPosition
	for groupIndex, entry := range entries {
		block, _ := entry.(map[string]any)
		configured, _ := block["hooks"].([]any)
		for handlerIndex, value := range configured {
			hook, _ := value.(map[string]any)
			if command, _ := hook["command"].(string); owned(command) {
				positions = append(positions, OwnedPosition{Command: command, Group: groupIndex, Handler: handlerIndex})
			}
		}
	}
	return positions
}

func OwnedCommands(entries []any, owned Owned) []string {
	var commands []string
	for _, position := range OwnedHooks(entries, owned) {
		commands = append(commands, position.Command)
	}
	return commands
}

// WithoutOwned drops owned hooks, and any group they leave empty, keeping
// every foreign hook and member untouched.
func WithoutOwned(entries []any, owned Owned) ([]any, bool) {
	kept := make([]any, 0, len(entries))
	removed := false
	for _, entry := range entries {
		block, isBlock := entry.(map[string]any)
		configured, isList := block["hooks"].([]any)
		if !isBlock || !isList {
			kept = append(kept, entry)
			continue
		}
		foreign := make([]any, 0, len(configured))
		for _, value := range configured {
			hook, _ := value.(map[string]any)
			if command, _ := hook["command"].(string); owned(command) {
				removed = true
				continue
			}
			foreign = append(foreign, value)
		}
		if len(foreign) == 0 && len(configured) > 0 {
			continue
		}
		if len(foreign) != len(configured) {
			copied := make(map[string]any, len(block))
			for key, value := range block {
				copied[key] = value
			}
			copied["hooks"] = foreign
			entry = copied
		}
		kept = append(kept, entry)
	}
	return kept, removed
}
