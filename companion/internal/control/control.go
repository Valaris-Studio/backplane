// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package control is the daemon's local control API: HTTP/1.1 over a
// per-user Unix socket (a named pipe on Windows) under /v1, with a
// server-sent event stream. It holds no companion logic of its own; every
// endpoint calls the implementation the CLI uses, through Backend.
package control

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// Codes the API adds to the CLI's; any CLI code may also appear.
const (
	CodeInvalidRequest     = "invalid_request"
	CodeNotFound           = "not_found"
	CodeConflict           = "conflict"
	CodeServerUnreachable  = "server_unreachable"
	CodeServerRejected     = "server_rejected"
	CodeUnauthorizedDevice = "unauthorized_device"
	CodePairingPending     = "pairing_pending"
	// CodePairingPersisting: the code was approved and the connection is
	// being stored (a switch sends the old server its queue first).
	CodePairingPersisting = "pairing_persisting"
	// CodeSameServer refuses to switch to the Backplane already connected.
	CodeSameServer = "same_server"
	CodeInternal   = "internal"
)

// Error is a non-2xx answer, written as the contract's error envelope.
type Error struct {
	Status  int
	Code    string
	Message string
	Detail  any
}

func (e *Error) Error() string { return fmt.Sprintf("%s (%d): %s", e.Code, e.Status, e.Message) }

// Snapshot is the status JSON plus what needs the user's attention in it.
type Snapshot struct {
	Status    any
	Attention []AttentionItem
}

type AttentionItem struct {
	Code     string  `json:"code"`
	Severity string  `json:"severity"`
	Agent    *string `json:"agent"`
	Message  string  `json:"message"`
}

// DiagnosticFile is one entry of the diagnostics archive; it is scrubbed
// before it is written.
type DiagnosticFile struct {
	Name string
	Data []byte
}

// Backend is the companion's shared command implementation. Results are
// marshaled as JSON exactly as returned.
type Backend interface {
	Status(context.Context) (Snapshot, error)
	// InvalidateProbes drops cached service-manager and keyring probes.
	InvalidateProbes()
	SetPaused(ctx context.Context, paused bool) error
	Projects(context.Context) (any, error)
	IgnoreProject(ctx context.Context, path string) (string, error)
	UnignoreProject(ctx context.Context, path string) (string, error)
	// DiscoverProject records a folder the user picked as a found project,
	// as a hook in it would, and returns its projects-list entry.
	DiscoverProject(ctx context.Context, path string) (any, error)
	Agents(context.Context) (any, error)
	InstallAgent(ctx context.Context, id string) (any, error)
	UninstallAgent(ctx context.Context, id string) (any, error)
	Disconnect(context.Context) (any, error)
	Version(context.Context) (any, error)
	Rename(ctx context.Context, name string) (string, error)
	// Device authenticates with the device token from the keyring, which
	// never leaves the daemon.
	Device(context.Context) (Device, error)
	RefreshPolicy(context.Context) error
	// ApplyPolicyWrite puts an accepted write's answer into the cached
	// policy at once, so no status after the write can show older values
	// even when the refresh that follows fails.
	ApplyPolicyWrite(context.Context, PolicyWrite) error
	Connected(context.Context) bool
	Diagnostics(context.Context) ([]DiagnosticFile, error)
	// FlushQueue asks the uploader to retry now, skipping the backoff once.
	FlushQueue(context.Context) (QueueFlush, error)
	// DescribeError maps a companion error to its stable code, HTTP status
	// and localized message; nil leaves it an internal error.
	DescribeError(err error, locale string) *Error
}

// PolicyWrite is what the server answered to one accepted write: exactly
// one of the fields is set.
type PolicyWrite struct {
	// Settings is the installation's settings document.
	Settings json.RawMessage
	// Mapping is the created or updated mapping document.
	Mapping json.RawMessage
	// DeletedMappingID is the mapping the server deleted.
	DeletedMappingID string
}

// Why a queue flush scheduled nothing; the answer is still 200.
const (
	FlushReasonQueueEmpty       = "queue_empty"
	FlushReasonNotConnected     = "not_connected"
	FlushReasonRevoked          = "device_revoked"
	FlushReasonDaemonNotRunning = "daemon_not_running"
)

type QueueFlush struct {
	Scheduled bool   `json:"scheduled"`
	Reason    string `json:"reason,omitempty"`
}

// Device is the device-token client of the Backplane self-service API.
type Device interface {
	Boards(context.Context) (json.RawMessage, error)
	CreateMapping(context.Context, uplink.MappingRequest) (json.RawMessage, error)
	UpdateMapping(ctx context.Context, id string, update uplink.MappingUpdate) (json.RawMessage, error)
	DeleteMapping(ctx context.Context, id string) error
	UpdateSettings(context.Context, uplink.SettingsUpdate) (json.RawMessage, error)
	Sessions(context.Context, uplink.SessionQuery) (json.RawMessage, error)
	Session(ctx context.Context, id string) (json.RawMessage, error)
	SessionUsage(ctx context.Context, id string) (json.RawMessage, error)
	Close()
}

// SocketPath is where the Unix listener lives.
func SocketPath(dataDir string) string { return filepath.Join(dataDir, "control.sock") }

// DiscoveryPath names the file that tells clients where to connect.
func DiscoveryPath(dataDir string) string { return filepath.Join(dataDir, "control.json") }
