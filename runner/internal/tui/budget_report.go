// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/budget"
)

func boardBudgetSummary(board BoardChoice, setting float64) string {
	settingText := "unset (uses board remaining)"
	if setting > 0 {
		settingText = fmt.Sprintf("$%.2f", setting)
	}
	if board.BudgetHistory == nil {
		return "Spending history unavailable; remaining budget is unknown. Launch requires verified history.\n" +
			fmt.Sprintf("Session setting %s is advisory until provider billing is verified.\n", settingText) + budget.EpochExplanation
	}
	report := budget.New(board.BudgetHistory, board.LoopBudgetLimitUSD, board.BudgetHistory.SpentUSD, setting, "advisory")
	return strings.Join([]string{
		fmt.Sprintf("Lifetime $%.2f (%s).", report.LifetimeSpentUSD, budget.CostBasis),
		fmt.Sprintf("Epoch %s: spent $%.2f / $%.2f; board remaining $%.2f.", report.EpochStart, report.EpochSpentUSD, report.EpochLimitUSD, report.EpochRemainingUSD),
		fmt.Sprintf("Session setting %s; effective amount $%.2f — advisory until provider billing is verified.", settingText, report.SessionCapUSD),
		budget.EpochExplanation,
	}, "\n")
}
