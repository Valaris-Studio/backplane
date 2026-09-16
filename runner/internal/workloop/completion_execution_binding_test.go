// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

func TestCompletionIterationBindsCodeExecutionToProviderOptions(t *testing.T) {
	cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory policy."))
	provider := llm.NewMockProvider("first", "second", "legacy")
	srv := newLoopModeServer(t)
	m := newLoopModeForServer(t, srv, provider)
	for i, id := range []string{"source-execution-1", "source-execution-2", "legacy-execution"} {
		if i == 2 {
			cfg.CompletionPolicy = nil
		}
		failed, _, _ := m.runIteration(context.Background(), &cfg, i+1, id, provider, "model", 1, 0)
		if failed {
			t.Fatal("iteration failed")
		}
		encoded, _ := json.Marshal(provider.Calls[i].Options)
		var opts map[string]any
		_ = json.Unmarshal(encoded, &opts)
		if i < 2 && opts["SourceExecutionID"] != id {
			t.Errorf("code-owned execution omitted from provider launch: got %v want %s", opts["SourceExecutionID"], id)
		}
		if i == 2 && opts["SourceExecutionID"] != nil && opts["SourceExecutionID"] != "" {
			t.Fatal("legacy launch inherited source binding")
		}
	}
}

func TestCompletionValidationDoesNotInheritSourceExecutionBinding(t *testing.T) {
	t.Setenv("BACKPLANE_SOURCE_EXECUTION_ID", "stale-source-execution")
	repo, sha, _ := completionSourceRepo(t)
	checks := []map[string]any{{"id": "identity", "argv": []string{"sh", "-c", "printf '%s' \"${BACKPLANE_SOURCE_EXECUTION_ID-unset}\""}, "timeout_seconds": 2}}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, checks))
	m := newLoopModeForServer(t, srv.base, llm.NewMockProvider("unused"))
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	receipt := assertCompletionAcknowledgment(t, srv, sha, "passed")
	output := receipt["checks"].([]any)[0].(map[string]any)["output"]
	if output != "unset" {
		t.Errorf("validation inherited source execution attribution: %v", output)
	}
}
