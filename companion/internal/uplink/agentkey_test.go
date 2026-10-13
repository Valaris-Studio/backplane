// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

const agentKeyFixture = "vlr_fixture_secret_key_do_not_leak_0001"

func TestCreateAgentKey_ReturnsTheKeyAndNeverPrintsIt(t *testing.T) {
	server, seen := contractServer(t, 201, `{"id":"k1","name":"Companion · mac · agents","key_prefix":"vlr_fixt","key":"`+agentKeyFixture+`","created_at":"2026-09-30T10:00:00Z"}`)
	key, err := deviceClient(t, server.URL).CreateAgentKey(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if request := (*seen)[0]; request.method != "POST" || request.path != "/api/companion/agent-key" || request.auth != "Bearer "+uplinktest.DeviceToken {
		t.Fatalf("request %+v", request)
	}
	if key.Key != agentKeyFixture || key.KeyPrefix != "vlr_fixt" || key.ID != "k1" {
		t.Fatalf("key %+v", key.KeyPrefix)
	}
	for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
		if strings.Contains(fmt.Sprintf(format, key), agentKeyFixture) {
			t.Errorf("%s printed the raw key", format)
		}
	}
}

func TestCreateAgentKey_RejectsAMalformedKey(t *testing.T) {
	for _, body := range []string{`{"id":"k1","key":"bpc_not_an_api_key_000000"}`, `{"id":"k1"}`, `[]`} {
		server, _ := contractServer(t, 201, body)
		if _, err := deviceClient(t, server.URL).CreateAgentKey(context.Background()); !errors.Is(err, uplink.ErrInvalidResponse) {
			t.Errorf("body %s: want invalid_response, got %v", body, err)
		}
	}
}

func TestCreateAgentKey_ServerErrorsAreTyped(t *testing.T) {
	server, _ := contractServer(t, 429, `{"error_code":"rate_limited"}`)
	if _, err := deviceClient(t, server.URL).CreateAgentKey(context.Background()); !errors.Is(err, uplink.ErrUnavailable) {
		t.Fatalf("want unavailable, got %v", err)
	}
}

func TestAgentKey_ReportsTheServerKey(t *testing.T) {
	server, seen := contractServer(t, 200, `{"id":"k1","name":"n","key_prefix":"vlr_fixt","created_at":"2026-09-30T10:00:00Z","last_used_at":null}`)
	info, err := deviceClient(t, server.URL).AgentKey(context.Background())
	if err != nil || info.KeyPrefix != "vlr_fixt" || info.ID != "k1" {
		t.Fatalf("info %+v %v", info, err)
	}
	if request := (*seen)[0]; request.method != "GET" || request.path != "/api/companion/agent-key" {
		t.Fatalf("request %+v", request)
	}
}

func TestAgentKey_MissingIsAgentKeyMissing(t *testing.T) {
	server, _ := contractServer(t, 404, `{"error_code":"agent_key_missing"}`)
	if _, err := deviceClient(t, server.URL).AgentKey(context.Background()); !errors.Is(err, uplink.ErrAgentKeyMissing) {
		t.Fatalf("want agent_key_missing, got %v", err)
	}
}

// A server without the route (older backend, proxy) answers a bare 404,
// which must never be read as "the user deleted the key".
func TestAgentKey_Bare404IsNotAgentKeyMissing(t *testing.T) {
	server, _ := contractServer(t, 404, `{"detail":"Not Found"}`)
	_, err := deviceClient(t, server.URL).AgentKey(context.Background())
	if errors.Is(err, uplink.ErrAgentKeyMissing) || !errors.Is(err, uplink.ErrNotFound) {
		t.Fatalf("want a plain not_found, got %v", err)
	}
}

func TestDeleteAgentKey_IsIdempotent(t *testing.T) {
	for _, status := range []int{204, 404} {
		server, seen := contractServer(t, status, ``)
		if err := deviceClient(t, server.URL).DeleteAgentKey(context.Background()); err != nil {
			t.Errorf("status %d: %v", status, err)
		}
		if request := (*seen)[0]; request.method != "DELETE" || request.path != "/api/companion/agent-key" {
			t.Fatalf("request %+v", request)
		}
	}
	server, _ := contractServer(t, 500, ``)
	if err := deviceClient(t, server.URL).DeleteAgentKey(context.Background()); !errors.Is(err, uplink.ErrUnavailable) {
		t.Fatalf("a server failure must surface: %v", err)
	}
}

func TestCreateAgentKey_ConcurrentMintIsRotationConflict(t *testing.T) {
	server, _ := contractServer(t, 409, `{"error_code":"agent_key_rotation_conflict"}`)
	_, err := deviceClient(t, server.URL).CreateAgentKey(context.Background())
	if !errors.Is(err, uplink.ErrAgentKeyRotationConflict) || !errors.Is(err, uplink.ErrConflict) {
		t.Fatalf("want agent_key_rotation_conflict, got %v", err)
	}
	bare, _ := contractServer(t, 409, `{}`)
	if _, err := deviceClient(t, bare.URL).CreateAgentKey(context.Background()); errors.Is(err, uplink.ErrAgentKeyRotationConflict) {
		t.Fatal("a bare 409 was read as a rotation conflict")
	}
}
