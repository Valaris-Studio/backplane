// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
)

// windowlessDaemonName is the same program linked for the Windows GUI
// subsystem, so the logon task opens no console window. Bundles ship it next
// to the console build, which stays the CLI and the agents' hook command.
const (
	windowlessDaemonName = "backplane-companiond.exe"
	consoleCLIName       = "backplane-companion.exe"
)

type artifactReport struct {
	Manifest     string `json:"manifest"`
	Verified     bool   `json:"verified"`
	SHA256       string `json:"sha256,omitempty"`
	SourceCommit string `json:"source_commit,omitempty"`
	Error        string `json:"error,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

type versionReport struct {
	buildinfo.Info
	Artifacts map[string]artifactReport `json:"artifacts"`
}

// version reports what an updater needs to decide: this build and the
// Beacon artifacts the daemon would load.
func (a *app) version(_ context.Context, args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("%w: version", errUsage)
	}
	return a.printJSON(a.versionReport())
}

func (a *app) versionReport() versionReport {
	return versionReport{
		Info: buildinfo.Current(a.goos, a.goarch),
		Artifacts: map[string]artifactReport{
			"beacon_hooks":   verifyArtifact(a.defaultBeaconManifest()),
			"beacon_otelcol": verifyArtifact(a.defaultOtelcolManifest()),
		},
	}
}

func verifyArtifact(manifestPath string) artifactReport {
	report := artifactReport{Manifest: manifestPath}
	manifest, err := beacon.Verify(manifestPath)
	if err != nil {
		// Every verification failure wraps ErrUnverified with its reason.
		report.Error = beacon.ErrUnverified.Error()
		report.Reason = strings.TrimPrefix(err.Error(), report.Error+": ")
		return report
	}
	report.Verified, report.SHA256, report.SourceCommit = true, manifest.SHA256, manifest.SourceCommit
	return report
}

// logArtifacts records, once at start, which Beacon artifacts this daemon
// will load and whether they verify, before it waits for anything.
func (a *app) logArtifacts(hooksManifest, otelcolManifest string) {
	for _, artifact := range []struct{ name, manifest string }{{"beacon_hooks", hooksManifest}, {"beacon_otelcol", otelcolManifest}} {
		report := verifyArtifact(artifact.manifest)
		if report.Verified {
			a.logLine(artifact.name + " verified " + report.Manifest + " sha256:" + report.SHA256)
		} else {
			// Not the error code: the retry loop logs that once itself.
			a.logLine(artifact.name + " not verified " + report.Manifest + " (" + report.Reason + ")")
		}
	}
}

// daemonExecutable is what the service manager starts: the windowless build
// on Windows when it is bundled, otherwise this executable.
func (a *app) daemonExecutable() string {
	if a.goos != "windows" {
		return a.executable
	}
	windowless := filepath.Join(filepath.Dir(a.executable), windowlessDaemonName)
	if info, err := os.Stat(windowless); err == nil && info.Mode().IsRegular() && !strings.EqualFold(windowless, a.executable) {
		return windowless
	}
	return a.executable
}

// hookExecutable is what agents' hooks run: always the console CLI, even when
// the windowless daemon installs or repairs them. Elsewhere the service runs
// the CLI binary itself.
func (a *app) hookExecutable() string {
	if a.goos == "windows" && strings.EqualFold(filepath.Base(a.executable), windowlessDaemonName) {
		return filepath.Join(filepath.Dir(a.executable), consoleCLIName)
	}
	return a.executable
}
