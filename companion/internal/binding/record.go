// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	recordName    = "binding.json"
	recordVersion = 1
	recordLimit   = 64 << 10
)

var ErrRecordInvalid = errors.New("binding_record_invalid")

// ConnectionScoped lists the data-root entries owned by one binding. The
// device's own entries (preferences, logs, otel.json, locks, health) are not
// among them and never move.
var ConnectionScoped = []string{
	"installation.json", "policy.json", "admission.json", "ledger.json", "threads.json",
	"capture-windows.json", "mapped-roots.json", "suppressed-sessions.json", "discovered.json",
	"queue", "inbox", "work", "otel", "usage", "rich",
}

// Record is binding.json: the identity the data root's connection state
// belongs to. BoundAt is set once per binding and survives a switch-back.
type Record struct {
	Version        int       `json:"version"`
	BindingID      string    `json:"binding_id"`
	Origin         string    `json:"origin"`
	InstallationID string    `json:"installation_id"`
	OwnerEmail     string    `json:"owner_email"`
	BoundAt        time.Time `json:"bound_at"`
	LastVerifiedAt time.Time `json:"last_verified_at"`
	// VerifiedTokenFile is the token file /me last verified for this
	// binding, by metadata only: a switch away never presents it unchanged
	// to the next origin.
	VerifiedTokenFile *credentials.FileIdentity `json:"verified_token_file,omitempty"`
}

func (r Record) identity() Identity {
	return Identity{Origin: r.Origin, InstallationID: r.InstallationID, OwnerEmail: r.OwnerEmail}
}

func (r Record) validate() error {
	if r.Version != recordVersion || r.BindingID != r.identity().ID() {
		return ErrRecordInvalid
	}
	return nil
}

// Load returns the active binding, or nil when root is unbound.
func Load(root string) (*Record, error) {
	return loadRecord(filepath.Join(root, recordName))
}

func loadRecord(path string) (*Record, error) {
	var record Record
	if err := store.ReadJSON(path, recordLimit, &record); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("%w: %v", ErrRecordInvalid, err)
	}
	if err := record.validate(); err != nil {
		return nil, err
	}
	return &record, nil
}

func Save(root string, record Record) error {
	if err := record.validate(); err != nil {
		return err
	}
	return store.WriteJSON(filepath.Join(root, recordName), record)
}
