// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agentaccess

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	keyFixture     = "vlr_fixture_secret_key_do_not_leak_0001"
	installationID = "7a1c0de5-0000-4000-8000-000000000001"
	endpoint       = "https://backplane.example"
)

type fakeKeys struct {
	creates, gets, deletes int
	createErr, getErr      error
	deleteErr              error
	// createErrs, when set, answers successive mints in order.
	createErrs []error
	onGet      func()
}

func (f *fakeKeys) CreateAgentKey(context.Context) (uplink.AgentKey, error) {
	f.creates++
	err := f.createErr
	if len(f.createErrs) > 0 {
		err, f.createErrs = f.createErrs[0], f.createErrs[1:]
	}
	if err != nil {
		return uplink.AgentKey{}, err
	}
	return uplink.AgentKey{ID: "k1", KeyPrefix: "vlr_fixt", Key: keyFixture}, nil
}

func (f *fakeKeys) AgentKey(context.Context) (uplink.AgentKeyInfo, error) {
	f.gets++
	if f.onGet != nil {
		f.onGet()
	}
	if f.getErr != nil {
		return uplink.AgentKeyInfo{}, f.getErr
	}
	return uplink.AgentKeyInfo{ID: "k1", KeyPrefix: "vlr_fixt"}, nil
}

func (f *fakeKeys) DeleteAgentKey(context.Context) error {
	f.deletes++
	return f.deleteErr
}

type memoryKeyring map[string]string

func (m memoryKeyring) Save(account, secret string) error { m[account] = secret; return nil }
func (m memoryKeyring) Delete(account string) error       { delete(m, account); return nil }
func (m memoryKeyring) Load(account string) (string, error) {
	secret, ok := m[account]
	if !ok {
		return "", credentials.ErrNotFound
	}
	return secret, nil
}

type fixture struct {
	manager *Manager
	keys    *fakeKeys
	keyring memoryKeyring
	home    string
	roots   map[string]string
	now     time.Time
}

func newFixture(t *testing.T, agents ...string) *fixture {
	t.Helper()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(base, "home")
	for _, dir := range agents {
		os.MkdirAll(filepath.Join(home, dir), 0o700)
	}
	executable := filepath.Join(base, "bin", "backplane-companion")
	os.MkdirAll(filepath.Dir(executable), 0o700)
	os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o755)
	data := filepath.Join(base, "data")
	os.MkdirAll(data, 0o700)
	f := &fixture{keys: &fakeKeys{}, keyring: memoryKeyring{}, home: home, roots: map[string]string{}, now: time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)}
	for _, id := range []string{"m1", "m2"} {
		root := filepath.Join(base, "src", id)
		os.MkdirAll(filepath.Join(root, ".git"), 0o700)
		f.roots[id] = root
	}
	f.manager = &Manager{
		Layout:  store.Layout{Root: data},
		Keyring: f.keyring,
		Env:     agent.Env{Home: home, Getenv: func(string) string { return "" }, Executable: executable},
		HasUvx:  func() bool { return true },
		Now:     func() time.Time { return f.now },
	}
	return f
}

func (f *fixture) connection() Connection {
	return Connection{InstallationID: installationID, Endpoint: endpoint, Keys: f.keys, MappingIDs: []string{"m1", "m2"}, AgentEnabled: func(string) bool { return true }}
}

func (f *fixture) access(id string) MappingAccess {
	return MappingAccess{Root: f.roots[id], WorkspaceSlug: "acme", WorkspaceName: "Acme", BoardID: "b-" + id, BoardName: "Board " + id}
}

