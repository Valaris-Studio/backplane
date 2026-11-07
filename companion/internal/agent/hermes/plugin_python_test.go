// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Printed by the fake companion on every call; the plugin must discard both streams.
const (
	pluginTestStdoutMarker = "fake-companion-stdout-5c1e"
	pluginTestStderrMarker = "fake-companion-stderr-5c1e"
)

// pluginTestCompanion records each call as one whole JSON file. Its behavior is
// keyed by the session id it receives: drop_ records nothing, slow_ hangs past
// the plugin's timeout, fail_ exits non-zero.
const pluginTestCompanion = `
import json, os, sys, time
RECORDS = __RECORDS__
stdin = sys.stdin.buffer.read()
sys.stdout.write("{} __STDOUT_MARKER__\n")
sys.stderr.write("__STDERR_MARKER__\n")
try:
    session = str(json.loads(stdin.decode("utf-8")).get("session_id") or "")
except Exception:
    session = ""
if not session.startswith("drop_"):
    record = {"argv": sys.argv, "env": dict(os.environ), "stdin": stdin.decode("utf-8", "replace"), "pid": os.getpid()}
    partial = os.path.join(RECORDS, ".partial-%d" % os.getpid())
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
    os.rename(partial, os.path.join(RECORDS, "call-%020d-%d.json" % (time.time_ns(), os.getpid())))
if session.startswith("slow_"):
    time.sleep(30)
sys.exit(7 if session.startswith("fail_") else 0)
`

// TestRenderedPluginHonorsHermesObserverContract loads the rendered plugin
// under python3 -I with a fake Hermes PluginContext (Hermes itself is never
// run) and a fake companion that records argv, env and stdin per call.
func TestRenderedPluginHonorsHermesObserverContract(t *testing.T) {
	interpreter := pluginTestPython(t)
	dir := t.TempDir()
	records := filepath.Join(dir, "records")
	scratch := filepath.Join(dir, "tmp")
	for _, path := range []string{records, scratch} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// A shell would split or expand this path; argv must carry it verbatim.
	companion := filepath.Join(dir, `Backplane Companion's "app" $HOME`, "backplane-companion")
	writePluginTestCompanion(t, companion, interpreter, records)
	pluginDir := pluginTestWriteRendered(t, companion, filepath.Join(dir, "hermes home", "plugins", "backplane-companion"))
	lateCompanion := filepath.Join(dir, "late install", "backplane-companion")
	latePluginDir := pluginTestWriteRendered(t, lateCompanion, filepath.Join(dir, "late hermes home", "plugins", "backplane-companion"))
	socketOnlyDir := pluginTestWriteFiles(t, RenderSocketOnlyPlugin(), filepath.Join(dir, "worker image", "plugins", "backplane-companion"))
	socketDir := pluginTestSocketDir(t)

	tests, err := os.ReadFile(filepath.Join("testdata", "plugin_tests.py"))
	if err != nil {
		t.Fatal(err)
	}
	driver := filepath.Join(dir, "driver", "plugin_tests.py")
	if err := os.MkdirAll(filepath.Dir(driver), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(driver, tests, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, interpreter, "-I", driver)
	cmd.Dir = filepath.Dir(driver)
	cmd.WaitDelay = 40 * time.Second
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + filepath.Join(dir, "gateway home"),
		"TMPDIR=" + scratch,
		"HERMES_PLUGIN_TEST_PLUGIN_DIR=" + pluginDir,
		"HERMES_PLUGIN_TEST_EXECUTABLE=" + companion,
		"HERMES_PLUGIN_TEST_LATE_PLUGIN_DIR=" + latePluginDir,
		"HERMES_PLUGIN_TEST_LATE_EXECUTABLE=" + lateCompanion,
		"HERMES_PLUGIN_TEST_RECORDS=" + records,
		"HERMES_PLUGIN_TEST_SOCKET_ONLY_PLUGIN_DIR=" + socketOnlyDir,
		"HERMES_PLUGIN_TEST_SOCKET_DIR=" + socketDir,
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("rendered plugin broke the Hermes observer contract: %v\n%s", err, output)
	}
	if strings.Contains(string(output), pluginTestStdoutMarker) || strings.Contains(string(output), pluginTestStderrMarker) {
		t.Fatalf("the companion's stdout/stderr reached the Hermes process instead of being discarded:\n%s", output)
	}
	if !regexp.MustCompile(`(?m)^OK$`).Match(output) {
		t.Fatalf("plugin contract tests did not finish clean (a skip counts as a failure here):\n%s", output)
	}
	t.Logf("%s", output)
}

