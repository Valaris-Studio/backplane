// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

const mcpFixtureKey = "vlr_fixture_secret_key_do_not_leak_0001"

// newRepo makes a git working tree under the env's temp root and returns
// its resolved root.
func newRepo(t *testing.T, env testEnv, name string) string {
	t.Helper()
	root := filepath.Join(filepath.Dir(env.Home), name)
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func claudeJSON(env testEnv) string { return filepath.Join(env.Home, ".claude.json") }

func decodeJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal(readFile(t, path), &root); err != nil {
		t.Fatalf("%s no longer parses: %v", path, err)
	}
	return root
}

func projectServers(t *testing.T, root map[string]any, key string) map[string]any {
	t.Helper()
	projects, _ := root["projects"].(map[string]any)
	project, _ := projects[key].(map[string]any)
	servers, _ := project["mcpServers"].(map[string]any)
	return servers
}

func TestClaudeMCP_WritesLocalScopeEntryForRoot(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	foreignProject := `{"allowedTools":["Bash"],"mcpServers":{"valaris":{"type":"stdio","command":"bash","args":["-c","x"],"env":{"VALARIS_API_KEY":"` + mcpFixtureKey + `"}}},"n":9007199254740993}`
	original := `{"numStartups":42,"projects":{"/elsewhere":` + foreignProject + `,"` + repo + `":{"allowedTools":[],"mcpServers":{}}}}`
	writeFile(t, claudeJSON(env), original)

	changed, err := WriteMCP(env.Env, repo, "m1")
	if err != nil || !changed {
		t.Fatalf("write: %v %v", changed, err)
	}
	root := decodeJSON(t, claudeJSON(env))
	entry, _ := projectServers(t, root, repo)[mcpentry.Name].(map[string]any)
	want := map[string]any{"type": "stdio", "command": env.Executable, "args": []any{"mcp", "--mapping", "m1"}, "env": map[string]any{}}
	if !reflect.DeepEqual(entry, want) {
		t.Fatalf("entry %v, want %v", entry, want)
	}
	var before, after map[string]any
	json.Unmarshal([]byte(foreignProject), &before)
	after = root["projects"].(map[string]any)["/elsewhere"].(map[string]any)
	if !reflect.DeepEqual(before, after) || !strings.Contains(string(readFile(t, claudeJSON(env))), "9007199254740993") {
		t.Fatal("a foreign project changed")
	}
	if changed, err := WriteMCP(env.Env, repo, "m1"); err != nil || changed {
		t.Fatalf("second write is not idempotent: %v %v", changed, err)
	}
}

func TestClaudeMCP_CreatesMissingFileAndProject(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	if _, err := WriteMCP(env.Env, repo, "m1"); err != nil {
		t.Fatal(err)
	}
	if servers := projectServers(t, decodeJSON(t, claudeJSON(env)), repo); !mcpentry.IsOwned(servers[mcpentry.Name]) {
		t.Fatalf("entry not written to a new file: %v", servers)
	}
	if info, _ := os.Stat(claudeJSON(env)); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("created file is %v", info.Mode().Perm())
	}
}

func TestClaudeMCP_HonoursCLAUDE_CONFIG_DIR(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	configDir := filepath.Join(filepath.Dir(env.Home), "claude-config")
	env.Getenv = func(key string) string {
		if key == "CLAUDE_CONFIG_DIR" {
			return configDir
		}
		return ""
	}
	if _, err := WriteMCP(env.Env, repo, "m1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(configDir, ".claude.json")); err != nil {
		t.Fatalf("entry not under CLAUDE_CONFIG_DIR: %v", err)
	}
	if _, err := os.Stat(claudeJSON(env)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("~/.claude.json written despite CLAUDE_CONFIG_DIR")
	}
}

