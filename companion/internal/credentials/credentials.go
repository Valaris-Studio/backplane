// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package credentials keeps the device token in the OS keyring (macOS
// Keychain, Secret Service on Linux, Windows Credential Manager).
package credentials

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

const service = "backplane-companion"

var (
	ErrNotFound    = errors.New("device_credential_missing")
	ErrUnavailable = errors.New("secure_credential_store_unavailable")
)

// Keyring stores one device token per installation id.
type Keyring struct{}

func (Keyring) Save(installationID, token string) error {
	if err := keyring.Set(service, installationID, token); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

func (Keyring) Load(installationID string) (string, error) {
	token, err := keyring.Get(service, installationID)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return token, nil
}

func (Keyring) Delete(installationID string) error {
	err := keyring.Delete(service, installationID)
	if err == nil || errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrUnavailable, err)
}
