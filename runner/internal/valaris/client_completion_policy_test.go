// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// Wire assertions deliberately avoid naming new Go structs: preserving the
// backend's policy is the contract, independent of its local representation.
func TestCompletionPolicyClient_PreservesEffectiveContractAndContext(t *testing.T) {
	wire := `{
		"enabled":true,
		"completion_policy":{"version":1,"landing_actor":"platform","landing_methods":["merge_queue"],"source_review":"independent","review_role":"source-examiner","require_forge_checks":true,"postmerge_validation":{"role":"acceptance-prober","checks":[{"id":"smoke","argv":["./verify","--mode","literal value"],"timeout_seconds":30}]},"evidence_only":{"enabled":true,"approval":"independent","review_role":"receipt-examiner"},"dependency_release":"accepted","auto_complete":true},
		"completion_policy_hash":"policy-hash-1",
		"completion_context":"MANDATORY: validate the accepted merged commit; policy-hash-1",
		"future_unrelated_field":{"enabled":true}
	}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/workspaces/acme/boards/board-1/loop" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(wire))
	}))
	defer server.Close()
	client := NewClient(server.URL, "vlr_test")
	got, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if err != nil {
		t.Fatalf("GetBoardLoop: %v", err)
	}
	roundTrip, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var want, preserved map[string]any
	if err := json.Unmarshal([]byte(wire), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(roundTrip, &preserved); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"completion_policy", "completion_policy_hash", "completion_context"} {
		if !reflect.DeepEqual(preserved[key], want[key]) {
			t.Errorf("GetBoardLoop discarded or changed mandatory %s: got %#v, want %#v", key, preserved[key], want[key])
		}
	}
}

func TestCompletionPolicyClient_LegacyAbsentOrNullStillDecodes(t *testing.T) {
	for _, wire := range []string{`{"enabled":true}`, `{"enabled":true,"completion_policy":null}`} {
		t.Run(wire, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(wire))
			}))
			defer server.Close()
			got, err := NewClient(server.URL, "vlr_test").GetBoardLoop(context.Background(), "acme", "board-1")
			if err != nil || got == nil || !got.Enabled {
				t.Fatalf("legacy config changed behavior: cfg=%+v err=%v", got, err)
			}
		})
	}
}

func TestCompletionPolicyClient_UnknownVersionCannotBecomeLegacy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"enabled":true,"completion_policy":{"version":99},"completion_policy_hash":"future"}`))
	}))
	defer server.Close()
	got, err := NewClient(server.URL, "vlr_test").GetBoardLoop(context.Background(), "acme", "board-1")
	if err == nil {
		t.Fatalf("unsupported explicit completion policy was accepted as executable: %+v", got)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "completion") || !strings.Contains(err.Error(), "99") {
		t.Errorf("incompatibility must identify completion policy version 99: %v", err)
	}
}

func TestCompletionWorkMalformedStatusCannotAppearEmpty(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"pending_count":0,"actionable_count":-1,"failed_count":0}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer server.Close()
			if _, err := NewClient(server.URL, "vlr_fixture").GetCompletionWork(context.Background(), "acme", "board-1"); err == nil {
				t.Fatal("malformed completion status was treated as no work")
			}
		})
	}
}
