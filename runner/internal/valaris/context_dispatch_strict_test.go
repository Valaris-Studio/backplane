// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const strictWorkspace = "00000000-0000-4000-8000-000000000248"

func strictContract(mode string, minimum any) map[string]any {
	return map[string]any{
		"protocol": "context-dispatch", "supported_versions": []int{1}, "minimum_version": minimum, "mode": mode,
		"agent_id": dispatchAgent, "workspace_id": strictWorkspace, "policy_revision": strings.Repeat("a", 64),
		"supported_flows": []string{ScheduledActiveExecution},
	}
}

// fetchStrictContract serves contract, acknowledged, and returns the client's
// verdict: the fetch error, else the validation error.
func fetchStrictContract(t *testing.T, contract map[string]any) error {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(ContextDispatchHeader, "1")
		_ = json.NewEncoder(w).Encode(contract)
	}))
	defer srv.Close()
	fetched, err := NewClient(srv.URL, "synthetic").ContextDispatchContract(context.Background(), "workspace", dispatchAgent)
	if err != nil {
		return err
	}
	return fetched.Validate(dispatchAgent, strictWorkspace)
}

// minimum_version is a required integer: a legacy contract that omits it or
// sends null states no floor, and is not read as floor 0.
func TestContextDispatchContractRequiresAnExplicitMinimumVersion(t *testing.T) {
	missing := strictContract("legacy", 0)
	delete(missing, "minimum_version")
	for name, contract := range map[string]map[string]any{
		"legacy_missing_minimum_version": missing,
		"legacy_null_minimum_version":    strictContract("legacy", nil),
		"legacy_string_minimum_version":  strictContract("legacy", "0"),
		"legacy_bool_minimum_version":    strictContract("legacy", false),
		"legacy_fractional_minimum":      strictContract("legacy", 0.5),
	} {
		t.Run(name, func(t *testing.T) {
			if err := fetchStrictContract(t, contract); err == nil {
				t.Error("a contract without an integer minimum_version was accepted")
			}
		})
	}
	for name, contract := range map[string]map[string]any{
		"legacy_explicit_zero":  strictContract("legacy", 0),
		"required_explicit_one": strictContract("required", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := fetchStrictContract(t, contract); err != nil {
				t.Errorf("a complete contract was refused: %v", err)
			}
		})
	}
}
