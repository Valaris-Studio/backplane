// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/daemon"
	"github.com/Valaris-Studio/backplane/runner/internal/events"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/health"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/telemetry"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/version"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
)

func main() {
	configPath := flag.String("config", "", "Path to config YAML file")
	profileName := flag.String("profile", "", "Named profile to run with: uses <config home>/profiles/<name>/runner.yaml and its stored credentials. Mutually exclusive with -config.")
	discover := flag.Bool("discover", false, "Discovery mode: list boards and unassigned cards via MCP, then exit")
	doctor := flag.Bool("doctor", false, "Doctor mode: read-only check of this machine (coding agents, git, forge CLI, credentials, backend, MCP config, work dir), then exit. Never starts an agent and never spends.")
	fix := flag.Bool("fix", false, "With -doctor: write a working mcp-config.json when none is configured (requires resolved credentials and uvx on PATH). Meaningless alone — -fix without -doctor is an error.")
	loopFlag := flag.Bool("loop", false, "Loop mode: bind to one board and repeat a headless agent session on an operator-authored prompt, exiting when the platform loop config disables or a safety rail trips (see -keep-alive to wait for a re-enable instead)")
	loopBoard := flag.String("loop-board", "", "Board ID for -loop mode (overrides valaris.board_ids / platform board_id binding)")
	keepAlive := flag.Bool("keep-alive", false, "With -loop: when the board's loop is switched off, wait for it to be re-enabled instead of exiting. Safety rails (budget, max_iterations, completion_query) still exit. Overrides loop_mode.keep_alive only when passed explicitly.")
	runProvider := flag.String("run-provider", "", "With -loop and -run-model: provider for this invocation only; never saved to config, profile, or board")
	runModel := flag.String("run-model", "", "With -loop and -run-provider: exact model for this invocation only; CLI presence does not verify model/account access")
	showVersion := flag.Bool("version", false, "Print version and exit")
	noSupervisor := flag.Bool("no-supervisor", false, "Disable panic recovery; let the work loop crash on panic (debug only). Also enabled by VALARIS_NO_SUPERVISOR=1.")
	verbose := flag.Bool("verbose", false, "Verbose operator output: Debug-level logs + full attrs (UUIDs, paths, internal IDs). Default emits Info-level with compacted attrs.")
	flag.Bool(interactiveFlagName, false, "Force the interactive setup wizard. Runs by default on a bare invocation from a terminal; never runs without a TTY on both stdin and stdout.")
	flag.Parse()
	if os.Getenv("VALARIS_NO_SUPERVISOR") == "1" {
		*noSupervisor = true
	}

	if *showVersion {
		fmt.Printf("backplane-runner %s (commit=%s built=%s)\n", version.Version, version.GitCommit, version.BuildTime)
		return
	}

	// Checked ahead of every dispatch below, including the wizard's: a -fix the
	// wizard branch swallowed would leave the operator believing a config was
	// written.
	if err := requireDoctorForFix(*doctor, *fix); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitCodeUsage)
	}

	interactive, _ := interactiveFlagValue(os.Args[1:])
	runOverride, err := parseRunOverride(*runProvider, *runModel, flagWasPassed("run-provider") || flagWasPassed("run-model"), *loopFlag, *doctor, *discover, interactive)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitCodeUsage)
	}

	if err := validateInteractiveSelectionFlags(interactive, flagWasPassed("config"), flagWasPassed("profile")); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitCodeUsage)
	}

	// The wizard is an alternative way to REACH the modes below, never a new
	// mode: it produces a config plus a mode and then falls into the same
	// runDiscovery / runLoopMode / runPipelineMode calls. Every non-TTY
	// invocation skips it entirely and keeps today's exact behavior, including
	// today's exact error when config is missing.
	if shouldRunInteractive(os.Args[1:], telemetry.IsTerminal(os.Stdin), telemetry.IsTerminal(os.Stdout)) {
		runInteractive(*verbose, *noSupervisor)
		return
	}

	// Doctor runs ahead of config.Load on purpose: a config too broken to load
	// is one of the things it diagnoses, so exiting on that error first would
	// deny the operator the report that explains it. It falls back to whatever
	// credentials the environment and the conventional config paths yield.
	if *doctor {
		homeDir, _ := os.UserHomeDir()
		workDir, _ := os.Getwd()
		// -profile routes through the store exactly as the run path does, so
		// doctor diagnoses the profile's runner.yaml, not a discovered one.
		doctorConfigPath, err := resolveDoctorConfigPath(profile.DefaultRoot(), *configPath, *profileName)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			if errors.Is(err, profile.ErrConflictingFlags) {
				os.Exit(exitCodeUsage)
			}
			os.Exit(1)
		}
		cfg := doctorConfigForReport(doctorConfigPath)
		if warnings, err := pinProfileCredentials(cfg, profile.DefaultRoot(), *profileName); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		} else {
			for _, warning := range warnings {
				fmt.Fprintf(os.Stderr, "warning: %s\n", warning)
			}
		}
		if cfg != nil {
			cfg.LLM.RunOverride = runOverride
			if *loopBoard != "" {
				cfg.Valaris.BoardIDs = []string{*loopBoard}
			}
		}
		creds := doctorCredentials(cfg, doctorConfigPath, homeDir, workDir)
		if *fix {
			os.Exit(runDoctorFix(context.Background(), cfg, creds, workDir))
		}
		os.Exit(runDoctor(context.Background(), cfg, creds))
	}

	resolvedConfigPath, err := profile.ResolveRunConfigPath(profile.DefaultRoot(), *configPath, *profileName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		if errors.Is(err, profile.ErrConflictingFlags) {
			os.Exit(exitCodeUsage)
		}
		os.Exit(1)
	}

	cfg, err := config.Load(resolvedConfigPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if warnings, err := pinProfileCredentials(cfg, profile.DefaultRoot(), *profileName); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	} else {
		for _, warning := range warnings {
			fmt.Fprintf(os.Stderr, "warning: %s\n", warning)
		}
	}

	cfg.LLM.RunOverride = runOverride
	if err := preflight(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	setupLogger(cfg.LogLevel, *verbose)

	// Initialize telemetry (noop when disabled).
	telemetryShutdown, err := telemetry.Init(context.Background(), cfg.Telemetry)
	if err != nil {
		slog.Error("failed to initialize telemetry", "error", err)
	} else {
		defer telemetryShutdown(context.Background())
	}

	// Minimal REST call: resolve identity behind the API key.
	client := valaris.NewClient(cfg.Valaris.APIURL, cfg.Valaris.APIKey)
	ctx := context.Background()
	if err := client.Init(ctx); err != nil {
		slog.Error("failed to authenticate", "error", err)
		os.Exit(1)
	}
	slog.Info("authenticated", "user_id", client.UserID)

	if client.Agent != nil {
		slog.Info("agent identity resolved",
			"agent_id", client.Agent.ID,
			"agent_type", client.Agent.AgentType,
			"allowed_workspaces", client.Agent.AllowedWorkspaces,
		)
	} else {
		slog.Warn("no agent linked to API key, running as plain user")
	}

	if err := validateAgentConfig(client.Agent, cfg.Valaris.WorkspaceSlug); err != nil {
		slog.Error("agent config validation failed", "error", err)
		os.Exit(1)
	}

	if err := client.Heartbeat(ctx); err != nil {
		slog.Warn("initial heartbeat failed", "error", err)
	}

	// Build the coding-agent providers. The default (cfg.LLM.Provider) plus any
	// llm.extra_providers, so a pipeline can mix agents per stage. providers is
	// keyed on provider string; defaultProvider is the fallback for stages that
	// declare none.
	providers, defaultProvider := buildProviders(cfg)
	slog.Info("llm providers ready",
		"default", defaultProvider.Name(), "available", launchProviderSet(cfg), "model", launchModel(cfg))

	if *discover {
		runDiscovery(ctx, cfg, defaultProvider)
		return
	}

	if *loopFlag {
		cfg.LoopMode.KeepAlive = resolveKeepAlive(cfg.LoopMode.KeepAlive, *keepAlive, flagWasPassed("keep-alive"))
		runLoopMode(ctx, cfg, client, providers, defaultProvider, *loopBoard)
		return
	}

	runPipelineMode(ctx, cfg, client, providers, defaultProvider, *noSupervisor)
}

