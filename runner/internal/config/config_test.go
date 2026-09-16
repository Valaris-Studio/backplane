// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadFromFile(t *testing.T) {
	content := `
valaris:
  api_url: "https://valaris.example.com"
  api_key: "vlr_test123"
  workspace_slug: "test-workspace"
  board_ids:
    - "board-1"
    - "board-2"

llm:
  provider: "claude-cli"
  model: "opus"
  max_budget_usd: 2.5
  mcp_config_path: "/opt/backplane/mcp.json"

git:
  base_dir: "/tmp/repos"
  branch_prefix: "agent/"
  auto_pr: false

work_loop:
  poll_interval: 5m
  max_concurrent: 2
  card_timeout: 1h
  idle_sleep: 10m
  priorities: ["urgent", "high"]

log_level: "debug"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Valaris.APIURL != "https://valaris.example.com" {
		t.Errorf("api_url = %q, want %q", cfg.Valaris.APIURL, "https://valaris.example.com")
	}
	if cfg.Valaris.APIKey != "vlr_test123" {
		t.Errorf("api_key = %q, want %q", cfg.Valaris.APIKey, "vlr_test123")
	}
	if cfg.Valaris.WorkspaceSlug != "test-workspace" {
		t.Errorf("workspace_slug = %q, want %q", cfg.Valaris.WorkspaceSlug, "test-workspace")
	}
	if len(cfg.Valaris.BoardIDs) != 2 {
		t.Errorf("board_ids len = %d, want 2", len(cfg.Valaris.BoardIDs))
	}
	if cfg.LLM.Model != "opus" {
		t.Errorf("model = %q, want %q", cfg.LLM.Model, "opus")
	}
	if cfg.LLM.MaxBudgetUSD != 2.5 {
		t.Errorf("max_budget_usd = %f, want 2.5", cfg.LLM.MaxBudgetUSD)
	}
	if cfg.LLM.MCPConfigPath != "/opt/backplane/mcp.json" {
		t.Errorf("mcp_config_path = %q, want %q", cfg.LLM.MCPConfigPath, "/opt/backplane/mcp.json")
	}
	if cfg.Git.BaseDir != "/tmp/repos" {
		t.Errorf("base_dir = %q, want %q", cfg.Git.BaseDir, "/tmp/repos")
	}
	if cfg.Git.BranchPrefix != "agent/" {
		t.Errorf("branch_prefix = %q, want %q", cfg.Git.BranchPrefix, "agent/")
	}
	if cfg.Git.AutoPR {
		t.Error("auto_pr = true, want false")
	}
	if cfg.WorkLoop.PollInterval != 5*time.Minute {
		t.Errorf("poll_interval = %v, want 5m", cfg.WorkLoop.PollInterval)
	}
	if cfg.WorkLoop.MaxConcurrent != 2 {
		t.Errorf("max_concurrent = %d, want 2", cfg.WorkLoop.MaxConcurrent)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("log_level = %q, want %q", cfg.LogLevel, "debug")
	}
}

// Backend /api/workspaces/{slug}/boards/{identifier} resolves either a UUID or
// a slug. The runner treats BoardIDs entries as opaque strings — no UUID parsing,
// no format assumption — so YAML authors can use either form, or mix them.
func TestConfig_BoardIDs_AcceptsSlugs(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
  board_ids:
    - "my-board"
    - "another-board"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"my-board", "another-board"}
	if len(cfg.Valaris.BoardIDs) != len(want) {
		t.Fatalf("BoardIDs len = %d, want %d", len(cfg.Valaris.BoardIDs), len(want))
	}
	for i, v := range want {
		if cfg.Valaris.BoardIDs[i] != v {
			t.Errorf("BoardIDs[%d] = %q, want %q", i, cfg.Valaris.BoardIDs[i], v)
		}
	}
}

func TestConfig_BoardIDs_MixedSlugAndUUID(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
  board_ids:
    - "82ab4c36-5004-4241-8674-690a30f11fdd"
    - "my-slug-board"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"82ab4c36-5004-4241-8674-690a30f11fdd", "my-slug-board"}
	if len(cfg.Valaris.BoardIDs) != len(want) {
		t.Fatalf("BoardIDs len = %d, want %d", len(cfg.Valaris.BoardIDs), len(want))
	}
	for i, v := range want {
		if cfg.Valaris.BoardIDs[i] != v {
			t.Errorf("BoardIDs[%d] = %q, want %q", i, cfg.Valaris.BoardIDs[i], v)
		}
	}
}

func TestEnvOverrides(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_from_file"
  workspace_slug: "from-file"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	t.Setenv("VALARIS_API_KEY", "vlr_from_env")
	t.Setenv("VALARIS_WORKSPACE", "from-env")
	t.Setenv("VALARIS_API_URL", "https://override.example.com")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Valaris.APIKey != "vlr_from_env" {
		t.Errorf("api_key = %q, want env override %q", cfg.Valaris.APIKey, "vlr_from_env")
	}
	if cfg.Valaris.WorkspaceSlug != "from-env" {
		t.Errorf("workspace_slug = %q, want env override %q", cfg.Valaris.WorkspaceSlug, "from-env")
	}
	if cfg.Valaris.APIURL != "https://override.example.com" {
		t.Errorf("api_url = %q, want env override", cfg.Valaris.APIURL)
	}
}

func TestDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "default-test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Valaris.APIURL != "http://localhost:8000" {
		t.Errorf("default api_url = %q, want localhost", cfg.Valaris.APIURL)
	}
	if cfg.LLM.Provider != "claude-cli" {
		t.Errorf("default provider = %q, want claude-cli", cfg.LLM.Provider)
	}
	if cfg.Git.DefaultRemote != "origin" {
		t.Errorf("default remote = %q, want origin", cfg.Git.DefaultRemote)
	}
	if cfg.WorkLoop.PollInterval != 2*time.Minute {
		t.Errorf("default poll_interval = %v, want 2m", cfg.WorkLoop.PollInterval)
	}
	if cfg.WorkLoop.ApprovalPollInterval != 30*time.Second {
		t.Errorf("default approval_poll_interval = %v, want 30s", cfg.WorkLoop.ApprovalPollInterval)
	}
	if cfg.WorkLoop.ApprovalMaxWait != 1*time.Hour {
		t.Errorf("default approval_max_wait = %v, want 1h", cfg.WorkLoop.ApprovalMaxWait)
	}
}

func TestDaemonConfigDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Daemon.DrainTimeout != 60*time.Second {
		t.Errorf("default drain_timeout = %v, want 60s", cfg.Daemon.DrainTimeout)
	}
	if cfg.Daemon.HealthPort != 0 {
		t.Errorf("default health_port = %d, want 0", cfg.Daemon.HealthPort)
	}
	if cfg.Daemon.HealthBind != "127.0.0.1" {
		t.Errorf("default health_bind = %q, want 127.0.0.1", cfg.Daemon.HealthBind)
	}
}

func TestDaemonConfigFromYAML(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
daemon:
  drain_timeout: 30s
  health_port: 9090
  health_bind: "0.0.0.0"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Daemon.DrainTimeout != 30*time.Second {
		t.Errorf("drain_timeout = %v, want 30s", cfg.Daemon.DrainTimeout)
	}
	if cfg.Daemon.HealthPort != 9090 {
		t.Errorf("health_port = %d, want 9090", cfg.Daemon.HealthPort)
	}
	if cfg.Daemon.HealthBind != "0.0.0.0" {
		t.Errorf("health_bind = %q, want 0.0.0.0", cfg.Daemon.HealthBind)
	}
}

func TestValidationMissingAPIKey(t *testing.T) {
	content := `
