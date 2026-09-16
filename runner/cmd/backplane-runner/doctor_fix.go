// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// -fix is the one place doctor is allowed to WRITE. It stays inside doctor's
// contract by writing exactly one thing — the MCP config the operator was
// otherwise told to hand-author — and nothing else: no clone, no agent, no
// spend.

// mcpFixDeps is the outside world the fix path touches, injected so tests drive
// every branch without a real HOME, a real PATH, or a real uv install.
type mcpFixDeps struct {
	WorkDir       string
	Creds         Credentials
	MCPConfigPath string
	// UvxAvailable is threaded rather than called directly so a test can drive
	// the uv-missing branch on a machine that happens to have uv installed.
	// Defaults to tui.UvxAvailable.
	UvxAvailable func() bool
}

// mcpFixOutcome is what the fix attempt did, kept separate from the check it
// produced so the caller does not have to parse a rendered Detail string to
// learn the path.
type mcpFixOutcome struct {
	Check       checkResult
	WrittenPath string
	// Note is the one operator-facing line about the attempt; empty when there
	// was nothing to attempt.
	Note string
}

// uvInstallHint is the one URL an operator needs when the launcher is missing.
const uvInstallHint = "https://docs.astral.sh/uv/"

// fixMCPConfig synthesizes a working MCP config when the current check is
// missing-or-template, and returns the check as it stands AFTER the attempt —
// re-run against the file it wrote, so the report describes reality rather than
// the state doctor found on entry.
func fixMCPConfig(deps mcpFixDeps) mcpFixOutcome {
	current := checkMCPConfig(deps.MCPConfigPath)
	if current.State == tui.StateOK {
		return mcpFixOutcome{Check: current}
	}
	// A file that exists, is not the template, and still is not OK is broken in
	// a way only its author can resolve (malformed JSON, unreadable). Writing
	// beside it would leave two configs and fix neither.
	if deps.MCPConfigPath != "" && !isMCPConfigTemplate(deps.MCPConfigPath) {
		return mcpFixOutcome{Check: current}
	}

	if missing := deps.Creds.Missing(); len(missing) > 0 {
		// A config written with an empty key would pass every check here and
		// then 401 on the runner's first platform call — the exact false green
		// the template check exists to prevent. Never write one we know cannot
		// work.
		current.Fix = "configure credentials first — run `backplane-runner` with no arguments and complete the wizard, then rerun `backplane-runner -doctor -fix`"
		return mcpFixOutcome{Check: current, Note: "not written: credentials unresolved (" + strings.Join(missing, ", ") + ")"}
	}

	uvxAvailable := deps.UvxAvailable
	if uvxAvailable == nil {
		uvxAvailable = tui.UvxAvailable
	}
	// The uvx launch is the only one doctor can synthesize unattended — the
	// checkout launch needs a source directory only the operator knows. Writing
	// a uvx config on a machine without uvx would produce a file that looks
	// configured and cannot start, so this reports instead of writing.
	if !uvxAvailable() {
		return mcpFixOutcome{
			Check: checkResult{
				Label:  "mcp config",
				Detail: "cannot write one: `uvx` is not on PATH, so the generated config could not start",
				Fix: "install uv (" + uvInstallHint + ") and rerun `backplane-runner -doctor -fix`, or run " +
					"`backplane-runner` with no arguments and pick the checkout option to point at a local mcp-server directory",
				State: tui.StateWarn,
			},
			Note: "not written: uvx is not on PATH",
		}
	}

	path := mcpFixTargetPath(deps)
	seed := tui.MCPConfigSeed{
		Launch: tui.MCPLaunchUvx(),
		APIURL: deps.Creds.APIURL,
		APIKey: deps.Creds.APIKey,
	}
	if err := tui.WriteMCPConfig(path, seed); err != nil {
		if errors.Is(err, tui.ErrMCPConfigExists) {
			current.Fix = fmt.Sprintf("%s already exists and was left untouched — edit it by hand, or move it aside and rerun `backplane-runner -doctor -fix`", path)
			return mcpFixOutcome{Check: current, Note: "not written: " + path + " already exists"}
		}
		current.Fix = "could not write " + path + ": " + errSummary(err)
		return mcpFixOutcome{Check: current, Note: "not written: " + errSummary(err)}
	}

	return mcpFixOutcome{Check: checkMCPConfig(path), WrittenPath: path, Note: "wrote " + path}
}

// mcpFixTargetPath picks where the synthesized config lands: beside the config
// currently in effect when there is one (including the template's own
// directory, so the real file replaces the placeholder where it was found),
// else beside the discovered runner config, else the working directory — the
// path README's quickstart tells operators to create.
func mcpFixTargetPath(deps mcpFixDeps) string {
	switch {
	case deps.MCPConfigPath != "":
		return filepath.Join(filepath.Dir(deps.MCPConfigPath), mcpConfigFilenames[0])
	case deps.Creds.ConfigPath != "":
		return filepath.Join(filepath.Dir(deps.Creds.ConfigPath), mcpConfigFilenames[0])
	case deps.WorkDir != "":
		return filepath.Join(deps.WorkDir, mcpConfigFilenames[0])
	}
	return mcpConfigFilenames[0]
}

// runDoctorFix is the `-doctor -fix` entry point: attempt the write first so
// the report that follows already reflects the file it created, then print what
// happened under the report where the operator is already reading.
func runDoctorFix(ctx context.Context, cfg *config.Config, creds Credentials, workDir string) int {
	outcome := fixMCPConfig(mcpFixDeps{
		WorkDir:       workDir,
		Creds:         creds,
		MCPConfigPath: creds.MCPConfigPath,
	})
	if outcome.WrittenPath != "" {
		creds.MCPConfigPath = outcome.WrittenPath
	}

	// The report shows the fix attempt's own verdict for this row: a re-check
	// that knows nothing about -fix would hand back the generic "run the wizard"
	// remedy to an operator who just ran -fix and needs the reason it did not
	// write.
	code, _ := runDoctorChecksWithOverride(ctx, cfg, creds, &outcome.Check)
	if outcome.Note != "" {
		fmt.Println(tui.StatusLine(fixIcon(outcome.Check), "fix", outcome.Note))
	}
	return code
}

// fixIcon marks the fix line with the outcome of the attempt, matching the
// verdict line's vocabulary.
func fixIcon(result checkResult) string {
	switch result.State {
	case tui.StateOK:
		return "✓"
	case tui.StateWarn:
		return "!"
	}
	return "✗"
}

// errFixWithoutDoctor rejects `-fix` on its own rather than ignoring it. A flag
// that silently does nothing is the defect class this branch has already fixed
// twice — the operator believes something was written when nothing was.
var errFixWithoutDoctor = errors.New("-fix only applies to -doctor: rerun as `backplane-runner -doctor -fix`")

// exitCodeUsage is the conventional shell code for a misused invocation, kept
// distinct from doctor's own 1 (checks failed) so a script can tell them apart.
const exitCodeUsage = 2

// requireDoctorForFix enforces the pairing at the flag layer.
func requireDoctorForFix(doctor, fix bool) error {
	if fix && !doctor {
		return errFixWithoutDoctor
	}
	return nil
}