// runPipelineMode drives the multi-role pipeline work loop: the runner's
// default mode when neither -discover nor -loop is given.
func runPipelineMode(ctx context.Context, cfg *config.Config, client *valaris.Client, providers map[string]llm.Provider, defaultProvider llm.Provider, noSupervisor bool) {
	// Dual-context signal handling for graceful shutdown:
	// - rootCtx: force-shutdown boundary (cancelled on second signal or drain timeout)
	// - loopCtx: stops the polling loop (cancelled on first signal)
	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()
	loopCtx, loopCancel := context.WithCancel(rootCtx)
	defer loopCancel()

	// Buffered so routeEvent never blocks on a runner that is already draining.
	restartRequested := make(chan struct{}, 1)

	// Health collector tracks runtime metrics and feeds both /healthz and heartbeat.
	hc := health.NewCollector(cfg.WorkLoop.PollInterval, cfg.WorkLoop.CardTimeout, cfg.Daemon.HealthPort)

	// Build the work loop first so we can pass TriggerPoll to the health server.
	gitMgr := &git.Manager{
		BaseDir:       cfg.Git.BaseDir,
		DefaultRemote: cfg.Git.DefaultRemote,
		BranchPrefix:  cfg.Git.BranchPrefix,
	}
	loop, err := workloop.New(ctx, client, defaultProvider, gitMgr, cfg, hc)
	if err != nil {
		slog.Error("failed to build work loop", "error", err)
		os.Exit(1)
	}
	// Register the per-stage provider registry so a stage whose pipeline_config
	// declares llm.provider runs on that provider (else the default).
	loop.SetProviders(providers)

	// Start health server if configured.
	if cfg.Daemon.HealthPort > 0 {
		addr, err := daemon.StartHealthServer(rootCtx, cfg.Daemon.HealthPort, cfg.Daemon.HealthBind, hc, loop.TriggerPoll)
		if err != nil {
			slog.Error("failed to start health server", "error", err)
			os.Exit(1)
		}
		slog.Info("health server started", "addr", addr)
	}

	// Start WebSocket event client if enabled — routes real-time events to the work loop
	// and provides near-instant approval notifications.
	if cfg.WebSocket.Enabled {
		agentID := ""
		if client.Agent != nil {
			agentID = client.Agent.ID
		}
		wsClient := events.NewClient(cfg.Valaris.APIURL, cfg.Valaris.APIKey, cfg.Valaris.WorkspaceSlug, agentID, client.UserID, loop.TriggerPoll)
		wsClient.SetReconnectTiming(cfg.WebSocket.ReconnectMin, cfg.WebSocket.ReconnectMax)
		// An operator restart drains exactly like SIGTERM — cancel the poll loop,
		// let the in-flight card finish, exit 0. Reusing the signal path rather
		// than adding a second shutdown route means restart inherits the drain
		// timeout and the force-shutdown escape hatch for free. Bringing the
		// process back is the supervisor's job, not the runner's.
		wsClient.SetRestartRequested(restartRequested)
		loop.SetApprovalSubscriber(wsClient)
		loop.SetHeartbeatSender(wsClient)
		go func() {
			if err := wsClient.Run(rootCtx); err != nil && rootCtx.Err() == nil {
				slog.Warn("websocket client exited", "error", err)
			}
		}()
		slog.Info("websocket client started")
	}

	// Signal handler goroutine. A drain starts on either an OS signal or an
	// operator restart pushed over the WS — both mean "stop taking new cards".
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		var sig os.Signal
		select {
		case sig = <-sigCh:
			slog.Info("received signal, draining", "signal", sig)
		case <-restartRequested:
			slog.Info("restart requested, draining")
		}
		hc.SetStatus("draining")
		loopCancel()

		// Wait for drain timeout or second signal.
		select {
		case sig = <-sigCh:
			slog.Warn("received second signal, forcing shutdown", "signal", sig)
		case <-time.After(cfg.Daemon.DrainTimeout):
			slog.Warn("drain timeout expired, forcing shutdown")
		}
		hc.SetStatus("shutting_down")
		rootCancel()
	}()

	logStartupBanner(cfg)

	supervised := func(ctx context.Context) error {
		return loop.Run(ctx, rootCtx)
	}
	err = workloop.Supervise(loopCtx, supervised, workloop.SupervisorConfig{
		DisableRecover: noSupervisor,
	})
	// loopCtx-cancelled shutdowns surface as context.Canceled — clean exit.
	if err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("work loop exited", "error", err)
		os.Exit(1)
	}

	slog.Info("clean shutdown complete")
}

