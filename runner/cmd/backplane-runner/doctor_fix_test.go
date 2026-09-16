// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// uvxPresent / uvxAbsent inject the launcher probe so these tests never depend
// on whether the machine running them happens to have uv installed.
func uvxPresent() bool { return true }
func uvxAbsent() bool  { return false }

func fixableCreds() Credentials {
	return Credentials{
		APIKey:    "vlr_realkey",
		APIURL:    "https://backplane.example",
		Workspace: "acme",
	}
}

// ------------------------------------------------------------- flag guard --

// A -fix that is silently ignored tells the operator a config was written when
// none was — the defect class this branch has already fixed twice.
func TestRequireDoctorForFix_RejectsFixAlone(t *testing.T) {
	tests := []struct {
		name           string
		doctor, fix    bool
		wantErr        bool
		wantExitOnFail int
	}{
		{name: "fix without doctor is a usage error", fix: true, wantErr: true, wantExitOnFail: exitCodeUsage},
		{name: "fix with doctor is accepted", doctor: true, fix: true},
		{name: "doctor alone is unchanged", doctor: true},
		{name: "neither is unchanged"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := requireDoctorForFix(tt.doctor, tt.fix)
			if tt.wantErr != (err != nil) {
				t.Fatalf("requireDoctorForFix(%v, %v) error = %v, wantErr %v", tt.doctor, tt.fix, err, tt.wantErr)
			}
			if !tt.wantErr {
				return
			}
			if !strings.Contains(err.Error(), "-doctor") {
				t.Errorf("the error must name the flag it needs: %q", err)
			}
			if exitCodeUsage == 0 {
				t.Error("a rejected invocation must exit non-zero")
			}
		})
	}
}

// ------------------------------------------------------------- happy path --

func TestFixMCPConfig_WritesAWorkingConfigAt0600(t *testing.T) {
	dir := t.TempDir()

	got := fixMCPConfig(mcpFixDeps{WorkDir: dir, Creds: fixableCreds(), UvxAvailable: uvxPresent})

	want := filepath.Join(dir, mcpConfigFilenames[0])
	if got.WrittenPath != want {
		t.Fatalf("wrote %q, want %q (%s)", got.WrittenPath, want, got.Note)
	}
	if got.Check.State != tui.StateOK {
		t.Fatalf("the re-run check must reflect the file just written, got %v (%s)", got.Check.State, got.Check.Detail)
	}
	if !strings.Contains(got.Note, want) {
		t.Errorf("the note must name the path written: %q", got.Note)
	}

	info, err := os.Stat(want)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %v, want 0600 — the file holds a real agent key", perm)
	}

	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		MCPServers map[string]struct {
			Command string
			Args    []string
			Env     map[string]string
		}
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("the written config must parse: %v", err)
	}
	entry, ok := doc.MCPServers["valaris"]
	if !ok {
		t.Fatalf("the config must carry the valaris server key: %s", data)
	}
	if entry.Command != "uvx" {
		t.Errorf("command = %q, want the uvx launch", entry.Command)
	}
	if entry.Env["VALARIS_API_KEY"] != "vlr_realkey" {
		t.Errorf("the key must be written as a real value, got %q", entry.Env["VALARIS_API_KEY"])
	}
	if entry.Env["VALARIS_API_URL"] != "https://backplane.example" {
		t.Errorf("api url = %q, want the resolved one", entry.Env["VALARIS_API_URL"])
	}
}

