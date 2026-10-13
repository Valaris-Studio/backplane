// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package state

import (
	"context"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// maxMappedRoots bounds the folders remembered; the least recently seen go.
const maxMappedRoots = 256

// MappedRoot is the mapping capture last attributed a folder's sessions to.
type MappedRoot struct {
	MappingID string    `json:"mapping_id"`
	SeenAt    time.Time `json:"seen_at"`
}

// MappedRoots are the repository roots capture attributed to mappings. A
// mapping bound by repository has no path of its own; this is where the
// companion learns its local clones.
type MappedRoots struct {
	Roots map[string]MappedRoot `json:"roots"`
}

// RecordMappedRoot notes that capture attributed root to mappingID, writing
// only when that is new or was last noted over threadRefresh ago.
func RecordMappedRoot(ctx context.Context, layout store.Layout, root, mappingID string, now time.Time) error {
	if known, err := Load[MappedRoots](layout.MappedRoots()); err == nil {
		existing, found := known.Roots[root]
		if found && existing.MappingID == mappingID && now.Sub(existing.SeenAt) < threadRefresh {
			return nil
		}
	}
	return Update(ctx, layout, layout.MappedRoots(), func(roots *MappedRoots) bool {
		if roots.Roots == nil {
			roots.Roots = map[string]MappedRoot{}
		}
		roots.Roots[root] = MappedRoot{MappingID: mappingID, SeenAt: now.UTC()}
		for len(roots.Roots) > maxMappedRoots {
			oldest := ""
			for candidate, seen := range roots.Roots {
				if oldest == "" || seen.SeenAt.Before(roots.Roots[oldest].SeenAt) {
					oldest = candidate
				}
			}
			delete(roots.Roots, oldest)
		}
		return true
	})
}
