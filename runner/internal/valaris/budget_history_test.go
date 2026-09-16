// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBudgetHistoryRejectsMissingOrInvalidAccounting(t *testing.T) {
	for _, body := range []string{
		`null`, `{}`, `{"iteration_count":0,"budget_epoch":null}`,
		`{"iteration_count":0,"spent_usd":0,"budget_epoch":null}`,
		`{"iteration_count":0,"spent_usd":-1,"lifetime_spent_usd":0,"budget_epoch":null}`,
		`{"iteration_count":0,"spent_usd":3,"lifetime_spent_usd":2,"budget_epoch":null}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			if _, err := NewClient(server.URL, "fixture").GetLoopHistory(context.Background(), "test", "board"); err == nil {
				t.Fatal("incomplete or invalid history was treated as usable budget evidence")
			}
		})
	}
}
