// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStatus_ReturnsTheBackendStatus(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/status", "")
	if reply.status != 200 || reply.json(t)["paused"] != false || !strings.HasPrefix(reply.header.Get("Content-Type"), "application/json") {
		t.Fatalf("status: %d %s", reply.status, reply.body)
	}
}

func TestStatus_HostHeaderIsIgnored(t *testing.T) {
	server := newTestServer(t, nil)
	request, _ := http.NewRequest("GET", server.http.URL+"/v1/status", nil)
	request.Host = "evil.example"
	reply, err := server.http.Client().Do(request)
	if err != nil || reply.StatusCode != 200 {
		t.Fatalf("status with a foreign Host: %v %v", reply, err)
	}
	reply.Body.Close()
}

func TestPause_SetsPausedInvalidatesProbesAndAnswersTheState(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/pause", "")
	if reply.status != 200 || string(bytes.TrimSpace(reply.body)) != `{"paused":true}` {
		t.Fatalf("pause: %d %s", reply.status, reply.body)
	}
	if !server.backend.paused || server.backend.invalidations.Load() == 0 {
		t.Fatal("pause did not reach the backend or left the probe cache")
	}
	reply = server.do(t, "POST", "/v1/resume", "")
	if reply.status != 200 || string(bytes.TrimSpace(reply.body)) != `{"paused":false}` || server.backend.paused {
		t.Fatalf("resume: %d %s", reply.status, reply.body)
	}
}

func TestPause_WrongMethodIsAnEnvelope(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/pause", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("GET /v1/pause: %d %s", reply.status, reply.body)
	}
}

func TestUnknownPath_IsANotFoundEnvelope(t *testing.T) {
	server := newTestServer(t, nil)
	for _, path := range []string{"/v1/nope", "/", "/v2/status"} {
		reply := server.do(t, "GET", path, "")
		if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
			t.Fatalf("%s: %d %s", path, reply.status, reply.body)
		}
	}
}

func TestProjects_ReturnsTheBackendProjects(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/projects", "")
	if reply.status != 200 || reply.json(t)["ignored"] == nil {
		t.Fatalf("projects: %d %s", reply.status, reply.body)
	}
}

func TestIgnoreProject_AnswersTheIgnoredPath(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/projects/ignore", `{"path":"/src/app"}`)
	if reply.status != 200 || reply.json(t)["ignored"] != "/src/app" {
		t.Fatalf("ignore: %d %s", reply.status, reply.body)
	}
}

func TestIgnoreProject_RefusesARelativeOrMissingPath(t *testing.T) {
	server := newTestServer(t, nil)
	for _, body := range []string{`{"path":"src/app"}`, `{}`, `{"path":""}`, `not json`, `{"path":"/a","extra":1}`} {
		reply := server.do(t, "POST", "/v1/projects/ignore", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", body, reply.status, reply.body)
		}
	}
	if len(server.backend.ignored) != 0 {
		t.Fatal("a refused request reached the backend")
	}
}

func TestUnignoreProject_IsIdempotent(t *testing.T) {
	server := newTestServer(t, nil)
	server.do(t, "POST", "/v1/projects/ignore", `{"path":"/src/app"}`)
	for range 2 {
		reply := server.do(t, "DELETE", "/v1/projects/ignore", `{"path":"/src/app"}`)
		if reply.status != 200 || reply.json(t)["unignored"] != "/src/app" {
			t.Fatalf("unignore: %d %s", reply.status, reply.body)
		}
	}
	if len(server.backend.ignored) != 0 {
		t.Fatal("path still ignored")
	}
}

func TestAgents_ReturnsTheBackendList(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/agents", "")
	if reply.status != 200 || !strings.Contains(string(reply.body), `"claude_code"`) {
		t.Fatalf("agents: %d %s", reply.status, reply.body)
	}
}

func TestInstallAgent_AnswersThatAgentsStatus(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/agents/claude_code/install", "")
	if reply.status != 200 || reply.json(t)["id"] != "claude_code" {
		t.Fatalf("install: %d %s", reply.status, reply.body)
	}
	reply = server.do(t, "POST", "/v1/agents/claude_code/uninstall", "")
	if reply.status != 200 || !strings.Contains(string(reply.body), "not_installed") {
		t.Fatalf("uninstall: %d %s", reply.status, reply.body)
	}
}

func TestInstallAgent_UnknownAgentUsesTheBackendCode(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/agents/cursor/install", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != "unknown_agent" {
		t.Fatalf("unknown agent: %d %s", reply.status, reply.body)
	}
}

