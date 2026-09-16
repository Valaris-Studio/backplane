// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Drift guard: runner.example.yaml must describe the real Config surface.
//
// The example is what a self-hoster copies to runner.yaml (and what
// docker-compose.prod.yml mounts as the config template), so an undocumented
// field is a feature nobody can find and a stale key is a setting that silently
// does nothing. Same spirit as backend/tests/test_env_example_drift.py.

// deprecatedExampleOmissions are struct fields the example deliberately does NOT
// document: parsed only so old runner.yaml files keep loading, never to be
// written fresh. Documenting them would advertise settings that do nothing.
var deprecatedExampleOmissions = map[string]bool{
	"work_loop.scheduling.max_consecutive_same_role": true,
	"work_loop.scheduling.starvation_prevention":     true,
	"work_loop.max_concurrent":                       true,
}

func examplePath(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "configs", "runner.example.yaml"))
	if err != nil {
		t.Fatalf("resolving example path: %v", err)
	}
	return p
}

// structYAMLPaths walks a struct type collecting every `yaml:"..."` tag as a
// dotted path. Nested structs recurse; slices and maps stop the walk at their
// own key (the example documents the container, not synthetic element paths).
// Map-typed paths are also recorded in freeform so the unknown-key check can
// allow user-chosen sub-keys (llm.tier_providers.premium) under them.
func structYAMLPaths(t reflect.Type, prefix string, out, freeform map[string]bool) {
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		tag := strings.Split(field.Tag.Get("yaml"), ",")[0]
		if tag == "" || tag == "-" {
			continue
		}
		path := tag
		if prefix != "" {
			path = prefix + "." + tag
		}
		out[path] = true

		ft := field.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		switch {
		case ft.Kind() == reflect.Map:
			freeform[path] = true
		// time.Duration is a struct-free named int; only real structs recurse.
		case ft.Kind() == reflect.Struct && ft.PkgPath() != "time":
			structYAMLPaths(ft, path, out, freeform)
		}
	}
}

// exampleKeys parses the example YAML into a generic map and flattens it to the
// same dotted-path form. Only mapping nodes recurse — a list value (board_ids)
// or a scalar is a leaf key, matching how structYAMLPaths stops at containers.
func exampleKeys(t *testing.T) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(examplePath(t))
	if err != nil {
		t.Fatalf("reading example: %v", err)
	}
	var root map[string]any
	if err := yaml.Unmarshal(data, &root); err != nil {
		t.Fatalf("parsing example: %v", err)
	}
	out := map[string]bool{}
	var walk func(m map[string]any, prefix string)
	walk = func(m map[string]any, prefix string) {
		for k, v := range m {
			path := k
			if prefix != "" {
				path = prefix + "." + k
			}
			out[path] = true
			if nested, ok := v.(map[string]any); ok {
				walk(nested, path)
			}
		}
	}
	walk(root, "")
	return out
}

func sorted(set map[string]bool) []string {
	var keys []string
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestExampleDocumentsEveryConfigField(t *testing.T) {
	want, freeform := map[string]bool{}, map[string]bool{}
	structYAMLPaths(reflect.TypeOf(Config{}), "", want, freeform)

	got := exampleKeys(t)

	var missing []string
	for path := range want {
		if !got[path] && !deprecatedExampleOmissions[path] {
			missing = append(missing, path)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("runner.example.yaml does not document these Config fields: %v\n"+
			"Add them to configs/runner.example.yaml (active or as a commented example key).", missing)
	}
}

func TestExampleHasNoUnknownKeys(t *testing.T) {
	known, freeform := map[string]bool{}, map[string]bool{}
	structYAMLPaths(reflect.TypeOf(Config{}), "", known, freeform)

	var unknown []string
	for path := range exampleKeys(t) {
		if known[path] {
			continue
		}
		// A key nested under a map-typed field (llm.model_overrides.discover,
		// git.tokens.reviewer) is user-chosen example data, not a struct field.
		// Only map parents grant this — a stray key under a struct is drift.
		if dot := strings.LastIndex(path, "."); dot > 0 && freeform[path[:dot]] {
			continue
		}
		unknown = append(unknown, path)
	}
	sort.Strings(unknown)
	if len(unknown) > 0 {
		t.Errorf("runner.example.yaml documents keys that match no Config field: %v\n"+
			"Remove them, or add the field to internal/config/config.go.\nKnown paths: %v",
			unknown, sorted(known))
	}
}