// providerByName constructs a single coding-agent provider by its config
// string. Returns nil for an unknown name so the caller can fail loudly.
func providerByName(name string) llm.Provider {
	switch name {
	case "claude-cli":
		return llm.NewClaudeCLI()
	case "codex-cli":
		return llm.NewCodexCLI()
	default:
		return nil
	}
}

// buildProviders builds the per-stage provider registry from cfg.LLM
// (default Provider + ExtraProviders) and returns it along with the default
// provider used as the fallback for stages that declare none. Exits loudly on
// an unknown provider name — same severity as the old single-provider path.
func buildProviders(cfg *config.Config) (map[string]llm.Provider, llm.Provider) {
	registry := make(map[string]llm.Provider)
	for _, name := range launchProviderSet(cfg) {
		p := providerByName(name)
		if p == nil {
			slog.Error("unknown LLM provider", "provider", name)
			os.Exit(1)
		}
		registry[name] = p
	}
	defaultProvider, ok := registry[launchDefaultProvider(cfg)]
	if !ok {
		// ProviderSet always includes a non-empty Provider; an empty default
		// is a misconfiguration the preflight/ProviderSet should surface.
		slog.Error("no default LLM provider configured (llm.provider is empty)")
		os.Exit(1)
	}
	return registry, defaultProvider
}

