// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

// A cloned repository controls its own files, so a .git file and the
// commondir it names are attacker text: they must never pick another
// project's key in ~/.claude.json.

// craftRedirect makes root a folder whose .git file claims to be a linked
// worktree of target's repository, through a fake git directory inside root.
func craftRedirect(t *testing.T, root, target string) {
	t.Helper()
	fake := filepath.Join(root, "fakegit")
	os.MkdirAll(fake, 0o700)
	os.WriteFile(filepath.Join(fake, "commondir"), []byte(filepath.Join(target, ".git")+"\n"), 0o600)
	os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: fakegit\n"), 0o600)
}

func TestSECURITY_CraftedCommondirRedirectsToArbitraryPath(t *testing.T) {
	env := newEnv(t)
	victim := newRepo(t, env, "victim")
	evil := filepath.Join(filepath.Dir(victim), "evil")
	os.MkdirAll(evil, 0o700)
	evil, _ = filepath.EvalSymlinks(evil)
	craftRedirect(t, evil, victim)
	key, trusted := MCPProjectKeyTrusted(evil)
	if key != evil || trusted {
		t.Fatalf("crafted commondir picked key %q (trusted %v), want the bound root %q", key, trusted, evil)
	}
}

func TestSECURITY_GitdirIntoAnotherRepositorysWorktreesNeedsItsBackLink(t *testing.T) {
	env := newEnv(t)
	victim := newRepo(t, env, "victim")
	realWorktree := filepath.Join(filepath.Dir(victim), "victim-wt")
	worktreeGitDir := filepath.Join(victim, ".git", "worktrees", "victim-wt")
	os.MkdirAll(worktreeGitDir, 0o700)
	os.MkdirAll(realWorktree, 0o700)
	os.WriteFile(filepath.Join(worktreeGitDir, "commondir"), []byte("../..\n"), 0o600)
	os.WriteFile(filepath.Join(worktreeGitDir, "gitdir"), []byte(filepath.Join(realWorktree, ".git")+"\n"), 0o600)
	os.WriteFile(filepath.Join(realWorktree, ".git"), []byte("gitdir: "+worktreeGitDir+"\n"), 0o600)
	evil := filepath.Join(filepath.Dir(victim), "evil")
	os.MkdirAll(evil, 0o700)
	evil, _ = filepath.EvalSymlinks(evil)
	os.WriteFile(filepath.Join(evil, ".git"), []byte("gitdir: "+worktreeGitDir+"\n"), 0o600)
	if key, trusted := MCPProjectKeyTrusted(evil); key != evil || trusted {
		t.Fatalf("a worktree whose back-link names another folder was trusted: %q %v", key, trusted)
	}
	if key, trusted := MCPProjectKeyTrusted(realWorktree); key != victim || !trusted {
		t.Fatalf("the genuine worktree lost its main root: %q %v", key, trusted)
	}
}

func TestSECURITY_MissingCommonDirFallsBackToTheRoot(t *testing.T) {
	env := newEnv(t)
	evil := newRepo(t, env, "evil")
	os.RemoveAll(filepath.Join(evil, ".git"))
	craftRedirect(t, evil, filepath.Join(filepath.Dir(evil), "does-not-exist"))
	if key, trusted := MCPProjectKeyTrusted(evil); key != evil || trusted {
		t.Fatalf("a missing common dir was trusted: %q %v", key, trusted)
	}
}

func TestSECURITY_WriteMCPLandsUnderRedirectedKeyNotBoundRoot(t *testing.T) {
	env := newEnv(t)
	victim := newRepo(t, env, "victim")
	if _, err := WriteMCP(env.Env, victim, "victim-mapping"); err != nil {
		t.Fatal(err)
	}
	evil := filepath.Join(filepath.Dir(victim), "evil")
	os.MkdirAll(evil, 0o700)
	evil, _ = filepath.EvalSymlinks(evil)
	craftRedirect(t, evil, victim)
	if _, err := WriteMCP(env.Env, evil, "evil-mapping"); err != nil {
		t.Fatal(err)
	}
	root := decodeJSON(t, claudeJSON(env))
	if mappingOf(projectServers(t, root, victim)[mcpentry.Name]) != "victim-mapping" {
		t.Fatal("the crafted folder overwrote another project's entry")
	}
	if mappingOf(projectServers(t, root, evil)[mcpentry.Name]) != "evil-mapping" {
		t.Fatal("the crafted folder's entry is not under its own root")
	}
	if changed, err := RemoveMCP(env.Env, evil, []string{"evil-mapping"}); err != nil || !changed {
		t.Fatalf("remove: %v %v", changed, err)
	}
	if mappingOf(projectServers(t, decodeJSON(t, claudeJSON(env)), victim)[mcpentry.Name]) != "victim-mapping" {
		t.Fatal("removing the crafted folder's entry touched another project")
	}
}

func mappingOf(entry any) string {
	fields, _ := entry.(map[string]any)
	args, _ := fields["args"].([]any)
	if len(args) == 3 {
		id, _ := args[2].(string)
		return id
	}
	return ""
}

func TestClaudeMCP_OtherMappingsEntryIsNeverOverwrittenOrRemoved(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	sub := filepath.Join(repo, "web")
	os.MkdirAll(sub, 0o700)
	if _, err := WriteMCP(env.Env, repo, "m1"); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteMCP(env.Env, sub, "m2"); !errors.Is(err, ErrOtherMapping) {
		t.Fatalf("want folder_bound_to_other_mapping, got %v", err)
	}
	if changed, err := RemoveMCP(env.Env, sub, []string{"m2"}); err != nil || changed {
		t.Fatalf("removed another mapping's entry: %v %v", changed, err)
	}
	if mappingOf(projectServers(t, decodeJSON(t, claudeJSON(env)), repo)[mcpentry.Name]) != "m1" {
		t.Fatal("m1's entry changed")
	}
	if changed, err := RemoveMCP(env.Env, repo, []string{"m1"}); err != nil || !changed {
		t.Fatalf("the owner could not remove its entry: %v %v", changed, err)
	}
}

func TestClaudeMCP_RemoveWithoutMappingsRemovesAnyOwnedEntry(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	WriteMCP(env.Env, repo, "m1")
	if changed, err := RemoveMCP(env.Env, repo, nil); err != nil || !changed {
		t.Fatalf("disconnect cleanup could not remove: %v %v", changed, err)
	}
}

func TestClaudeMCP_UnpinnedOwnedEntryIsReplaced(t *testing.T) {
	env := newEnv(t)
	repo := newRepo(t, env, "app")
	writeFile(t, claudeJSON(env), `{"projects":{"`+repo+`":{"mcpServers":{"backplane":{"command":"/old/backplane-companion","args":["mcp"]}}}}}`)
	if changed, err := WriteMCP(env.Env, repo, "m1"); err != nil || !changed {
		t.Fatalf("an unpinned entry of ours must be replaced: %v %v", changed, err)
	}
}