func (f *fixture) set(t *testing.T, id string, enabled bool) AgentAccess {
	t.Helper()
	result, err := f.manager.Set(context.Background(), f.connection(), id, enabled, f.access(id))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *fixture) claudeEntry(t *testing.T, id string) any {
	t.Helper()
	config, err := mcpentry.ReadJSON(filepath.Join(f.home, ".claude.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	projects, _ := config["projects"].(map[string]any)
	project, _ := projects[f.roots[id]].(map[string]any)
	servers, _ := project["mcpServers"].(map[string]any)
	return servers[mcpentry.Name]
}

func (f *fixture) codexConfig() string {
	data, _ := os.ReadFile(filepath.Join(f.home, ".codex", "config.toml"))
	return string(data)
}

func agentState(result AgentAccess, mappingID, agentID string) AgentStatus {
	for _, mapping := range result.Mappings {
		if mapping.MappingID != mappingID {
			continue
		}
		for _, status := range mapping.Agents {
			if status.AgentID == agentID {
				return status
			}
		}
	}
	return AgentStatus{}
}

func problem(status AgentStatus) string {
	if status.Problem == nil {
		return ""
	}
	return *status.Problem
}

func TestAccess_EnableMintsKeyOnceAndWritesPresentAgents(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	result := f.set(t, "m1", true)
	if f.keys.creates != 1 || f.keyring[credentials.AgentKeyAccount(installationID)] != keyFixture {
		t.Fatalf("key not minted into the keyring: creates=%d", f.keys.creates)
	}
	if !mcpentry.IsOwned(f.claudeEntry(t, "m1")) {
		t.Fatal("Claude entry not written for the folder")
	}
	if !strings.Contains(f.codexConfig(), "[mcp_servers.backplane]") {
		t.Fatal("Codex entry not written")
	}
	for agentID, want := range map[string]string{"claude_code": "configured", "codex_cli": "configured", "pi_cli": "unsupported"} {
		if got := agentState(result, "m1", agentID); got.State != want {
			t.Errorf("%s state %+v, want %s", agentID, got, want)
		}
	}
	if pi := agentState(result, "m1", "pi_cli"); problem(pi) != "agent_not_installed" || pi.Scope != "global" {
		t.Errorf("pi %+v", pi)
	}
	if claude := agentState(result, "m1", "claude_code"); claude.Scope != "folder" {
		t.Errorf("claude scope %+v", claude)
	}
	if !result.Key.Present || result.Key.KeyPrefix == nil || *result.Key.KeyPrefix != "vlr_fixt" || result.Key.ServerState != "active" {
		t.Fatalf("key status %+v", result.Key)
	}
	f.set(t, "m2", true)
	f.set(t, "m1", true)
	if f.keys.creates != 1 {
		t.Fatalf("minted %d keys; a present key is reused", f.keys.creates)
	}
	if !mcpentry.IsOwned(f.claudeEntry(t, "m2")) {
		t.Fatal("second folder not written")
	}
	file, _ := Load(f.manager.Layout)
	if !file.Mappings["m1"].Enabled || file.Endpoint != endpoint || !file.Written.CodexCLI || len(file.Written.ClaudeCode) != 2 {
		t.Fatalf("agent_access.json %+v", file)
	}
}

func TestAccess_MintFailureWritesNothing(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	f.keys.createErr = uplink.ErrUnavailable
	_, err := f.manager.Set(context.Background(), f.connection(), "m1", true, f.access("m1"))
	if !errors.Is(err, uplink.ErrUnavailable) {
		t.Fatalf("want the uplink error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.home, ".claude.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Claude config written after a mint failure")
	}
	if f.codexConfig() != "" || len(f.keyring) != 0 {
		t.Fatal("something was written after a mint failure")
	}
	if file, _ := Load(f.manager.Layout); file.Mappings["m1"].Enabled {
		t.Fatal("the mapping was recorded as enabled")
	}
}

func TestAccess_LastDisableRemovesGlobalEntriesAndDeletesKey(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	original := "model = \"gpt-5\"\n"
	os.WriteFile(filepath.Join(f.home, ".codex", "config.toml"), []byte(original), 0o600)
	f.set(t, "m1", true)
	result := f.set(t, "m1", false)
	if f.claudeEntry(t, "m1") != nil {
		t.Fatal("Claude entry survived")
	}
	if f.codexConfig() != original {
		t.Fatalf("Codex config not restored:\n%s", f.codexConfig())
	}
	if f.keys.deletes != 1 || len(f.keyring) != 0 {
		t.Fatalf("key not deleted: server %d keyring %v", f.keys.deletes, len(f.keyring))
	}
	if result.Key.Present || result.Mappings[0].Enabled {
		t.Fatalf("result %+v", result)
	}
	f.set(t, "m1", false)
	if f.keys.deletes != 1 {
		t.Fatal("disabling an already disabled mapping deleted the key again")
	}
}

func TestAccess_OtherEnabledMappingKeepsGlobal(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	f.set(t, "m1", true)
	f.set(t, "m2", true)
	f.set(t, "m1", false)
	if f.claudeEntry(t, "m1") != nil || !mcpentry.IsOwned(f.claudeEntry(t, "m2")) {
		t.Fatal("only m1's folder entry may go")
	}
	if !strings.Contains(f.codexConfig(), "[mcp_servers.backplane]") || f.keys.deletes != 0 || len(f.keyring) != 1 {
		t.Fatal("the global entry or the key went while m2 is enabled")
	}
}

func TestAccess_ConflictIsReportedAndNeverWritten(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	foreign := "[mcp_servers.backplane]\ncommand = \"uvx\"\nargs = [\"backplane-mcp\"]\n"
	os.WriteFile(filepath.Join(f.home, ".codex", "config.toml"), []byte(foreign), 0o600)
	result := f.set(t, "m1", true)
	if codex := agentState(result, "m1", "codex_cli"); codex.State != "conflict" {
		t.Fatalf("codex %+v", codex)
	}
	if f.codexConfig() != foreign {
		t.Fatal("a foreign entry was touched")
	}
	if claude := agentState(result, "m1", "claude_code"); claude.State != "configured" {
		t.Fatalf("claude %+v", claude)
	}
	found := false
	for _, warning := range result.Warnings {
		found = found || warning == Warning{AgentID: "codex_cli", EntryName: "backplane", Reason: "mcp_name_taken"}
	}
	if !found {
		t.Fatalf("warnings %+v", result.Warnings)
	}
	f.set(t, "m1", false)
	if f.codexConfig() != foreign {
		t.Fatal("disable removed a foreign entry")
	}
}

func TestAccess_ConfigChangedIsPendingThenRetried(t *testing.T) {
	f := newFixture(t, ".claude")
	claudeJSON := filepath.Join(f.home, ".claude.json")
	os.WriteFile(claudeJSON, []byte(`{"numStartups":1}`), 0o600)
	mcpentry.BeforeWrite = func(path string) { os.WriteFile(path, []byte(`{"numStartups":2}`), 0o600) }
	result := f.set(t, "m1", true)
	mcpentry.BeforeWrite = nil
	if claude := agentState(result, "m1", "claude_code"); claude.State != "pending" || problem(claude) != "agent_config_changed" {
		t.Fatalf("claude %+v", claude)
	}
	result, changed := f.manager.Reconcile(context.Background(), f.connection())
	if claude := agentState(result, "m1", "claude_code"); claude.State != "configured" || !changed {
		t.Fatalf("retry did not configure: %+v changed=%v", claude, changed)
	}
}

func TestAccess_KeyMissingOnServerClearsKeychain(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	f.now = f.now.Add(11 * time.Minute)
	f.keys.getErr = uplink.ErrAgentKeyMissing
	result, changed := f.manager.Reconcile(context.Background(), f.connection())
	if !changed || result.Key.ServerState != "missing" || result.Key.Present || len(f.keyring) != 0 {
		t.Fatalf("key status %+v keyring %d", result.Key, len(f.keyring))
	}
	if !mcpentry.IsOwned(f.claudeEntry(t, "m1")) {
		t.Fatal("entries must stay so turning it back on only mints a key")
	}
	f.keys.getErr = nil
	result = f.set(t, "m1", true)
	if f.keys.creates != 2 || !result.Key.Present || result.Key.ServerState != "active" {
		t.Fatalf("turning it back on did not mint: %+v", result.Key)
	}
}

func TestAccess_KeyCheckIsRateLimitedAndUnreachableKeepsTheKey(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	gets := f.keys.gets
	f.manager.Reconcile(context.Background(), f.connection())
	if f.keys.gets != gets {
		t.Fatal("key checked again within ten minutes")
	}
	f.now = f.now.Add(11 * time.Minute)
	f.keys.getErr = uplink.ErrUnavailable
	result, _ := f.manager.Reconcile(context.Background(), f.connection())
	if result.Key.ServerState != "unknown" || !result.Key.Present || len(f.keyring) != 1 {
		t.Fatalf("an unreachable server cleared the key: %+v", result.Key)
	}
	f.keys.getErr = uplink.ErrNotFound
	result, _ = f.manager.Reconcile(context.Background(), f.connection())
	if len(f.keyring) != 1 {
		t.Fatal("a bare 404 cleared the key")
	}
}

func TestAccess_MappingGoneFromPolicyIsCleanedUp(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	f.set(t, "m1", true)
	connection := f.connection()
	connection.MappingIDs = []string{"m2"}
	result, changed := f.manager.Reconcile(context.Background(), connection)
	if !changed || f.claudeEntry(t, "m1") != nil || strings.Contains(f.codexConfig(), "backplane") || len(f.keyring) != 0 || f.keys.deletes != 1 {
		t.Fatalf("a deleted mapping kept its entries or key: changed=%v", changed)
	}
	if len(result.Mappings) != 1 || result.Mappings[0].MappingID != "m2" {
		t.Fatalf("mappings %+v", result.Mappings)
	}
}

func TestAccess_DisabledAgentIsNotWritten(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	connection := f.connection()
	connection.AgentEnabled = func(id string) bool { return id != "codex_cli" }
	result, err := f.manager.Set(context.Background(), connection, "m1", true, f.access("m1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.codexConfig(), "backplane") || agentState(result, "m1", "codex_cli").State != "unsupported" {
		t.Fatalf("a capture-disabled agent got an entry: %+v", agentState(result, "m1", "codex_cli"))
	}
}

func TestAccess_PiWithoutAdapterIsUnsupported(t *testing.T) {
	f := newFixture(t, ".pi/agent")
	result := f.set(t, "m1", true)
	if pi := agentState(result, "m1", "pi_cli"); pi.State != "unsupported" || problem(pi) != "mcp_adapter_missing" {
		t.Fatalf("pi %+v", pi)
	}
}

func TestAccess_UvxMissingIsAPrerequisite(t *testing.T) {
	f := newFixture(t, ".claude")
	f.manager.HasUvx = func() bool { return false }
	result := f.set(t, "m1", true)
	if result.Prerequisites.Uvx || problem(agentState(result, "m1", "claude_code")) != "uvx_missing" {
		t.Fatalf("result %+v", result)
	}
}

func TestAccess_SnapshotAndFileHoldNoSecret(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	os.WriteFile(filepath.Join(f.home, ".claude.json"), []byte(`{"mcpServers":{"valaris":{"command":"uvx","args":["backplane-mcp"],"env":{"VALARIS_API_URL":"`+endpoint+`","VALARIS_API_KEY":"vlr_other_users_key_value"}}}}`), 0o600)
	result := f.set(t, "m1", true)
	encoded, _ := json.Marshal(result)
	stored, _ := os.ReadFile(Path(f.manager.Layout))
	for name, text := range map[string]string{"snapshot": string(encoded), "agent_access.json": string(stored), "claude.json": readText(f.home, ".claude.json"), "config.toml": f.codexConfig()} {
		if strings.Contains(text, keyFixture) || strings.Contains(text, "vlr_other_users_key_value") && name != "claude.json" {
			t.Errorf("a key reached %s", name)
		}
	}
	if !strings.Contains(string(encoded), `"warnings":[{"agent_id":"claude_code","entry_name":"valaris","reason":"same_endpoint"}]`) {
		t.Errorf("snapshot %s", encoded)
	}
	empty := newFixture(t).manager.Snapshot(Connection{})
	encoded, _ = json.Marshal(empty)
	if !strings.Contains(string(encoded), `"mappings":[]`) || !strings.Contains(string(encoded), `"warnings":[]`) || !strings.Contains(string(encoded), `"key_prefix":null`) {
		t.Errorf("arrays must be [], never null: %s", encoded)
	}
}

func readText(dir, name string) string {
	data, _ := os.ReadFile(filepath.Join(dir, name))
	return string(data)
}

func TestAccess_RemoveAllClearsEntriesKeychainAndFile(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	f.set(t, "m1", true)
	f.set(t, "m2", true)
	if err := f.manager.RemoveAll(installationID); err != nil {
		t.Fatal(err)
	}
	if f.claudeEntry(t, "m1") != nil || f.claudeEntry(t, "m2") != nil || strings.Contains(f.codexConfig(), "backplane") {
		t.Fatal("entries survived")
	}
	if len(f.keyring) != 0 {
		t.Fatal("keychain item survived")
	}
	if _, err := os.Stat(Path(f.manager.Layout)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("agent_access.json survived")
	}
	if f.keys.deletes != 0 {
		t.Fatal("local cleanup must not call the server (revoke deletes the keys there)")
	}
}

func TestRepair_RewritesMovedExecutable(t *testing.T) {
	f := newFixture(t, ".claude", ".codex")
	f.set(t, "m1", true)
	moved := filepath.Join(filepath.Dir(f.manager.Env.Executable), "new", "backplane-companion")
	f.manager.Env.Executable = moved
	changed, err := f.manager.Repair()
	if err != nil || !changed {
		t.Fatalf("repair: %v %v", changed, err)
	}
	if entry := f.claudeEntry(t, "m1").(map[string]any); entry["command"] != moved {
		t.Fatalf("claude entry %v", entry)
	}
	if !strings.Contains(f.codexConfig(), moved) {
		t.Fatal("codex entry not repointed")
	}
	if changed, _ := f.manager.Repair(); changed {
		t.Fatal("a second repair changed something")
	}
}

func TestAccess_SecondMappingInSameRepoIsConflictNotFlipFlop(t *testing.T) {
	f := newFixture(t, ".claude")
	sub := filepath.Join(f.roots["m1"], "web")
	os.MkdirAll(sub, 0o700)
	f.roots["m2"] = sub
	f.set(t, "m1", true)
	result := f.set(t, "m2", true)
	if claude := agentState(result, "m2", "claude_code"); claude.State != "conflict" || problem(claude) != "folder_bound_to_other_mapping" {
		t.Fatalf("m2 %+v", claude)
	}
	for range 2 {
		if _, changed := f.manager.Reconcile(context.Background(), f.connection()); changed {
			t.Fatal("reconcile flip-flopped the shared entry")
		}
	}
	if mappingArg(f.claudeEntry(t, "m1")) != "m1" {
		t.Fatal("m2 overwrote m1's entry")
	}
	result = f.set(t, "m1", false)
	if claude := agentState(result, "m2", "claude_code"); claude.State != "configured" || mappingArg(f.claudeEntry(t, "m1")) != "m2" {
		t.Fatalf("m2 did not take the folder once m1 let go: %+v", claude)
	}
}

func mappingArg(entry any) string {
	fields, _ := entry.(map[string]any)
	args, _ := fields["args"].([]any)
	if len(args) != 3 {
		return ""
	}
	id, _ := args[2].(string)
	return id
}

func TestAccess_UntrustedWorktreeLinkIsRecorded(t *testing.T) {
	f := newFixture(t, ".claude")
	root := f.roots["m1"]
	os.RemoveAll(filepath.Join(root, ".git"))
	os.MkdirAll(filepath.Join(root, "fakegit"), 0o700)
	os.WriteFile(filepath.Join(root, "fakegit", "commondir"), []byte(filepath.Join(f.roots["m2"], ".git")), 0o600)
	os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: fakegit\n"), 0o600)
	result := f.set(t, "m1", true)
	if claude := agentState(result, "m1", "claude_code"); claude.State != "configured" || problem(claude) != "worktree_link_untrusted" {
		t.Fatalf("claude %+v", claude)
	}
	if !mcpentry.IsOwned(f.claudeEntry(t, "m1")) {
		t.Fatal("entry not under the bound root")
	}
}

func TestAccess_UnreachableDeleteIsRetriedOnReconcile(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	f.keys.deleteErr = uplink.ErrUnavailable
	f.set(t, "m1", false)
	if len(f.keyring) != 0 {
		t.Fatal("the local key survived turning access off")
	}
	file, _ := Load(f.manager.Layout)
	if !file.PendingServerDelete {
		t.Fatal("the failed server delete was forgotten")
	}
	raw, _ := os.ReadFile(Path(f.manager.Layout))
	if strings.Contains(string(raw), keyFixture) {
		t.Fatal("the pending delete stored the key")
	}
	f.manager.Reconcile(context.Background(), f.connection())
	if file, _ := Load(f.manager.Layout); !file.PendingServerDelete || f.keys.deletes != 2 {
		t.Fatalf("a still-failing delete must stay pending (deletes %d)", f.keys.deletes)
	}
	f.keys.deleteErr = nil
	f.manager.Reconcile(context.Background(), f.connection())
	if file, _ := Load(f.manager.Layout); file.PendingServerDelete || f.keys.deletes != 3 {
		t.Fatalf("the retried delete did not clear the flag (deletes %d)", f.keys.deletes)
	}
}

func TestAccess_MintBeforeTheRetryClearsThePendingDelete(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	f.keys.deleteErr = uplink.ErrUnavailable
	f.set(t, "m1", false)
	f.keys.deleteErr = nil
	deletes := f.keys.deletes
	f.set(t, "m1", true)
	f.manager.Reconcile(context.Background(), f.connection())
	if file, _ := Load(f.manager.Layout); file.PendingServerDelete || f.keys.deletes != deletes || len(f.keyring) != 1 {
		t.Fatalf("a retry after a new mint would delete the key in use (deletes %d)", f.keys.deletes-deletes)
	}
}

func TestAccess_RotationConflictChecksThenMintsOnce(t *testing.T) {
	f := newFixture(t, ".claude")
	f.keys.createErrs = []error{uplink.ErrAgentKeyRotationConflict, nil}
	result := f.set(t, "m1", true)
	if f.keys.creates != 2 || f.keys.gets != 1 || !result.Key.Present || f.keyring[credentials.AgentKeyAccount(installationID)] != keyFixture {
		t.Fatalf("creates %d gets %d key %+v", f.keys.creates, f.keys.gets, result.Key)
	}
}

func TestAccess_RepeatedRotationConflictGivesUpAfterOneRetry(t *testing.T) {
	f := newFixture(t, ".claude")
	f.keys.createErrs = []error{uplink.ErrAgentKeyRotationConflict, uplink.ErrAgentKeyRotationConflict, nil}
	_, err := f.manager.Set(context.Background(), f.connection(), "m1", true, f.access("m1"))
	if !errors.Is(err, uplink.ErrAgentKeyRotationConflict) || f.keys.creates != 2 {
		t.Fatalf("want one retry then the conflict, got %v after %d mints", err, f.keys.creates)
	}
	if _, statErr := os.Stat(filepath.Join(f.home, ".claude.json")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("entries written without a key")
	}
}

func TestAccess_RotationConflictUsesAKeyAnotherProcessStored(t *testing.T) {
	f := newFixture(t, ".claude")
	f.keys.createErrs = []error{uplink.ErrAgentKeyRotationConflict}
	f.keys.onGet = func() { f.keyring[credentials.AgentKeyAccount(installationID)] = keyFixture }
	f.set(t, "m1", true)
	if f.keys.creates != 1 {
		t.Fatalf("minted again although the keyring now holds a key (%d)", f.keys.creates)
	}
}

// A folder rebound to another board: the old mapping is gone from the policy
// and the new one names the same root.
func TestAccess_ReboundFolderTakesOverTheGoneMappingsEntry(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	f.roots["m2"] = f.roots["m1"]
	connection := f.connection()
	connection.MappingIDs = []string{"m2"}
	if _, err := f.manager.Set(context.Background(), connection, "m2", true, f.access("m2")); err != nil {
		t.Fatal(err)
	}
	result, _ := f.manager.Reconcile(context.Background(), connection)
	if claude := agentState(result, "m2", "claude_code"); claude.State != "configured" || mappingArg(f.claudeEntry(t, "m1")) != "m2" {
		t.Fatalf("the rebound folder stayed with the gone mapping: %+v", claude)
	}
	if file, _ := Load(f.manager.Layout); len(file.Mappings) != 1 {
		t.Fatalf("the gone mapping was not forgotten: %+v", file.Mappings)
	}
}

func TestAccess_MappingWithTwoRootsWritesAndRemovesBoth(t *testing.T) {
	f := newFixture(t, ".claude")
	access := f.access("m1")
	access.Roots = []string{f.roots["m1"], f.roots["m2"]}
	if _, err := f.manager.Set(context.Background(), f.connection(), "m1", true, access); err != nil {
		t.Fatal(err)
	}
	if mappingArg(f.claudeEntry(t, "m1")) != "m1" || mappingArg(f.claudeEntry(t, "m2")) != "m1" {
		t.Fatal("not every root of the mapping got its entry")
	}
	f.set(t, "m1", false)
	if f.claudeEntry(t, "m1") != nil || f.claudeEntry(t, "m2") != nil {
		t.Fatal("an entry of the mapping survived disable")
	}
}

func TestAccess_ReconcilePicksUpANewClone(t *testing.T) {
	f := newFixture(t, ".claude")
	f.set(t, "m1", true)
	connection := f.connection()
	connection.RootsFor = func(id string) []string {
		if id == "m1" {
			return []string{f.roots["m1"], f.roots["m2"]}
		}
		return nil
	}
	f.manager.Reconcile(context.Background(), connection)
	if mappingArg(f.claudeEntry(t, "m2")) != "m1" {
		t.Fatal("a clone found after enabling got no entry")
	}
}