// runDiscovery invokes the LLM with MCP tools to discover available work.
// All Valaris interactions happen through MCP — the Go binary only orchestrates.
func runDiscovery(ctx context.Context, cfg *config.Config, provider llm.Provider) {
	prompt := fmt.Sprintf(`You have access to Valaris MCP tools. Perform a discovery scan and report what you find.

WORKSPACE: %s

Steps:
1. Call list_boards(workspace_slug="%s") to find all boards.
2. For each board, call list_git_repos to check if git repos are linked.
3. For each board, call search_cards with has_assignee=false to find unassigned work.
4. Report a summary table with: board name, git repo status, unassigned card count, and the top 5 highest-priority unassigned cards per board.

If a board has no git repos linked, mark it as "BLOCKED — no git repo".
Format the output as a clear text report.`, cfg.Valaris.WorkspaceSlug, cfg.Valaris.WorkspaceSlug)

	slog.Info("running discovery via MCP", "workspace", cfg.Valaris.WorkspaceSlug)

	result, err := provider.Execute(ctx, prompt, llm.Options{
		Model:                      cfg.LLM.Model,
		MCPConfigPath:              cfg.LLM.MCPConfigPath,
		MaxBudgetUSD:               cfg.LLM.MaxBudgetUSD,
		PermissionMode:             cfg.LLM.PermissionMode,
		DangerouslySkipPermissions: cfg.LLM.DangerouslySkipPermissions,
		AllowedTools:               []string{"mcp__valaris__*"},
		AnthropicAPIKey:            cfg.LLM.AnthropicAPIKey,
		OutputFormat:               "text",
	})
	if err != nil {
		slog.Error("discovery failed", "error", err)
		os.Exit(1)
	}

	fmt.Println(result.Output)
}