valaris:
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	t.Setenv("VALARIS_API_KEY", "")

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected validation error for missing api_key")
	}
}

func TestValidationMissingWorkspace(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	t.Setenv("VALARIS_WORKSPACE", "")

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected validation error for missing workspace_slug")
	}
}

func TestValidationMissingMCPConfig(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected validation error for missing mcp_config_path")
	}
}

func TestGitConfigDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Git.MergeStrategy != "squash" {
		t.Errorf("default MergeStrategy = %q, want squash", cfg.Git.MergeStrategy)
	}
	if !cfg.Git.ReviewOnGitHub {
		t.Error("default ReviewOnGitHub = false, want true")
	}
	if !cfg.Git.ForceWithLease {
		t.Error("default ForceWithLease = false, want true")
	}
}

func TestGitConfigDefaults_ReviewMode(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	// Default is "platform" (comment-only): the runner uses a single `gh` identity
	// for both PR creation and review, and GitHub refuses self-approval
	// ("Can not approve your own pull request"), so the "github" formal-review
	// path cannot succeed on a single-identity install. Auto-merge is gated by
	// required status checks instead (see EnsureBranchProtection) — no review
	// decision needed. Operators running a two-identity setup (e.g. a GitHub App
	// installed as a separate reviewer bot) can opt in to review_mode: github.
	if cfg.Git.ReviewMode != "platform" {
		t.Errorf("default ReviewMode = %q, want %q", cfg.Git.ReviewMode, "platform")
	}
}

