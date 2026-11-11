// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

type Decision int

// The zero Decision is none of these, so the value returned with an error
// is never mistaken for Fresh.
const (
	Fresh Decision = iota + 1
	Resume
	Switch
	HoldIdentityMismatch
	HoldUnverified
	HoldSwitchInProgress
	// HoldUnboundState: connection state without a binding.json (a desktop
	// data root) is never silently adopted by the configured identity.
	HoldUnboundState
)

// Decide only reads root. verified is the identity /me reported for the
// token, or nil when it could not be obtained. Only the configured identity
// can switch a binding; a token for another identity holds.
func Decide(root string, configured Identity, verified *Identity) (Decision, error) {
	switching, err := exists(filepath.Join(root, journalName))
	if err != nil {
		return 0, err
	}
	if switching {
		return HoldSwitchInProgress, nil
	}
	if verified == nil {
		return HoldUnverified, nil
	}
	record, err := Load(root)
	if err != nil {
		return 0, err
	}
	if record != nil && record.BindingID != configured.ID() {
		return Switch, nil
	}
	if *verified != configured {
		return HoldIdentityMismatch, nil
	}
	if record != nil {
		return Resume, nil
	}
	for _, entry := range ConnectionScoped {
		present, err := holdsState(filepath.Join(root, entry))
		if err != nil {
			return 0, err
		}
		if present {
			return HoldUnboundState, nil
		}
	}
	return Fresh, nil
}

// holdsState reports whether path exists with something in it: store.Open
// creates the inbox, queue and work directories empty in every root.
func holdsState(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return true, nil
	}
	dir, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer dir.Close()
	if _, err := dir.Readdirnames(1); errors.Is(err, io.EOF) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}

func exists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
