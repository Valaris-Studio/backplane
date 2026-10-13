// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

func deviceClient(t *testing.T, url string) *uplink.Client {
	t.Helper()
	client, err := uplink.New(uplink.Options{Endpoint: url, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	device, err := client.WithDeviceToken(uplinktest.DeviceToken)
	if err != nil {
		t.Fatal(err)
	}
	return device
}

func TestEndpointRequiresTLSExceptExplicitLoopbackIP(t *testing.T) {
	for _, c := range []struct {
		endpoint string
		loopback bool
	}{
		{"http://example.com", true},
		{"http://localhost:8000", true},
		{"http://127.0.0.1:8000", false},
		{"https://user:pw@example.com", false},
		{"https://example.com/?q=1", false},
		{"ftp://example.com", true},
	} {
		if _, err := uplink.New(uplink.Options{Endpoint: c.endpoint, AllowLoopbackHTTP: c.loopback}); !errors.Is(err, uplink.ErrInsecureEndpoint) {
			t.Errorf("accepted %s (loopback=%v): %v", c.endpoint, c.loopback, err)
		}
	}
	for _, endpoint := range []string{"https://backplane.example.com", "https://backplane.example.com/"} {
		client, err := uplink.New(uplink.Options{Endpoint: endpoint})
		if err != nil || client.Endpoint() != "https://backplane.example.com" {
			t.Errorf("rejected %s: %v", endpoint, err)
		}
	}
	if _, err := uplink.New(uplink.Options{Endpoint: "http://127.0.0.1:8000", AllowLoopbackHTTP: true}); err != nil {
		t.Fatal(err)
	}
}

func TestRegisterInstallationExchangesKeyForDeviceToken(t *testing.T) {
	server := uplinktest.New(t)
	client, _ := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	request := uplink.InstallationRequest{InstallationID: "11111111-1111-4111-8111-111111111111", Name: "host", Platform: "darwin/arm64"}
	installation, err := client.RegisterInstallation(context.Background(), uplinktest.APIKey, request)
	if err != nil || installation.DeviceToken != uplinktest.DeviceToken {
		t.Fatalf("registration failed: %+v %v", installation, err)
	}
	if _, err := client.RegisterInstallation(context.Background(), "vlr_wrong_key_value", request); !errors.Is(err, uplink.ErrUnauthorized) {
		t.Fatalf("wrong key: %v", err)
	}
	if _, err := client.RegisterInstallation(context.Background(), "not-a-key", request); !errors.Is(err, uplink.ErrInvalidToken) {
		t.Fatalf("malformed key sent: %v", err)
	}
}

func TestTypedErrorsForStatusCodes(t *testing.T) {
	statuses := map[int]error{401: uplink.ErrUnauthorized, 403: uplink.ErrForbidden, 404: uplink.ErrNotFound, 409: uplink.ErrConflict, 413: uplink.ErrTooLarge, 422: uplink.ErrUnprocessable, 429: uplink.ErrUnavailable, 503: uplink.ErrUnavailable, 400: uplink.ErrUnexpectedStatus}
	for status, want := range statuses {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
		_, err := deviceClient(t, server.URL).Policy(context.Background())
		server.Close()
		if !errors.Is(err, want) {
			t.Errorf("%d: got %v want %v", status, err, want)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.Close()
	if _, err := deviceClient(t, server.URL).Policy(context.Background()); !errors.Is(err, uplink.ErrUnavailable) {
		t.Fatalf("transport failure: %v", err)
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	followed := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { followed = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/api/companion/policy", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	if _, err := deviceClient(t, redirect.URL).Policy(context.Background()); err == nil || followed {
		t.Fatalf("redirect followed: %v", err)
	}
}

func TestPolicyDecodingIsTolerantButChecksRequiredMembers(t *testing.T) {
	body := `{"installation":{"id":"i","paused":false,"auto_match_repos":true,"enabled_agents":["claude_code"],"exclude_globs":[],"new":{"x":1}},"mappings":[{"id":"m","workspace_id":"w","board_id":null,"root_path":null,"repo_url_normalized":"github.com/a/b","origin":"auto","enabled":true,"content_level":"standard","later":1}],"repo_catalog":[],"version":2}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }))
	defer server.Close()
	result, err := deviceClient(t, server.URL).Policy(context.Background())
	if err != nil || result.Mappings[0].RepoURLNormalized != "github.com/a/b" || result.Mappings[0].RootPath != "" {
		t.Fatalf("tolerant decode failed: %+v %v", result, err)
	}
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"mappings":[]}`)) }))
	defer missing.Close()
	if _, err := deviceClient(t, missing.URL).Policy(context.Background()); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("missing installation accepted: %v", err)
	}
}

