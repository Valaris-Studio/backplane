// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestSelectUsesTheOSKeyringUnlessTheDevStoreIsRequested(t *testing.T) {
	store, err := Select(func(string) string { return "" }, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, isKeyring := store.(Keyring); !isKeyring {
		t.Fatalf("default store is %T", store)
	}
	for _, value := range []string{"file", "insecure", "FILE-INSECURE-DEV"} {
		if _, err := Select(func(string) string { return value }, t.TempDir()); !errors.Is(err, ErrUnknownStore) {
			t.Errorf("%q accepted: %v", value, err)
		}
	}
}

func TestDevStoreIsRefusedWithoutTheBuildTag(t *testing.T) {
	if devStoreBuilt {
		t.Skip("built with the devkeyring tag")
	}
	_, err := Select(func(string) string { return DevStoreValue }, filepath.Join(t.TempDir(), "data"))
	if !errors.Is(err, ErrDevStoreUnavailable) {
		t.Fatalf("release build accepted the insecure dev store: %v", err)
	}
}
