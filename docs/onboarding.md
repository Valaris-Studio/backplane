# Onboarding Flow Specification

> **Status: Superseded and non-authoritative (2026-08-16).** This specification
> predates the current Launch Runner wizard, profiles, lifecycle pipeline and
> generated configuration bundle. Use the in-app Getting Started documentation,
> `runner/README.md`, and `backplane-runner -doctor` for the supported flow. The
> steps below are design history and must not be used as an installation runbook.

## Overview

This document specifies the onboarding flow for setting up an autonomous runner team on the Backplane platform. The flow guides users through project setup, runner creation, team assembly, and validation.

## Prerequisites

- Access to a Backplane instance (local password login by default; OIDC or Google IAP where configured)
- A GitHub or Gitea repository for the project
- The `backplane-runner` Go binary (or Docker image)

## Steps

### Step 1: Create Workspace
- Navigate to the dashboard
- Click "Create Workspace"
- Enter workspace name and slug
- Result: Empty workspace with default settings

### Step 2: Create Board
- Navigate to the workspace
- Click "Create Board"
- Enter board name and description
- Columns are auto-created: To Do, In Progress, Blocked, Done
- Ensure columns have correct `column_type` values (backlog, active, review, done, blocked); add a review-typed column if your pipeline includes a review stage

### Step 3: Write Project Definition
- Navigate to Board > Definitions tab
- Write project objectives, tech stack, constraints
- This definition is injected into runner prompts as project context

### Step 4: Connect Repository
- Navigate to Board > Git tab
- Add repository URL and default branch
- The runner uses this to clone and push code

### Step 5: Create Runner
- Navigate to Runners section
- Click "Create runner"
- Enter name, select type (coding/reviewer)
- Save the API key -- it's shown only once
- Configure: budget, rate limit (use presets: Conservative/Balanced/Aggressive)

### Step 6: Assemble Team
- Navigate to Teams section
- Click "Create Team"
- Add runners with roles:
  - Orchestrator: implements cards
  - Reviewer: reviews pull requests
  - Documentator: generates documentation
- Recommended: Standard composition (1 of each)
- Scope team to the board

### Step 7: Configure Prompts (Optional)
- Navigate to Runners > Prompt Configuration
- Review default prompts for each stage
- Customize if needed (e.g., add project-specific coding standards)
- Template variables are listed in the sidebar

### Step 8: Export & Run Go Client
- On the runner detail page, click "Export Config"
- Download the starter YAML
- Update: api_url, api_key, mcp_config_path, git.base_dir
- Run: `./backplane-runner --config runner.yaml`
- Or Docker: `docker run -v $(pwd)/runner.yaml:/etc/backplane/runner.yaml ghcr.io/valaris-studio/backplane-runner`

### Step 9: Create Test Cards
- Create 1-2 simple cards in the "To Do" column
- Example: "Add a README.md with project overview"
- Set priority: high, type: task

### Step 10: Validate in Observatory
- Navigate to Runners > select a runner (the runner detail page)
- Watch the execution timeline for new entries
- Verify: discover > claim > implement > ship > review > document
- Check: PR created, review decision, cost within budget

## Success Criteria

The onboarding is complete when:
1. A card moves from To Do to Done without human intervention
2. A PR is created and visible in the Git tab
3. Execution details show full pipeline (implement + review + document)
4. Cost is tracked and visible in the budget panel
5. The observatory shows the runner's decision reasoning

## Troubleshooting

**Run `./backplane-runner -doctor` first.** It is a read-only preflight —
coding agents on `PATH`, git, forge CLI and auth, credentials (masked, with
their source), backend identity and budget, MCP config, work-dir safety — and
it exits without starting a coding-agent session and without spending. Most rows in the
table below are named directly by a failing check, so doctor usually turns
this table into a lookup rather than a guessing game.

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Runner not picking up cards | Wrong workspace_slug in config | Check config matches workspace URL slug |
| "Budget exceeded" | budget_usd too low | Increase budget on the runner detail page |
| PR creation fails | Missing GH_TOKEN | Set GH_TOKEN env var with repo access |
| Runner offline | Process not running | Check logs, restart with `./backplane-runner` |
| No review happening | No reviewer role assigned | Add a reviewer role to the team |
