// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// bindBoard gives the harness mapping a board the server lists, and Claude
// Code a configuration directory so it counts as installed.
func (h *harness) bindBoard(t *testing.T) {
	t.Helper()
	h.server.Policy.Mappings[0].BoardID = "b1"
	h.server.Boards = map[string]any{"workspaces": []any{map[string]any{"id": "w", "slug": "acme", "name": "Acme", "boards": []any{map[string]any{"id": "b1", "name": "App", "repos": []any{}}}}}}
	mustMkdir(t, filepath.Join(h.home, ".claude"))
}

func (h *harness) claudeServers(t *testing.T) map[string]any {
	t.Helper()
	config, err := mcpentry.ReadJSON(filepath.Join(h.home, ".claude.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	projects, _ := config["projects"].(map[string]any)
	project, _ := projects[h.repo].(map[string]any)
	servers, _ := project["mcpServers"].(map[string]any)
	return servers
}

func (h *harness) agentKeyInKeyring(t *testing.T, keyring credentialStore) string {
	t.Helper()
	key, err := keyring.Load(credentials.AgentKeyAccount(installationID(t, h)))
	if err != nil && !errors.Is(err, credentials.ErrNotFound) {
		t.Fatal(err)
	}
	return key
}

func TestAgentAccessAPI_EnableWritesEntriesAndKeepsTheKeyInTheKeychain(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	api := h.api(t)
	status, body := api.call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	key := h.agentKeyInKeyring(t, h.app.keyring)
	if key == "" || key != h.server.AgentKey || h.server.AgentKeyMints != 1 {
		t.Fatalf("key not minted into the keyring (mints %d)", h.server.AgentKeyMints)
	}
	if !mcpentry.IsOwned(h.claudeServers(t)[mcpentry.Name]) {
		t.Fatal("Claude entry not written")
	}
	file, err := agentaccess.Load(store.Layout{Root: h.data})
	if want := (agentaccess.MappingAccess{Enabled: true, Root: h.repo, WorkspaceSlug: "acme", WorkspaceName: "Acme", BoardID: "b1", BoardName: "App", Roots: []string{h.repo}}); err != nil || !reflect.DeepEqual(file.Mappings["m1"], want) {
		t.Fatalf("agent_access.json %+v %v", file, err)
	}
	var access agentaccess.AgentAccess
	if err := json.Unmarshal(body, &access); err != nil || !access.Key.Present || len(access.Mappings) != 1 || !access.Mappings[0].Enabled {
		t.Fatalf("answer %s", body)
	}
	if status, _ := api.call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`); status != http.StatusOK || h.server.AgentKeyMints != 1 {
		t.Fatalf("repeat PUT %d minted again (%d)", status, h.server.AgentKeyMints)
	}
	for name, text := range map[string]string{"answer": string(body), "agent_access.json": readTextFile(h.accessFile()), "claude.json": readTextFile(filepath.Join(h.home, ".claude.json"))} {
		if strings.Contains(text, key) {
			t.Errorf("the key reached %s", name)
		}
	}
}

func (h *harness) accessFile() string { return agentaccess.Path(store.Layout{Root: h.data}) }

func readTextFile(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}

func TestAgentAccessAPI_DisableLastMappingDeletesTheKey(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	api := h.api(t)
	api.call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	status, body := api.call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":false}`)
	if status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	if h.agentKeyInKeyring(t, h.app.keyring) != "" || h.server.AgentKeyDeletes != 1 || h.server.AgentKey != "" {
		t.Fatal("the key survived turning the last mapping off")
	}
	if _, ours := h.claudeServers(t)[mcpentry.Name]; ours {
		t.Fatal("Claude entry survived")
	}
}

func TestAgentAccessAPI_NotConnectedIsConflict(t *testing.T) {
	h := newHarness(t)
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if status != http.StatusConflict || !strings.Contains(string(body), `"not_connected"`) {
		t.Fatalf("PUT while not connected %d %s", status, body)
	}
}

func TestAgentAccessAPI_UnknownMappingIsNotFound(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/nope/agent-access", `{"enabled":true}`)
	if status != http.StatusNotFound || !strings.Contains(string(body), `"not_found"`) || h.server.AgentKeyMints != 0 {
		t.Fatalf("unknown mapping %d %s", status, body)
	}
}

func TestAgentAccessAPI_AutoRepoMappingWithoutLocalRootIsConflict(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.server.Policy.Mappings = append(h.server.Policy.Mappings, policy.Mapping{ID: "auto", WorkspaceID: "w", BoardID: "b1", RepoURLNormalized: "github.com/acme/elsewhere", Origin: "auto_repo", Enabled: true, ContentLevel: "standard"})
	h.connect(t)
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if status != http.StatusConflict || !strings.Contains(string(body), `"mapping_root_unknown"`) || h.server.AgentKeyMints != 0 {
		t.Fatalf("auto mapping without a root %d %s", status, body)
	}
}

func TestAgentAccessAPI_AutoRepoMappingUsesTheDiscoveredRoot(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.server.Policy.Mappings = []policy.Mapping{{ID: "auto", WorkspaceID: "w", BoardID: "b1", RepoURLNormalized: "github.com/acme/app", Origin: "auto_repo", Enabled: true, ContentLevel: "standard"}}
	h.connect(t)
	store.WriteJSON(filepath.Join(h.data, "discovered.json"), map[string]any{"projects": []any{map[string]any{"root": h.repo, "repo_url": "github.com/acme/app", "first_seen": "2026-09-30T10:00:00Z"}}})
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	if file, _ := agentaccess.Load(store.Layout{Root: h.data}); file.Mappings["auto"].Root != h.repo {
		t.Fatalf("root %+v", file.Mappings["auto"])
	}
}

func TestAgentAccessAPI_BoardTheOwnerCannotReachIsNotFound(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.server.Boards = map[string]any{"workspaces": []any{}}
	h.connect(t)
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if status != http.StatusNotFound || h.server.AgentKeyMints != 0 {
		t.Fatalf("unreachable board %d %s", status, body)
	}
}

func TestAgentAccessAPI_GetWhenNotConnectedHasNoMappings(t *testing.T) {
	h := newHarness(t)
	status, body := h.api(t).call(t, "GET", "/v1/agent-access", "")
	if status != http.StatusOK || !strings.Contains(string(body), `"mappings":[]`) || !strings.Contains(string(body), `"present":false`) {
		t.Fatalf("GET %d %s", status, body)
	}
}

func TestDisconnect_RemovesEntriesAndKeychainBeforePurge(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	id := installationID(t, h)
	h.api(t).call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if !mcpentry.IsOwned(h.claudeServers(t)[mcpentry.Name]) || h.agentKeyInKeyring(t, h.app.keyring) == "" {
		t.Fatal("precondition: access was not enabled")
	}
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if _, ours := h.claudeServers(t)[mcpentry.Name]; ours {
		t.Fatal("Claude entry survived disconnect")
	}
	if _, err := h.app.keyring.Load(credentials.AgentKeyAccount(id)); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("agents key survived disconnect: %v", err)
	}
	if _, err := os.Stat(h.accessFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("agent_access.json survived disconnect")
	}
}

