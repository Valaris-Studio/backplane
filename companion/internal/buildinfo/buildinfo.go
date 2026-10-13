// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package buildinfo carries the release identity stamped at link time with
// -ldflags "-X"; a plain `go build` reports version "dev".
package buildinfo

import (
	"runtime"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
)

var (
	Version = "dev"
	Commit  = ""
)

type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	// BeaconCommit is compiled in, not stamped: every Beacon artifact must
	// match it, so a stamp could only disagree with what is enforced.
	BeaconCommit string `json:"beacon_commit"`
	GoVersion    string `json:"go_version"`
	Platform     string `json:"platform"`
}

func Current(goos, goarch string) Info {
	return Info{Version: Version, Commit: Commit, BeaconCommit: beacon.Commit, GoVersion: runtime.Version(), Platform: goos + "/" + goarch}
}
