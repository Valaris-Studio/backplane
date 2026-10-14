// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import "os"

func init() {
	createPhysicalFixtureDirectory = nativeCreateFixtureDirectory
}

// Preserve default creation for the independent constructor regression baseline.
func nativeCreateFixtureDirectory(path string) error {
	return os.MkdirAll(path, 0o700)
}
