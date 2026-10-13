// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

func TestEnqueue_WorkingDirectoriesWithSpacesStayPrivateAcrossSources(t *testing.T) {
	for _, level := range []string{"standard", "full"} {
		t.Run(level, func(t *testing.T) {
			f := newFixture(t, pi.New(), codex.New())
			rootWithSpaces := filepath.Join(filepath.Dir(f.repo), "My Projects", "app")
			if err := os.MkdirAll(filepath.Dir(rootWithSpaces), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(f.repo, rootWithSpaces); err != nil {
				t.Fatal(err)
			}
			f.repo = rootWithSpaces
			expectedRelative := filepath.Join("packages suite", "api worker")
			nested := filepath.Join(f.repo, expectedRelative)
			if err := os.MkdirAll(nested, 0o700); err != nil {
				t.Fatal(err)
			}
			f.normalizer.carryPayload = true
			f.server.Lock()
			f.server.Policy.Mappings[0].RootPath = f.repo
			f.server.Policy.Mappings[0].ContentLevel = level
			f.server.Policy.Installation.EnabledAgents = []string{"claude_code", pi.ID, codex.ID}
			f.server.Unlock()
			f.daemon.config.OTel = &OTelConfig{Harness: codex.HarnessForService}
			f.daemon.refreshPolicy(context.Background())

			const outside = "/opt/Other Projects/external worker"
			const prompt = "Keep the build report and https://example.test/team%20data unchanged."
			claudeMessage, err := json.Marshal(map[string]any{
				"cwd": nested, "session_id": "sess-1", "hook_event_name": "UserPromptSubmit",
				"prompt": prompt, "workdir": outside,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := f.shim.Handle("claude_code", strings.NewReader(string(claudeMessage))); err != nil {
				t.Fatal(err)
			}
			piMessage, _ := json.Marshal(map[string]any{
				"type": "message_end", "sessionId": "pi-space-session", "cwd": nested, "workdir": outside,
				"message": map[string]any{"role": "assistant", "model": "fixture-model", "content": []any{}, "usage": map[string]any{"input": 10, "output": 5}},
			})
			if err := f.shim.Handle(pi.ID, strings.NewReader(string(piMessage))); err != nil {
				t.Fatal(err)
			}
			f.thread(t, "codex-space-session", nested)
			codexEvent, _ := json.Marshal(map[string]any{
				"schema_version": "1.0", "event": map[string]any{"action": "tool.invoked"},
				"harness": map[string]any{"name": "codex_cli"},
				"session": map[string]any{"id": "codex-space-session", "working_directory": nested},
				"raw":     map[string]any{"cwd": nested, "workdir": outside},
			})
			if err := os.MkdirAll(f.layout.OTelDir(), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), append(codexEvent, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
			f.tick(t)

			records := f.server.Records()
			if len(records) != 3 {
				t.Fatalf("uploaded %d records, want Claude, Pi and Codex records", len(records))
			}
			seenSessions := map[string]bool{}
			for _, record := range records {
				native, _ := record["native_session_id"].(string)
				seenSessions[native] = true
				event := record["events"].([]any)[0].(map[string]any)
				if directory := event["session"].(map[string]any)["working_directory"]; directory != expectedRelative {
					t.Errorf("%s sent working directory %q", native, directory)
				}
				if record["mapping_id"] != "m1" || event["repository"] != "github.com/acme/app" || event["schema_version"] != "1.0" {
					t.Errorf("privacy placement lost source provenance: %v", record)
				}
			}
			for _, native := range []string{"sess-1", "pi-space-session", "codex-space-session"} {
				if !seenSessions[native] {
					t.Errorf("source session %q is missing", native)
				}
			}
			directories := uploadedWorkingDirectories(f)
			insideCount, outsideCount := 0, 0
			for _, directory := range directories {
				switch directory {
				case expectedRelative:
					insideCount++
				case "external worker":
					outsideCount++
				default:
					t.Errorf("device working directory crossed the upload boundary: %q", directory)
				}
			}
			if insideCount != 6 || outsideCount != 3 {
				t.Errorf("want six project-relative and three outside-folder values, got %v", directories)
			}
			uploaded := uploadedText(t, f)
			if strings.Contains(uploaded, outside) || strings.Contains(uploaded, f.repo) {
				t.Errorf("an absolute working directory left the device: %s", uploaded)
			}
			if !strings.Contains(uploaded, prompt) {
				t.Errorf("unrelated prompt/URL content was lost: %s", uploaded)
			}
		})
	}
}

func TestPlaceEvents_WorkingDirectoryPrivacyIsIndependentOfCaptureAdapter(t *testing.T) {
	input := json.RawMessage(`{"schema_version":"1.0","session":{"id":"s1","working_directory":"\\\\?\\UNC\\server\\team share\\app\\api worker"},"raw":{"turns":[{"CWD":"D:\\Other Projects\\external worker"}],"workdir":"https://example.test/team%20data"},"tool":{"arguments":{"workdir":"packages/api worker"}},"message":"Build /opt/team data after lunch","count":17}`)
	for _, level := range []privacy.ContentLevel{privacy.Standard, privacy.Full} {
		t.Run(string(level), func(t *testing.T) {
			output, err := placeEvents([]json.RawMessage{input}, privacy.Place{Roots: []string{`\\server\team share\app`}}, level)
			if err != nil {
				t.Fatal(err)
			}
			if len(output) != 1 {
				t.Fatalf("placed %d events, want 1", len(output))
			}
			var got map[string]any
			if err := json.Unmarshal(output[0], &got); err != nil {
				t.Fatal(err)
			}
			if directory := got["session"].(map[string]any)["working_directory"]; directory != "api worker" {
				t.Errorf("verbatim UNC working directory = %q, want api worker", directory)
			}
			raw := got["raw"].(map[string]any)
			if directory := raw["turns"].([]any)[0].(map[string]any)["CWD"]; directory != "external worker" {
				t.Errorf("nested drive working directory = %q, want external worker", directory)
			}
			if raw["workdir"] != "https://example.test/team%20data" || got["tool"].(map[string]any)["arguments"].(map[string]any)["workdir"] != "packages/api worker" {
				t.Errorf("URL or relative provenance changed: %s", output[0])
			}
			if got["message"] != "Build /opt/team data after lunch" || got["count"] != float64(17) || got["session"].(map[string]any)["id"] != "s1" {
				t.Errorf("unrelated normalized content changed: %s", output[0])
			}
		})
	}
}
