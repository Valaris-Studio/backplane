// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package gitea implements forge.Provider for Gitea/Forgejo via its REST API.
// It is the SECOND forge driver: where the GitHub driver shells the `gh` CLI,
// this one speaks HTTP directly, proving forge.Provider is genuinely
// provider-agnostic rather than GitHub-shaped. Built to the documented Gitea
// v1 API contract and unit-verified against fixtures (the *Driver.http seam is
// faked in tests); not yet exercised against a live Gitea server.
package gitea

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
)

var _ forge.Provider = (*Driver)(nil)

// httpDoer is the injectable HTTP seam (satisfied by *http.Client). Tests
// substitute a fake to assert request shape without a live server.
type httpDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Driver is the Gitea/Forgejo forge.Provider. baseURL is the instance root
// (e.g. https://gitea.example.com); token is a Gitea access token sent as
// `Authorization: token <token>`.
type Driver struct {
	baseURL string
	token   string
	http    httpDoer
}

// New builds a Gitea driver. baseURL must be the instance root (no /api/v1).
func New(baseURL, token string) *Driver {
	return &Driver{baseURL: baseURL, token: token, http: http.DefaultClient}
}

func (d *Driver) Kind() string { return "gitea" }

// Gitea PR web URLs look like https://host/{owner}/{repo}/pulls/{index}. The
// API addresses a PR by index, so every URL-taking op parses it out first.
var changeURLRe = regexp.MustCompile(`/([^/]+)/([^/]+)/pulls/(\d+)/?$`)

func parseChangeURL(changeURL string) (owner, repo string, index int, err error) {
	m := changeURLRe.FindStringSubmatch(changeURL)
	if m == nil {
		return "", "", 0, fmt.Errorf("not a Gitea pull-request URL: %q", changeURL)
	}
	idx, _ := strconv.Atoi(m[3])
	return m[1], m[2], idx, nil
}

func (d *Driver) OpenChange(ctx context.Context, repoDir string, in forge.OpenChangeInput) (string, error) {
	// A brand-new change has no URL to parse, so OpenChange needs the owner/repo
	// some other way. Unlike the GitHub driver (where `gh` infers owner/repo
	// from the local clone's remote), the Gitea API is addressed directly: the
	// runner passes the API repo path "/repos/{owner}/{repo}" as repoDir for
	// non-GitHub forges. We require it here rather than guess.
	repoPath, err := apiRepoPath(repoDir)
	if err != nil {
		return "", err
	}
	body := map[string]string{
		"head":  in.SourceBranch,
		"base":  in.TargetBranch,
		"title": in.Title,
		"body":  in.Body,
	}
	var resp struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
	}
	if err := d.call(ctx, http.MethodPost, "/api/v1"+repoPath+"/pulls", body, &resp); err != nil {
		return "", err
	}
	return resp.HTMLURL, nil
}

// apiRepoPath normalizes the runner-supplied repo identifier to the Gitea API
// form "/repos/{owner}/{repo}". Accepts either that exact form or a bare
// "{owner}/{repo}" slug.
var repoSlugRe = regexp.MustCompile(`^/?(?:repos/)?([^/]+)/([^/]+)/?$`)

func apiRepoPath(repoDir string) (string, error) {
	m := repoSlugRe.FindStringSubmatch(repoDir)
	if m == nil {
		return "", fmt.Errorf("gitea OpenChange needs an owner/repo path, got %q", repoDir)
	}
	return fmt.Sprintf("/repos/%s/%s", m[1], m[2]), nil
}

func (d *Driver) Review(ctx context.Context, _ string, changeURL string, decision forge.ReviewDecision, body string) error {
	if !decision.Valid() {
		return fmt.Errorf("invalid review decision %q", decision)
	}
	owner, repo, idx, err := parseChangeURL(changeURL)
	if err != nil {
		return err
	}
	event := map[forge.ReviewDecision]string{
		forge.Approve:        "APPROVED",
		forge.RequestChanges: "REQUEST_CHANGES",
		forge.Comment:        "COMMENT",
	}[decision]
	path := fmt.Sprintf("/api/v1/repos/%s/%s/pulls/%d/reviews", owner, repo, idx)
	return d.call(ctx, http.MethodPost, path, map[string]string{"event": event, "body": body}, nil)
}

