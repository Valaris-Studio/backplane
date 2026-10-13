// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build richseam

package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// The seam check: the real daemon and uplink against a disposable RC-02
// backend over HTTP, its database and body store. Run from an isolated copy:
//
//	RICH_SEAM_URL=http://127.0.0.1:PORT RICH_SEAM_API_KEY=vlr_… \
//	RICH_SEAM_WORKSPACE=<id> RICH_SEAM_SLUG=<slug> RICH_SEAM_BOARD=<id> \
//	RICH_SEAM_DATA=<dir> RICH_SEAM_PHASE=run|crash:<point>|resume \
//	go test -tags richseam -run TestRichSeam ./internal/daemon
//
// crash:<point> exits the process (code 137, no deferred cleanup) at that
// commit point; resume continues on the same data root and verifies.

type seamConfig struct {
	endpoint, apiKey, workspace, slug, board, data, phase string
}

type seamState struct {
	InstallationID string `json:"installation_id"`
	DeviceToken    string `json:"device_token"`
	MappingID      string `json:"mapping_id"`
	Repo           string `json:"repo"`
	Session        string `json:"session"`
	// Expected are the bodies written, by content key.
	Expected map[string]string `json:"expected"`
}

type noEvents struct{}

func (noEvents) Normalize(context.Context, beacon.Request) (beacon.Result, error) {
	return beacon.Result{}, beacon.ErrNoEvents
}

