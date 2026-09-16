// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package forge

import (
	"context"
	"testing"
)

// The Fake must satisfy Provider — this is the test seam every driver-agnostic
// test uses instead of shelling a real forge CLI/API.
var _ Provider = (*Fake)(nil)

func TestReviewDecision_Valid(t *testing.T) {
	for _, d := range []ReviewDecision{Approve, RequestChanges, Comment} {
		if !d.Valid() {
			t.Errorf("%q should be a valid review decision", d)
		}
	}
	if ReviewDecision("lgtm").Valid() {
		t.Error(`"lgtm" must not be a valid review decision`)
	}
}

func TestMergeStrategy_Valid(t *testing.T) {
	for _, s := range []MergeStrategy{MergeSquash, MergeRebase, MergeCommit} {
		if !s.Valid() {
			t.Errorf("%q should be a valid merge strategy", s)
		}
	}
	if MergeStrategy("fast-forward").Valid() {
		t.Error(`"fast-forward" must not be a valid merge strategy`)
	}
}

// The Fake records calls and returns canned results so call-site tests can
// assert behavior without a real forge. This exercises the whole interface.
func TestFake_RecordsAndReturns(t *testing.T) {
	ctx := context.Background()
	f := &Fake{
		OpenChangeURL: "https://forge.example/acme/repo/changes/7",
		Status:        ChangeStatus{State: StateOpen, Mergeable: true},
	}

	url, err := f.OpenChange(ctx, "repo", OpenChangeInput{
		Title: "t", Body: "b", SourceBranch: "feat", TargetBranch: "main",
	})
	if err != nil {
		t.Fatalf("OpenChange: %v", err)
	}
	if url != "https://forge.example/acme/repo/changes/7" {
		t.Errorf("OpenChange url = %q", url)
	}
	if len(f.OpenChangeCalls) != 1 || f.OpenChangeCalls[0].Input.SourceBranch != "feat" {
		t.Errorf("OpenChange not recorded correctly: %+v", f.OpenChangeCalls)
	}

	if err := f.Review(ctx, "repo", url, Approve, "nice"); err != nil {
		t.Fatalf("Review: %v", err)
	}
	if got := f.ReviewCalls[0].Decision; got != Approve {
		t.Errorf("Review decision = %q, want approve", got)
	}

	st, err := f.ChangeStatusFor(ctx, "repo", url)
	if err != nil {
		t.Fatalf("ChangeStatusFor: %v", err)
	}
	if st.State != StateOpen || !st.Mergeable {
		t.Errorf("status = %+v, want open+mergeable", st)
	}

	if err := f.Merge(ctx, "repo", url, MergeSquash); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if f.MergeCalls[0].Strategy != MergeSquash {
		t.Errorf("merge strategy = %q, want squash", f.MergeCalls[0].Strategy)
	}
}

// Merge must reject an invalid strategy before touching the forge — this is a
// pure-validation guard shared by every driver.
func TestFake_MergeRejectsBadStrategy(t *testing.T) {
	f := &Fake{}
	if err := f.Merge(context.Background(), "repo", "url", MergeStrategy("nope")); err == nil {
		t.Fatal("Merge must reject an invalid strategy")
	}
	if len(f.MergeCalls) != 0 {
		t.Error("Merge must not record a call when the strategy is invalid")
	}
}

// The Fake can be primed to error, so call-site tests exercise failure paths.
func TestFake_ErrorInjection(t *testing.T) {
	f := &Fake{Err: context.DeadlineExceeded}
	if _, err := f.OpenChange(context.Background(), "repo", OpenChangeInput{}); err == nil {
		t.Fatal("expected injected error from OpenChange")
	}
}
