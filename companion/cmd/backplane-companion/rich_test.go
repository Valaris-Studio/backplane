// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

func TestPurgeCapturedState_RemovesRichCapture(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	if _, err := daemon.ContentSpool(layout).Stage(richcapture.Body{ContentKey: strings.Repeat("a", 64), CaptureID: queuedCaptureID}, []byte("body")); err != nil {
		t.Fatal(err)
	}
	if err := purgeCapturedState(layout); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(layout.RichDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("spooled bodies and read positions survived an installation switch")
	}
}

// m1: a switch's bounded flush also sends the old server the bodies it
// asked for; whatever is left is purged, never sent to the new server.
func TestSwitch_FlushSendsPendingChunkUploadsThenPurgesRichCapture(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	body := bytes.Repeat([]byte("pending body "), 4000)
	sum := sha256.Sum256(body)
	contentKey := hex.EncodeToString(sum[:])
	h.server.Lock()
	h.server.Contents[contentKey] = &uplinktest.StoredContent{
		ID: "00000000-0000-4000-8000-0000000000c1", Key: contentKey, Delivery: "upload", Coverage: "captured",
		SHA256: contentKey, ByteCount: int64(len(body)), State: "pending", ChunkCount: 1, Chunks: map[int][]byte{},
	}
	h.server.Unlock()
	spool := daemon.ContentSpool(layout)
	if _, err := spool.Stage(richcapture.Body{ContentKey: contentKey, CaptureID: queuedCaptureID}, body); err != nil {
		t.Fatal(err)
	}
	if _, err := spool.AwaitUpload(contentKey, "00000000-0000-4000-8000-0000000000c1", uplink.UploadSlot{ChunkBytes: 4 << 20, ChunkCount: 1, ReceivedChunks: []int{}}); err != nil {
		t.Fatal(err)
	}
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	persist := h.app.persistSwitch(layout, "", h.app.now().UTC(), &switchOutcome{})
	if err := persist(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken)); err != nil {
		t.Fatalf("switch: %v", err)
	}
	if got := h.server.Body(contentKey); !bytes.Equal(got, body) {
		t.Fatalf("the old server holds %d of %d bytes", len(got), len(body))
	}
	if _, err := os.Stat(layout.RichDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("rich capture state survived the switch")
	}
	// The new connection's windows, and so its generations, start afresh.
	if _, err := os.Stat(layout.CaptureWindows()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("capture windows survived the switch")
	}
	other.Lock()
	defer other.Unlock()
	if other.ChunkPuts != 0 || len(other.Contents) != 0 {
		t.Fatal("the old connection's content reached the new server")
	}
}

// writeCachedPolicy replaces the cached policy with a raw document, as a
// server would have answered it.
func writeCachedPolicy(t *testing.T, layout store.Layout, policyDocument string) {
	t.Helper()
	cached := `{"refreshed_at":"` + goldenClock.Format(time.RFC3339) + `","policy":` + policyDocument + `}`
	if err := store.WriteFileAtomic(layout.Policy(), []byte(cached)); err != nil {
		t.Fatal(err)
	}
}

func connectionOffer(t *testing.T, h *harness) any {
	t.Helper()
	status, body := h.api(t).call(t, "GET", "/v1/status", "")
	if status != 200 {
		t.Fatalf("status: %d %s", status, body)
	}
	var report struct {
		Connections []map[string]any `json:"connections"`
	}
	json.Unmarshal(body, &report)
	if len(report.Connections) != 1 {
		t.Fatalf("connections %s", body)
	}
	richCapture, _ := report.Connections[0]["rich_capture"].(map[string]any)
	return richCapture["offer"]
}

const cachedInstallation = `"installation":{"id":"%s","paused":false,"auto_match_repos":true,"enabled_agents":null,"exclude_globs":[]},"repo_catalog":[]`

// Each connection reports what its latest cached policy said about rich
// capture: an offer, an explicit null, or nothing known (no policy, or a
// server from before rich capture).
func TestStatus_EachConnectionReportsItsRichCaptureOffer(t *testing.T) {
	h := newHarness(t)
	h.app.now = func() time.Time { return goldenClock }
	h.connect(t)
	layout, _ := h.app.layout()
	installation := fmt.Sprintf(cachedInstallation, installationID(t, h))
	offer := string(contracttest.WireExample(t, "policy-rich-capture-offer.json").Body)
	for _, c := range []struct{ name, member, want string }{
		{"absent", "", "unknown"},
		{"null", `,"rich_capture":null`, "not_offered"},
		{"offer", `,"rich_capture":` + offer, "offered"},
	} {
		writeCachedPolicy(t, layout, `{`+installation+`,"mappings":[]`+c.member+`}`)
		if got := connectionOffer(t, h); got != c.want {
			t.Errorf("%s: offer = %v, want %s", c.name, got, c.want)
		}
	}
	os.Remove(layout.Policy())
	if got := connectionOffer(t, h); got != "unknown" {
		t.Errorf("no cached policy: offer = %v, want unknown", got)
	}
}

// The server's effective capture of each mapping reaches the desktop as the
// server wrote it; servers from before it send none.
func TestProjects_MappingsCarryTheServersCaptureVerbatim(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	capture := string(contracttest.WireExample(t, "mapping-capture-device-unsupported.json").Body)
	mapping := `{"id":"m1","workspace_id":"w","root_path":"/src/app","enabled":true,"content_level":"rich","capture":` + capture + `}`
	plain := `{"id":"m2","workspace_id":"w","root_path":"/src/other","enabled":true,"content_level":"standard"}`
	writeCachedPolicy(t, layout, `{`+fmt.Sprintf(cachedInstallation, installationID(t, h))+`,"mappings":[`+mapping+`,`+plain+`]}`)
	status, body := h.api(t).call(t, "GET", "/v1/projects", "")
	if status != 200 {
		t.Fatalf("projects: %d %s", status, body)
	}
	var report struct {
		Mappings []map[string]json.RawMessage `json:"mappings"`
	}
	json.Unmarshal(body, &report)
	if len(report.Mappings) != 2 {
		t.Fatalf("mappings %s", body)
	}
	var got, want any
	json.Unmarshal(report.Mappings[0]["capture"], &got)
	json.Unmarshal([]byte(capture), &want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("capture %s, want %s", report.Mappings[0]["capture"], capture)
	}
	if _, sent := report.Mappings[1]["capture"]; sent {
		t.Fatal("a mapping the server sent without capture gained one")
	}
}