func TestGitConfigFromYAML_ReviewMode_GitHub(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
git:
  review_mode: github
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Git.ReviewMode != "github" {
		t.Errorf("ReviewMode = %q, want %q", cfg.Git.ReviewMode, "github")
	}
}

func TestGitConfigFromYAML_ReviewMode_Platform(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
git:
  review_mode: platform
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Git.ReviewMode != "platform" {
		t.Errorf("ReviewMode = %q, want %q", cfg.Git.ReviewMode, "platform")
	}
}

// Cluster III: TestGitConfigDefaults_MergeTrigger and
// TestGitConfigFromYAML_MergeTrigger were removed with the merge_trigger /
// auto_merge config fields. The runner no longer arms GitHub auto-merge.

func TestGitConfigFromYAML(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
git:
  merge_strategy: rebase
  review_on_github: false
  force_with_lease: false
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Git.MergeStrategy != "rebase" {
		t.Errorf("MergeStrategy = %q, want rebase", cfg.Git.MergeStrategy)
	}
	if cfg.Git.ReviewOnGitHub {
		t.Error("ReviewOnGitHub = true, want false")
	}
	if cfg.Git.ForceWithLease {
		t.Error("ForceWithLease = true, want false")
	}
}

func TestWebSocketDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if !cfg.WebSocket.Enabled {
		t.Error("WebSocket.Enabled = false, want true")
	}
	if cfg.WebSocket.ReconnectMin != 1*time.Second {
		t.Errorf("WebSocket.ReconnectMin = %v, want 1s", cfg.WebSocket.ReconnectMin)
	}
	if cfg.WebSocket.ReconnectMax != 30*time.Second {
		t.Errorf("WebSocket.ReconnectMax = %v, want 30s", cfg.WebSocket.ReconnectMax)
	}
}

func TestWebSocketFromYAML(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
websocket:
  enabled: false
  reconnect_min: 5s
  reconnect_max: 2m
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.WebSocket.Enabled {
		t.Error("WebSocket.Enabled = true, want false")
	}
	if cfg.WebSocket.ReconnectMin != 5*time.Second {
		t.Errorf("WebSocket.ReconnectMin = %v, want 5s", cfg.WebSocket.ReconnectMin)
	}
	if cfg.WebSocket.ReconnectMax != 2*time.Minute {
		t.Errorf("WebSocket.ReconnectMax = %v, want 2m", cfg.WebSocket.ReconnectMax)
	}
}

func TestWebSocketEnvDisable(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
websocket:
  enabled: true
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	t.Setenv("VALARIS_WS_ENABLED", "false")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.WebSocket.Enabled {
		t.Error("WebSocket.Enabled = true after VALARIS_WS_ENABLED=false, want false")
	}
}

