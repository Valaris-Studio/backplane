// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package version

// Injected at build time via -ldflags.
var (
	Version   = "dev"
	GitCommit = "unknown"
	BuildTime = "unknown"
)