// Hermes keys the plugin by its manifest name and sniffs __init__.py for
// provider markers (hermes_cli/plugins_manifest.py _detect_kind_from_source);
// a match routes the plugin away from the general PluginManager and none of
// its hooks would ever load.
func TestRenderedPluginLoadsAsStandaloneHermesPlugin(t *testing.T) {
	files, err := RenderPlugin(filepath.Join(t.TempDir(), "backplane-companion"))
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(files["plugin.yaml"])
	if !regexp.MustCompile(`(?m)^name:\s*["']?backplane-companion["']?\s*$`).MatchString(manifest) {
		t.Errorf("plugin.yaml does not name the plugin backplane-companion:\n%s", manifest)
	}
	if !regexp.MustCompile(`(?m)^description:\s*\S`).MatchString(manifest) {
		t.Errorf("plugin.yaml has no description:\n%s", manifest)
	}
	if kind := regexp.MustCompile(`(?m)^kind:\s*["']?([^"'\s]+)`).FindStringSubmatch(manifest); kind != nil && kind[1] != "standalone" {
		t.Errorf("plugin.yaml declares kind %q; observer hooks load only for standalone plugins", kind[1])
	}
	source := string(files["__init__.py"])
	for _, marker := range []string{"register_memory_provider", "MemoryProvider", "register_cron_scheduler", "CronScheduler", "register_computer_use_provider", "ComputerUseProvider"} {
		if strings.Contains(source, marker) {
			t.Errorf("__init__.py contains %q, which Hermes reads as an exclusive provider plugin", marker)
		}
	}
	if strings.Contains(source, "register_provider") && strings.Contains(source, "ProviderProfile") {
		t.Error("__init__.py reads to Hermes as a model-provider plugin")
	}
}

// The worker image's rendering has no command to run: the socket named by
// the gateway's environment is its only route, and without one it is inert.
func TestSocketOnlyPluginRenderingSpawnsNothing(t *testing.T) {
	files := RenderSocketOnlyPlugin()
	source := string(files["__init__.py"])
	if !strings.Contains(source, "\nCOMPANION_ARGV = None\n") {
		t.Fatalf("the socket-only rendering keeps a command:\n%s", source)
	}
	if strings.Contains(source, argvPlaceholder) {
		t.Fatal("the template placeholder survived rendering")
	}
	if !strings.Contains(source, "BACKPLANE_COMPANION_HOOK_SOCKET") {
		t.Fatal("the socket-only rendering does not read BACKPLANE_COMPANION_HOOK_SOCKET")
	}
	withCommand, err := RenderPlugin(filepath.Join(t.TempDir(), "backplane-companion"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(files["plugin.yaml"], withCommand["plugin.yaml"]) {
		t.Fatal("the two renderings disagree on the manifest")
	}
	if bytes.Equal(files["__init__.py"], withCommand["__init__.py"]) {
		t.Fatal("the two renderings are the same source")
	}
}

func TestPluginRenderingRefusesRelativeCompanionPath(t *testing.T) {
	for _, executable := range []string{"", "backplane-companion", "./bin/backplane-companion", "bin/backplane-companion"} {
		if files, err := RenderPlugin(executable); !errors.Is(err, agent.ErrConfigInvalid) || files != nil {
			t.Errorf("RenderPlugin(%q) = %d files, %v; want agent.ErrConfigInvalid", executable, len(files), err)
		}
	}
}

// pluginTestPython resolves the real interpreter behind python3 (not a pyenv
// shim) so it can also sit in the fake companion's #! line.
func pluginTestPython(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the Hermes plugin contract test needs a POSIX python3 and #! scripts")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("needs python3 on PATH to load the rendered Hermes plugin")
	}
	output, err := exec.Command(python, "-I", "-c", "import sys; assert sys.version_info >= (3, 8); print(sys.executable)").Output()
	interpreter := strings.TrimSpace(string(output))
	if err != nil || !filepath.IsAbs(interpreter) || strings.ContainsAny(interpreter, " \t") {
		t.Skipf("needs python3 >= 3.8 with an interpreter path usable in a #! line (got %q, %v)", interpreter, err)
	}
	return interpreter
}

func writePluginTestCompanion(t *testing.T, path, interpreter, records string) {
	t.Helper()
	recordsLiteral, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	source := strings.NewReplacer(
		"__RECORDS__", string(recordsLiteral),
		"__STDOUT_MARKER__", pluginTestStdoutMarker,
		"__STDERR_MARKER__", pluginTestStderrMarker,
	).Replace(pluginTestCompanion)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!"+interpreter+" -IS\n"+source), 0o700); err != nil {
		t.Fatal(err)
	}
}

// pluginTestSocketDir is a directory short enough for a Unix socket path,
// which TMPDIR under a long test name is not.
func pluginTestSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bphs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func pluginTestWriteRendered(t *testing.T, companion, pluginDir string) string {
	t.Helper()
	files, err := RenderPlugin(companion)
	if err != nil {
		t.Fatalf("RenderPlugin(%q): %v", companion, err)
	}
	return pluginTestWriteFiles(t, files, pluginDir)
}

func pluginTestWriteFiles(t *testing.T, files map[string][]byte, pluginDir string) string {
	t.Helper()
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "__init__.py,plugin.yaml" {
		t.Fatalf("RenderPlugin returned %v, want exactly __init__.py and plugin.yaml", names)
	}
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(pluginDir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return pluginDir
}
