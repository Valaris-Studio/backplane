// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pairing

// SetAfterCollect runs hook right after a grant is collected, before the
// pairing turns persisting: the window a racing Cancel lands in.
func SetAfterCollect(m *Manager, hook func()) {
	m.afterCollect = hook
}
