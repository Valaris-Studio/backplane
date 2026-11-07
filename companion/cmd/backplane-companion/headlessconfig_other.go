// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !unix

package main

// Without owner and mode bits neither the config nor the token file can be
// proven to be the operator's, so headless mode is Unix-only.
func readOperatorConfig(string) ([]byte, error) {
	return nil, headlessConfigRefused("unsupported_platform")
}