func TestWebSocketEnvDisableZero(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	t.Setenv("VALARIS_WS_ENABLED", "0")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.WebSocket.Enabled {
		t.Error("WebSocket.Enabled = true after VALARIS_WS_ENABLED=0, want false")
	}
}

func TestConfig_SchedulingDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	// The platform's pipeline_config.scheduling is authoritative; YAML defaults
	// must NOT pre-populate PriorityOrder (would silently override the platform
	// value at runtime — see audits/runner-launch-walkthrough-2026-04-18.md B1).
	sched := cfg.WorkLoop.Scheduling
	if sched.Strategy != "priority" {
		t.Errorf("Scheduling.Strategy = %q, want %q", sched.Strategy, "priority")
	}
	if len(sched.PriorityOrder) != 0 {
		t.Errorf("Scheduling.PriorityOrder must be empty by default, got %v", sched.PriorityOrder)
	}
	if sched.MaxConsecutive != 0 {
		t.Errorf("MaxConsecutive must be unset by default (platform-authoritative), got %d", sched.MaxConsecutive)
	}
	if sched.StarvationPrevention {
		t.Error("StarvationPrevention must be unset by default (platform-authoritative)")
	}
}

func TestConfig_SchedulingFromYAML(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
work_loop:
  scheduling:
    strategy: "priority"
    priority_order: ["documentator", "reviewer"]
    max_consecutive_same_role: 3
    starvation_prevention: false
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	sched := cfg.WorkLoop.Scheduling
	if sched.Strategy != "priority" {
		t.Errorf("Strategy = %q, want %q", sched.Strategy, "priority")
	}
	if len(sched.PriorityOrder) != 2 {
		t.Fatalf("PriorityOrder len = %d, want 2", len(sched.PriorityOrder))
	}
	if sched.PriorityOrder[0] != "documentator" {
		t.Errorf("PriorityOrder[0] = %q, want %q", sched.PriorityOrder[0], "documentator")
	}
	if sched.MaxConsecutive != 3 {
		t.Errorf("MaxConsecutive = %d, want 3", sched.MaxConsecutive)
	}
	if sched.StarvationPrevention {
		t.Error("StarvationPrevention = true, want false")
	}
}

func TestConfig_TelemetryDefaults(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Telemetry.Enabled {
		t.Error("Telemetry.Enabled = true, want false")
	}
	if cfg.Telemetry.Exporter != "otlp" {
		t.Errorf("Telemetry.Exporter = %q, want %q", cfg.Telemetry.Exporter, "otlp")
	}
	if cfg.Telemetry.Endpoint != "localhost:4317" {
		t.Errorf("Telemetry.Endpoint = %q, want %q", cfg.Telemetry.Endpoint, "localhost:4317")
	}
	if cfg.Telemetry.ServiceName != "backplane-runner" {
		t.Errorf("Telemetry.ServiceName = %q, want %q", cfg.Telemetry.ServiceName, "backplane-runner")
	}
	if cfg.Telemetry.SampleRate != 1.0 {
		t.Errorf("Telemetry.SampleRate = %f, want 1.0", cfg.Telemetry.SampleRate)
	}
}

func TestGitTokensParsing(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
git:
  tokens:
    orchestrator: "ghp_orchestrator_token"
    reviewer: "ghp_reviewer_token"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if len(cfg.Git.Tokens) != 2 {
		t.Fatalf("Git.Tokens len = %d, want 2", len(cfg.Git.Tokens))
	}
	if cfg.Git.Tokens["orchestrator"] != "ghp_orchestrator_token" {
		t.Errorf("Tokens[orchestrator] = %q, want %q", cfg.Git.Tokens["orchestrator"], "ghp_orchestrator_token")
	}
	if cfg.Git.Tokens["reviewer"] != "ghp_reviewer_token" {
		t.Errorf("Tokens[reviewer] = %q, want %q", cfg.Git.Tokens["reviewer"], "ghp_reviewer_token")
	}
}

