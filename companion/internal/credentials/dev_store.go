// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build devkeyring

package credentials

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// The dev store exists only for disposable end-to-end runs: tokens sit in a
// 0600 file in the data directory, unencrypted.
const devStoreBuilt = true

const devStoreFile = "dev-credentials.json"

type devStore struct{ path string }

func newDevStore(dataDir string) Store { return devStore{path: filepath.Join(dataDir, devStoreFile)} }

func (d devStore) load() (map[string]string, error) {
	tokens := map[string]string{}
	err := store.ReadJSON(d.path, 1<<16, &tokens)
	if errors.Is(err, os.ErrNotExist) {
		return tokens, nil
	}
	return tokens, err
}

func (d devStore) Save(installationID, token string) error {
	tokens, err := d.load()
	if err != nil {
		return err
	}
	tokens[installationID] = token
	if err := store.EnsurePrivateDir(filepath.Dir(d.path)); err != nil {
		return err
	}
	return store.WriteJSON(d.path, tokens)
}

func (d devStore) Load(installationID string) (string, error) {
	tokens, err := d.load()
	if err != nil {
		return "", err
	}
	token, ok := tokens[installationID]
	if !ok {
		return "", ErrNotFound
	}
	return token, nil
}

func (d devStore) Delete(installationID string) error {
	tokens, err := d.load()
	if err != nil {
		return err
	}
	delete(tokens, installationID)
	return store.WriteJSON(d.path, tokens)
}