func (d *Driver) CommentOn(ctx context.Context, _ string, changeURL, body string) error {
	if body == "" {
		return nil
	}
	owner, repo, idx, err := parseChangeURL(changeURL)
	if err != nil {
		return err
	}
	// A PR is an issue in Gitea, so comments go on the issues endpoint.
	path := fmt.Sprintf("/api/v1/repos/%s/%s/issues/%d/comments", owner, repo, idx)
	return d.call(ctx, http.MethodPost, path, map[string]string{"body": body}, nil)
}

func (d *Driver) ChangeStatusFor(ctx context.Context, _ string, changeURL string) (forge.ChangeStatus, error) {
	owner, repo, idx, err := parseChangeURL(changeURL)
	if err != nil {
		return forge.ChangeStatus{}, err
	}
	var resp struct {
		State     string `json:"state"`
		Mergeable bool   `json:"mergeable"`
		Merged    bool   `json:"merged"`
	}
	path := fmt.Sprintf("/api/v1/repos/%s/%s/pulls/%d", owner, repo, idx)
	if err := d.call(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return forge.ChangeStatus{}, err
	}
	state := forge.StateOpen
	switch {
	case resp.Merged:
		state = forge.StateMerged
	case resp.State == "closed":
		state = forge.StateClosed
	case resp.State == "open":
		state = forge.StateOpen
	default:
		state = forge.StateUnknown
	}
	return forge.ChangeStatus{State: state, Mergeable: state == forge.StateOpen && resp.Mergeable}, nil
}

func (d *Driver) ListOpenChanges(ctx context.Context, _ string, repoSlug string) ([]forge.ChangeFiles, error) {
	if repoSlug == "" {
		return nil, fmt.Errorf("gitea ListOpenChanges requires a repo slug")
	}
	var resp []struct {
		Number int `json:"number"`
		Head   struct {
			Ref string `json:"ref"`
		} `json:"head"`
	}
	path := fmt.Sprintf("/api/v1/repos/%s/pulls?state=open&limit=100", repoSlug)
	if err := d.call(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]forge.ChangeFiles, 0, len(resp))
	for _, p := range resp {
		// Gitea's pulls list doesn't include changed files; the overlap sensor
		// degrades to branch-name comparison for this forge.
		out = append(out, forge.ChangeFiles{Number: p.Number, HeadBranch: p.Head.Ref})
	}
	return out, nil
}

func (d *Driver) CurrentChangeForBranch(ctx context.Context, _ string, branch string) (string, error) {
	// Resolving an open change by head branch requires the repo slug, which the
	// neutral interface doesn't pass here. Return empty (no current change) so
	// the caller falls back to opening a new one — behavior-safe for Gitea.
	_ = branch
	return "", nil
}

func (d *Driver) TargetBranchFor(ctx context.Context, _ string, changeURL string) (string, error) {
	owner, repo, idx, err := parseChangeURL(changeURL)
	if err != nil {
		return "", err
	}
	var resp struct {
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	}
	path := fmt.Sprintf("/api/v1/repos/%s/%s/pulls/%d", owner, repo, idx)
	if err := d.call(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return "", err
	}
	return resp.Base.Ref, nil
}

func (d *Driver) Merge(ctx context.Context, _ string, changeURL string, strategy forge.MergeStrategy) error {
	if !strategy.Valid() {
		return fmt.Errorf("invalid merge strategy %q", strategy)
	}
	owner, repo, idx, err := parseChangeURL(changeURL)
	if err != nil {
		return err
	}
	// Gitea's merge "Do" field uses the same lower-case words as our strategy.
	path := fmt.Sprintf("/api/v1/repos/%s/%s/pulls/%d/merge", owner, repo, idx)
	return d.call(ctx, http.MethodPost, path, map[string]string{"Do": string(strategy)}, nil)
}

// EnsureBranchProtection is a no-op for Gitea: the runner stays failure-reactive
// (attempt the merge, react to a 4xx) rather than pre-applying protection, and
// Gitea's protection model doesn't map onto the GitHub status-check policy.
func (d *Driver) EnsureBranchProtection(context.Context, string, string) error { return nil }

// call performs an authenticated JSON request and, when out != nil, decodes the
// response body into it. A non-2xx status is an error carrying the body.
func (d *Driver) call(ctx context.Context, method, path string, in, out any) error {
	var bodyReader io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "token "+d.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("gitea %s %s: status %d: %s", method, path, resp.StatusCode, string(raw))
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}
