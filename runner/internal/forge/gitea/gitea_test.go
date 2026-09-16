// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package gitea

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
)

// The Gitea driver must satisfy forge.Provider.
var _ forge.Provider = (*Driver)(nil)

// fakeDoer is an injectable http.RoundTripper-ish seam: it records the request
// and returns a canned response, so the driver is unit-tested against the
// documented Gitea contract without a live server.
type fakeDoer struct {
	gotMethod string
	gotPath   string
	gotBody   string
	gotAuth   string
	respCode  int
	respBody  string
	err       error
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.gotMethod = req.Method
	f.gotPath = req.URL.Path
	f.gotAuth = req.Header.Get("Authorization")
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		f.gotBody = string(b)
	}
	code := f.respCode
	if code == 0 {
		code = 200
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(f.respBody)),
		Header:     make(http.Header),
	}, nil
}

func newDriver(d *fakeDoer) *Driver {
	return &Driver{
		baseURL: "https://gitea.example.com",
		token:   "tok123",
		http:    d,
	}
}

func TestDriver_Kind(t *testing.T) {
	if got := newDriver(&fakeDoer{}).Kind(); got != "gitea" {
		t.Errorf("Kind() = %q, want gitea", got)
	}
}

// parseChangeURL must extract owner/repo/index from a Gitea PR URL.
func TestParseChangeURL(t *testing.T) {
	owner, repo, idx, err := parseChangeURL("https://gitea.example.com/acme/widgets/pulls/42")
	if err != nil {
		t.Fatalf("parseChangeURL: %v", err)
	}
	if owner != "acme" || repo != "widgets" || idx != 42 {
		t.Errorf("got %s/%s#%d, want acme/widgets#42", owner, repo, idx)
	}
}

func TestParseChangeURL_Invalid(t *testing.T) {
	if _, _, _, err := parseChangeURL("https://gitea.example.com/acme/widgets"); err == nil {
		t.Error("expected error for a non-PR URL")
	}
}

func TestDriver_OpenChange(t *testing.T) {
	d := &fakeDoer{respCode: 201, respBody: `{"number":7,"html_url":"https://gitea.example.com/acme/widgets/pulls/7","state":"open"}`}
	url, err := newDriver(d).OpenChange(context.Background(), "/repos/acme/widgets", forge.OpenChangeInput{
		Title: "T", Body: "B", SourceBranch: "feat", TargetBranch: "main",
	})
	if err != nil {
		t.Fatalf("OpenChange: %v", err)
	}
	if url != "https://gitea.example.com/acme/widgets/pulls/7" {
		t.Errorf("url = %q", url)
	}
	if d.gotMethod != "POST" || !strings.HasSuffix(d.gotPath, "/repos/acme/widgets/pulls") {
		t.Errorf("request = %s %s", d.gotMethod, d.gotPath)
	}
	// head/base map from SourceBranch/TargetBranch.
	if !strings.Contains(d.gotBody, `"head":"feat"`) || !strings.Contains(d.gotBody, `"base":"main"`) {
		t.Errorf("body = %s, want head=feat base=main", d.gotBody)
	}
	if d.gotAuth != "token tok123" {
		t.Errorf("auth = %q, want 'token tok123'", d.gotAuth)
	}
}

func TestDriver_Review_MapsEvent(t *testing.T) {
	cases := []struct {
		dec       forge.ReviewDecision
		wantEvent string
	}{
		{forge.Approve, "APPROVED"},
		{forge.RequestChanges, "REQUEST_CHANGES"},
		{forge.Comment, "COMMENT"},
	}
	for _, c := range cases {
		d := &fakeDoer{respCode: 200, respBody: `{}`}
		err := newDriver(d).Review(context.Background(), "/r", "https://gitea.example.com/acme/widgets/pulls/3", c.dec, "body")
		if err != nil {
			t.Fatalf("Review(%s): %v", c.dec, err)
		}
		if !strings.Contains(d.gotBody, `"event":"`+c.wantEvent+`"`) {
			t.Errorf("decision %s → body %s, want event %s", c.dec, d.gotBody, c.wantEvent)
		}
		if !strings.HasSuffix(d.gotPath, "/repos/acme/widgets/pulls/3/reviews") {
			t.Errorf("path = %s", d.gotPath)
		}
	}
}