// Claude Code keys local-scope servers by the repository's main working
// tree: a subdirectory or a linked worktree resolves to it (spike, CLI 2.1.285).
func TestClaudeMCP_KeyIsMainRepositoryRoot(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	sub := filepath.Join(repo, "services", "api")
	os.MkdirAll(sub, 0o700)
	if key := MCPProjectKey(sub); key != repo {
		t.Fatalf("subdirectory key %q, want %q", key, repo)
	}
	worktree := filepath.Join(filepath.Dir(repo), "app-wt")
	gitDir := filepath.Join(repo, ".git", "worktrees", "app-wt")
	os.MkdirAll(gitDir, 0o700)
	os.WriteFile(filepath.Join(gitDir, "commondir"), []byte("../..\n"), 0o600)
	os.MkdirAll(worktree, 0o700)
	os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: "+gitDir+"\n"), 0o600)
	os.WriteFile(filepath.Join(gitDir, "gitdir"), []byte(filepath.Join(worktree, ".git")+"\n"), 0o600)
	if key := MCPProjectKey(worktree); key != repo {
		t.Fatalf("worktree key %q, want main root %q", key, repo)
	}
	plain := filepath.Join(filepath.Dir(repo), "plain", "child")
	os.MkdirAll(plain, 0o700)
	if key := MCPProjectKey(plain); key != plain {
		t.Fatalf("a folder outside git keys by itself, got %q", key)
	}
}

func TestClaudeMCP_RefusesSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	target := filepath.Join(filepath.Dir(env.Home), "real.json")
	writeFile(t, target, `{}`)
	os.Symlink(target, claudeJSON(env))
	if _, err := WriteMCP(env.Env, repo, "m1"); !errors.Is(err, agent.ErrConfigSymlink) {
		t.Fatalf("want agent_config_symlink, got %v", err)
	}
	if string(readFile(t, target)) != `{}` {
		t.Fatal("the symlink target was written")
	}
}

func TestClaudeMCP_RetriesOnConcurrentRewrite(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	writeFile(t, claudeJSON(env), `{"numStartups":1}`)
	concurrent := `{"numStartups":2}`
	mcpentry.BeforeWrite = func(path string) { os.WriteFile(path, []byte(concurrent), 0o600) }
	defer func() { mcpentry.BeforeWrite = nil }()
	if _, err := WriteMCP(env.Env, repo, "m1"); !errors.Is(err, agent.ErrConfigChanged) {
		t.Fatalf("want agent_config_changed, got %v", err)
	}
	if string(readFile(t, claudeJSON(env))) != concurrent {
		t.Fatal("Claude's newer file was replaced")
	}
	mcpentry.BeforeWrite = nil
	if changed, err := WriteMCP(env.Env, repo, "m1"); err != nil || !changed {
		t.Fatalf("the retry did not write: %v %v", changed, err)
	}
}

func TestClaudeMCP_NeverTouchesForeignBackplane(t *testing.T) {
	cases := map[string]func(env testEnv, repo string){
		"local": func(env testEnv, repo string) {
			writeFile(t, claudeJSON(env), `{"projects":{"`+repo+`":{"mcpServers":{"backplane":{"command":"uvx","args":["backplane-mcp"]}}}}}`)
		},
		"user": func(env testEnv, repo string) {
			writeFile(t, claudeJSON(env), `{"mcpServers":{"backplane":{"command":"uvx","args":["backplane-mcp"]}}}`)
		},
		"project .mcp.json": func(env testEnv, repo string) {
			writeFile(t, filepath.Join(repo, ".mcp.json"), `{"mcpServers":{"backplane":{"command":"uvx"}}}`)
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			repo := newRepo(t, env, "app")
			setup(env, repo)
			before, _ := os.ReadFile(claudeJSON(env))
			if _, err := WriteMCP(env.Env, repo, "m1"); !errors.Is(err, mcpentry.ErrNameTaken) {
				t.Fatalf("want mcp_name_taken, got %v", err)
			}
			if after, _ := os.ReadFile(claudeJSON(env)); string(after) != string(before) {
				t.Fatal("a conflict still wrote")
			}
		})
	}
}

