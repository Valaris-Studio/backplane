// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import (
	"encoding/json"
	"time"
)

type BeaconProvenance struct {
	Commit string `json:"commit"`
	// SchemaVersion is null on a record that carries only content.
	SchemaVersion *string `json:"schema_version"`
}

// Record is one normalized hook observation as sent to /api/companion/ingest.
type Record struct {
	CaptureID        string  `json:"capture_id"`
	MappingID        string  `json:"mapping_id"`
	Harness          string  `json:"harness"`
	HarnessVersion   *string `json:"harness_version"`
	CollectionMethod string  `json:"collection_method"`
	NativeSessionID  string  `json:"native_session_id"`
	// ParentNativeSessionID names the root session of a subagent thread
	// (Codex); it is omitted for root sessions and other agents.
	ParentNativeSessionID string            `json:"parent_native_session_id,omitempty"`
	CapturedAt            time.Time         `json:"captured_at"`
	Beacon                BeaconProvenance  `json:"beacon"`
	Events                []json.RawMessage `json:"events"`
	// Contents and their CaptureGeneration go only to a server that offered
	// rich capture; older servers forbid both members.
	Contents          []ContentDeclaration `json:"contents,omitempty"`
	CaptureGeneration *CaptureGeneration   `json:"capture_generation,omitempty"`
}
