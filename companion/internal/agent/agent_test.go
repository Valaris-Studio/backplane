// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
)

func TestRegistryAcceptsBothSpellings(t *testing.T) {
	registry := agent.NewRegistry(claudecode.New())
	for _, name := range []string{"claude_code", "claude-code"} {
		if adapter, err := registry.Lookup(name); err != nil || adapter.ID() != "claude_code" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := registry.Lookup("codex"); !errors.Is(err, agent.ErrUnknownAgent) {
		t.Fatal("unknown agent resolved")
	}
	if agent.CommandName("claude_code") != "claude-code" || len(registry.All()) != 1 {
		t.Fatal("command name or listing wrong")
	}
}

type aliased struct{ agent.Agent }

func (aliased) ID() string        { return "pi_cli" }
func (aliased) Aliases() []string { return []string{"pi"} }

func TestRegistryResolvesAliases(t *testing.T) {
	registry := agent.NewRegistry(claudecode.New(), aliased{})
	for _, name := range []string{"pi", "pi_cli", "pi-cli"} {
		if adapter, err := registry.Lookup(name); err != nil || adapter.ID() != "pi_cli" {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestLookPathUsesTheEnvironmentPath(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "pi")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	env := agent.Env{Getenv: func(key string) string {
		if key == "PATH" {
			return dir
		}
		return ""
	}}
	if path, ok := env.LookPath("pi"); !ok || path != executable {
		t.Fatalf("not found on the env PATH: %q", path)
	}
	if _, ok := (agent.Env{Getenv: func(string) string { return "" }}).LookPath("pi"); ok {
		t.Fatal("found without a PATH")
	}
}

func TestWindowsLookPathHonorsPATHEXT(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "pi.cmd"), []byte("@echo off\r\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "claude.bat"), []byte("@echo off\r\n"), 0o600)
	env := agent.Env{Getenv: func(key string) string {
		return map[string]string{"PATH": dir, "PATHEXT": ".COM;.EXE;.BAT;.CMD"}[key]
	}}
	for _, name := range []string{"pi", "claude"} {
		if _, ok := env.LookPathFor("windows", name); !ok {
			t.Errorf("%s not found through PATHEXT", name)
		}
	}
	noPathext := agent.Env{Getenv: func(key string) string { return map[string]string{"PATH": dir}[key] }}
	if _, ok := noPathext.LookPathFor("windows", "pi"); !ok {
		t.Error("the default PATHEXT must include .CMD")
	}
	if _, ok := env.LookPathFor("linux", "pi"); ok {
		t.Error("PATHEXT applies only on Windows")
	}
}
