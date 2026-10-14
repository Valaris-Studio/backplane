// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"fmt"
	"testing"

	"github.com/zalando/go-keyring"
)

// The messages below are what go-keyring's Secret Service backend and godbus
// return on Linux; the keyring mock replays them without a D-Bus.
const (
	dbusDaemonNoSecretService = "The name org.freedesktop.secrets was not provided by any .service files"
	dbusBrokerNoSecretService = "The name is not activatable"
	noSessionBusAddress       = "dbus: couldn't determine address of session bus"
	noDbusLaunch              = `exec: "dbus-launch": executable file not found in $PATH`
	unlockDismissed           = "failed to unlock correct collection '/org/freedesktop/secrets/aliases/default'"
	collectionIsLocked        = "org.freedesktop.Secret.Error.IsLocked"
)

func loadFailure(t *testing.T, keyringErr error) error {
	t.Helper()
	keyring.MockInitWithError(keyringErr)
	t.Cleanup(keyring.MockInit)
	_, err := Keyring{}.Load("install-1")
	return err
}

func TestKeyring_NoSecretServiceIsUnavailableNotNotFound(t *testing.T) {
	for _, message := range []string{dbusDaemonNoSecretService, dbusBrokerNoSecretService} {
		err := loadFailure(t, errors.New(message))
		if !errors.Is(err, ErrUnavailable) || errors.Is(err, ErrNotFound) {
			t.Fatalf("%q: %v, want ErrUnavailable and not ErrNotFound", message, err)
		}
		if reason := UnavailableReason(err); reason != ReasonSecretServiceMissing {
			t.Errorf("%q: reason %q, want %q", message, reason, ReasonSecretServiceMissing)
		}
	}
}

func TestKeyring_NoSessionBusIsADistinctReason(t *testing.T) {
	for _, message := range []string{noSessionBusAddress, noDbusLaunch} {
		if reason := UnavailableReason(loadFailure(t, errors.New(message))); reason != ReasonSessionBusMissing {
			t.Errorf("%q: reason %q, want %q", message, reason, ReasonSessionBusMissing)
		}
	}
}

func TestKeyring_LockedCollectionIsADistinctReason(t *testing.T) {
	for _, message := range []string{unlockDismissed, collectionIsLocked} {
		keyring.MockInitWithError(errors.New(message))
		t.Cleanup(keyring.MockInit)
		err := Keyring{}.Save("install-1", "bpc_token")
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%q: %v, want ErrUnavailable", message, err)
		}
		if reason := UnavailableReason(err); reason != ReasonCollectionLocked {
			t.Errorf("%q: reason %q, want %q", message, reason, ReasonCollectionLocked)
		}
	}
}

func TestUnavailableReason_OnlyClassifiesAnUnavailableStore(t *testing.T) {
	for name, err := range map[string]error{
		"nil":                   nil,
		"not found":             ErrNotFound,
		"unrecognized failure":  loadFailure(t, errors.New("locked")),
		"text outside the code": fmt.Errorf("other: %s", dbusDaemonNoSecretService),
	} {
		if reason := UnavailableReason(err); reason != "" {
			t.Errorf("%s: reason %q, want none", name, reason)
		}
	}
}
