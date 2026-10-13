// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package inbox is the private hand-off between hook shims and the daemon:
// one atomically written file per admitted observation.
package inbox

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	MaxItems     = 2048
	MaxBytes     = 128 << 20
	MaxItemBytes = 2 << 20
	itemVersion  = 1
)

var (
	ErrFull        = errors.New("inbox_full")
	ErrItemTooBig  = errors.New("inbox_item_too_large")
	ErrInvalidItem = errors.New("invalid_inbox_item")
)

var namePattern = regexp.MustCompile(`^[0-9]{20}-[0-9a-f]{16}\.json$`)

type Item struct {
	Version          int                     `json:"version"`
	Agent            string                  `json:"agent"`
	Observation      agent.Observation       `json:"observation"`
	MappingID        string                  `json:"mapping_id,omitempty"`
	PendingAutoMatch *scope.PendingAutoMatch `json:"pending_auto_match,omitempty"`
	ContentLevel     privacy.ContentLevel    `json:"content_level"`
	ReceivedAt       time.Time               `json:"received_at"`
	Coverage         privacy.Coverage        `json:"coverage"`
	Payload          map[string]any          `json:"payload"`
	// UsageTranscript is the local transcript the daemon reads token usage
	// from after this observation. It stays on the device.
	UsageTranscript string `json:"usage_transcript,omitempty"`
	// ContentFile is the agent's session file rich capture reads; the daemon
	// reads it, never the hook.
	ContentFile string `json:"content_file,omitempty"`
}

// Write publishes item atomically. Names sort by arrival so the daemon drains
// each session's events in order.
func Write(dir string, item Item) error {
	item.Version = itemVersion
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(item); err != nil {
		return err
	}
	if buffer.Len() > MaxItemBytes {
		return ErrItemTooBig
	}
	if err := store.EnsurePrivateDir(dir); err != nil {
		return err
	}
	if err := checkCapacity(dir, buffer.Len()); err != nil {
		return err
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	name := fmt.Sprintf("%020d-%s.json", item.ReceivedAt.UnixNano(), hex.EncodeToString(suffix))
	return store.WriteFileAtomic(filepath.Join(dir, name), buffer.Bytes())
}

func checkCapacity(dir string, incoming int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) >= MaxItems {
		return ErrFull
	}
	total := int64(incoming)
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
	}
	if total > MaxBytes {
		return ErrFull
	}
	return nil
}

// List returns item names oldest first, ignoring temporaries and strays.
func List(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type().IsRegular() && namePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func Read(dir, name string) (Item, error) {
	data, err := store.ReadPrivateFile(filepath.Join(dir, name), MaxItemBytes)
	if err != nil {
		return Item{}, err
	}
	var item Item
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&item); err != nil || item.Version != itemVersion || item.Agent == "" || item.Payload == nil {
		return Item{}, ErrInvalidItem
	}
	return item, nil
}

func Remove(dir, name string) error {
	if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return store.SyncDir(dir)
}
