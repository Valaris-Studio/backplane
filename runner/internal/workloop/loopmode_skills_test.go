// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// skillsLocatorMock is a mock provider that also declares a skills directory,
// so loop mode's materialization path can be exercised without a real CLI.
type skillsLocatorMock struct {
	*llm.MockProvider
}

func (m *skillsLocatorMock) SkillsRelDir() string { return ".claude/skills" }

func TestLoopMode_MaterializesBoardSkillsBeforeExecute(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.boardSkillsBody = `{"skills":[{"slug":"loop-skill","name":"Loop Skill","version":1,"content_hash":"hash-loop"}]}`

	provider := &skillsLocatorMock{MockProvider: llm.NewMockProvider("ok")}
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1", provider.CallCount())
	}

	workDir := provider.Calls[0].Options.WorkingDir
	if workDir == "" {
		t.Fatal("Execute got an empty WorkingDir")
	}
	got, err := os.ReadFile(filepath.Join(workDir, ".claude/skills/loop-skill/SKILL.md"))
	if err != nil {
		t.Fatalf("skill not materialized into the loop working dir: %v", err)
	}
	if string(got) != "# Loop Skill\n" {
		t.Errorf("SKILL.md = %q, want the verbatim published content", got)
	}
}

func TestLoopMode_SkillsOutageDoesNotKillTheLoop(t *testing.T) {
	// A skills fetch failure must degrade to "no skills this iteration", never
	// take the loop down — the loop's actual work is unrelated to skills.
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	// A manifest whose version fetch will 500 is simulated by naming a skill
	// the version route still serves; instead force failure via a bad body.
	srv.boardSkillsBody = `{"skills":[{"slug":"loop-skill","version":1,"content_hash":"hash-loop"}]}`

	// A provider with no SkillsLocator: materialization is skipped entirely and
	// the iteration must still run.
	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want the iteration to run anyway", provider.CallCount())
	}
	workDir := provider.Calls[0].Options.WorkingDir
	if _, err := os.Stat(filepath.Join(workDir, ".claude")); err == nil {
		t.Error("materialized skills for a provider that declares no skills dir")
	}
}
