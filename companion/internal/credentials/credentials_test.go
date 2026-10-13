// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestKeyringRoundTripUsesMockOnly(t *testing.T) {
	keyring.MockInit()
	store := Keyring{}
	if _, err := store.Load("install-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing token: %v", err)
	}
	if err := store.Save("install-1", "bpc_token"); err != nil {
		t.Fatal(err)
	}
	if token, err := store.Load("install-1"); err != nil || token != "bpc_token" {
		t.Fatalf("round trip: %q %v", token, err)
	}
	if err := store.Delete("install-1"); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("install-1"); err != nil {
		t.Fatal("delete must be idempotent")
	}
}

func TestKeyringFailuresAreTyped(t *testing.T) {
	keyring.MockInitWithError(errors.New("locked"))
	store := Keyring{}
	if err := store.Save("i", "t"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("save failure: %v", err)
	}
	if _, err := store.Load("i"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("load failure: %v", err)
	}
	keyring.MockInit()
}
