// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// recordedRequest is what the contract-C fake saw.
type recordedRequest struct {
	method, path, query, auth string
	body                      map[string]any
}

// contractServer answers every request with status and body and records it.
func contractServer(t *testing.T, status int, body string) (*httptest.Server, *[]recordedRequest) {
	t.Helper()
	var seen []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		request := recordedRequest{method: r.Method, path: r.URL.EscapedPath(), query: r.URL.RawQuery, auth: r.Header.Get("Authorization")}
		if len(raw) > 0 {
			json.Unmarshal(raw, &request.body)
		}
		seen = append(seen, request)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	return server, &seen
}

func TestBoards_ReturnsTheServerDocument(t *testing.T) {
	document := `{"workspaces":[{"id":"w1","slug":"acme","name":"Acme","boards":[{"id":"b1","name":"App","repos":["github.com/acme/app"]}]}]}`
	server, seen := contractServer(t, 200, document)
	raw, err := deviceClient(t, server.URL).Boards(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if request := (*seen)[0]; request.method != "GET" || request.path != "/api/companion/boards" || request.auth != "Bearer "+uplinktest.DeviceToken {
		t.Fatalf("request %+v", request)
	}
	var decoded map[string]any
	if json.Unmarshal(raw, &decoded) != nil || decoded["workspaces"] == nil {
		t.Fatalf("boards body %s", raw)
	}
}

func TestBoards_NonObjectBodyIsInvalidResponse(t *testing.T) {
	server, _ := contractServer(t, 200, `[1,2]`)
	if _, err := deviceClient(t, server.URL).Boards(context.Background()); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("a non-object body must be refused: %v", err)
	}
}

