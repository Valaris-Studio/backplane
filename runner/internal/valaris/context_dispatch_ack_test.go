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

func ackPreparation() DispatchPreparation {
	return DispatchPreparation{
		ProtocolVersion: 1, ClientRequestID: "00000000-0000-4000-8000-0000000000a1",
		ContextRevision: strings.Repeat("d", 64), DispatchRevision: strings.Repeat("e", 64),
		Invocation:  DispatchInvocation{Kind: "stage", PromptSlot: "main"},
		InputPrompt: "Input é🧪", Provider: "operator-provider", Adapter: "operator-provider", Model: "operator-model",
		ResolutionKind: "pinned", ChannelContract: ChannelContract{Version: 1, Input: "verbatim", System: "empty"},
	}
}

func validAck(p DispatchPreparation) map[string]any {
	return map[string]any{
		"protocol_version": 1, "acknowledged": "prepared", "receipt_id": "00000000-0000-4000-8000-0000000000b2",
		"execution_id": snapshotExecution, "client_request_id": p.ClientRequestID, "ordinal": 1,
		"context_revision": p.ContextRevision, "dispatch_revision": p.DispatchRevision,
		"prompt_sha256": digestHex(p.InputPrompt), "prompt_bytes": len(p.InputPrompt),
		"system_prompt_sha256": digestHex(""), "system_prompt_bytes": 0,
		"inclusion_verification": "no_required_sources", "use_verification": "not_verified",
	}
}

// prepareAgainst submits the preparation to a server answering with ack at
// status, and returns the client's verdict: the exchange error, else the
// validation error.
func prepareAgainst(t *testing.T, ack map[string]any, status int, redirect int) error {
	t.Helper()
	p := ackPreparation()
	mux := http.NewServeMux()
	answer := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(ContextDispatchHeader, "1")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(ack)
	}
	route := "/api/workspaces/workspace/executions/" + snapshotExecution + "/dispatch-preparations"
	if redirect != 0 {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/elsewhere", redirect)
		})
		mux.HandleFunc("/elsewhere", answer)
	} else {
		mux.HandleFunc(route, answer)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	got, err := NewClient(srv.URL, "synthetic").PrepareDispatch(context.Background(), "workspace", snapshotExecution, p)
	if err != nil {
		return err
	}
	return got.Validate(p, snapshotExecution, false)
}

// An acknowledgement commits the preparation only in the server's own exact
// shapes: integer numbers, canonical lowercase UUIDs and digests, a 200 or
// 201 to this very request.
func TestPreparationAckRefusesLooseShapes(t *testing.T) {
	changes := map[string]func(map[string]any){
		"ordinal_string":     func(a map[string]any) { a["ordinal"] = "1" },
		"ordinal_negative":   func(a map[string]any) { a["ordinal"] = -1 },
		"ordinal_fractional": func(a map[string]any) { a["ordinal"] = 1.5 },
		"bytes_float":        func(a map[string]any) { a["prompt_bytes"] = json.Number("13.0") },
		"bytes_string":       func(a map[string]any) { a["system_prompt_bytes"] = "0" },
		"version_string":     func(a map[string]any) { a["protocol_version"] = "1" },
		"receipt_uppercase":  func(a map[string]any) { a["receipt_id"] = "00000000-0000-4000-8000-0000000000B2" },
		"receipt_unhyphened": func(a map[string]any) { a["receipt_id"] = "000000000000400080000000000000b2" },
		"request_uppercase":  func(a map[string]any) { a["client_request_id"] = "00000000-0000-4000-8000-0000000000A1" },
		"hash_uppercase":     func(a map[string]any) { a["prompt_sha256"] = strings.ToUpper(a["prompt_sha256"].(string)) },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			ack := validAck(ackPreparation())
			change(ack)
			if err := prepareAgainst(t, ack, http.StatusCreated, 0); err == nil {
				t.Error("loose acknowledgement accepted")
			}
		})
	}
	for _, status := range []int{http.StatusAccepted, http.StatusNoContent, http.StatusNonAuthoritativeInfo} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			if err := prepareAgainst(t, validAck(ackPreparation()), status, 0); err == nil {
				t.Errorf("HTTP %d accepted as an acknowledgement", status)
			}
		})
	}
	for _, redirect := range []int{http.StatusTemporaryRedirect, http.StatusSeeOther} {
		t.Run("redirect_"+http.StatusText(redirect), func(t *testing.T) {
			if err := prepareAgainst(t, validAck(ackPreparation()), http.StatusCreated, redirect); err == nil {
				t.Errorf("an acknowledgement reached through a %d redirect was accepted", redirect)
			}
		})
	}
}

func TestPreparationAckControlsAreAccepted(t *testing.T) {
	for _, status := range []int{http.StatusCreated, http.StatusOK} {
		if err := prepareAgainst(t, validAck(ackPreparation()), status, 0); err != nil {
			t.Errorf("valid HTTP %d acknowledgement refused: %v", status, err)
		}
	}
}
