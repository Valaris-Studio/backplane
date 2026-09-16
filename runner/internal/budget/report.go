// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package budget describes recorded source and completion costs consistently.
package budget

import "github.com/Valaris-Studio/backplane/runner/internal/valaris"

const EpochExplanation = "Restart preserves this epoch; disabling then re-enabling starts a new epoch."
const CostBasis = "reported/estimated cost, not an invoice"

type Report struct {
	LifetimeSpentUSD   float64
	EpochStart         string
	EpochSpentUSD      float64
	EpochLimitUSD      float64
	EpochRemainingUSD  float64
	SessionSettingUSD  float64
	SessionCapUSD      float64
	SessionEnforcement string
}

func New(history *valaris.LoopHistory, limit, spent, setting float64, enforcement string) Report {
	report := Report{EpochStart: "all recorded history", EpochLimitUSD: limit, EpochSpentUSD: spent,
		EpochRemainingUSD: max(limit-spent, 0), SessionSettingUSD: setting, SessionEnforcement: enforcement}
	if history != nil {
		report.LifetimeSpentUSD = history.LifetimeSpentUSD + spent - history.SpentUSD
		if history.BudgetEpoch != nil {
			report.EpochStart = *history.BudgetEpoch
		}
	}
	report.SessionCapUSD = report.EpochRemainingUSD
	if setting > 0 {
		report.SessionCapUSD = min(report.SessionCapUSD, setting)
	}
	return report
}