func TestGitTokensParsing_Empty(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Git.Tokens != nil && len(cfg.Git.Tokens) != 0 {
		t.Errorf("Git.Tokens should be nil or empty when not configured, got %v", cfg.Git.Tokens)
	}
}

func TestConfig_TelemetryFromYAML(t *testing.T) {
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
telemetry:
  enabled: true
  exporter: stdout
  endpoint: "otel-collector:4317"
  service_name: "my-agent"
  sample_rate: 0.5
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if !cfg.Telemetry.Enabled {
		t.Error("Telemetry.Enabled = false, want true")
	}
	if cfg.Telemetry.Exporter != "stdout" {
		t.Errorf("Telemetry.Exporter = %q, want %q", cfg.Telemetry.Exporter, "stdout")
	}
	if cfg.Telemetry.Endpoint != "otel-collector:4317" {
		t.Errorf("Telemetry.Endpoint = %q, want %q", cfg.Telemetry.Endpoint, "otel-collector:4317")
	}
	if cfg.Telemetry.ServiceName != "my-agent" {
		t.Errorf("Telemetry.ServiceName = %q, want %q", cfg.Telemetry.ServiceName, "my-agent")
	}
	if cfg.Telemetry.SampleRate != 0.5 {
		t.Errorf("Telemetry.SampleRate = %f, want 0.5", cfg.Telemetry.SampleRate)
	}
}

func TestProviderSet_DefaultOnly(t *testing.T) {
	c := &LLMConfig{Provider: "claude-cli"}
	got := c.ProviderSet()
	if len(got) != 1 || got[0] != "claude-cli" {
		t.Fatalf("expected [claude-cli], got %v", got)
	}
}

func TestProviderSet_DefaultPlusExtras_DedupedDefaultFirst(t *testing.T) {
	c := &LLMConfig{Provider: "codex-cli", ExtraProviders: []string{"claude-cli", "codex-cli", ""}}
	got := c.ProviderSet()
	// default first, dedup the repeated codex-cli, drop the empty string.
	want := []string{"codex-cli", "claude-cli"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

func TestProviderSet_EmptyDefaultDropped(t *testing.T) {
	c := &LLMConfig{Provider: "", ExtraProviders: []string{"codex-cli"}}
	got := c.ProviderSet()
	if len(got) != 1 || got[0] != "codex-cli" {
		t.Fatalf("expected [codex-cli], got %v", got)
	}
}

func TestProviderSet_IncludesTierProviderEntries(t *testing.T) {
	// A provider named ONLY in tier_providers must still be built+preflighted,
	// else a tier remap would point at an unbuilt provider.
	c := &LLMConfig{
		Provider: "codex-cli",
		TierProviders: map[string][]string{
			"premium": {"claude-cli", "codex-cli"},
			"mid":     {"codex-cli"},
		},
	}
	got := c.ProviderSet()
	want := map[string]bool{"codex-cli": false, "claude-cli": false}
	for _, p := range got {
		if _, ok := want[p]; !ok {
			t.Fatalf("unexpected provider %q in set %v", p, got)
		}
		want[p] = true
	}
	for p, seen := range want {
		if !seen {
			t.Fatalf("expected %q in provider set, got %v", p, got)
		}
	}
	if got[0] != "codex-cli" {
		t.Fatalf("default provider must come first, got %v", got)
	}
}

// --- git.base_dir containment guard -----------------------------------------
//
// A relative or ill-placed git.base_dir puts the runner's clone root INSIDE a
// live git worktree. A later `git reset --hard origin/<default>` then walks up
// to the enclosing .git and rewinds the operator's real repository — this
// destroyed 25 unpushed commits on 2026-07-27. Two invariants pin the cure:
//   1. base_dir must not resolve inside any git worktree (checked by walking up).
//   2. a relative base_dir resolves against the CONFIG FILE's directory, never
//      the process CWD, so launching a runner from inside a repo is harmless.

// initGitRepo makes dir a real git worktree, skipping the test when no git
// binary is available. Real `git init` (not a hand-rolled .git) so the guard is
// exercised against the layout it will meet in production.
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git binary not available")
	}
	cmd := exec.Command(gitBin, "init", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init %s: %v\n%s", dir, err, out)
	}
}