func TestDriver_Review_RejectsInvalid(t *testing.T) {
	d := &fakeDoer{}
	if err := newDriver(d).Review(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/1", forge.ReviewDecision("x"), ""); err == nil {
		t.Fatal("Review must reject an invalid decision")
	}
	if d.gotMethod != "" {
		t.Error("no HTTP call should be made for an invalid decision")
	}
}

func TestDriver_ChangeStatusFor_RollsUp(t *testing.T) {
	cases := []struct {
		body          string
		wantState     forge.ChangeState
		wantMergeable bool
	}{
		{`{"state":"open","mergeable":true,"merged":false}`, forge.StateOpen, true},
		{`{"state":"open","mergeable":false,"merged":false}`, forge.StateOpen, false},
		{`{"state":"closed","mergeable":false,"merged":true}`, forge.StateMerged, false},
		{`{"state":"closed","mergeable":false,"merged":false}`, forge.StateClosed, false},
	}
	for _, c := range cases {
		d := &fakeDoer{respCode: 200, respBody: c.body}
		st, err := newDriver(d).ChangeStatusFor(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/9")
		if err != nil {
			t.Fatalf("ChangeStatusFor: %v", err)
		}
		if st.State != c.wantState || st.Mergeable != c.wantMergeable {
			t.Errorf("body %s → %+v, want {%s %v}", c.body, st, c.wantState, c.wantMergeable)
		}
	}
}

func TestDriver_Merge_MapsStrategy(t *testing.T) {
	cases := []struct {
		strat  forge.MergeStrategy
		wantDo string
	}{
		{forge.MergeSquash, "squash"},
		{forge.MergeRebase, "rebase"},
		{forge.MergeCommit, "merge"},
	}
	for _, c := range cases {
		d := &fakeDoer{respCode: 200, respBody: `{}`}
		if err := newDriver(d).Merge(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/5", c.strat); err != nil {
			t.Fatalf("Merge(%s): %v", c.strat, err)
		}
		if !strings.Contains(d.gotBody, `"Do":"`+c.wantDo+`"`) {
			t.Errorf("strategy %s → body %s, want Do=%s", c.strat, d.gotBody, c.wantDo)
		}
		if !strings.HasSuffix(d.gotPath, "/pulls/5/merge") {
			t.Errorf("path = %s", d.gotPath)
		}
	}
}

func TestDriver_Merge_RejectsInvalid(t *testing.T) {
	d := &fakeDoer{}
	if err := newDriver(d).Merge(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/1", forge.MergeStrategy("x")); err == nil {
		t.Fatal("Merge must reject an invalid strategy")
	}
	if d.gotMethod != "" {
		t.Error("no HTTP call for an invalid strategy")
	}
}

func TestDriver_TargetBranchFor(t *testing.T) {
	d := &fakeDoer{respCode: 200, respBody: `{"base":{"ref":"develop"}}`}
	got, err := newDriver(d).TargetBranchFor(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/2")
	if err != nil {
		t.Fatalf("TargetBranchFor: %v", err)
	}
	if got != "develop" {
		t.Errorf("target = %q, want develop", got)
	}
}

// An HTTP error status surfaces as an error, not a silent success.
func TestDriver_HTTPError(t *testing.T) {
	d := &fakeDoer{respCode: 403, respBody: `{"message":"forbidden"}`}
	if err := newDriver(d).Merge(context.Background(), "/r", "https://gitea.example.com/a/b/pulls/1", forge.MergeSquash); err == nil {
		t.Error("a 403 must surface as an error")
	}
}

// EnsureBranchProtection is best-effort/no-op on Gitea (no equivalent need) —
// it must not error.
func TestDriver_EnsureBranchProtection_NoOp(t *testing.T) {
	d := &fakeDoer{}
	if err := newDriver(d).EnsureBranchProtection(context.Background(), "/r", "main"); err != nil {
		t.Errorf("EnsureBranchProtection should no-op, got %v", err)
	}
}
