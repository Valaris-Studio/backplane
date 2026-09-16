// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"encoding/json"
	"fmt"
	"math"
)

func (h *LoopHistory) UnmarshalJSON(data []byte) error {
	var wire struct {
		IterationCount   *int            `json:"iteration_count"`
		SpentUSD         *float64        `json:"spent_usd"`
		LifetimeSpentUSD *float64        `json:"lifetime_spent_usd"`
		BudgetEpoch      json.RawMessage `json:"budget_epoch"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.IterationCount == nil || wire.SpentUSD == nil || wire.LifetimeSpentUSD == nil || len(wire.BudgetEpoch) == 0 {
		return fmt.Errorf("incomplete required loop spending history")
	}
	if *wire.IterationCount < 0 || *wire.SpentUSD < 0 || *wire.LifetimeSpentUSD < *wire.SpentUSD || math.IsInf(*wire.LifetimeSpentUSD, 0) {
		return fmt.Errorf("invalid loop spending history")
	}
	*h = LoopHistory{IterationCount: *wire.IterationCount, SpentUSD: *wire.SpentUSD, LifetimeSpentUSD: *wire.LifetimeSpentUSD}
	return json.Unmarshal(wire.BudgetEpoch, &h.BudgetEpoch)
}
