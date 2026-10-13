// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package policy

import (
	"encoding/json"
	"time"
)

// RichCaptureCapability is announced on every policy request; a server that
// knows rich capture answers with its offer, or null.
const (
	CapabilitiesHeader    = "Backplane-Capture-Capabilities"
	RichCaptureCapability = "rich_capture_v1"
	richCaptureVersion    = 1
	maxRichMappings       = 1000
)

// RichCaptureLimits bound what the device declares and uploads. The device
// uses the smaller of the offer's and its own.
type RichCaptureLimits struct {
	MaxContentsPerRecord    int   `json:"max_contents_per_record"`
	MaxInlineBodyBytes      int64 `json:"max_inline_body_bytes"`
	MaxInlineBytesPerRecord int64 `json:"max_inline_bytes_per_record"`
	MaxTextBodyBytes        int64 `json:"max_text_body_bytes"`
	MaxAttachmentBytes      int64 `json:"max_attachment_bytes"`
	ChunkBytes              int64 `json:"chunk_bytes"`
	MaxChunks               int   `json:"max_chunks"`
	StagingTTLSeconds       int64 `json:"staging_ttl_seconds"`
	SessionBodyBytes        int64 `json:"session_body_bytes"`
	InstallationBodyBytes   int64 `json:"installation_body_bytes"`
}

// DeviceRichLimits are this build's own bounds (contract §10).
var DeviceRichLimits = RichCaptureLimits{
	MaxContentsPerRecord:    256,
	MaxInlineBodyBytes:      16 << 10,
	MaxInlineBytesPerRecord: 1 << 20,
	MaxTextBodyBytes:        32 << 20,
	MaxAttachmentBytes:      20 << 20,
	ChunkBytes:              4 << 20,
	MaxChunks:               8,
	StagingTTLSeconds:       7 * 24 * 60 * 60,
	SessionBodyBytes:        512 << 20,
	InstallationBodyBytes:   10 << 30,
}

// RichMappingGrant is a mapping this device may capture rich, since when on
// the server's clock.
type RichMappingGrant struct {
	MappingID string    `json:"mapping_id"`
	RichSince time.Time `json:"rich_since"`
}

type RichCaptureOffer struct {
	Version      int                `json:"version"`
	Limits       RichCaptureLimits  `json:"limits"`
	RichMappings []RichMappingGrant `json:"rich_mappings"`
}

// RichCapture is DevicePolicy.rich_capture. Servers that know rich capture
// always send it, as an offer or as null; older servers never do, so an
// absent member and an explicit null are different evidence.
type RichCapture struct {
	// Present: the server sent the member, null or not.
	Present bool
	// Offer is nil for null, and for an offer this build cannot honour.
	Offer *RichCaptureOffer
}

// UnmarshalJSON runs only for a member that is present. An offer this build
// cannot act on is kept as present without an offer, never as an error: the
// rest of the policy still applies.
func (r *RichCapture) UnmarshalJSON(data []byte) error {
	*r = RichCapture{Present: true}
	var offer RichCaptureOffer
	if json.Unmarshal(data, &offer) == nil && offer.Valid() {
		r.Offer = &offer
	}
	return nil
}

// MarshalJSON writes null for a present member without an offer; an absent
// member is left out by the field's omitzero.
func (r RichCapture) MarshalJSON() ([]byte, error) { return json.Marshal(r.Offer) }

// Valid reports whether the offer is one this build may act on, as the
// server's RichCaptureOffer model validates it.
func (o RichCaptureOffer) Valid() bool {
	limits := o.Limits
	if o.Version != richCaptureVersion || o.RichMappings == nil || len(o.RichMappings) > maxRichMappings {
		return false
	}
	if limits.MaxContentsPerRecord < 1 || limits.MaxInlineBodyBytes < 0 || limits.MaxInlineBytesPerRecord < 0 || limits.MaxTextBodyBytes < 1 ||
		limits.MaxAttachmentBytes < 0 || limits.ChunkBytes < 1 || limits.MaxChunks < 1 || limits.StagingTTLSeconds < 1 {
		return false
	}
	if room := limits.ChunkBytes * int64(limits.MaxChunks); max(limits.MaxTextBodyBytes, limits.MaxAttachmentBytes) > room {
		return false
	}
	granted := map[string]bool{}
	for _, grant := range o.RichMappings {
		if grant.MappingID == "" || grant.RichSince.IsZero() || granted[grant.MappingID] {
			return false
		}
		granted[grant.MappingID] = true
	}
	return true
}

// EffectiveLimits are the smaller of the offer's limits and the device's.
// Chunk geometry comes from each upload slot, never from here.
func (o RichCaptureOffer) EffectiveLimits() RichCaptureLimits {
	own, offered := DeviceRichLimits, o.Limits
	return RichCaptureLimits{
		MaxContentsPerRecord:    min(own.MaxContentsPerRecord, offered.MaxContentsPerRecord),
		MaxInlineBodyBytes:      min(own.MaxInlineBodyBytes, offered.MaxInlineBodyBytes),
		MaxInlineBytesPerRecord: min(own.MaxInlineBytesPerRecord, offered.MaxInlineBytesPerRecord),
		MaxTextBodyBytes:        min(own.MaxTextBodyBytes, offered.MaxTextBodyBytes),
		MaxAttachmentBytes:      min(own.MaxAttachmentBytes, offered.MaxAttachmentBytes),
		ChunkBytes:              own.ChunkBytes,
		MaxChunks:               own.MaxChunks,
		StagingTTLSeconds:       min(own.StagingTTLSeconds, offered.StagingTTLSeconds),
		SessionBodyBytes:        min(own.SessionBodyBytes, offered.SessionBodyBytes),
		InstallationBodyBytes:   min(own.InstallationBodyBytes, offered.InstallationBodyBytes),
	}
}

// RichSince is when the offer granted mappingID rich capture; false when the
// offer does not list it (or there is none).
func (p Policy) RichSince(mappingID string) (time.Time, bool) {
	if p.RichCapture.Offer == nil {
		return time.Time{}, false
	}
	for _, grant := range p.RichCapture.Offer.RichMappings {
		if grant.MappingID == mappingID {
			return grant.RichSince, true
		}
	}
	return time.Time{}, false
}
