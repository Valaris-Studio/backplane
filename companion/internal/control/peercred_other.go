// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !darwin && !linux && !windows

package control

import "errors"

// Without a known peer-credential call every connection is refused.
func socketPeerUID(int) (int, error) {
	return 0, errors.New("peer credentials unsupported on this platform")
}