func TestResolveMapping(t *testing.T) {
	server := uplinktest.New(t)
	server.Resolvable["github.com/acme/app"] = policy.Mapping{ID: "m1", WorkspaceID: "w", Enabled: true}
	client := deviceClient(t, server.URL)
	mapping, err := client.ResolveMapping(context.Background(), "github.com/acme/app")
	if err != nil || mapping.ID != "m1" || mapping.RootPath != "" || mapping.RepoURLNormalized != "github.com/acme/app" {
		t.Fatalf("resolution failed: %+v %v", mapping, err)
	}
	// The device keeps its local root; only the repository is sent.
	if request := server.Resolutions[0]; len(request) != 1 || request["repo_url"] != "github.com/acme/app" {
		t.Fatalf("mapping request %v", request)
	}
	if _, err := client.ResolveMapping(context.Background(), "github.com/acme/other"); !errors.Is(err, uplink.ErrNotFound) {
		t.Fatalf("unmatched repo: %v", err)
	}
}

func TestIngestAckParsing(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	cases := map[string]error{
		`{"acknowledged":["` + id + `"],"rejected":[],"extra":1}`:                   nil,
		`{"acknowledged":[],"rejected":[{"capture_id":"` + id + `","reason":"x"}]}`: nil,
		`{"acknowledged":["` + id + `"]}`:                                           nil,
		`{"rejected":[]}`:                                                           uplink.ErrInvalidResponse,
		`{"acknowledged":["not-an-id"]}`:                                            uplink.ErrInvalidResponse,
		`{"acknowledged":[],"rejected":[{"capture_id":"bad"}]}`:                     uplink.ErrInvalidResponse,
		`not json`:                      uplink.ErrInvalidResponse,
		`{"acknowledged":"` + id + `"}`: uplink.ErrInvalidResponse,
	}
	for body, want := range cases {
		server := uplinktest.New(t)
		server.Respond = func([]string) (int, any) { return 200, json.RawMessage(body) }
		_, err := deviceClient(t, server.URL).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{"capture_id":"` + id + `"}`)})
		if !errors.Is(err, want) && !(want == nil && err == nil) {
			t.Errorf("%s: got %v want %v", body, err, want)
		}
	}
}

func TestDeviceTokenFormatIsChecked(t *testing.T) {
	client, _ := uplink.New(uplink.Options{Endpoint: "https://example.com"})
	for _, token := range []string{"", "vlr_human_key_value", "bpc_short", "bpc_has space_0123456789"} {
		if _, err := client.WithDeviceToken(token); !errors.Is(err, uplink.ErrInvalidToken) {
			t.Errorf("accepted token %q", token)
		}
	}
}

func TestRevokeInstallation(t *testing.T) {
	server := uplinktest.New(t)
	if err := deviceClient(t, server.URL).RevokeInstallation(context.Background()); err != nil {
		t.Fatal(err)
	}
	server.Lock()
	revocations := server.Revocations
	server.Unlock()
	if revocations != 1 {
		t.Fatalf("revocations = %d", revocations)
	}
	server.Lock()
	server.Status["/api/companion/installation"] = 401
	server.Unlock()
	if err := deviceClient(t, server.URL).RevokeInstallation(context.Background()); !errors.Is(err, uplink.ErrUnauthorized) {
		t.Fatalf("revoked device: %v", err)
	}
}

func TestRepeatRegistrationYieldsNoTokenAndRotationIssuesOne(t *testing.T) {
	server := uplinktest.New(t)
	client, _ := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	ctx := context.Background()
	request := uplink.InstallationRequest{InstallationID: "11111111-1111-4111-8111-111111111111", Name: "host", Platform: "darwin/arm64"}
	if first, err := client.RegisterInstallation(ctx, uplinktest.APIKey, request); err != nil || first.DeviceToken == "" {
		t.Fatalf("first registration: %+v %v", first, err)
	}
	again, err := client.RegisterInstallation(ctx, uplinktest.APIKey, request)
	if err != nil || again.DeviceToken != "" || again.InstallationID != request.InstallationID {
		t.Fatalf("repeat registration must succeed without a token: %+v %v", again, err)
	}
	rotated, err := client.RotateInstallation(ctx, uplinktest.APIKey, request.InstallationID)
	if err != nil || rotated.DeviceToken != uplinktest.DeviceToken {
		t.Fatalf("rotation: %+v %v", rotated, err)
	}
	server.Lock()
	server.Revoked[request.InstallationID] = true
	server.Unlock()
	if _, err := client.RotateInstallation(ctx, uplinktest.APIKey, request.InstallationID); !errors.Is(err, uplink.ErrConflict) {
		t.Fatalf("revoked installation: %v", err)
	}
}

func TestNullEnabledAgentsMeansAllAndEmptyMeansNone(t *testing.T) {
	for body, want := range map[string]bool{
		`{"installation":{"id":"i","enabled_agents":null}}`:  true,
		`{"installation":{"id":"i"}}`:                        true,
		`{"installation":{"id":"i","enabled_agents":[]}}`:    false,
		`{"installation":{"id":"i","enabled_agents":["x"]}}`: false,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }))
		result, err := deviceClient(t, server.URL).Policy(context.Background())
		server.Close()
		if err != nil || result.AgentEnabled("codex_cli") != want {
			t.Errorf("%s: enabled=%v %v", body, result.AgentEnabled("codex_cli"), err)
		}
	}
}

func TestIngestAckCarriesDroppedRecords(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	server := uplinktest.New(t)
	server.Respond = func([]string) (int, any) {
		return 200, json.RawMessage(`{"acknowledged":["` + id + `"],"rejected":[],"dropped":[{"capture_id":"` + id + `","reason":"session_deleted","later":1}]}`)
	}
	ack, err := deviceClient(t, server.URL).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{"capture_id":"` + id + `"}`)})
	if err != nil || len(ack.Dropped) != 1 || ack.Dropped[0] != (uplink.Drop{CaptureID: id, Reason: "session_deleted"}) {
		t.Fatalf("dropped: %+v %v", ack, err)
	}
	server.Respond = func([]string) (int, any) {
		return 200, json.RawMessage(`{"acknowledged":["` + id + `"],"rejected":[],"dropped":[{"capture_id":"bad","reason":"session_deleted"}]}`)
	}
	if _, err := deviceClient(t, server.URL).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{"capture_id":"` + id + `"}`)}); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("malformed dropped id accepted: %v", err)
	}
}

func TestIngestAckCarriesDeletedHistory(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	server := uplinktest.New(t)
	server.Respond = func([]string) (int, any) {
		return 200, json.RawMessage(`{"acknowledged":["` + id + `"],"rejected":[],"history_deleted":[{"mapping_id":"m1","harness":"claude_code","native_session_id":"gone","deleted_through":"2026-09-24T12:02:00.5Z","reason":"retention"}]}`)
	}
	ack, err := deviceClient(t, server.URL).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{"capture_id":"` + id + `"}`)})
	want := uplink.HistoryDeleted{MappingID: "m1", Harness: "claude_code", NativeSessionID: "gone", DeletedThrough: time.Date(2026, 9, 24, 12, 2, 0, 500_000_000, time.UTC), Reason: "retention"}
	if err != nil || len(ack.HistoryDeleted) != 1 || ack.HistoryDeleted[0].MappingID != want.MappingID || ack.HistoryDeleted[0].Reason != want.Reason || ack.HistoryDeleted[0].Harness != want.Harness || ack.HistoryDeleted[0].NativeSessionID != want.NativeSessionID || !ack.HistoryDeleted[0].DeletedThrough.Equal(want.DeletedThrough) {
		t.Fatalf("history deleted: %+v %v", ack, err)
	}
	server.Respond = func([]string) (int, any) {
		return 200, json.RawMessage(`{"acknowledged":["` + id + `"],"rejected":[],"history_deleted":[{"harness":"claude_code","native_session_id":"gone"}]}`)
	}
	if _, err := deviceClient(t, server.URL).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{"capture_id":"` + id + `"}`)}); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("deleted history without a cutoff accepted: %v", err)
	}
}

func TestReportStatusPostsTheHeartbeat(t *testing.T) {
	server := uplinktest.New(t)
	client := deviceClient(t, server.URL)
	oldest := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	report := uplink.StatusReport{
		CompanionVersion: "1.2.3", BeaconCommit: "b17031414618cf86f7aad2b485935e548e8a8e63",
		Agents: []uplink.AgentStatus{{Harness: "claude_code", State: "capturing"}, {Harness: "pi_cli", State: "error", Detail: "extension:stale"}},
		Queue:  uplink.QueueStatus{Pending: 2, DroppedTotal: 1, OldestPendingAt: &oldest},
	}
	recorded, err := client.ReportStatus(context.Background(), report)
	if err != nil || !recorded {
		t.Fatalf("heartbeat: %v %v", recorded, err)
	}
	server.Lock()
	sent := server.Heartbeats[0]
	server.Unlock()
	encoded, _ := json.Marshal(sent)
	want := `{"agents":[{"harness":"claude_code","state":"capturing"},{"detail":"extension:stale","harness":"pi_cli","state":"error"}],"beacon_commit":"b17031414618cf86f7aad2b485935e548e8a8e63","companion_version":"1.2.3","queue":{"dropped_total":1,"oldest_pending_at":"2026-09-24T12:00:00Z","pending":2}}`
	if string(encoded) != want {
		t.Fatalf("heartbeat body:\n%s\nwant\n%s", encoded, want)
	}
	server.Status["/api/companion/status"] = 401
	if _, err := client.ReportStatus(context.Background(), report); !errors.Is(err, uplink.ErrUnauthorized) {
		t.Fatalf("revoked device: %v", err)
	}
}

func TestOnlyTheBackendsDeviceTokenCodeMeansRevoked(t *testing.T) {
	policyAfter401 := func(body string) error {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(body))
		}))
		defer server.Close()
		_, err := deviceClient(t, server.URL).Policy(context.Background())
		return err
	}
	err := policyAfter401(`{"detail":"Invalid or revoked device token","error_code":"invalid_device_token"}`)
	if !errors.Is(err, uplink.ErrDeviceRevoked) || errors.Is(err, uplink.ErrUnauthorized) {
		t.Fatalf("the backend's revoked-token 401: %v", err)
	}
	// A proxy or identity-aware front end can answer 401 on its own.
	for _, body := range []string{``, `<html>proxy says no</html>`, `{"error_code":"invalid_credentials"}`} {
		if err := policyAfter401(body); !errors.Is(err, uplink.ErrUnauthorized) || errors.Is(err, uplink.ErrDeviceRevoked) {
			t.Fatalf("a 401 without the device code (%q) is not a revocation: %v", body, err)
		}
	}
}