// flagWasPassed reports whether the operator actually named this flag on the
// command line, as opposed to it holding its zero value. flag.Visit walks only
// the flags that were SET, which is the only way to tell `-keep-alive=false`
// from an absent `-keep-alive`.
func flagWasPassed(name string) bool {
	passed := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			passed = true
		}
	})
	return passed
}

// resolveKeepAlive layers the -keep-alive flag over loop_mode.keep_alive. The
// flag wins ONLY when explicitly passed: a boolean's zero value reads the same
// as "off", so an unconditional override would make every bare `-loop` silently
// clear a profile that opted into keep-alive.
func resolveKeepAlive(fromYAML, flagValue, flagPassed bool) bool {
	if flagPassed {
		return flagValue
	}
	return fromYAML
}

// runLoopMode resolves the target board and drives workloop.LoopMode.Run
// under the same signal-cancelled-context pattern the pipeline work loop
// uses, so an operator SIGINT/SIGTERM exits cleanly instead of leaving the
// board's loop flag flipped (see docs/loop-mode-contract.md point 4).
func runLoopMode(ctx context.Context, cfg *config.Config, client *valaris.Client, providers map[string]llm.Provider, defaultProvider llm.Provider, loopBoardFlag string) {
	boardID, err := resolveLoopBoardID(ctx, cfg, client, loopBoardFlag)
	if err != nil {
		slog.Error("loop mode board resolution failed", "error", err)
		os.Exit(1)
	}

	if err := validateLoopAgentID(client.Agent); err != nil {
		slog.Error("loop mode agent resolution failed", "error", err)
		os.Exit(1)
	}
	agentID := client.Agent.ID

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		slog.Info("received signal, exiting loop mode", "signal", sig)
		cancel()
	}()

	mode := workloop.NewLoopMode(client, cfg, providers, defaultProvider, cfg.Valaris.WorkspaceSlug, boardID, agentID)
	mode.SetKeepAlive(cfg.LoopMode.KeepAlive)

	// Both operator re-enablement and newly actionable completion work wake a
	// parked loop. Completion can park an enabled board without keep-alive.
	if cfg.WebSocket.Enabled {
		wake := make(chan struct{}, 1)
		wsClient := events.NewClient(cfg.Valaris.APIURL, cfg.Valaris.APIKey, cfg.Valaris.WorkspaceSlug, agentID, client.UserID, nil)
		wsClient.SetReconnectTiming(cfg.WebSocket.ReconnectMin, cfg.WebSocket.ReconnectMax)
		wsClient.SetLoopBoardWake(boardID, wake)
		mode.SetWake(wake)
		go func() {
			if err := wsClient.Run(runCtx); err != nil && runCtx.Err() == nil {
				slog.Warn("websocket client exited — falling back to poll-only wake", "error", err)
			}
		}()
		slog.Info("websocket client started for loop wake", "board_id", boardID)
	}

	slog.Info("loop mode starting", "workspace", cfg.Valaris.WorkspaceSlug, "board_id", boardID,
		"keep_alive", cfg.LoopMode.KeepAlive)

	err = mode.Run(runCtx)
	// ctx-cancelled shutdowns surface as context.Canceled — clean exit, same
	// severity convention as the pipeline work loop's supervised Run below.
	if err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("loop mode exited", "error", err)
		os.Exit(1)
	}
	slog.Info("loop mode clean shutdown complete")
	os.Exit(0)
}