func TestCreateMapping_SendsTheBoardChoiceBody(t *testing.T) {
	server, seen := contractServer(t, 201, `{"id":"m9","workspace_id":"w1","board_id":"b1","content_level":"metadata","enabled":true}`)
	enabled := false
	raw, err := deviceClient(t, server.URL).CreateMapping(context.Background(), uplink.MappingRequest{WorkspaceID: "w1", BoardID: "b1", RootPath: "/src/app", ContentLevel: "metadata", Enabled: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	request := (*seen)[0]
	if request.method != "POST" || request.path != "/api/companion/mappings" {
		t.Fatalf("request %+v", request)
	}
	want := map[string]any{"workspace_id": "w1", "board_id": "b1", "root_path": "/src/app", "content_level": "metadata", "enabled": false}
	if len(request.body) != len(want) {
		t.Fatalf("body %v, want exactly %v", request.body, want)
	}
	for key, value := range want {
		if request.body[key] != value {
			t.Fatalf("body %v, want %v", request.body, want)
		}
	}
	if !strings.Contains(string(raw), `"m9"`) {
		t.Fatalf("mapping %s", raw)
	}
}

func TestCreateMapping_WithoutIDIsInvalidResponse(t *testing.T) {
	server, _ := contractServer(t, 201, `{"workspace_id":"w1"}`)
	_, err := deviceClient(t, server.URL).CreateMapping(context.Background(), uplink.MappingRequest{WorkspaceID: "w1", BoardID: "b1", RepoURL: "github.com/acme/app", ContentLevel: "standard"})
	if !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("a mapping without an id must be refused: %v", err)
	}
}

func TestResolveMapping_StillSendsOnlyTheRepoURL(t *testing.T) {
	server, seen := contractServer(t, 201, `{"id":"m1","workspace_id":"w1","enabled":true}`)
	if _, err := deviceClient(t, server.URL).ResolveMapping(context.Background(), "github.com/acme/app"); err != nil {
		t.Fatal(err)
	}
	if body := (*seen)[0].body; len(body) != 1 || body["repo_url"] != "github.com/acme/app" {
		t.Fatalf("the auto-match body must stay {repo_url}: %v", body)
	}
}

func TestUpdateMapping_PatchesOnlyGivenFields(t *testing.T) {
	server, seen := contractServer(t, 200, `{"id":"m/1","workspace_id":"w1","enabled":false}`)
	enabled := false
	if _, err := deviceClient(t, server.URL).UpdateMapping(context.Background(), "m/1", uplink.MappingUpdate{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	request := (*seen)[0]
	if request.method != "PATCH" || request.path != "/api/companion/mappings/m%2F1" || len(request.body) != 1 || request.body["enabled"] != false {
		t.Fatalf("request %+v", request)
	}
}

func TestDeleteMapping_SendsDelete(t *testing.T) {
	server, seen := contractServer(t, 204, ``)
	if err := deviceClient(t, server.URL).DeleteMapping(context.Background(), "m1"); err != nil {
		t.Fatal(err)
	}
	if request := (*seen)[0]; request.method != "DELETE" || request.path != "/api/companion/mappings/m1" {
		t.Fatalf("request %+v", request)
	}
}

func TestDeleteMapping_UnknownIsNotFound(t *testing.T) {
	server, _ := contractServer(t, 404, `{"detail":"Not found","error_code":"not_found"}`)
	err := deviceClient(t, server.URL).DeleteMapping(context.Background(), "m1")
	var status *uplink.StatusError
	if !errors.Is(err, uplink.ErrNotFound) || !errors.As(err, &status) || status.Status != 404 || status.Code != "not_found" {
		t.Fatalf("want a 404 StatusError carrying the code, got %v", err)
	}
}

func TestUpdateSettings_SendsOnlyGivenFields(t *testing.T) {
	server, seen := contractServer(t, 200, `{"paused":false,"auto_match_repos":false,"enabled_agents":[],"exclude_globs":[],"retention_days":null}`)
	autoMatch, agents := false, []string{}
	if _, err := deviceClient(t, server.URL).UpdateSettings(context.Background(), uplink.SettingsUpdate{AutoMatchRepos: &autoMatch, EnabledAgents: &agents}); err != nil {
		t.Fatal(err)
	}
	request := (*seen)[0]
	if request.method != "PATCH" || request.path != "/api/companion/settings" || len(request.body) != 2 || request.body["auto_match_repos"] != false {
		t.Fatalf("request %+v", request)
	}
	if list, ok := request.body["enabled_agents"].([]any); !ok || len(list) != 0 {
		t.Fatalf("an empty agent list must be sent as [] (none), not omitted: %v", request.body)
	}
}

func TestSessions_ForwardsTheQuery(t *testing.T) {
	server, seen := contractServer(t, 200, `{"items":[],"next_cursor":null}`)
	if _, err := deviceClient(t, server.URL).Sessions(context.Background(), uplink.SessionQuery{Status: "active", Limit: 25, Cursor: "c 1"}); err != nil {
		t.Fatal(err)
	}
	request := (*seen)[0]
	if request.path != "/api/companion/sessions" || request.query != "cursor=c+1&limit=25&status=active" {
		t.Fatalf("request %+v", request)
	}
}

func TestSessionAndUsage_EscapeTheID(t *testing.T) {
	server, seen := contractServer(t, 200, `{"id":"s1"}`)
	device := deviceClient(t, server.URL)
	if _, err := device.Session(context.Background(), "../policy"); err != nil {
		t.Fatal(err)
	}
	if _, err := device.SessionUsage(context.Background(), "s1"); err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].path != "/api/companion/sessions/..%2Fpolicy" || (*seen)[1].path != "/api/companion/sessions/s1/usage" {
		t.Fatalf("paths %+v", *seen)
	}
}

func TestRenameInstallation_PatchesTheName(t *testing.T) {
	server, seen := contractServer(t, 200, `{"installation_id":"i","name":"work laptop"}`)
	if err := deviceClient(t, server.URL).RenameInstallation(context.Background(), "work laptop"); err != nil {
		t.Fatal(err)
	}
	request := (*seen)[0]
	if request.method != "PATCH" || request.path != "/api/companion/installation" || request.body["name"] != "work laptop" {
		t.Fatalf("request %+v", request)
	}
}

func TestDeviceMethods_RevokedTokenIsErrDeviceRevoked(t *testing.T) {
	server, _ := contractServer(t, 401, `{"detail":"revoked","error_code":"invalid_device_token"}`)
	_, err := deviceClient(t, server.URL).Boards(context.Background())
	if !errors.Is(err, uplink.ErrDeviceRevoked) {
		t.Fatalf("want ErrDeviceRevoked, got %v", err)
	}
}

func TestStatusError_KeepsTheLegacyMessage(t *testing.T) {
	server, _ := contractServer(t, 502, `{"error_code":"bad_gateway"}`)
	_, err := deviceClient(t, server.URL).Boards(context.Background())
	var status *uplink.StatusError
	if !errors.Is(err, uplink.ErrUnavailable) || !errors.As(err, &status) || status.Code != "bad_gateway" {
		t.Fatalf("want an unavailable StatusError, got %v", err)
	}
	if err.Error() != "unavailable: GET /api/companion/boards returned 502" {
		t.Fatalf("message changed: %q", err.Error())
	}
}

func TestMe_DecodesTheOwnerAndInstallation(t *testing.T) {
	server, seen := contractServer(t, 200, `{"user":{"email":"jane@example.com","display_name":"Jane"},"installation":{"id":"i1","name":"laptop"},"web_origin":"https://app.example","future":1}`)
	me, err := deviceClient(t, server.URL).Me(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].method != "GET" || (*seen)[0].path != "/api/companion/me" {
		t.Fatalf("request %+v", (*seen)[0])
	}
	if me.User.Email != "jane@example.com" || me.User.DisplayName != "Jane" || me.Installation.ID != "i1" || me.Installation.Name != "laptop" || me.WebOrigin == nil || *me.WebOrigin != "https://app.example" {
		t.Fatalf("me %+v", me)
	}
}

func TestMe_WithoutAUserIsInvalidResponse(t *testing.T) {
	server, _ := contractServer(t, 200, `{"installation":{"id":"i1"}}`)
	if _, err := deviceClient(t, server.URL).Me(context.Background()); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("want ErrInvalidResponse, got %v", err)
	}
}
