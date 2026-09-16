// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRuntimeHealthProbeSanitizesAndBoundsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX diagnostic fixture")
	}
	for _, tc := range []struct{ name, body, reason string }{
		{"stderr_failure", "printf 'vlr_secret_fixture' >&2; exit 9", "could not complete"},
		{"invalid_version", "printf 'vlr_secret_fixture\\n'", "version diagnostic was not recognized"},
		{"excessive_output", "i=0; while [ $i -lt 900 ]; do printf 'vlr_secret_fixture'; i=$((i+1)); done", "exceeded its output limit"},
		{"timeout", "while :; do :; done", "timed out"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "codex")
			if err := os.WriteFile(path, []byte("#!/bin/sh\n"+tc.body+"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			deadline := 5 * time.Second
			if tc.name == "timeout" {
				deadline = 150 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), deadline)
			defer cancel()
			report, err := CheckRuntimeHealth(ctx, NewCodexCLI(), func(string) (string, error) { return path, nil })
			if err == nil {
				t.Fatal("unsafe or unavailable diagnostic output accepted")
			}
			if !strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("wrong diagnostic reason: %v", err)
			}
			if strings.Contains(err.Error()+report.String(), "vlr_secret_fixture") {
				t.Fatal("raw diagnostic output leaked")
			}
			if len(err.Error()+report.String()) > 2048 {
				t.Fatal("unbounded runtime diagnostic report")
			}
		})
	}
}

func TestRuntimeHealthUnknownProviderIsExplicitlyUnverified(t *testing.T) {
	provider := NewMockProvider("must not execute")
	provider.NameOverride = "operator-agent"
	report, err := CheckRuntimeHealth(context.Background(), provider, nil)
	if err != nil {
		t.Fatal(err)
	}
	if provider.CallCount() != 0 || len(report.Unverified) == 0 {
		t.Fatal("unknown runtime must not invoke or claim verification")
	}
}

func TestRuntimeHealthPreservesQualifiedPrereleaseVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX diagnostic fixture")
	}
	path := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'codex-cli 0.154.0-alpha.6.2\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	report, err := CheckRuntimeHealth(context.Background(), NewCodexCLI(), func(string) (string, error) { return path, nil })
	if err != nil || report.Version != "0.154.0-alpha.6.2" {
		t.Fatalf("qualified version lost: %+v err=%v", report, err)
	}
}

func TestRuntimeHealthTimeoutReapsOwnedProcessTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process group fixture")
	}
	root := t.TempDir()
	marker := filepath.Join(root, "orphan-finished")
	t.Setenv("RUNTIME_ORPHAN_MARKER", marker)
	path := filepath.Join(root, "codex")
	// A surviving grandchild will write after the diagnostic has returned.
	body := "#!/bin/sh\n(/bin/sleep 0.5; printf orphan > \"$RUNTIME_ORPHAN_MARKER\") &\nwait\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := CheckRuntimeHealth(ctx, NewCodexCLI(), func(string) (string, error) { return path, nil })
	if err == nil {
		t.Fatal("hanging runtime accepted")
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("diagnostic descendant survived cancellation")
	}
}