func TestClaudeMCP_RemoveLeavesOtherEntries(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	writeFile(t, claudeJSON(env), `{"projects":{"`+repo+`":{"mcpServers":{"valaris":{"command":"bash"}}},"/other":{"mcpServers":{}}}}`)
	if _, err := WriteMCP(env.Env, repo, "m1"); err != nil {
		t.Fatal(err)
	}
	changed, err := RemoveMCP(env.Env, repo, []string{"m1"})
	if err != nil || !changed {
		t.Fatalf("remove: %v %v", changed, err)
	}
	root := decodeJSON(t, claudeJSON(env))
	servers := projectServers(t, root, repo)
	if _, ours := servers[mcpentry.Name]; ours || servers["valaris"] == nil {
		t.Fatalf("remove result %v", servers)
	}
	if _, kept := root["projects"].(map[string]any)["/other"]; !kept {
		t.Fatal("another project was dropped")
	}
	if changed, err := RemoveMCP(env.Env, repo, []string{"m1"}); err != nil || changed {
		t.Fatalf("second remove: %v %v", changed, err)
	}
}

func TestClaudeMCP_RemoveNeverCreatesTheFile(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	if changed, err := RemoveMCP(env.Env, repo, []string{"m1"}); err != nil || changed {
		t.Fatalf("remove on a missing file: %v %v", changed, err)
	}
	if _, err := os.Stat(claudeJSON(env)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("remove created ~/.claude.json")
	}
}

func TestClaudeMCP_RepairRewritesMovedExecutable(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	other := newRepo(t, env, "other")
	stale := `{"type":"stdio","command":"/old/place/backplane-companion","args":["mcp","--mapping","m1"],"env":{}}`
	writeFile(t, claudeJSON(env), `{"projects":{"`+repo+`":{"mcpServers":{"backplane":`+stale+`}},"`+other+`":{"mcpServers":{"valaris":{"command":"/old/place/backplane-companion","args":["x"]}}}}}`)
	changed, err := RepairMCP(env.Env)
	if err != nil || !changed {
		t.Fatalf("repair: %v %v", changed, err)
	}
	root := decodeJSON(t, claudeJSON(env))
	if command := projectServers(t, root, repo)[mcpentry.Name].(map[string]any)["command"]; command != env.Executable {
		t.Fatalf("owned command %v", command)
	}
	if command := projectServers(t, root, other)["valaris"].(map[string]any)["command"]; command != "/old/place/backplane-companion" {
		t.Fatal("a foreign entry was repointed")
	}
	if changed, _ := RepairMCP(env.Env); changed {
		t.Fatal("a second repair reported a change")
	}
}

func TestClaudeMCP_FindingsNameEntriesNeverValues(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	writeFile(t, claudeJSON(env), `{"mcpServers":{"valaris":{"command":"uvx","args":["backplane-mcp"],"env":{"VALARIS_API_URL":"https://backplane.example","VALARIS_API_KEY":"`+mcpFixtureKey+`"}}},"projects":{"`+repo+`":{"mcpServers":{"old":{"command":"python","args":["-m","valaris_mcp"]}}},"/unrelated":{"mcpServers":{"x":{"command":"uvx","args":["backplane-mcp"]}}}}}`)
	writeFile(t, filepath.Join(repo, ".mcp.json"), `{"mcpServers":{"team":{"command":"uvx","args":["backplane-mcp"]}}}`)
	findings, err := MCPFindings(env.Env, repo, "https://backplane.example")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(findings)
	if strings.Contains(string(encoded), mcpFixtureKey) || strings.Contains(string(encoded), "backplane.example") {
		t.Fatalf("findings leaked a value: %s", encoded)
	}
	got := map[string]string{}
	for _, finding := range findings {
		got[finding.EntryName] = finding.Reason
	}
	want := map[string]string{"valaris": mcpentry.ReasonSameEndpoint, "old": mcpentry.ReasonOtherBackplane, "team": mcpentry.ReasonOtherBackplane}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findings %v, want %v", got, want)
	}
}
