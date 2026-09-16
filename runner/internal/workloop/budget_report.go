// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/budget"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func (m *LoopMode) reportBudget(cfg *valaris.BoardLoopConfig, spent float64, provider llm.Provider, kind string) budget.Report {
	enforcement := "advisory"
	if provider == nil {
		enforcement = "not_applicable"
	} else if capable, ok := provider.(llm.BudgetEnforcementProvider); ok && capable.CanEnforceBudget(llm.Options{AnthropicAPIKey: m.cfg.LLM.AnthropicAPIKey}) {
		enforcement = "provider_enforced"
	}
	report := budget.New(m.budgetHistory, cfg.BudgetUSD, spent, m.cfg.LLM.MaxBudgetUSD, enforcement)
	slog.Info("loop budget", "board_id", m.boardID, "kind", kind,
		"cost_basis", budget.CostBasis, "lifetime_spent_usd", report.LifetimeSpentUSD,
		"epoch_start", report.EpochStart, "epoch_spent_usd", report.EpochSpentUSD,
		"epoch_remaining_usd", report.EpochRemainingUSD, "epoch_limit_usd", report.EpochLimitUSD,
		"session_setting_usd", report.SessionSettingUSD, "session_cap_usd", report.SessionCapUSD,
		"session_enforcement", report.SessionEnforcement, "epoch_rule", budget.EpochExplanation,
		"board_budget_usd", cfg.BudgetUSD, "spent_usd", spent, "remaining_usd", report.EpochRemainingUSD)
	return report
}
