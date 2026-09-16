// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package github

import (
	"context"
	"errors"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
)

// The GitHub driver must satisfy forge.Provider.
var _ forge.Provider = (*Driver)(nil)

// fakeGH records the git.Manager-level calls the driver delegates to, so we can
// assert the neutral→gh mapping without shelling real `gh`.
type fakeGH struct {
	createURL   string
	status      ghStatus
	branchURL   string
	targetRef   string
	openList    []ghPR
	err         error
	createCall  ghCreateArgs
	reviewCall  ghReviewArgs
	mergeCall   ghMergeArgs
	commentBody string
}

type ghCreateArgs struct{ title, body, base string }
type ghReviewArgs struct{ url, decision, body string }
type ghMergeArgs struct{ url, strategy string }

func (f *fakeGH) CreatePR(_ context.Context, _, title, body, base string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.createCall = ghCreateArgs{title, body, base}
	return f.createURL, nil
}
func (f *fakeGH) ReviewPR(_ context.Context, _, url, decision, body string) error {
	if f.err != nil {
		return f.err
	}
	f.reviewCall = ghReviewArgs{url, decision, body}
	return nil
}
func (f *fakeGH) CommentPR(_ context.Context, _, _, body string) error {
	if f.err != nil {
		return f.err
	}
	f.commentBody = body
	return nil
}
func (f *fakeGH) CheckPRStatus(_ context.Context, _, _ string) (ghStatus, error) {
	if f.err != nil {
		return ghStatus{}, f.err
	}
	return f.status, nil
}
func (f *fakeGH) ListOpenPRs(_ context.Context, _, _ string) ([]ghPR, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.openList, nil
}
func (f *fakeGH) CurrentPRForBranch(_ context.Context, _, _ string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.branchURL, nil
}
func (f *fakeGH) PRBaseBranch(_ context.Context, _, _ string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.targetRef, nil
}
func (f *fakeGH) MergePR(_ context.Context, _, url, strategy string) error {
	if f.err != nil {
		return f.err
	}
	f.mergeCall = ghMergeArgs{url, strategy}
	return nil
}
func (f *fakeGH) EnsureBranchProtection(_ context.Context, _, _ string) error { return f.err }

func newTestDriver(gh *fakeGH) *Driver { return &Driver{gh: gh} }

func TestDriver_Kind(t *testing.T) {
	if got := newTestDriver(&fakeGH{}).Kind(); got != "github" {
		t.Errorf("Kind() = %q, want github", got)
	}
}

func TestDriver_OpenChange_MapsToCreatePR(t *testing.T) {
	gh := &fakeGH{createURL: "https://github.com/a/b/pull/3"}
	d := newTestDriver(gh)
	url, err := d.OpenChange(context.Background(), "/repo", forge.OpenChangeInput{
		Title: "T", Body: "B", SourceBranch: "feat", TargetBranch: "main",
	})
	if err != nil {
		t.Fatalf("OpenChange: %v", err)
	}
	if url != "https://github.com/a/b/pull/3" {
		t.Errorf("url = %q", url)
	}
	// SourceBranch is NOT passed to gh pr create (gh infers it from HEAD); the
	// TargetBranch becomes --base.
	if gh.createCall.base != "main" || gh.createCall.title != "T" || gh.createCall.body != "B" {
		t.Errorf("createCall = %+v, want base=main title=T body=B", gh.createCall)
	}
}

func TestDriver_Review_MapsDecision(t *testing.T) {
	gh := &fakeGH{}
	d := newTestDriver(gh)
	if err := d.Review(context.Background(), "/r", "url", forge.RequestChanges, "fix"); err != nil {
		t.Fatalf("Review: %v", err)
	}
	// Neutral forge.RequestChanges must map to gh's "request-changes" verb.
	if gh.reviewCall.decision != "request-changes" {
		t.Errorf("decision = %q, want request-changes", gh.reviewCall.decision)
	}
}

func TestDriver_Review_RejectsInvalidDecision(t *testing.T) {
	gh := &fakeGH{}
	if err := newTestDriver(gh).Review(context.Background(), "/r", "url", forge.ReviewDecision("bogus"), ""); err == nil {
		t.Fatal("Review must reject an invalid decision before calling gh")
	}
	if gh.reviewCall.decision != "" {
		t.Error("gh.ReviewPR must not be called for an invalid decision")
	}
}

func TestDriver_ChangeStatusFor_RollsUp(t *testing.T) {
	// CLEAN + OPEN → mergeable; BLOCKED → not mergeable.
	cases := []struct {
		state, mergeState string
		wantState         forge.ChangeState
		wantMergeable     bool
	}{
		{"OPEN", "CLEAN", forge.StateOpen, true},
		{"OPEN", "BLOCKED", forge.StateOpen, false},
		{"OPEN", "BEHIND", forge.StateOpen, false},
		{"MERGED", "CLEAN", forge.StateMerged, false},
		{"CLOSED", "DIRTY", forge.StateClosed, false},
	}
	for _, c := range cases {
		gh := &fakeGH{status: ghStatus{State: c.state, MergeStateStatus: c.mergeState}}
		st, err := newTestDriver(gh).ChangeStatusFor(context.Background(), "/r", "url")
		if err != nil {
			t.Fatalf("ChangeStatusFor: %v", err)
		}
		if st.State != c.wantState || st.Mergeable != c.wantMergeable {
			t.Errorf("state=%s merge=%s → %+v, want {%s %v}", c.state, c.mergeState, st, c.wantState, c.wantMergeable)
		}
	}
}

func TestDriver_Merge_MapsStrategy(t *testing.T) {
	gh := &fakeGH{}
	d := newTestDriver(gh)
	if err := d.Merge(context.Background(), "/r", "url", forge.MergeSquash); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if gh.mergeCall.strategy != "squash" {
		t.Errorf("strategy = %q, want squash", gh.mergeCall.strategy)
	}
}

func TestDriver_Merge_RejectsInvalidStrategy(t *testing.T) {
	gh := &fakeGH{}
	if err := newTestDriver(gh).Merge(context.Background(), "/r", "url", forge.MergeStrategy("x")); err == nil {
		t.Fatal("Merge must reject an invalid strategy before calling gh")
	}
	if gh.mergeCall.url != "" {
		t.Error("gh.MergePR must not be called for an invalid strategy")
	}
}

func TestDriver_ListOpenChanges_MapsFiles(t *testing.T) {
	gh := &fakeGH{openList: []ghPR{{Number: 5, HeadRefName: "feat", Files: []string{"a.go"}}}}
	got, err := newTestDriver(gh).ListOpenChanges(context.Background(), "/r", "a/b")
	if err != nil {
		t.Fatalf("ListOpenChanges: %v", err)
	}
	if len(got) != 1 || got[0].Number != 5 || got[0].HeadBranch != "feat" || got[0].Files[0] != "a.go" {
		t.Errorf("mapped = %+v", got)
	}
}

func TestDriver_ErrorPropagates(t *testing.T) {
	sentinel := errors.New("gh blew up")
	gh := &fakeGH{err: sentinel}
	if _, err := newTestDriver(gh).OpenChange(context.Background(), "/r", forge.OpenChangeInput{}); !errors.Is(err, sentinel) {
		t.Errorf("err = %v, want wrapped sentinel", err)
	}
}
