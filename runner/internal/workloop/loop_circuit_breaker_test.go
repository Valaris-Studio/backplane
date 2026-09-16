// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"
	"time"
)

func TestIsCardBlocked_UnknownCard(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}
	if loop.IsCardBlocked("unknown-card") {
		t.Error("unknown card should not be blocked")
	}
}

func TestRecordCardFailure_BlocksAfterThreeFailures(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-flaky"

	// First two failures should not block.
	loop.RecordCardFailure(cardID)
	if loop.IsCardBlocked(cardID) {
		t.Error("card should not be blocked after 1 failure")
	}

	loop.RecordCardFailure(cardID)
	if loop.IsCardBlocked(cardID) {
		t.Error("card should not be blocked after 2 failures")
	}

	// Third failure triggers the circuit breaker.
	loop.RecordCardFailure(cardID)
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after 3 failures")
	}
}

func TestIsCardBlocked_CooldownExpires(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-expired"

	// Manually insert a failure entry with lastFail far in the past.
	loop.cardFailures[cardID] = cardFailure{
		count:    defaultMaxReworkAttempts,
		lastFail: time.Now().Add(-time.Duration(2 * defaultCardCooldownHours * float64(time.Hour))),
	}
	if loop.IsCardBlocked(cardID) {
		t.Error("card should be unblocked after cooldown expires (transient)")
	}

	// Same for rework counter.
	loop.cardFailures[cardID] = cardFailure{
		reworkCount: defaultMaxReworkAttempts,
		lastFail:    time.Now().Add(-time.Duration(2 * defaultCardCooldownHours * float64(time.Hour))),
	}
	if loop.IsCardBlocked(cardID) {
		t.Error("card should be unblocked after cooldown expires (rework)")
	}
}

func TestIsCardBlocked_IndependentCards(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardA := "card-a"
	cardB := "card-b"

	// Block card A.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure(cardA)
	}

	if !loop.IsCardBlocked(cardA) {
		t.Error("card A should be blocked")
	}
	if loop.IsCardBlocked(cardB) {
		t.Error("card B should not be blocked (independent)")
	}

	// Record one failure for card B — should still not be blocked.
	loop.RecordCardFailure(cardB)
	if loop.IsCardBlocked(cardB) {
		t.Error("card B should not be blocked after 1 failure")
	}
}

func TestClearCardFailure_ResetsBlock(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-reset"
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure(cardID)
	}
	if !loop.IsCardBlocked(cardID) {
		t.Fatal("precondition: card should be blocked")
	}

	loop.ClearCardFailure(cardID)
	if loop.IsCardBlocked(cardID) {
		t.Error("card should be unblocked after clearing failures")
	}
}

func TestBlockedCardIDList_Empty(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}
	if got := loop.BlockedCardIDList(); got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestBlockedCardIDList_ReturnsBlockedOnly(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	// Block card-1 and card-3, leave card-2 with only 1 failure.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure("card-1")
		loop.RecordCardFailure("card-3")
	}
	loop.RecordCardFailure("card-2")

	list := loop.BlockedCardIDList()
	if list == "" {
		t.Fatal("expected non-empty blocked list")
	}

	// Should contain card-1 and card-3 but not card-2.
	if !containsID(list, "card-1") {
		t.Error("blocked list should contain card-1")
	}
	if !containsID(list, "card-3") {
		t.Error("blocked list should contain card-3")
	}
	if containsID(list, "card-2") {
		t.Error("blocked list should not contain card-2")
	}
}

func TestBlockedCardIDList_ExcludesExpiredCooldowns(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	// card-fresh is freshly blocked.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure("card-fresh")
	}

	// card-expired has enough failures but cooldown has passed.
	loop.cardFailures["card-expired"] = cardFailure{
		count:    defaultMaxReworkAttempts,
		lastFail: time.Now().Add(-time.Duration(2 * defaultCardCooldownHours * float64(time.Hour))),
	}

	list := loop.BlockedCardIDList()
	if !containsID(list, "card-fresh") {
		t.Error("blocked list should contain card-fresh")
	}
	if containsID(list, "card-expired") {
		t.Error("blocked list should not contain card-expired (cooldown expired)")
	}
}

func TestRecordCardRework_BlocksAfterThreeReworks(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-rework"

	// Two reworks should not block.
	loop.RecordCardRework(cardID)
	loop.RecordCardRework(cardID)
	if loop.IsCardBlocked(cardID) {
		t.Error("card should not be blocked after 2 reworks")
	}

	// Third rework triggers the block.
	loop.RecordCardRework(cardID)
	if !loop.IsCardBlocked(cardID) {
		t.Error("card should be blocked after 3 reworks")
	}

	// Transient counter should remain at 0.
	if loop.CardFailureCount(cardID) != 0 {
		t.Errorf("transient failure count should be 0, got %d", loop.CardFailureCount(cardID))
	}
	if loop.CardReworkCount(cardID) != 3 {
		t.Errorf("rework count should be 3, got %d", loop.CardReworkCount(cardID))
	}
}