func TestRichSeam(t *testing.T) {
	config := seamConfig{os.Getenv("RICH_SEAM_URL"), os.Getenv("RICH_SEAM_API_KEY"), os.Getenv("RICH_SEAM_WORKSPACE"), os.Getenv("RICH_SEAM_SLUG"), os.Getenv("RICH_SEAM_BOARD"), os.Getenv("RICH_SEAM_DATA"), os.Getenv("RICH_SEAM_PHASE")}
	if config.endpoint == "" || config.data == "" {
		t.Skip("RICH_SEAM_URL and RICH_SEAM_DATA name the disposable backend and data root")
	}
	statePath := filepath.Join(config.data, "seam.json")
	var seam seamState
	if raw, err := os.ReadFile(statePath); err == nil {
		json.Unmarshal(raw, &seam)
	}
	client, err := uplink.New(uplink.Options{Endpoint: config.endpoint, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if seam.InstallationID == "" {
		seam = seamSetup(t, ctx, client, config)
		writeSeamState(t, statePath, seam)
	}
	device, err := client.WithDeviceToken(seam.DeviceToken)
	if err != nil {
		t.Fatal(err)
	}
	layout, err := store.Open(filepath.Join(config.data, "companion"))
	if err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.Installation(), state.Installation{ID: seam.InstallationID, Endpoint: config.endpoint})
	registry := agent.NewRegistry(contracttest.Agent{Name: richAgent, Root: filepath.Join(config.data, "sessions")})
	home := filepath.Dir(filepath.Dir(seam.Repo))
	d := New(Config{InstallationID: seam.InstallationID, Layout: layout, Client: device, Normalizer: noEvents{}, Registry: registry, Home: home})
	hook := shim.Shim{Layout: layout, Registry: registry, Home: home, Now: time.Now}
	if point, crashing := strings.CutPrefix(config.phase, "crash:"); crashing {
		commitFault = func(at string) error {
			if at == point {
				fmt.Fprintf(os.Stderr, "seam: exiting at %s\n", point)
				os.Exit(137)
			}
			return nil
		}
	}
	sessionFile := filepath.Join(config.data, "sessions", seam.Session+".jsonl")
	if config.phase != "resume" {
		// Policy first, so the hook decides against the rich mapping.
		mustTick(t, d, ctx)
		// The records come before the hook that names their file, as with a
		// lazily created session file (amendment 19): the header admits them.
		os.MkdirAll(filepath.Dir(sessionFile), 0o700)
		seam.Expected = writeSeamSession(t, sessionFile, seam.Session)
		writeSeamState(t, statePath, seam)
		time.Sleep(1100 * time.Millisecond)
		payload, _ := json.Marshal(map[string]string{"session_id": seam.Session, "cwd": seam.Repo, "hook_event_name": "message_end", "session_file": sessionFile})
		if err := hook.Handle(richAgent, bytes.NewReader(payload)); err != nil {
			t.Fatal(err)
		}
	}
	var ticks []time.Duration
	for range 120 {
		started := time.Now()
		mustTick(t, d, ctx)
		ticks = append(ticks, time.Since(started))
		stats, _ := d.spool.Stats()
		queued, _ := d.queue.Stats()
		if stats.PendingBodies == 0 && queued.Records == 0 && len(ticks) > 2 {
			break
		}
		time.Sleep(PollInterval)
	}
	stats, _ := d.spool.Stats()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	sort.Slice(ticks, func(i, j int) bool { return ticks[i] < ticks[j] })
	t.Logf("ticks %d, median %v, max %v; spool now %d bodies %d bytes, failed %d; heap sys %d MiB",
		len(ticks), ticks[len(ticks)/2], ticks[len(ticks)-1], stats.PendingBodies, stats.PendingBytes, stats.FailedTotal, memory.HeapSys>>20)
	seamVerify(t, config, seam)
}

func mustTick(t *testing.T, d *Daemon, ctx context.Context) {
	t.Helper()
	if err := d.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
}

func writeSeamState(t *testing.T, path string, seam seamState) {
	t.Helper()
	encoded, _ := json.Marshal(seam)
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func seamSetup(t *testing.T, ctx context.Context, client *uplink.Client, config seamConfig) seamState {
	t.Helper()
	id := fmt.Sprintf("5ea30000-0000-4000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
	installation, err := client.RegisterInstallation(ctx, config.apiKey, uplink.InstallationRequest{InstallationID: id, Name: "rc03 seam", Platform: runtime.GOOS})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	device, _ := client.WithDeviceToken(installation.DeviceToken)
	repo := filepath.Join(config.data, "home", "code", "app")
	os.MkdirAll(repo, 0o700)
	repo, _ = filepath.EvalSymlinks(repo)
	enabled := true
	mapping, err := device.CreateMapping(ctx, uplink.MappingRequest{WorkspaceID: config.workspace, BoardID: config.board, RootPath: repo, ContentLevel: "rich", Enabled: &enabled})
	if err != nil {
		t.Fatalf("mapping: %v", err)
	}
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(mapping, &created)
	if _, err := device.UpdateSettings(ctx, uplink.SettingsUpdate{EnabledAgents: &[]string{richAgent}}); err != nil {
		t.Fatalf("settings: %v", err)
	}
	return seamState{InstallationID: id, DeviceToken: installation.DeviceToken, MappingID: created.ID, Repo: repo, Session: "seam-" + id[len(id)-12:]}
}

// writeSeamSession writes the representative records: an inline prompt, a
// reply over 16 KiB, a binary attachment and a 9 MiB tool output that takes
// three 4 MiB chunks.
func writeSeamSession(t *testing.T, path, session string) map[string]string {
	t.Helper()
	image, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-cli"), "swatch.png"))
	if err != nil {
		t.Fatal(err)
	}
	reply := strings.Repeat("Zoë→日本語🙂 retry with backoff. ", 1200)
	output := strings.Repeat("ok 0123456789 abcdefghijklmnopqrstuvwxyz\n", 9<<20/42)
	at := time.Now().UTC()
	lines := []contracttest.Line{
		{Type: "session", Began: &at},
		textLine("p1", at, "Add a retry with exponential backoff."),
		replyLine("r1", at, reply),
		{ID: "a1", At: at, Items: []contracttest.Item{{Part: "image:0", Role: "user", Channel: "attachment", MediaType: "image/png", DataBase64: base64.StdEncoding.EncodeToString(image)}}},
		{ID: "o1", At: at, Items: []contracttest.Item{contracttest.TextItem("output", "tool", "tool_output", "text/plain", output)}},
	}
	var text strings.Builder
	for _, line := range lines {
		text.WriteString(line.Encode())
	}
	if err := os.WriteFile(path, []byte(text.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := func(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }
	return map[string]string{
		agent.ContentKey(richAgent, session, "p1", "text:0"):  digest([]byte("Add a retry with exponential backoff.")),
		agent.ContentKey(richAgent, session, "r1", "text:0"):  digest([]byte(reply)),
		agent.ContentKey(richAgent, session, "a1", "image:0"): digest(image),
		agent.ContentKey(richAgent, session, "o1", "output"):  digest([]byte(output)),
	}
}

// seamVerify reads the session's contents as their owner, through the
// owner-only API, and checks each body's bytes against what was written.
func seamVerify(t *testing.T, config seamConfig, seam seamState) {
	t.Helper()
	get := func(path string) []byte {
		request, _ := http.NewRequest(http.MethodGet, config.endpoint+path, nil)
		request.Header.Set("Authorization", "Bearer "+config.apiKey)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, response.StatusCode, body)
		}
		return body
	}
	var sessions struct {
		Items []struct {
			ID              string `json:"id"`
			NativeSessionID string `json:"native_session_id"`
		} `json:"items"`
	}
	json.Unmarshal(get("/api/workspaces/"+config.slug+"/sessions?limit=100"), &sessions)
	sessionID := ""
	for _, item := range sessions.Items {
		if item.NativeSessionID == seam.Session {
			sessionID = item.ID
		}
	}
	if sessionID == "" {
		t.Fatalf("session %s not found among %d", seam.Session, len(sessions.Items))
	}
	var page struct {
		Items []struct {
			ID       string `json:"id"`
			SHA256   string `json:"sha256"`
			Bytes    int64  `json:"byte_count"`
			Coverage string `json:"coverage"`
			Render   string `json:"render"`
			Channel  string `json:"channel"`
		} `json:"items"`
	}
	json.Unmarshal(get("/api/workspaces/"+config.slug+"/sessions/"+sessionID+"/contents?limit=200"), &page)
	matched := 0
	for _, item := range page.Items {
		downloaded := get("/api/workspaces/" + config.slug + "/sessions/" + sessionID + "/contents/" + url.PathEscape(item.ID) + "/download")
		sum := sha256.Sum256(downloaded)
		found := false
		for _, want := range seam.Expected {
			found = found || want == hex.EncodeToString(sum[:])
		}
		t.Logf("content %s %s %s %d bytes render %s sha256 %s; downloaded sha256 matches written: %v", item.ID, item.Channel, item.Coverage, item.Bytes, item.Render, item.SHA256, found)
		if !found || item.SHA256 != hex.EncodeToString(sum[:]) {
			t.Errorf("content %s: downloaded bytes are not a body written", item.ID)
		}
		matched++
	}
	if matched != len(seam.Expected) || len(page.Items) != len(seam.Expected) {
		t.Fatalf("server holds %d contents, want exactly %d", len(page.Items), len(seam.Expected))
	}
}
