// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// ReadHarnessStore reads a harness-owned body store through the guarded open
// of store.ReadOwnedFile.
func ReadHarnessStore(body agent.BodyStore, limit int64) ([]byte, error) {
	data, err := store.ReadOwnedFile(body.Path, body.Within, limit)
	if err != nil {
		return nil, ErrStoreRefused
	}
	return data, nil
}