func writeConfig(t *testing.T, dir, baseDir string) string {
	t.Helper()
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
git:
  base_dir: "` + baseDir + `"
`
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestValidation_RejectsBaseDirInsideGitRepo(t *testing.T) {
	worktree := t.TempDir()
	initGitRepo(t, worktree)

	configDir := t.TempDir()
	baseDir := filepath.Join(worktree, "repos")
	path := writeConfig(t, configDir, baseDir)

	_, err := Load(path)
	if err == nil {
		t.Fatalf("expected error: git.base_dir %q is inside git worktree %q; a reset --hard would rewind the live repo", baseDir, worktree)
	}
	// The operator must be told WHICH ancestor is the offending repo, else the
	// error is unactionable.
	if !strings.Contains(err.Error(), worktree) {
		t.Errorf("error must name the offending git worktree %q so an operator can act on it, got: %v", worktree, err)
	}
}

func TestValidation_RejectsBaseDirWhoseAncestorIsGitRepo(t *testing.T) {
	worktree := t.TempDir()
	initGitRepo(t, worktree)

	configDir := t.TempDir()
	// Several levels deep, and the intermediate dirs do not exist yet — the
	// guard must WALK UP, not just stat the immediate parent.
	baseDir := filepath.Join(worktree, "a", "b", "repos")
	path := writeConfig(t, configDir, baseDir)

	_, err := Load(path)
	if err == nil {
		t.Fatalf("expected error: git.base_dir %q has git worktree ancestor %q; guard must walk up the path", baseDir, worktree)
	}
	if !strings.Contains(err.Error(), worktree) {
		t.Errorf("error must name the offending git worktree ancestor %q, got: %v", worktree, err)
	}
}

// A base_dir that IS a symlink into a worktree is the hole a purely lexical
// walk leaves open: filepath.Dir climbs the link's parents, never the target's,
// but git resolves the target and would rewind it.
func TestValidation_RejectsBaseDirSymlinkedIntoGitRepo(t *testing.T) {
	worktree := t.TempDir()
	initGitRepo(t, worktree)
	target := filepath.Join(worktree, "repos")
	if err := os.MkdirAll(target, 0755); err != nil {
		t.Fatal(err)
	}

	anchor := t.TempDir()
	link := filepath.Join(anchor, "repos")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	_, err := Load(writeConfig(t, t.TempDir(), link))
	if err == nil {
		t.Fatalf("expected error: git.base_dir %q symlinks into worktree %q, which git resolves and would rewind", link, worktree)
	}
}

// `git worktree add` and submodules write .git as a regular FILE containing a
// gitdir: pointer. A reset --hard there still reaches the real repository.
func TestValidation_RejectsBaseDirUnderGitFileWorktree(t *testing.T) {
	worktree := t.TempDir()
	if err := os.WriteFile(filepath.Join(worktree, ".git"), []byte("gitdir: /elsewhere/.git/worktrees/x\n"), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := Load(writeConfig(t, t.TempDir(), filepath.Join(worktree, "repos")))
	if err == nil {
		t.Fatal("a .git regular file marks a linked worktree or submodule — the guard must reject it, not only .git directories")
	}
}

// An ancestor we cannot read could be hiding a .git, so the guard must fail
// closed rather than silently read as "no worktree". Symlink resolution and the
// .git walk each surface the permission error independently, so this passes
// while either branch survives — it pins the property, not one implementation.
func TestValidation_UnreadableAncestorFailsClosed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(filepath.Join(locked, "repos"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0755) })

	if _, err := Load(writeConfig(t, t.TempDir(), filepath.Join(locked, "repos"))); err == nil {
		t.Fatal("an unreadable ancestor could hide a .git — the guard must fail closed rather than accept")
	}
}

func TestValidation_RelativeBaseDirResolvesAgainstConfigDir(t *testing.T) {
	// Neither dir is inside a git repo (t.TempDir is under /var/folders on
	// macOS, /tmp on Linux) so only the resolution base is under test.
	configDir := t.TempDir()
	cwdDir := t.TempDir()
	path := writeConfig(t, configDir, "./repos")

	t.Chdir(cwdDir)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected relative base_dir to load, got: %v", err)
	}

	if base := filepath.Base(cfg.Git.BaseDir); base != "repos" {
		t.Fatalf("Git.BaseDir = %q, want it to end in %q", cfg.Git.BaseDir, "repos")
	}
	// Compare the PARENT dirs: they exist on disk, so EvalSymlinks can resolve
	// both sides (/var/folders is a symlink to /private/var/folders on macOS,
	// and filepath.Abs does not resolve it). The joined base_dir does not exist
	// yet, so resolving it directly would silently no-op on one side only.
	got := realPath(t, filepath.Dir(cfg.Git.BaseDir))
	want := realPath(t, configDir)
	if got != want {
		t.Errorf("Git.BaseDir resolved under %q, want %q — a relative base_dir must resolve against the config file's directory, not the process CWD (%q)", got, want, cwdDir)
	}
}

// realPath resolves symlinks so paths from different sources compare equal.
func realPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("resolving %q: %v", path, err)
	}
	return resolved
}

// An unset base_dir is the shipped default, and filepath.Join("", name) makes
// clones land relative to the process CWD — the same rewind hazard as an
// explicit relative path, so it must resolve against the config dir too.
func TestValidation_EmptyBaseDirResolvesAgainstConfigDir(t *testing.T) {
	configDir := t.TempDir()
	cwdDir := t.TempDir()
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "/tmp/mcp.json"
`
	path := filepath.Join(configDir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	t.Chdir(cwdDir)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected empty base_dir to load, got: %v", err)
	}
	if !filepath.IsAbs(cfg.Git.BaseDir) {
		t.Fatalf("Git.BaseDir = %q, want an absolute path — an empty base_dir must not stay CWD-relative", cfg.Git.BaseDir)
	}
	got, want := realPath(t, cfg.Git.BaseDir), realPath(t, configDir)
	if got != want {
		t.Errorf("Git.BaseDir = %q, want %q — an unset base_dir must anchor to the config dir, not the CWD (%q)", got, want, cwdDir)
	}
}

