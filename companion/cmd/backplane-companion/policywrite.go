// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

type answerFields map[string]json.RawMessage

// required decodes a member that must be present and non-null. A missing or
// null member must never fall back to a zero value: for enabled_agents nil
// means every agent, and for exclude_globs no exclusion — both widen capture.
func required[T any](fields answerFields, name string) (T, bool) {
	var value T
	raw, present := fields[name]
	if !present || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
		return value, false
	}
	return value, true
}

// applyPolicyWrite folds an accepted write into the cached policy so no
// status after it shows older values. Only a complete answer is applied;
// anything partial or malformed is skipped and the refresh that follows is
// the fallback. The refresh time is kept: this is one write's answer, not a
// fresh policy.
func applyPolicyWrite(ctx context.Context, layout store.Layout, write control.PolicyWrite) error {
	return state.Update(ctx, layout, layout.Policy(), func(cached *policy.Cached) bool {
		if cached.Policy.Installation.ID == "" {
			return false
		}
		next := cached.Policy
		var applied bool
		switch {
		case write.Settings != nil:
			next.Installation, applied = settingsApplied(next.Installation, write.Settings)
		case write.Mapping != nil:
			var mapping policy.Mapping
			if mapping, applied = completeMapping(write.Mapping); applied {
				next.Mappings = withMapping(next.Mappings, mapping)
			}
		case write.DeletedMappingID != "":
			next.Mappings, applied = withoutMapping(next.Mappings, write.DeletedMappingID), true
		}
		if !applied || next.Validate() != nil {
			return false
		}
		cached.Policy = next
		return true
	})
}

// settingsApplied needs every capture-scope member of the server's settings
// document; paused and retention_days follow only when present.
func settingsApplied(installation policy.Installation, document json.RawMessage) (policy.Installation, bool) {
	var fields answerFields
	if json.Unmarshal(document, &fields) != nil {
		return installation, false
	}
	autoMatch, hasAutoMatch := required[bool](fields, "auto_match_repos")
	enabledAgents, hasAgents := required[[]string](fields, "enabled_agents")
	excludeGlobs, hasGlobs := required[[]string](fields, "exclude_globs")
	if !hasAutoMatch || !hasAgents || !hasGlobs {
		return installation, false
	}
	installation.AutoMatchRepos, installation.EnabledAgents, installation.ExcludeGlobs = autoMatch, enabledAgents, excludeGlobs
	if paused, ok := required[bool](fields, "paused"); ok {
		installation.Paused = paused
	}
	if raw, present := fields["retention_days"]; present {
		var days *int
		if json.Unmarshal(raw, &days) == nil {
			installation.RetentionDays = days
		}
	}
	return installation, true
}

// completeMapping needs the members that decide what is captured and how
// much: a missing enabled or content_level never becomes a default.
func completeMapping(document json.RawMessage) (policy.Mapping, bool) {
	var fields answerFields
	if json.Unmarshal(document, &fields) != nil {
		return policy.Mapping{}, false
	}
	var mapping policy.Mapping
	if json.Unmarshal(document, &mapping) != nil {
		return policy.Mapping{}, false
	}
	id, hasID := required[string](fields, "id")
	workspace, hasWorkspace := required[string](fields, "workspace_id")
	enabled, hasEnabled := required[bool](fields, "enabled")
	level, hasLevel := required[string](fields, "content_level")
	if !hasID || id == "" || !hasWorkspace || workspace == "" || !hasEnabled || !hasLevel {
		return policy.Mapping{}, false
	}
	if _, err := privacy.ParseContentLevel(level); err != nil || level == "" {
		return policy.Mapping{}, false
	}
	if mapping.RootPath == "" && mapping.RepoURLNormalized == "" {
		return policy.Mapping{}, false
	}
	mapping.Enabled, mapping.ContentLevel = enabled, level
	return mapping, true
}

func withMapping(mappings []policy.Mapping, mapping policy.Mapping) []policy.Mapping {
	updated := make([]policy.Mapping, 0, len(mappings)+1)
	replaced := false
	for _, existing := range mappings {
		if existing.ID == mapping.ID {
			existing, replaced = mapping, true
		}
		updated = append(updated, existing)
	}
	if !replaced {
		updated = append(updated, mapping)
	}
	return updated
}

func withoutMapping(mappings []policy.Mapping, id string) []policy.Mapping {
	kept := make([]policy.Mapping, 0, len(mappings))
	for _, existing := range mappings {
		if existing.ID != id {
			kept = append(kept, existing)
		}
	}
	return kept
}
