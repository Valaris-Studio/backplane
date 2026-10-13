// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package policy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCacheRoundTripAndTrustWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	refreshed := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	cached := Cached{RefreshedAt: refreshed, Policy: Policy{Installation: Installation{ID: "i", EnabledAgents: []string{"claude_code"}}}}
	if err := Save(path, cached); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil || !loaded.Policy.AgentEnabled("claude_code") || loaded.Policy.AgentEnabled("codex") {
		t.Fatalf("round trip failed: %+v %v", loaded, err)
	}
	if loaded.Stale(refreshed.Add(TrustWindow)) || !loaded.Stale(refreshed.Add(TrustWindow+time.Second)) {
		t.Fatal("trust window boundary wrong")
	}
	if !loaded.Stale(refreshed.Add(-time.Hour)) {
		t.Fatal("a policy refreshed in the future must not be trusted")
	}
}

func TestValidateRequiresOnlyDependedOnMembers(t *testing.T) {
	if err := (Policy{}).Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing installation id accepted")
	}
	if err := (Policy{Installation: Installation{ID: "i"}, Mappings: []Mapping{{ID: "m"}}}).Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatal("mapping without workspace accepted")
	}
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"policy":{"installation":{"id":"i","future":1}},"refreshed_at":"2026-09-24T12:00:00Z","extra":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("unknown members must be ignored: %v", err)
	}
}

func TestWithMappingReplacesById(t *testing.T) {
	cached := Cached{Policy: Policy{Mappings: []Mapping{{ID: "a", RootPath: "/old"}, {ID: "b"}}}}
	updated := cached.WithMapping(Mapping{ID: "a", RootPath: "/new"})
	if len(updated.Policy.Mappings) != 2 || updated.Policy.Mappings[1].RootPath != "/new" || cached.Policy.Mappings[0].RootPath != "/old" {
		t.Fatalf("mapping not replaced immutably: %+v", updated.Policy.Mappings)
	}
}

func TestRepoCatalog_DecodesTheWorkspaceNameWhenTheServerSendsIt(t *testing.T) {
	var withName, withoutName Policy
	if err := json.Unmarshal([]byte(`{"installation":{"id":"i"},"repo_catalog":[{"workspace_slug":"acme","workspace_name":"Acme Corp","workspace_id":"w1","board_id":"b1","board_name":"App","repo_url_normalized":"github.com/acme/app"}]}`), &withName); err != nil {
		t.Fatal(err)
	}
	if name := withName.RepoCatalog[0].WorkspaceName; name == nil || *name != "Acme Corp" {
		t.Fatalf("workspace_name = %v", name)
	}
	if err := json.Unmarshal([]byte(`{"installation":{"id":"i"},"repo_catalog":[{"workspace_slug":"acme","workspace_id":"w1","board_id":"b1","board_name":"App","repo_url_normalized":"github.com/acme/app"}]}`), &withoutName); err != nil {
		t.Fatal(err)
	}
	if withoutName.RepoCatalog[0].WorkspaceName != nil || withoutName.Validate() != nil {
		t.Fatalf("an older server's catalog must stay valid without a name: %+v", withoutName.RepoCatalog[0])
	}
}

// The desktop writes enabled_agents from its integrations, which have one
// Codex (codex_cli); Codex Desktop's sessions follow that switch.
func TestAgentEnabled_CodexDesktopFollowsTheCodexSwitch(t *testing.T) {
	cases := []struct {
		enabled []string
		want    bool
	}{
		{[]string{"claude_code", "codex_cli"}, true},
		{[]string{"claude_code", "codex_cli", "pi_cli"}, true},
		{[]string{"claude_code", "pi_cli"}, false},
		{[]string{"codex_desktop"}, false},
		{nil, true},
	}
	for _, c := range cases {
		policy := Policy{Installation: Installation{EnabledAgents: c.enabled}}
		if got := policy.AgentEnabled("codex_desktop"); got != c.want {
			t.Fatalf("enabled %v: codex_desktop enabled = %v", c.enabled, got)
		}
	}
	if (Policy{Installation: Installation{EnabledAgents: []string{"codex_desktop"}}}).AgentEnabled("codex_cli") {
		t.Fatal("the Codex switch is codex_cli's own")
	}
}

