// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package binding ties a data root's connection state to the one (origin,
// installation, owner) identity it was captured for, and moves that state
// aside when the operator configures another identity.
package binding

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
)

// Identity holds normalized components; compare identities with ==.
type Identity struct {
	Origin         string `json:"origin"`
	InstallationID string `json:"installation_id"`
	OwnerEmail     string `json:"owner_email"`
}

const bindingIDDomain = "backplane-companion-binding/v1\n"

func (i Identity) ID() string {
	sum := sha256.Sum256([]byte(bindingIDDomain + i.Origin + "\n" + i.InstallationID + "\n" + i.OwnerEmail))
	return hex.EncodeToString(sum[:])[:32]
}

var (
	ErrInstallationID = errors.New("installation_id_invalid")
	ErrOwnerEmail     = errors.New("owner_email_invalid")
)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func NormalizeInstallationID(raw string) (string, error) {
	lowered := strings.ToLower(raw)
	if !canonicalUUID.MatchString(lowered) {
		return "", ErrInstallationID
	}
	return lowered, nil
}

// NormalizeOwnerEmail mirrors how the server stores a user's email, so it
// compares equal to the email /me reports.
func NormalizeOwnerEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if strings.Count(email, "@") != 1 {
		return "", ErrOwnerEmail
	}
	return email, nil
}
