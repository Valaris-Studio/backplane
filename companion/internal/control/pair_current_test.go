// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"fmt"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

func TestPairCurrent_AnswersThePendingPairing(t *testing.T) {
	server, _ := pairingServer(t)
	if reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`); reply.status != 200 {
		t.Fatalf("start: %d %s", reply.status, reply.body)
	}
	reply := server.do(t, "GET", "/v1/pair", "")
	if reply.status != 200 {
		t.Fatalf("current: %d %s", reply.status, reply.body)
	}
	body := reply.json(t)
	for key, want := range map[string]any{"pairing_id": "p1", "user_code": "BCDF-GHJK", "verification_uri_complete": "https://bp.example/companion/pair?code=BCDF-GHJK", "expires_at": "2026-09-28T10:10:00Z"} {
		if body[key] != want {
			t.Fatalf("%s = %v, want %v (%s)", key, body[key], want, reply.body)
		}
	}
}

func TestPairCurrent_NotFoundWithoutAPendingPairing(t *testing.T) {
	server, pairer := pairingServer(t)
	if reply := server.do(t, "GET", "/v1/pair", ""); reply.status != 404 || reply.json(t)["error"].(map[string]any)["code"] != CodeNotFound {
		t.Fatalf("no pairing: %d %s", reply.status, reply.body)
	}
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	pairer.set("p1", PairState{State: PairDenied})
	if reply := server.do(t, "GET", "/v1/pair", ""); reply.status != 404 {
		t.Fatalf("a settled pairing is not current: %d %s", reply.status, reply.body)
	}
}

func TestPairCurrent_WithoutAPairerIsUnavailable(t *testing.T) {
	server := newTestServer(t, nil)
	if reply := server.do(t, "GET", "/v1/pair", ""); reply.status != 501 {
		t.Fatalf("no pairer: %d %s", reply.status, reply.body)
	}
}

func TestPairStart_AForeignVerificationPageIsPairingFailed(t *testing.T) {
	server, pairer := pairingServer(t)
	pairer.startErr = fmt.Errorf("start: %w", uplink.ErrForeignVerificationPage)
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	if reply.status != 422 || reply.json(t)["error"].(map[string]any)["code"] != "pairing_failed" {
		t.Fatalf("foreign page: %d %s", reply.status, reply.body)
	}
}

func TestPairCurrent_CarriesThePairingEndpoint(t *testing.T) {
	server, _ := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	if body := server.do(t, "GET", "/v1/pair", "").json(t); body["endpoint"] != "https://bp.example" {
		t.Fatalf("current pairing endpoint: %v", body)
	}
}
