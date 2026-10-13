// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestScrub_HomeIsCaseInsensitiveWhereTheFilesystemIs(t *testing.T) {
	homes := []string{"/home/jane"}
	text := []byte(`/home/JANE/code and /HOME/jane/x and /home/Janet`)
	if got := string(Scrub(text, homes, true)); got != `~/code and ~/x and /home/Janet` {
		t.Fatalf("darwin/windows scrub: %s", got)
	}
	if got := string(Scrub(text, homes, false)); got != string(text) {
		t.Fatalf("linux matches home exactly: %s", got)
	}
}

func TestScrub_JSONEscapedHome(t *testing.T) {
	home := "/home/jane"
	got := string(Scrub([]byte(`{"a":"\/home\/jane\/code","b":"\/home\/janet"}`), homeSpellings(home), false))
	if got != `{"a":"~\/code","b":"\/home\/janet"}` {
		t.Fatalf("escaped scrub: %s", got)
	}
}

func TestHomeSpellings_IncludeTheResolvedHome(t *testing.T) {
	real := t.TempDir()
	resolved, _ := filepath.EvalSymlinks(real)
	link := filepath.Join(t.TempDir(), "home")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	spellings := homeSpellings(link)
	for _, want := range []string{link, resolved, strings.ReplaceAll(resolved, "/", `\/`)} {
		if !slices.Contains(spellings, want) {
			t.Fatalf("spellings %v lack %s", spellings, want)
		}
	}
	got := string(Scrub([]byte(resolved+"/x "+link+"/y"), spellings, false))
	if got != "~/x ~/y" {
		t.Fatalf("both spellings must go: %s", got)
	}
}

func TestScrub_RedactsTokensAndURLUserinfo(t *testing.T) {
	got := string(Scrub([]byte(`bpc_abcdefghijklmnop vlr_abcdefgh https://user:pass@example.com/a ssh://git@github.com/acme/app`), nil, false))
	for _, leaked := range []string{"bpc_abc", "vlr_abc", "user:pass", "git@"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("%q survived: %s", leaked, got)
		}
	}
	if !strings.Contains(got, "https://example.com/a") || !strings.Contains(got, "ssh://github.com/acme/app") {
		t.Fatalf("hosts must stay: %s", got)
	}
}

func TestDiagnostics_ScrubsAnUpperCaseHomeWhenCaseInsensitive(t *testing.T) {
	server := newTestServer(t, func(config *Config) { config.Home, config.HomeCaseInsensitive = "/home/jane", true })
	server.backend.diagnostics = []DiagnosticFile{{Name: "logs/companion.log", Data: []byte("opened /home/JANE/secret-project")}}
	reply := server.do(t, "GET", "/v1/diagnostics", "")
	archive, err := zip.NewReader(bytes.NewReader(reply.body), int64(len(reply.body)))
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := archive.File[0].Open()
	data, _ := io.ReadAll(contents)
	if strings.Contains(strings.ToLower(string(data)), "/home/jane") {
		t.Fatalf("upper-case home survived: %s", data)
	}
}

type recordingLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *recordingLog) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *recordingLog) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

func TestRecover_APanickingHandlerAnswersInternalAndKeepsServing(t *testing.T) {
	log := &recordingLog{}
	server := newTestServer(t, func(config *Config) { config.Logf = log.logf })
	server.backend.panicVersion = true
	reply := server.do(t, "GET", "/v1/version", "")
	if reply.status != http.StatusInternalServerError || reply.errorCode(t) != CodeInternal {
		t.Fatalf("panic: %d %s", reply.status, reply.body)
	}
	if strings.Contains(string(reply.body), "exploded") {
		t.Fatalf("the panic value must not reach the client: %s", reply.body)
	}
	if !strings.Contains(log.text(), "version exploded") {
		t.Fatalf("the panic must be logged: %q", log.text())
	}
	server.backend.panicVersion = false
	if reply := server.do(t, "GET", "/v1/version", ""); reply.status != 200 {
		t.Fatalf("the server must keep serving: %d", reply.status)
	}
}

func TestPairStart_LoopbackHTTPNeedsTheInsecureLoopbackSetting(t *testing.T) {
	for _, allow := range []bool{false, true} {
		pairer := &fakePairer{states: map[string]PairState{}}
		server := newTestServer(t, func(config *Config) { config.Pairer, config.AllowInsecureLoopback = pairer, allow })
		reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"http://127.0.0.1:8000"}`)
		if allow && reply.status != 200 || !allow && (reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest) {
			t.Fatalf("allow=%v: %d %s", allow, reply.status, reply.body)
		}
		for _, endpoint := range []string{"http://localhost:8000", "http://example.com", "http://10.0.0.1"} {
			reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"`+endpoint+`"}`)
			if reply.status != http.StatusBadRequest {
				t.Fatalf("allow=%v %s: %d %s", allow, endpoint, reply.status, reply.body)
			}
		}
	}
}
