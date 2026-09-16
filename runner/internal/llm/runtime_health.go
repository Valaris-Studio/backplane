// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const runtimeProbeTimeout = 3 * time.Second
const runtimeOutputLimit = 1024

// RuntimeHealthProvider checks an adapter's local installation without model,
// authentication or network requests. Providers without this seam remain usable
// but must never be described as having a verified runtime.
type RuntimeHealthProvider interface {
	RuntimeHealth(context.Context, string) (RuntimeHealthReport, error)
}

type RuntimeHealthReport struct {
	Provider     string
	Executable   string
	Installation string
	Version      string
	Verified     []string
	Unverified   []string
}

func (r RuntimeHealthReport) String() string {
	parts := []string{fmt.Sprintf("provider %q runtime", r.Provider)}
	if r.Executable != "" {
		parts = append(parts, fmt.Sprintf("executable %q; installation %q; version %q", r.Executable, r.Installation, r.Version))
	}
	parts = append(parts, r.Verified...)
	for _, item := range r.Unverified {
		parts = append(parts, "unverified: "+item)
	}
	return strings.Join(parts, "; ")
}

func CheckRuntimeHealth(ctx context.Context, provider Provider, lookPath func(string) (string, error)) (RuntimeHealthReport, error) {
	report := RuntimeHealthReport{Provider: provider.Name()}
	local, ok := provider.(ExecutableProvider)
	if !ok {
		report.Unverified = []string{"local runtime diagnostics are not provided by this adapter"}
		return report, nil
	}
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	path, err := lookPath(local.Executable())
	if err != nil {
		return report, fmt.Errorf("provider %q runtime executable %q is unavailable; install the provider or correct its configured path", provider.Name(), local.Executable())
	}
	report.Executable = path
	probe, ok := provider.(RuntimeHealthProvider)
	if !ok {
		report.Unverified = []string{"executable discovered; runtime diagnostics are not provided by this adapter"}
		return report, nil
	}
	return probe.RuntimeHealth(ctx, path)
}

func (c *ClaudeCLI) RuntimeHealth(ctx context.Context, path string) (RuntimeHealthReport, error) {
	return probeCLIRuntime(ctx, c.Name(), path, false)
}

func (c *CodexCLI) RuntimeHealth(ctx context.Context, path string) (RuntimeHealthReport, error) {
	return probeCLIRuntime(ctx, c.Name(), path, true)
}

var codexVersion = regexp.MustCompile(`^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)$`)
var claudeVersion = regexp.MustCompile(`^([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)$`)

func probeCLIRuntime(ctx context.Context, provider, path string, codex bool) (RuntimeHealthReport, error) {
	report := RuntimeHealthReport{Provider: provider, Executable: path}
	fail := func(reason string) (RuntimeHealthReport, error) {
		return report, fmt.Errorf("provider %q runtime at %q: %s", provider, path, reason)
	}
	installation, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fail("cannot resolve the installation; reinstall the selected CLI or correct its path")
	}
	report.Installation = installation
	output, reason := runRuntimeDiagnostic(ctx, path, "--version")
	if reason != "" {
		return fail(reason + "; verify the selected CLI installation before launching")
	}
	pattern := claudeVersion
	if codex {
		pattern = codexVersion
	}
	version := pattern.FindStringSubmatch(strings.TrimSpace(output))
	if len(version) != 2 {
		return fail("version diagnostic was not recognized; install a supported CLI distribution before launching")
	}
	report.Version = version[1]
	report.Verified = []string{"version diagnostic succeeded"}
	if codex {
		resources := filepath.Dir(installation)
		bundle := filepath.Dir(filepath.Dir(resources))
		if filepath.Base(resources) == "Resources" && filepath.Base(filepath.Dir(resources)) == "Contents" && strings.HasSuffix(bundle, ".app") {
			companion := "codex-code-mode-host"
			canonical := filepath.Join(resources, companion)
			if _, err := os.Lstat(canonical); err == nil {
				selected := filepath.Join(filepath.Dir(path), companion)
				expectedInfo, expectedErr := os.Stat(canonical)
				selectedInfo, selectedErr := os.Stat(selected)
				if expectedErr != nil || selectedErr != nil || !os.SameFile(expectedInfo, selectedInfo) {
					return fail(fmt.Sprintf("bundled inspection dependency %q does not resolve to this installation beside the launch executable; use the complete CLI installation or launch its original bundled executable", companion))
				}
				if _, reason := runRuntimeDiagnostic(ctx, selected, "--help"); reason != "" {
					return fail(fmt.Sprintf("bundled inspection dependency %q is not usable beside the launch executable (%s); use the complete CLI installation or launch its original bundled executable", companion, reason))
				}
				report.Verified = append(report.Verified, "bundled inspection dependency "+companion+" diagnostic succeeded")
			} else if !os.IsNotExist(err) {
				return fail("cannot inspect bundled runtime dependencies; correct installation access before launching")
			} else {
				report.Unverified = append(report.Unverified, "this bundle has no recognized inspection companion; inspection tools require operational verification")
			}
		} else {
			report.Unverified = append(report.Unverified, "inspection tools for this CLI distribution require operational verification")
		}
	}
	report.Unverified = append(report.Unverified, "provider account/model access is not tested by local diagnostics")
	return report, nil
}

type diagnosticOutput struct {
	data     []byte
	overflow bool
}

func (b *diagnosticOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := runtimeOutputLimit - len(b.data)
	if n > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	b.data = append(b.data, p...)
	return n, nil
}

func runRuntimeDiagnostic(ctx context.Context, path, arg string) (string, string) {
	ctx, cancel := context.WithTimeout(ctx, runtimeProbeTimeout)
	defer cancel()
	var output diagnosticOutput
	err := runOwnedRuntimeDiagnostic(ctx, path, arg, &output)
	if ctx.Err() != nil {
		return "", "runtime diagnostic timed out or was canceled"
	}
	if err != nil {
		return "", "runtime diagnostic could not complete"
	}
	if output.overflow {
		return "", "runtime diagnostic exceeded its output limit"
	}
	return string(output.data), ""
}
