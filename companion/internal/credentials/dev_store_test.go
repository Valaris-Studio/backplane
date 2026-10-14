// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build devkeyring

package credentials

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDevStoreKeepsTokensInAPrivateFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	store, err := Select(func(string) string { return DevStoreValue }, dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load("install-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing token: %v", err)
	}
	if err := store.Save("install-1", "bpc_token"); err != nil {
		t.Fatal(err)
	}
	reopened, _ := Select(func(string) string { return DevStoreValue }, dir)
	if token, err := reopened.Load("install-1"); err != nil || token != "bpc_token" {
		t.Fatalf("round trip: %q %v", token, err)
	}
	info, err := os.Stat(filepath.Join(dir, devStoreFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("dev store not private: %v %v", info, err)
	}
	if err := reopened.Delete("install-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Load("install-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("delete did not remove the token")
	}
}
