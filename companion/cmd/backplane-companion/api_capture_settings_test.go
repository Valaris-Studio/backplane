// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

type captureSettingsView struct {
	Capture map[string]json.RawMessage `json:"capture"`
}

func (c *apiClient) captureSettings(t *testing.T) (autoMatch bool, excludeGlobs []string, present bool) {
	t.Helper()
	_, body := c.call(t, "GET", "/v1/status", "")
	var view captureSettingsView
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	rawAutoMatch, hasAutoMatch := view.Capture["auto_match_repos"]
	rawGlobs, hasGlobs := view.Capture["exclude_globs"]
	if !hasAutoMatch || !hasGlobs {
		return false, nil, false
	}
	if json.Unmarshal(rawAutoMatch, &autoMatch) != nil || string(rawGlobs) == "null" || json.Unmarshal(rawGlobs, &excludeGlobs) != nil {
		t.Fatalf("capture settings are not a bool and an array: %s", body)
	}
	return autoMatch, excludeGlobs, true
}

func setCachedInstallation(t *testing.T, h *harness, autoMatch bool, excludeGlobs []string) {
	t.Helper()
	layout := store.Layout{Root: h.data}
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	cached.Policy.Installation.AutoMatchRepos, cached.Policy.Installation.ExcludeGlobs = autoMatch, excludeGlobs
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
}

func TestAPIStatus_CaptureCarriesTheCachedAutoMatchAndExcludeGlobs(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	setCachedInstallation(t, h, true, []string{"**/secret/**", "vendor/*"})
	autoMatch, globs, present := h.api(t).captureSettings(t)
	if !present || !autoMatch || strings.Join(globs, ",") != "**/secret/**,vendor/*" {
		t.Fatalf("want auto_match_repos=true and both globs, got present=%v %v %v", present, autoMatch, globs)
	}
}

func TestAPIStatus_CaptureSettingsAreFalseAndEmptyWithoutGlobs(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	setCachedInstallation(t, h, false, nil)
	autoMatch, globs, present := h.api(t).captureSettings(t)
	if !present || autoMatch || globs == nil || len(globs) != 0 {
		t.Fatalf("want auto_match_repos=false and exclude_globs=[], got present=%v %v %v", present, autoMatch, globs)
	}
}

func TestAPIStatus_CaptureSettingsAreFalseAndEmptyWhenNotConnected(t *testing.T) {
	h := newHarness(t)
	autoMatch, globs, present := h.api(t).captureSettings(t)
	if !present || autoMatch || len(globs) != 0 {
		t.Fatalf("without a policy: want false and [], got present=%v %v %v", present, autoMatch, globs)
	}
}

func TestCLIStatus_KeepsItsShapeWithoutTheCaptureSettings(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	setCachedInstallation(t, h, true, []string{"**/secret/**"})
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	if out := h.stdout.String(); strings.Contains(out, `"auto_match_repos"`) || strings.Contains(out, `"exclude_globs"`) {
		t.Fatalf("CLI status keeps its recorded shape: %s", out)
	}
}