func TestRevoked_RemovesEntries(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	id := installationID(t, h)
	h.app.keyring = sharedKeyring()
	if status, body := h.api(t).call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	if !mcpentry.IsOwned(h.claudeServers(t)[mcpentry.Name]) || h.agentKeyInKeyring(t, h.app.keyring) == "" {
		t.Fatal("precondition: access was not enabled")
	}
	h.server.RevokeAll()
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "device_revoked")
	waitFor(t, "the agents key to leave the keyring", func() bool {
		_, err := sharedKeyring().Load(credentials.AgentKeyAccount(id))
		return errors.Is(err, credentials.ErrNotFound)
	})
	waitFor(t, "the Claude entry to go", func() bool {
		_, ours := h.claudeServers(t)[mcpentry.Name]
		return !ours
	})
}

func TestRevoked_NoAccessLeavesAgentConfigsUntouched(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	h.server.RevokeAll()
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "device_revoked")
	if _, err := os.Stat(filepath.Join(h.home, ".claude.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revocation without agent access created ~/.claude.json")
	}
}

func TestDiagnostics_ExcludeAgentAccessKey(t *testing.T) {
	h := newHarness(t)
	h.bindBoard(t)
	h.connect(t)
	api := h.api(t)
	api.call(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	key := h.agentKeyInKeyring(t, h.app.keyring)
	if key == "" {
		t.Fatal("no key to look for")
	}
	status, archive := api.call(t, "GET", "/v1/diagnostics", "")
	if status != http.StatusOK {
		t.Fatalf("diagnostics %d", status)
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	sawAccess := false
	for _, file := range reader.File {
		opened, _ := file.Open()
		data, _ := io.ReadAll(opened)
		opened.Close()
		if strings.Contains(string(data), key) {
			t.Errorf("diagnostics file %s holds the agents key", file.Name)
		}
		sawAccess = sawAccess || file.Name == "agent_access.json"
	}
	if !sawAccess {
		t.Error("diagnostics lack the agent access summary")
	}
}

// bindRepo replaces the harness mapping with one bound by repository only
// (auto_repo, no root_path), the shape a repository-bound auto mapping takes.
func (h *harness) bindRepo(t *testing.T) {
	t.Helper()
	h.bindBoard(t)
	h.server.Policy.Mappings = []policy.Mapping{{ID: "auto", WorkspaceID: "w", BoardID: "b1", RepoURLNormalized: "github.com/acme/app", Origin: "auto_repo", Enabled: true, ContentLevel: "standard"}}
}

// clone makes a git working tree under ~/code with origin remote.
func (h *harness) clone(t *testing.T, name, remote string) string {
	t.Helper()
	root := filepath.Join(h.home, "code", name)
	mustMkdir(t, filepath.Join(root, ".git"))
	mustWrite(t, filepath.Join(root, ".git", "config"), "[remote \"origin\"]\n\turl = "+remote+"\n")
	return root
}

func (h *harness) ownerServers(t *testing.T, root string) map[string]any {
	t.Helper()
	config, err := mcpentry.ReadJSON(filepath.Join(h.home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	projects, _ := config["projects"].(map[string]any)
	project, _ := projects[root].(map[string]any)
	servers, _ := project["mcpServers"].(map[string]any)
	return servers
}

func (h *harness) recordCaptured(t *testing.T, root, mappingID string) {
	t.Helper()
	if err := state.RecordMappedRoot(t.Context(), store.Layout{Root: h.data}, root, mappingID, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestAgentAccessAPI_RepoBoundMappingResolvesTheFolderCaptureAttributed(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	h.recordCaptured(t, h.repo, "auto")
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	if entry := h.ownerServers(t, h.repo)[mcpentry.Name]; !mcpentry.IsOwned(entry) || !strings.Contains(fmt.Sprint(entry), "auto") {
		t.Fatalf("no Claude entry for the captured folder: %v", entry)
	}
}

// The owner's retest: sessions captured before this build recorded nothing,
// but Claude Code and Codex list the folders they ran in.
func TestAgentAccessAPI_RepoBoundMappingResolvesFromFoldersAgentsRanIn(t *testing.T) {
	for name, seed := range map[string]func(h *harness){
		"claude projects": func(h *harness) {
			mustWrite(t, filepath.Join(h.home, ".claude.json"), `{"projects":{"`+h.repo+`":{"allowedTools":[]}}}`)
		},
		"codex threads": func(h *harness) {
			store.WriteJSON(filepath.Join(h.data, "threads.json"), state.Threads{Threads: map[string]state.Thread{"t1": {Agent: "codex_cli", Cwd: filepath.Join(h.repo, "src"), SessionID: "s1"}}})
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.bindRepo(t)
			mustMkdir(t, filepath.Join(h.repo, "src"))
			h.connect(t)
			seed(h)
			status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
			if status != http.StatusOK || !mcpentry.IsOwned(h.ownerServers(t, h.repo)[mcpentry.Name]) {
				t.Fatalf("PUT %d %s", status, body)
			}
		})
	}
}

func TestAgentAccessAPI_TwoKnownClonesGetTwoEntries(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	second := h.clone(t, "app-copy", "https://github.com/acme/app.git")
	h.recordCaptured(t, h.repo, "auto")
	h.recordCaptured(t, second, "auto")
	if status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	for _, root := range []string{h.repo, second} {
		if !mcpentry.IsOwned(h.ownerServers(t, root)[mcpentry.Name]) {
			t.Errorf("no entry for clone %s", root)
		}
	}
	file, _ := agentaccess.Load(store.Layout{Root: h.data})
	if roots := file.Mappings["auto"].Roots; len(roots) != 2 {
		t.Fatalf("roots %v", roots)
	}
	if status, _ := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":false}`); status != http.StatusOK {
		t.Fatal("disable failed")
	}
	for _, root := range []string{h.repo, second} {
		if _, ours := h.ownerServers(t, root)[mcpentry.Name]; ours {
			t.Errorf("entry for clone %s survived disable", root)
		}
	}
}

func TestAgentAccessAPI_FolderOfAnotherRepositoryIsNotPicked(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	other := h.clone(t, "other", "git@github.com:acme/other.git")
	h.recordCaptured(t, other, "auto")
	mustWrite(t, filepath.Join(h.home, ".claude.json"), `{"projects":{"`+other+`":{}}}`)
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if status != http.StatusConflict || !strings.Contains(string(body), `"mapping_root_unknown"`) {
		t.Fatalf("a folder of another repository was picked: %d %s", status, body)
	}
}

func TestAgentAccessAPI_RootSeenAfterA409ResolvesOnTheNextPutWithoutRestart(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	api := h.api(t)
	if status, _ := api.call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusConflict {
		t.Fatalf("an unseen repository must stay 409, got %d", status)
	}
	h.recordCaptured(t, h.repo, "auto")
	if status, body := api.call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("the same running API did not resolve the new root: %d %s", status, body)
	}
}

// Candidates from ~/.claude.json were never capture-filtered; they must
// pass capture's own exclusions before they get an entry and the key.
func TestAgentAccessAPI_ExcludedFolderGetsNoEntry(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.server.Policy.Installation.ExcludeGlobs = []string{"code/app"}
	h.connect(t)
	mustWrite(t, filepath.Join(h.home, ".claude.json"), `{"projects":{"`+h.repo+`":{}}}`)
	h.recordCaptured(t, h.repo, "auto")
	status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if status != http.StatusConflict || h.server.AgentKeyMints != 0 {
		t.Fatalf("an excluded folder was granted access: %d %s", status, body)
	}
	if _, ours := h.ownerServers(t, h.repo)[mcpentry.Name]; ours {
		t.Fatal("an excluded folder got an entry")
	}
}

func TestAgentAccessAPI_NeverCaptureFolderGetsNoEntry(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	second := h.clone(t, "app-copy", "https://github.com/acme/app.git")
	mustWrite(t, filepath.Join(h.home, ".claude.json"), `{"projects":{"`+h.repo+`":{},"`+second+`":{}}}`)
	store.WriteJSON(filepath.Join(h.data, "preferences.json"), state.Preferences{IgnoredPaths: []string{h.repo}})
	if status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("PUT %d %s", status, body)
	}
	if _, ours := h.ownerServers(t, h.repo)[mcpentry.Name]; ours {
		t.Fatal("a never-capture folder got an entry")
	}
	if !mcpentry.IsOwned(h.ownerServers(t, second)[mcpentry.Name]) {
		t.Fatal("the other clone lost its entry")
	}
}

// Pausing capture is about recording sessions, not about agents' access.
func TestAgentAccessAPI_LocallyPausedCaptureKeepsAccess(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	h.recordCaptured(t, h.repo, "auto")
	store.WriteJSON(filepath.Join(h.data, "preferences.json"), state.Preferences{Paused: true})
	if status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("pause stripped access: %d %s", status, body)
	}
}

func TestPurgeCapturedState_RemovesMappedRoots(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	state.RecordMappedRoot(t.Context(), layout, "/src/app", "m1", time.Now())
	if err := purgeCapturedState(layout); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(layout.MappedRoots()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("mapped roots survived an installation switch")
	}
}

// Disconnect is also the desktop's Remove; uninstall --purge deletes the whole
// data directory (TestUninstallPurge_RemovesHooksServiceKeyringAndDataDir).
func TestDisconnect_RemovesMappedRoots(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.recordCaptured(t, h.repo, "m1")
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.Layout{Root: h.data}.MappedRoots()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("mapped roots survived disconnect")
	}
}

