// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestBudgetTruthUnavailableHistoryDoesNotAdvertiseFullBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/loop"):
			_, _ = w.Write([]byte(`{"enabled":true,"budget_usd":100,"provider":"claude-cli","model":"fixture-model"}`))
		case strings.HasSuffix(r.URL.Path, "/loop/history"):
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	choice := tui.BoardChoice{ID: "board", Name: "Fixture"}
	enrichBoardChoice(context.Background(), valaris.NewClient(server.URL, "fixture"), "test", "board", &choice)
	if choice.LoopBudgetUSD > 0 {
		t.Fatalf("unknown spend was advertised as $%.2f available", choice.LoopBudgetUSD)
	}
}
