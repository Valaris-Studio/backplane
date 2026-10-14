// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/process"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func (h *harness) codexHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join(h.home, ".codex")
	mustMkdir(t, home)
	h.env["CODEX_HOME"] = home
	return home
}

func TestCodexInstallAllocatesTheGateAndExplainsTrust(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	codexHome := h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	var reports []struct {
		ID          string `json:"id"`
		Action      string `json:"action"`
		Integration struct {
			State string `json:"state"`
			Trust string `json:"trust"`
		} `json:"integration"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &reports); err != nil {
		t.Fatalf("%v: %s", err, h.stdout)
	}
	if len(reports) != 1 || reports[0].ID != "codex_cli" || reports[0].Integration.State != "needs_trust" || !strings.Contains(reports[0].Action, "Trust all and continue") {
		t.Fatalf("install report: %s", h.stdout)
	}
	settings, err := state.Load[state.OTelSettings](store.Layout{Root: h.data}.OTelSettings())
	if err != nil || settings.GatePort == 0 {
		t.Fatalf("gate port not allocated: %+v %v", settings, err)
	}
	config, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(config), "127.0.0.1:"+itoa(settings.GatePort)+"/v1/logs") {
		t.Fatalf("Codex not pointed at the gate:\n%s", config)
	}
	h.env["LANG"] = "es_ES.UTF-8"
	h.run(t, "agents", "status", "codex")
	if !strings.Contains(h.stdout.String(), "Confiar en todos y continuar") && !strings.Contains(h.stdout.String(), "Trust all and continue") {
		t.Fatalf("trust instructions missing: %s", h.stdout)
	}
	report := h.status(t)
	found := false
	for _, agent := range report.Agents {
		if agent.ID == "codex_cli" {
			found = agent.State == "needs_trust"
		}
	}
	if !found {
		t.Fatalf("status must show needs_trust: %s", h.stdout)
	}
}

func TestRunWithoutACollectorStillCapturesOtherAgents(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	h.env[envOtelcolArtifact] = filepath.Join(h.root, "missing", "otelcol.json")
	logPath := filepath.Join(h.data, "logs", "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	log := waitForLog(t, logPath, "started")
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log, "otel_collector_unavailable") {
		t.Fatalf("missing collector not logged:\n%s", log)
	}
}

func itoa(value int) string { data, _ := json.Marshal(value); return string(data) }

var _ = context.Background
var _ = time.Second

func TestCodexInstallSaysWhenTelemetryWasSkippedForAConflict(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	codexHome := h.codexHome(t)
	mustWrite(t, filepath.Join(codexHome, "config.toml"), "[otel.exporter.otlp-grpc]\nendpoint = \"http://collector:4317\"\n")
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	output := h.stdout.String()
	if !strings.Contains(output, `"telemetry": "skipped_conflict_existing_otel"`) || !strings.Contains(output, "already exports telemetry to another OpenTelemetry endpoint") {
		t.Fatalf("conflict not reported by install: %s", output)
	}
}

func TestHooksAlwaysPointAtTheConsoleCLI(t *testing.T) {
	h := newHarness(t)
	bin := filepath.Dir(h.executable)
	cli := filepath.Join(bin, "backplane-companion.exe")
	for _, c := range []struct{ goos, running, want string }{
		// The logon task runs the windowless build, which must not repoint
		// hooks at itself.
		{"windows", filepath.Join(bin, windowlessDaemonName), cli},
		{"windows", filepath.Join(bin, "BACKPLANE-COMPANIOND.EXE"), cli},
		{"windows", cli, cli},
		// Elsewhere the service manager runs the CLI binary itself.
		{"linux", h.executable, h.executable},
		{"darwin", h.executable, h.executable},
	} {
		h.app.goos, h.app.executable = c.goos, c.running
		if got := h.app.agentEnv().Executable; got != c.want {
			t.Errorf("%s running %s: hooks point at %s, want %s", c.goos, c.running, got, c.want)
		}
	}
}

func TestStatusReportsACodexHooksFileCodexWouldReject(t *testing.T) {
	h := newHarness(t)
	codexHome := h.codexHome(t)
	invalid := `{"SessionStart":[{"hooks":[{"type":"command","command":"guard.sh"}]}]}`
	mustWrite(t, filepath.Join(codexHome, "hooks.json"), invalid)
	if err := h.run(t, "agents", "install", "codex"); err == nil {
		t.Fatal("install into a hooks.json Codex rejects must fail")
	}
	h.stdout.Reset()
	if err := h.run(t, "agents", "status", "codex"); err != nil {
		t.Fatal(err)
	}
	if action := h.stdout.String(); !strings.Contains(action, "invalid_config") || !strings.Contains(action, filepath.Join(codexHome, "hooks.json")) || strings.Contains(action, "(config_path)") {
		t.Fatalf("the action must name the rejected file: %s", action)
	}
	if data, _ := os.ReadFile(filepath.Join(codexHome, "hooks.json")); string(data) != invalid {
		t.Fatalf("hooks.json was written:\n%s", data)
	}
	report := h.status(t)
	for _, agent := range report.Agents {
		if agent.ID == "codex_cli" && (agent.State != "invalid_config" || agent.Broken) {
			t.Fatalf("codex status: %+v", agent)
		}
	}
}

// staleAppServer is a fake process table holding a Codex app-server that
// started long before any install; no real process is listed.
type staleAppServer struct{}

func (staleAppServer) Find(query process.Query) ([]process.Process, error) {
	executable := "/Applications/ChatGPT.app/Contents/Resources/codex"
	if !query.Executable(executable) || !query.Arguments([]string{executable, "app-server"}) {
		return nil, nil
	}
	return []process.Process{{PID: 31154, Executable: executable, StartedAt: time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)}}, nil
}

func TestCodexStatusReportsAStaleAppServer(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.codexHome(t)
	h.app.processes = staleAppServer{}
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	h.run(t, "agents", "status", "codex")
	if !strings.Contains(h.stdout.String(), `"restart_required"`) {
		t.Fatalf("status must name the stale Codex app: %s", h.stdout)
	}
}

func TestAttentionAsksToRestartTheCodexApp(t *testing.T) {
	h := newHarness(t)
	report := statusReport{Agents: []agentReport{
		{ID: "codex_cli", State: AgentStateIdle, Integration: agent.IntegrationStatus{State: agent.Installed, Problems: []string{agent.ProblemRestartRequired}}},
		{ID: "claude_code", State: AgentStateIdle, Integration: agent.IntegrationStatus{State: agent.Installed}},
	}}
	items := h.app.attention(report)
	if len(items) != 1 || items[0].Code != agent.ProblemRestartRequired || items[0].Severity != "warning" || items[0].Agent == nil || *items[0].Agent != "codex_cli" {
		t.Fatalf("attention: %+v", items)
	}
	if !strings.Contains(items[0].Message, "Restart the Codex app") {
		t.Fatalf("message: %q", items[0].Message)
	}

	report.Agents[0].Integration.Problems = []string{agent.ProblemDaemonRestartRequired}
	items = h.app.attention(report)
	if len(items) != 1 || items[0].Code != agent.ProblemDaemonRestartRequired || !strings.Contains(items[0].Message, "codex app-server daemon restart") {
		t.Fatalf("daemon attention: %+v", items)
	}

	report.Agents[0].Integration.Problems = nil
	if items := h.app.attention(report); len(items) != 0 {
		t.Fatalf("a restarted app clears the attention: %+v", items)
	}
}

func TestRequiredActionExplainsTheRestart(t *testing.T) {
	h := newHarness(t)
	action := h.app.requiredAction(agent.IntegrationStatus{State: agent.Installed, Problems: []string{agent.ProblemRestartRequired}})
	if !strings.Contains(action, "Restart the Codex app") {
		t.Fatalf("action: %q", action)
	}
	if action := h.app.requiredAction(agent.IntegrationStatus{State: agent.Installed}); action != "" {
		t.Fatalf("nothing to do: %q", action)
	}
}

func TestRequiredActionNamesTrustThenRestartForAnUntrustedStaleApp(t *testing.T) {
	h := newHarness(t)
	both := h.app.requiredAction(agent.IntegrationStatus{State: agent.NeedsTrust, Problems: []string{agent.ProblemRestartRequired}})
	trust, restart := strings.Index(both, "Trust all and continue"), strings.Index(both, "Restart the Codex app")
	if trust < 0 || restart < 0 || restart < trust {
		t.Fatalf("trust first, then restart: %q", both)
	}
	daemon := h.app.requiredAction(agent.IntegrationStatus{State: agent.NeedsTrust, Problems: []string{agent.ProblemDaemonRestartRequired}})
	if !strings.Contains(daemon, "Trust all and continue") || !strings.Contains(daemon, "codex app-server daemon restart") {
		t.Fatalf("trust and daemon restart: %q", daemon)
	}
	if trustOnly := h.app.requiredAction(agent.IntegrationStatus{State: agent.NeedsTrust}); strings.Contains(trustOnly, "Restart") || strings.Contains(trustOnly, "restart") {
		t.Fatalf("no stale app, no restart: %q", trustOnly)
	}
	if restartOnly := h.app.requiredAction(agent.IntegrationStatus{State: agent.Installed, Problems: []string{agent.ProblemRestartRequired}}); strings.Contains(restartOnly, "Trust all") {
		t.Fatalf("already trusted, no trust step: %q", restartOnly)
	}
}

func TestAttentionKeepsOneItemNamingTrustAndRestart(t *testing.T) {
	h := newHarness(t)
	report := statusReport{Agents: []agentReport{
		{ID: "codex_cli", State: AgentStateNeedsTrust, Integration: agent.IntegrationStatus{State: agent.NeedsTrust, Problems: []string{agent.ProblemRestartRequired}}},
	}}
	items := h.app.attention(report)
	if len(items) != 1 || items[0].Code != string(agent.NeedsTrust) {
		t.Fatalf("one needs_trust item per agent: %+v", items)
	}
	if !strings.Contains(items[0].Message, "Trust all and continue") || !strings.Contains(items[0].Message, "Restart the Codex app") {
		t.Fatalf("the item names both steps: %q", items[0].Message)
	}
}
