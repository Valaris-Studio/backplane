// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !unix

package hook

import "net"

// Headless mode is Unix-only (no owner and mode bits elsewhere), so the
// socket it would serve refuses with the same code.
func CheckDirectory(string) error { return ErrUnsupportedPlatform }

func Listen(string, Options) (net.Listener, error) { return nil, ErrUnsupportedPlatform }
