// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"fmt"
)

// EnvStore selects a credential store other than the OS keyring. Its only
// accepted value is DevStoreValue, and only in builds with the devkeyring tag.
const EnvStore = "BACKPLANE_COMPANION_KEYRING"

// DevStoreValue selects an insecure file store for disposable test runs
// that must never touch the operator's real keychain.
const DevStoreValue = "file-insecure-dev"

var (
	ErrUnknownStore        = errors.New("unknown_credential_store")
	ErrDevStoreUnavailable = errors.New("dev_credential_store_not_built")
)

// Store keeps one device token per installation id.
type Store interface {
	Save(installationID, token string) error
	Load(installationID string) (string, error)
	Delete(installationID string) error
}

// Select returns the OS keyring unless EnvStore asks for the dev file store,
// which exists only in builds with the devkeyring tag.
func Select(getenv func(string) string, dataDir string) (Store, error) {
	switch value := getenv(EnvStore); value {
	case "":
		return Keyring{}, nil
	case DevStoreValue:
		if !devStoreBuilt {
			return nil, ErrDevStoreUnavailable
		}
		return newDevStore(dataDir), nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownStore, value)
	}
}
