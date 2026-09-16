// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func checkCompletionResume(ctx context.Context, cfg *config.Config, creds Credentials) checkResult {
	row := checkResult{Label: "completion resume", State: tui.StateWarn, Detail: "Select a board to inspect preserved completion work.", Fix: "run -doctor -loop-board BOARD with the intended profile"}
	if cfg == nil || len(cfg.Valaris.BoardIDs) != 1 || creds.APIKey == "" {
		return row
	}
	status, err := valaris.NewClient(creds.APIURL, creds.APIKey).GetCompletionWork(ctx, creds.Workspace, cfg.Valaris.BoardIDs[0])
	if err != nil {
		row.Detail = "Completion state could not be read; verify board access and backend compatibility."
		return row
	}
	row.Detail = redactDoctorWorkflow(status.ResumeSummary(), cfg, creds)
	row.Fix = "Inspect the reported next action. This read does not retry work, release a lease, unblock a card, or enable the loop."
	if !status.Outstanding() {
		row.State = tui.StateOK
		row.Fix = ""
	}
	return row
}