func TestValidation_AcceptsBaseDirOutsideGitRepo(t *testing.T) {
	// Negative control: a guard that rejected everything would satisfy the two
	// rejection tests above. A plain absolute base_dir with no .git ancestor
	// must still load.
	configDir := t.TempDir()
	baseDir := filepath.Join(t.TempDir(), "repos")
	path := writeConfig(t, configDir, baseDir)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("base_dir %q has no git ancestor and must be accepted, got: %v", baseDir, err)
	}
	if cfg.Git.BaseDir != baseDir {
		t.Errorf("Git.BaseDir = %q, want %q unchanged", cfg.Git.BaseDir, baseDir)
	}
}

func TestProvidersForTier_FirstAvailableWins(t *testing.T) {
	c := &LLMConfig{
		Provider: "codex-cli",
		TierProviders: map[string][]string{
			"premium": {"claude-cli", "codex-cli"},
		},
	}
	got := c.ProvidersForTier("premium")
	if len(got) != 2 || got[0] != "claude-cli" || got[1] != "codex-cli" {
		t.Fatalf("expected preference list [claude-cli codex-cli], got %v", got)
	}
	if c.ProvidersForTier("mid") != nil {
		t.Fatalf("unmapped tier must return nil, got %v", c.ProvidersForTier("mid"))
	}
	if c.ProvidersForTier("") != nil {
		t.Fatalf("empty tier must return nil")
	}
}