// resolveLoopBoardID picks the single board -loop operates on: the
// -loop-board flag wins outright; else exactly one valaris.board_ids entry;
// else the agent's platform board_id binding. None or an ambiguous multi-
// board_ids list (without -loop-board to disambiguate) is a fatal,
// actionable error — loop mode never guesses which board to run on.
func resolveLoopBoardID(ctx context.Context, cfg *config.Config, client *valaris.Client, loopBoardFlag string) (string, error) {
	if loopBoardFlag != "" {
		return loopBoardFlag, nil
	}
	if len(cfg.Valaris.BoardIDs) > 1 {
		return "", fmt.Errorf("loop mode requires a board: valaris.board_ids has %d entries — pass -loop-board to disambiguate", len(cfg.Valaris.BoardIDs))
	}
	if len(cfg.Valaris.BoardIDs) == 1 {
		return cfg.Valaris.BoardIDs[0], nil
	}
	platformConfig, err := client.GetPlatformConfig(ctx, cfg.Valaris.WorkspaceSlug)
	if err != nil {
		return "", fmt.Errorf("loop mode requires a board: pass -loop-board, set exactly one entry in valaris.board_ids, or bind the agent to a board on the platform (fetching platform config failed: %w)", err)
	}
	if platformConfig != nil && platformConfig.BoardID != nil && *platformConfig.BoardID != "" {
		return *platformConfig.BoardID, nil
	}
	return "", fmt.Errorf("loop mode requires a board: pass -loop-board, set exactly one entry in valaris.board_ids, or bind the agent to a board on the platform")
}

// validateLoopAgentID fails fast, before any iteration or spend, when the API
// key has no usable agent binding: a user/personal key resolves client.Agent
// to nil, and every execution write loop mode makes (LogExecutionStart,
// LogExecutionUpdate, FailExecution, ...) needs a non-empty agent ID or it
// silently no-ops server-side (executions are recorded under the agent).
func validateLoopAgentID(agent *valaris.AgentConfig) error {
	if agent == nil || agent.ID == "" {
		return fmt.Errorf("loop mode requires an AGENT key: the API key resolved no usable agent (a user/personal key cannot record executions) — mint an agent key on the platform and set it as valaris.api_key")
	}
	return nil
}

func validateAgentConfig(agent *valaris.AgentConfig, workspaceSlug string) error {
	if agent == nil {
		return nil
	}
	if !agent.IsActive {
		return fmt.Errorf("agent %q is deactivated on the platform", agent.Name)
	}
	if len(agent.AllowedWorkspaces) > 0 {
		for _, ws := range agent.AllowedWorkspaces {
			if ws == workspaceSlug {
				return nil
			}
		}
		return fmt.Errorf("workspace %q not in agent's allowed_workspaces %v", workspaceSlug, agent.AllowedWorkspaces)
	}
	return nil
}

// setupLogger picks the slog handler. On an interactive TTY we use the
// operator-friendly ConsoleHandler (colors, compact single-line, attr filtering);
// when piped we keep the machine-readable slog.TextHandler. --verbose flips
// to Debug level and reveals all attrs in both cases.
func setupLogger(level string, verbose bool) {
	var logLevel slog.Level
	switch strings.ToLower(level) {
	case "debug":
		logLevel = slog.LevelDebug
	case "warn":
		logLevel = slog.LevelWarn
	case "error":
		logLevel = slog.LevelError
	default:
		logLevel = slog.LevelInfo
	}
	if verbose {
		logLevel = slog.LevelDebug
	}

	var handler slog.Handler
	if telemetry.IsTerminal(os.Stderr) {
		handler = telemetry.NewConsoleHandler(os.Stderr, telemetry.ConsoleHandlerOptions{
			Verbose: verbose,
			Color:   true,
		})
	} else {
		handler = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel})
	}
	slog.SetDefault(slog.New(handler))
}

func logStartupBanner(cfg *config.Config) {
	slog.Info("backplane-runner starting",
		"version", version.Version,
		"commit", version.GitCommit,
		"built", version.BuildTime,
		"workspace", cfg.Valaris.WorkspaceSlug,
		"poll_interval", cfg.WorkLoop.PollInterval,
		"drain_timeout", cfg.Daemon.DrainTimeout,
		"health_port", cfg.Daemon.HealthPort,
	)
}