// DK-12n: a server pause is the device's own capture switch, set from the
// web; it keeps agents' access. Revocation is the incident lever and ends it.
func (h *harness) pauseFromServer(t *testing.T) policy.Cached {
	t.Helper()
	layout := store.Layout{Root: h.data}
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	cached.Policy.Installation.Paused = true
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
	return cached
}

func TestMappingRoots_ServerPausedInstallationKeepsAgentAccess(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	h.recordCaptured(t, h.repo, "auto")
	cached := h.pauseFromServer(t)
	roots := h.app.mappingRoots(store.Layout{Root: h.data}, cached, cached.Policy.Mappings[0])
	if len(roots) != 1 || roots[0] != h.repo {
		t.Fatalf("a server pause took the folder away: %v", roots)
	}
	if status, body := h.api(t).call(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`); status != http.StatusOK {
		t.Fatalf("server pause stripped access: %d %s", status, body)
	}
	if entry := h.ownerServers(t, h.repo)[mcpentry.Name]; !mcpentry.IsOwned(entry) {
		t.Fatalf("no Claude entry while paused from the server: %v", entry)
	}
}

func TestMappingRoots_RevokedDeviceKeepsNoFolder(t *testing.T) {
	h := newHarness(t)
	h.bindRepo(t)
	h.connect(t)
	h.recordCaptured(t, h.repo, "auto")
	cached := h.pauseFromServer(t)
	layout := store.Layout{Root: h.data}
	if err := store.WriteJSON(layout.Admission(), state.Admission{Unauthorized: true, Since: time.Now(), InstallationID: installationID(t, h)}); err != nil {
		t.Fatal(err)
	}
	if roots := h.app.mappingRoots(layout, cached, cached.Policy.Mappings[0]); len(roots) != 0 {
		t.Fatalf("a revoked device still resolves folders for agent access: %v", roots)
	}
}