func TestReworkAndTransientCountersAreIndependent(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-mixed"

	// Record 2 transient failures + 1 rework — neither should trigger block.
	loop.RecordCardFailure(cardID)
	loop.RecordCardFailure(cardID)
	loop.RecordCardRework(cardID)

	if loop.IsCardBlocked(cardID) {
		t.Error("card should not be blocked with 2 transient + 1 rework")
	}
	if loop.CardFailureCount(cardID) != 2 {
		t.Errorf("transient count should be 2, got %d", loop.CardFailureCount(cardID))
	}
	if loop.CardReworkCount(cardID) != 1 {
		t.Errorf("rework count should be 1, got %d", loop.CardReworkCount(cardID))
	}
}

// containsID checks if a comma-separated list contains a specific ID.
func containsID(commaSeparated, id string) bool {
	for _, part := range splitCSV(commaSeparated) {
		if part == id {
			return true
		}
	}
	return false
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			part := trimSpaces(s[start:i])
			if part != "" {
				parts = append(parts, part)
			}
			start = i + 1
		}
	}
	part := trimSpaces(s[start:])
	if part != "" {
		parts = append(parts, part)
	}
	return parts
}

func trimSpaces(s string) string {
	i, j := 0, len(s)
	for i < j && s[i] == ' ' {
		i++
	}
	for j > i && s[j-1] == ' ' {
		j--
	}
	return s[i:j]
}

func TestBlockedCardDetails_ReturnsCorrectInfo(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-detail-test"

	// Record enough failures to trigger the circuit breaker.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure(cardID)
	}

	details := loop.BlockedCardDetails()
	if len(details) != 1 {
		t.Fatalf("expected 1 blocked card, got %d", len(details))
	}

	d := details[0]
	if d.CardID != cardID {
		t.Errorf("card_id = %q, want %q", d.CardID, cardID)
	}
	if d.FailCount != defaultMaxReworkAttempts {
		t.Errorf("fail_count = %d, want %d", d.FailCount, defaultMaxReworkAttempts)
	}
	if d.ReworkCount != 0 {
		t.Errorf("rework_count = %d, want 0", d.ReworkCount)
	}
	if d.LastFailAt == "" {
		t.Error("last_fail_at should not be empty")
	}
	if d.CooldownRemaining == "" {
		t.Error("cooldown_remaining should not be empty")
	}
}

func TestBlockedCardDetails_EmptyWhenNoneBlocked(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	details := loop.BlockedCardDetails()
	if len(details) != 0 {
		t.Errorf("expected empty slice, got %d entries", len(details))
	}
}

func TestBlockedCardDetails_ExcludesExpiredCooldowns(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	// card-fresh is freshly blocked.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardFailure("card-fresh")
	}

	// card-expired has enough failures but cooldown has passed.
	loop.cardFailures["card-expired"] = cardFailure{
		count:    defaultMaxReworkAttempts,
		lastFail: time.Now().Add(-time.Duration(2 * defaultCardCooldownHours * float64(time.Hour))),
	}

	details := loop.BlockedCardDetails()

	var foundFresh, foundExpired bool
	for _, d := range details {
		if d.CardID == "card-fresh" {
			foundFresh = true
		}
		if d.CardID == "card-expired" {
			foundExpired = true
		}
	}

	if !foundFresh {
		t.Error("should include card-fresh (still within cooldown)")
	}
	if foundExpired {
		t.Error("should exclude card-expired (cooldown expired)")
	}
}

func TestBlockedCardDetails_IncludesReworkBlocked(t *testing.T) {
	loop := &Loop{
		cardFailures: make(map[string]cardFailure),
	}

	cardID := "card-rework-detail"

	// Block via rework counter.
	for i := 0; i < defaultMaxReworkAttempts; i++ {
		loop.RecordCardRework(cardID)
	}

	details := loop.BlockedCardDetails()
	if len(details) != 1 {
		t.Fatalf("expected 1 blocked card, got %d", len(details))
	}

	d := details[0]
	if d.CardID != cardID {
		t.Errorf("card_id = %q, want %q", d.CardID, cardID)
	}
	if d.FailCount != 0 {
		t.Errorf("fail_count = %d, want 0", d.FailCount)
	}
	if d.ReworkCount != defaultMaxReworkAttempts {
		t.Errorf("rework_count = %d, want %d", d.ReworkCount, defaultMaxReworkAttempts)
	}
}