// A template discovered on disk is the "not configured yet" case — the real
// config lands beside it and wins discovery from then on.
func TestFixMCPConfig_ReplacesTheTemplateInItsOwnDirectory(t *testing.T) {
	dir := t.TempDir()
	template := filepath.Join(dir, mcpConfigTemplateFilename)
	if err := os.WriteFile(template, []byte(`{"mcpServers":{"valaris":{"command":"bash","args":["/path/to/run.sh"]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	got := fixMCPConfig(mcpFixDeps{WorkDir: t.TempDir(), Creds: fixableCreds(), MCPConfigPath: template, UvxAvailable: uvxPresent})

	if want := filepath.Join(dir, mcpConfigFilenames[0]); got.WrittenPath != want {
		t.Fatalf("wrote %q, want the real config beside the template at %q", got.WrittenPath, want)
	}
	if got.Check.State != tui.StateOK {
		t.Fatalf("state = %v, want OK after the write (%s)", got.Check.State, got.Check.Detail)
	}
}

// ------------------------------------------------------- refusal branches --

func TestFixMCPConfig_WritesNothingWithoutCredentials(t *testing.T) {
	tests := []struct {
		name  string
		creds Credentials
	}{
		{name: "no key at all", creds: Credentials{APIURL: "https://backplane.example", Workspace: "acme"}},
		{name: "no workspace", creds: Credentials{APIKey: "vlr_realkey", APIURL: "https://backplane.example"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()

			got := fixMCPConfig(mcpFixDeps{WorkDir: dir, Creds: tt.creds, UvxAvailable: uvxPresent})

			if got.WrittenPath != "" {
				t.Fatalf("wrote %q — a config with no usable key would 401 on the first platform call", got.WrittenPath)
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Fatalf("the target directory must stay empty, found %v", entries)
			}
			if got.Check.State == tui.StateOK {
				t.Fatal("the check must stay unhealthy when nothing was written")
			}
			if !strings.Contains(strings.ToLower(got.Check.Fix), "credential") {
				t.Errorf("the fix must point at configuring credentials: %q", got.Check.Fix)
			}
		})
	}
}

// Writing a uvx config on a machine with no uvx produces a file that looks
// configured and cannot start — worse than writing nothing.
func TestFixMCPConfig_WarnsAndWritesNothingWithoutUvx(t *testing.T) {
	dir := t.TempDir()

	got := fixMCPConfig(mcpFixDeps{WorkDir: dir, Creds: fixableCreds(), UvxAvailable: uvxAbsent})

	if got.WrittenPath != "" {
		t.Fatalf("wrote %q — the generated config could not start without uvx", got.WrittenPath)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("the target directory must stay empty, found %v", entries)
	}
	if got.Check.State != tui.StateWarn {
		t.Fatalf("state = %v, want StateWarn (%s)", got.Check.State, got.Check.Detail)
	}
	if !strings.Contains(got.Check.Fix, uvInstallHint) {
		t.Errorf("the fix must name the uv install hint: %q", got.Check.Fix)
	}
	if !strings.Contains(strings.ToLower(got.Check.Fix), "checkout") {
		t.Errorf("the fix must name the wizard's checkout alternative: %q", got.Check.Fix)
	}
}

// An operator's hand-tuned config is never replaced, whatever -fix was asked to
// do.
func TestFixMCPConfig_NeverClobbersARealConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, mcpConfigFilenames[0])
	const original = `{"mcpServers":{"valaris":{"command":"my-own-launcher","args":[],"env":{}}}}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	got := fixMCPConfig(mcpFixDeps{WorkDir: dir, Creds: fixableCreds(), MCPConfigPath: path, UvxAvailable: uvxPresent})

	if got.WrittenPath != "" {
		t.Fatalf("wrote %q over an existing config", got.WrittenPath)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != original {
		t.Fatalf("the existing config was modified:\n got %s\nwant %s", data, original)
	}
	// A healthy config is not a problem to fix — it stays OK and says nothing.
	if got.Check.State != tui.StateOK {
		t.Errorf("state = %v, want the existing config to keep passing", got.Check.State)
	}
	if got.Note != "" {
		t.Errorf("nothing to fix should print no fix line, got %q", got.Note)
	}
}

// A malformed config is broken in a way only its author can resolve — writing
// beside it would leave two configs and fix neither.
func TestFixMCPConfig_LeavesAMalformedConfigToItsAuthor(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, mcpConfigFilenames[0])
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := fixMCPConfig(mcpFixDeps{WorkDir: dir, Creds: fixableCreds(), MCPConfigPath: path, UvxAvailable: uvxPresent})

	if got.WrittenPath != "" {
		t.Fatalf("wrote %q instead of leaving the broken file alone", got.WrittenPath)
	}
	if got.Check.State != tui.StateFail {
		t.Errorf("state = %v, want the malformed config to keep failing", got.Check.State)
	}
}

// ---------------------------------------------------------- part B: guidance --

// The old fix text only named the placeholders to hand-edit, leaving an
// operator to find out what the real command is. Both write-it-for-you paths
// must be named instead.
func TestCheckMCPConfig_FixNamesBothWaysForward(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), mcpConfigTemplateFilename)
	if err := os.WriteFile(templatePath, []byte(`{"mcpServers":{"valaris":{"command":"bash","args":["/path/to/run.sh"]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		path string
	}{
		{name: "no config discovered", path: ""},
		{name: "only the shipped template", path: templatePath},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fix := checkMCPConfig(tt.path).Fix

			if !strings.Contains(fix, "-doctor -fix") {
				t.Errorf("fix must offer to write the config now: %q", fix)
			}
			if !strings.Contains(fix, "wizard") {
				t.Errorf("fix must name the wizard as the interactive way forward: %q", fix)
			}
			if !strings.Contains(fix, mcpConfigFilenames[0]) {
				t.Errorf("fix must still name the file it produces: %q", fix)
			}
		})
	}
}

// ------------------------------------------------------------- report row --

// An operator who just ran -fix must read the reason it did not write, not the
// generic "run the wizard" remedy a fix-unaware re-check produces.
func TestReplaceCheck_SwapsTheRowInPlace(t *testing.T) {
	results := []checkResult{
		{Label: "credentials", State: tui.StateOK},
		{Label: "mcp config", Detail: "stale", Fix: "generic", State: tui.StateFail},
		{Label: "work dir", State: tui.StateOK},
	}
	override := checkResult{Label: "mcp config", Detail: "fresh", Fix: "fix-aware", State: tui.StateWarn}

	got := replaceCheck(results, &override)

	if len(got) != 3 || got[1].Label != "mcp config" {
		t.Fatalf("check order must survive the swap: %v", got)
	}
	if got[1].Fix != "fix-aware" || got[1].State != tui.StateWarn {
		t.Errorf("row = %+v, want the override", got[1])
	}
	if got[0].Label != "credentials" || got[2].Label != "work dir" {
		t.Errorf("only the matching row may change: %v", got)
	}
}

func TestReplaceCheck_NilOverrideChangesNothing(t *testing.T) {
	results := []checkResult{{Label: "mcp config", Fix: "generic"}}

	if got := replaceCheck(results, nil); got[0].Fix != "generic" {
		t.Errorf("a plain -doctor run must be untouched: %+v", got[0])
	}
}

// ------------------------------------------------------------ target path --

func TestMCPFixTargetPath_PrefersTheConfigInEffect(t *testing.T) {
	tests := []struct {
		name string
		deps mcpFixDeps
		want string
	}{
		{
			name: "beside the discovered mcp config",
			deps: mcpFixDeps{MCPConfigPath: "/etc/bp/" + mcpConfigTemplateFilename, WorkDir: "/work"},
			want: "/etc/bp/" + mcpConfigFilenames[0],
		},
		{
			name: "beside the runner config when no mcp config was found",
			deps: mcpFixDeps{Creds: Credentials{ConfigPath: "/etc/bp/runner.yaml"}, WorkDir: "/work"},
			want: "/etc/bp/" + mcpConfigFilenames[0],
		},
		{
			name: "the working directory otherwise",
			deps: mcpFixDeps{WorkDir: "/work"},
			want: "/work/" + mcpConfigFilenames[0],
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mcpFixTargetPath(tt.deps); got != tt.want {
				t.Errorf("mcpFixTargetPath() = %q, want %q", got, tt.want)
			}
		})
	}
}