func TestRename_AnswersTheName(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.connected = true
	reply := server.do(t, "POST", "/v1/rename", `{"name":"work laptop"}`)
	if reply.status != 200 || reply.json(t)["name"] != "work laptop" || server.backend.renamed != "work laptop" {
		t.Fatalf("rename: %d %s", reply.status, reply.body)
	}
}

func TestRename_RefusesAnEmptyLongOrControlName(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.connected = true
	for _, body := range []string{`{"name":""}`, `{"name":"   "}`, `{"name":"` + strings.Repeat("a", 81) + `"}`, `{"name":"a\u0007b"}`, `{}`} {
		reply := server.do(t, "POST", "/v1/rename", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", body, reply.status, reply.body)
		}
	}
	if reply := server.do(t, "POST", "/v1/rename", `{"name":"`+strings.Repeat("é", 80)+`"}`); reply.status != 200 {
		t.Fatalf("80 characters is allowed: %d %s", reply.status, reply.body)
	}
}

func TestRename_NotConnectedUsesTheBackendCode(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/rename", `{"name":"laptop"}`)
	if reply.status != http.StatusConflict || reply.errorCode(t) != "not_connected" {
		t.Fatalf("rename while not connected: %d %s", reply.status, reply.body)
	}
}

func TestDisconnect_AnswersTheBackendResult(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/disconnect", "")
	if reply.status != 200 || reply.json(t)["connected"] != false {
		t.Fatalf("disconnect: %d %s", reply.status, reply.body)
	}
	if server.backend.invalidations.Load() == 0 {
		t.Fatal("disconnect left the probe cache")
	}
}

func TestVersion_AnswersTheBackendVersion(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/version", "")
	if reply.status != 200 || reply.json(t)["version"] != "dev" {
		t.Fatalf("version: %d %s", reply.status, reply.body)
	}
}

func TestUnexpectedBackendError_IsInternalWithoutDetail(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.deviceErr = io.ErrUnexpectedEOF
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != http.StatusInternalServerError || reply.errorCode(t) != CodeInternal {
		t.Fatalf("internal: %d %s", reply.status, reply.body)
	}
	if strings.Contains(string(reply.body), "unexpected EOF") {
		t.Fatalf("internal errors must not leak their text: %s", reply.body)
	}
}

func TestOversizedBody_IsInvalidRequest(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/rename", `{"name":"`+strings.Repeat("a", 1<<20)+`"}`)
	if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
		t.Fatalf("oversized: %d", reply.status)
	}
}

func TestDiagnostics_ZipsScrubbedBackendFiles(t *testing.T) {
	home := "/home/jane"
	server := newTestServer(t, func(config *Config) { config.Home = home })
	server.backend.diagnostics = []DiagnosticFile{
		{Name: "status.json", Data: []byte(`{"data_dir":"/home/jane/Library/Application Support/Backplane Companion"}`)},
		{Name: "logs/companion.log", Data: []byte("2026 token bpc_abcdefghijklmnopqrstuvwxyz and vlr_12345678abc at https://jane:secret@github.com/acme/app.git?x=1\nAuthorization: Bearer abc.def\n")},
	}
	reply := server.do(t, "GET", "/v1/diagnostics", "")
	if reply.status != 200 || reply.header.Get("Content-Type") != "application/zip" {
		t.Fatalf("diagnostics: %d %s", reply.status, reply.header)
	}
	archive, err := zip.NewReader(bytes.NewReader(reply.body), int64(len(reply.body)))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, file := range archive.File {
		contents, _ := file.Open()
		data, _ := io.ReadAll(contents)
		all.Write(data)
	}
	text := all.String()
	for _, forbidden := range []string{home, "bpc_abc", "vlr_1234", "jane:secret", "x=1", "abc.def"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("diagnostics leak %q:\n%s", forbidden, text)
		}
	}
	for _, kept := range []string{"~/Library/Application Support", "github.com/acme/app"} {
		if !strings.Contains(text, kept) {
			t.Fatalf("diagnostics lost %q:\n%s", kept, text)
		}
	}
}

func TestScrub_ReplacesEveryHomeSpelling(t *testing.T) {
	scrubbed := string(Scrub([]byte(`C:\home\jane\x and C:/home/jane/y and /home/janet`), []string{`C:\home\jane`, "C:/home/jane", "/home/jane"}, false))
	if scrubbed != `~\x and ~/y and /home/janet` {
		t.Fatalf("scrub: %s", scrubbed)
	}
}