func TestAPIBase_DecodesTheAdvertisedBaseAndToleratesItsAbsence(t *testing.T) {
	for body, want := range map[string]string{
		`{"installation":{"id":"i"},"api_base_url":"https://api.example.test"}`: "https://api.example.test",
		`{"installation":{"id":"i"},"api_base_url":null}`:                       "",
		`{"installation":{"id":"i"}}`:                                           "",
	} {
		var decoded Policy
		if err := json.Unmarshal([]byte(body), &decoded); err != nil || decoded.APIBaseURL != want {
			t.Errorf("%s decoded to %q (%v)", body, decoded.APIBaseURL, err)
		}
	}
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := Save(path, Cached{Policy: Policy{Installation: Installation{ID: "i"}, APIBaseURL: "https://api.example.test"}}); err != nil {
		t.Fatal(err)
	}
	if loaded, err := Load(path); err != nil || loaded.Policy.APIBaseURL != "https://api.example.test" {
		t.Fatalf("the cache dropped the API base: %+v %v", loaded, err)
	}
}

func TestAgentAPIBase_UsesAnHTTPSOriginTheServerAdvertises(t *testing.T) {
	const endpoint = "https://pair.example.test"
	for advertised, want := range map[string]string{
		"https://api.example.test":       "https://api.example.test",
		"https://api.example.test/":      "https://api.example.test",
		"https://api.example.test:8443":  "https://api.example.test:8443",
		"https://API.example.test:1":     "https://api.example.test:1",
		"https://api.example.test:65535": "https://api.example.test:65535",
		"https://[2001:db8::1]:8443":     "https://[2001:db8::1]:8443",
		" https://api.example.test ":     "https://api.example.test",
		// Another registrable domain is allowed: prod serves its API from
		// run.app and its web app from the pairing endpoint's domain.
		"https://other-site.example.run": "https://other-site.example.run",
	} {
		got, source := (Policy{APIBaseURL: advertised}).AgentAPIBase(endpoint)
		if got != want || source != APIBaseAdvertised {
			t.Errorf("advertised %q: agents call %q (%s), want %q", advertised, got, source, want)
		}
	}
}

func TestAgentAPIBase_FallsBackToTheEndpointWhenNoneIsAdvertised(t *testing.T) {
	const endpoint = "https://pair.example.test"
	for _, advertised := range []string{"", "  "} {
		if got, source := (Policy{APIBaseURL: advertised}).AgentAPIBase(endpoint); got != endpoint || source != APIBaseAbsent {
			t.Errorf("advertised %q: agents call %q (%s), want the endpoint, absent", advertised, got, source)
		}
	}
}

func TestAgentAPIBase_FallsBackToTheEndpointForAnUnsafeBase(t *testing.T) {
	const endpoint = "https://pair.example.test"
	for _, advertised := range []string{
		"https://api.example.test:",
		"https://api.example.test:0",
		"https://api.example.test:99999",
		"https://api.example.test:65536",
		"https://[fe80::1%25en0]",
		"https://[fe80::1%25en0]:8443",
		"http://api.example.test",
		"api.example.test",
		"/api",
		"//api.example.test",
		"https://",
		"https://:443",
		"https://user:pass@api.example.test",
		"https://user@api.example.test",
		"https://api.example.test#frag",
		"https://api.example.test/#",
		"https://api.example.test?x=1",
		"https://api.example.test/?",
		"https://api.example.test/api",
		"https://api.example.test/%2F",
		"https://api.example.test\n.evil",
		"https://api.example.test/\x00",
		"javascript:alert(1)",
		"https:api.example.test",
	} {
		if got, source := (Policy{APIBaseURL: advertised}).AgentAPIBase(endpoint); got != endpoint || source != APIBaseRejected {
			t.Errorf("advertised %q: agents call %q (%s), want the endpoint, rejected", advertised, got, source)
		}
	}
}
