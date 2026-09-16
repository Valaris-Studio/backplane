// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lastValue returns the effective value of key in a `KEY=VALUE` env slice.
// Later entries win in exec, so the pin must be the last occurrence.
func lastValue(env []string, key string) (string, bool) {
	prefix := key + "="
	value, found := "", false
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			value, found = strings.TrimPrefix(entry, prefix), true
		}
	}
	return value, found
}

func TestSubprocessEnv_PinsGitAllowProtocol(t *testing.T) {
	value, found := lastValue((&Manager{}).subprocessEnv(), "GIT_ALLOW_PROTOCOL")
	if !found {
		t.Fatal("GIT_ALLOW_PROTOCOL not set on subprocess env")
	}

	allowed := strings.Split(value, ":")
	for _, banned := range []string{"ext", "fd"} {
		for _, proto := range allowed {
			if proto == banned {
				t.Fatalf("remote-helper protocol %q must not be allowed, got %q", banned, value)
			}
		}
	}
}

// The pin must not depend on RoleToken: the pre-existing wiring only built a
// custom env when a token was present, which would leave token-less runs
// (a public-repo clone) inheriting whatever the ambient environment says.
func TestSubprocessEnv_PinsGitAllowProtocolWithoutRoleToken(t *testing.T) {
	withToken, _ := lastValue((&Manager{RoleToken: "gho_x"}).subprocessEnv(), "GIT_ALLOW_PROTOCOL")
	withoutToken, found := lastValue((&Manager{}).subprocessEnv(), "GIT_ALLOW_PROTOCOL")

	if !found {
		t.Fatal("GIT_ALLOW_PROTOCOL missing when RoleToken is empty")
	}
	if withToken != withoutToken {
		t.Fatalf("protocol pin differs by token presence: %q vs %q", withToken, withoutToken)
	}
}

// A token still has to reach the child — the pin must not displace it.
func TestSubprocessEnv_StillCarriesRoleToken(t *testing.T) {
	value, found := lastValue((&Manager{RoleToken: "gho_secret"}).subprocessEnv(), "GH_TOKEN")
	if !found || value != "gho_secret" {
		t.Fatalf("GH_TOKEN not propagated, got %q (found=%v)", value, found)
	}
}

func TestSubprocessEnv_AmbientGitAllowProtocolCannotWiden(t *testing.T) {
	t.Setenv("GIT_ALLOW_PROTOCOL", "ext:fd:https")

	value, _ := lastValue((&Manager{}).subprocessEnv(), "GIT_ALLOW_PROTOCOL")

	for _, proto := range strings.Split(value, ":") {
		if proto == "ext" || proto == "fd" {
			t.Fatalf("ambient env widened the allowlist: %q", value)
		}
	}
}

// Acceptance: real git, real ext:: URL. Modern git already refuses ext:: by
// default, so the permissive ambient value is what makes this discriminate —
// without the pin git runs the helper and the canary file appears.
func TestCloneOrOpen_ExtURLBlockedDespitePermissiveAmbientEnv(t *testing.T) {
	base := t.TempDir()
	canary := filepath.Join(base, "pwned")
	t.Setenv("GIT_ALLOW_PROTOCOL", "ext:https")

	m := &Manager{BaseDir: base}
	_, err := m.CloneOrOpen(context.Background(), "ext::sh -c touch% "+canary, "victim")

	if err == nil {
		t.Fatal("clone of an ext:: URL succeeded")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "transport") {
		t.Fatalf("expected git's transport gate to reject the clone, got: %v", err)
	}
	if _, statErr := os.Stat(canary); statErr == nil {
		t.Fatal("ext:: remote helper executed — canary file was created")
	}
}
