// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/process"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// Codex's app-servers read hooks.json and config.toml only when they start.
// The desktop app (inside ChatGPT.app) keeps one running for days, and the
// managed daemon under CODEX_HOME/packages outlives the app, so an install
// reaches neither until they restart. The CLI starts a fresh process per run
// and is never flagged.

const integrationChangeFile = "codex-integration.json"

// desktopBundles are the app bundles that ship Codex's app-server as
// Contents/Resources/codex.
var desktopBundles = map[string]bool{"ChatGPT.app": true, "Codex.app": true}

const desktopExecutableSuffix = "/Contents/Resources/codex"

type integrationChange struct {
	ChangedAt time.Time `json:"changed_at"`
}

// recordIntegrationChange is best effort: without it, hooks.json's own time
// dates the change.
func recordIntegrationChange(env agent.Env) {
	if env.StateDir == "" {
		return
	}
	store.WriteJSON(filepath.Join(env.StateDir, integrationChangeFile), integrationChange{ChangedAt: time.Now().UTC()})
}

// installChangedAt is when the companion last changed the integration, or
// zero when it cannot tell.
func installChangedAt(env agent.Env) time.Time {
	var recorded integrationChange
	if env.StateDir != "" && store.ReadJSON(filepath.Join(env.StateDir, integrationChangeFile), 4096, &recorded) == nil && !recorded.ChangedAt.IsZero() {
		return recorded.ChangedAt
	}
	if info, err := os.Stat(hooksPath(env)); err == nil {
		return info.ModTime()
	}
	return time.Time{}
}

// isDesktopAppServer accepts only installed apps, so a copy run from a
// disk image or Downloads is not taken for the one the user restarts.
func isDesktopAppServer(env agent.Env, executable string) bool {
	bundle, found := strings.CutSuffix(executable, desktopExecutableSuffix)
	if !found || !desktopBundles[filepath.Base(bundle)] {
		return false
	}
	folder := filepath.Dir(bundle)
	return folder == "/Applications" || folder == filepath.Join(env.Home, "Applications")
}

func daemonRoots(env agent.Env) []string {
	roots := []string{filepath.Join(codexHome(env), "packages", "app-server-daemon") + string(filepath.Separator)}
	if resolved, err := filepath.EvalSymlinks(codexHome(env)); err == nil {
		roots = append(roots, filepath.Join(resolved, "packages", "app-server-daemon")+string(filepath.Separator))
	}
	return roots
}

func isDaemonAppServer(env agent.Env, executable string) bool {
	for _, root := range daemonRoots(env) {
		if strings.HasPrefix(executable, root) && filepath.Base(executable) == "codex" {
			return true
		}
	}
	return false
}

// servesSessions: `codex … app-server …`, but not `app-server daemon …`,
// the daemon's own management commands and updater loop.
func servesSessions(argv []string) bool {
	for index, arg := range argv {
		if arg == "app-server" {
			return index+1 == len(argv) || argv[index+1] != "daemon"
		}
	}
	return false
}

// restartProblems names each kind of app-server still running without the
// companion's current integration. An unreadable process table reports
// nothing: a false alarm would ask the user to restart for no reason.
func restartProblems(env agent.Env) []string {
	if env.Processes == nil {
		return nil
	}
	changedAt := installChangedAt(env)
	if changedAt.IsZero() {
		return nil
	}
	// ps reports whole seconds; a process started in the change's own second
	// may already have read it.
	changedAt = changedAt.Truncate(time.Second)
	servers, err := env.Processes.Find(process.Query{
		Name:       "codex-app-server:" + codexHome(env),
		Executable: func(path string) bool { return isDesktopAppServer(env, path) || isDaemonAppServer(env, path) },
		Arguments:  servesSessions,
	})
	if err != nil {
		return nil
	}
	var desktopStale, daemonStale bool
	for _, server := range servers {
		if !server.StartedAt.Before(changedAt) {
			continue
		}
		if isDesktopAppServer(env, server.Executable) {
			desktopStale = true
		} else {
			daemonStale = true
		}
	}
	var problems []string
	if desktopStale {
		problems = append(problems, agent.ProblemRestartRequired)
	}
	if daemonStale {
		problems = append(problems, agent.ProblemDaemonRestartRequired)
	}
	return problems
}
