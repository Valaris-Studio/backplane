// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// The route table is read from the control package's source, so a route
// added there later is enumerated here without anyone updating this test.
var fixRoutePattern = regexp.MustCompile(`"(GET|HEAD|POST|PUT|PATCH|DELETE) (/v1/[^"\s]*)"`)

func fixControlRoutes(t *testing.T) []string {
	t.Helper()
	sources, err := filepath.Glob(filepath.Join("..", "..", "internal", "control", "*.go"))
	if err != nil || len(sources) == 0 {
		t.Fatalf("no control package sources: %v", err)
	}
	seen := map[string]bool{}
	for _, source := range sources {
		if strings.HasSuffix(source, "_test.go") {
			continue
		}
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range fixRoutePattern.FindAllStringSubmatch(string(data), -1) {
			seen[match[1]+" "+match[2]] = true
		}
	}
	routes := make([]string, 0, len(seen))
	for route := range seen {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	for _, known := range []string{"GET /v1/status", "POST /v1/pause", "POST /v1/projects/discover", "POST /v1/agents/{id}/install"} {
		if !seen[known] {
			t.Fatalf("the route scan missed %s; found %v", known, routes)
		}
	}
	return routes
}

// fixMutating are the routes that are not reads: everything but GET and HEAD.
func fixMutating(routes []string) []string {
	var mutating []string
	for _, route := range routes {
		if method, _, _ := strings.Cut(route, " "); method != http.MethodGet && method != http.MethodHead {
			mutating = append(mutating, route)
		}
	}
	return mutating
}

// fixRequest is the concrete call for a route pattern: path values filled
// in, and a body the handler accepts when one is known ("{}" otherwise, so a
// new route's guard must not wait for its body to validate).
func fixRequest(route, repo, endpoint string) (method, path, body string) {
	method, pattern, _ := strings.Cut(route, " ")
	value := "fix1"
	switch {
	case strings.HasPrefix(pattern, "/v1/agents/"):
		value = claudecode.ID
	case strings.HasPrefix(pattern, "/v1/mappings/"):
		value = "m1"
	case strings.HasPrefix(pattern, "/v1/pair/"):
		value = "pr_fix1"
	}
	path = regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(pattern, value)
	bodies := map[string]string{
		"POST /v1/projects/ignore":           `{"path":` + quoted(repo) + `}`,
		"DELETE /v1/projects/ignore":         `{"path":` + quoted(repo) + `}`,
		"POST /v1/projects/discover":         `{"path":` + quoted(repo) + `}`,
		"POST /v1/rename":                    `{"name":"desk"}`,
		"POST /v1/pair/start":                `{"endpoint":` + quoted(endpoint) + `,"replace":true}`,
		"POST /v1/mappings":                  `{"workspace_id":"w","board_id":"b2","root_path":` + quoted(repo) + `,"content_level":"metadata"}`,
		"PATCH /v1/mappings/{id}":            `{"enabled":false,"content_level":"full"}`,
		"PATCH /v1/settings":                 `{"exclude_globs":["**/secret/**"]}`,
		"PUT /v1/mappings/{id}/agent-access": `{"enabled":true}`,
	}
	withoutBody := map[string]bool{
		"POST /v1/pause": true, "POST /v1/resume": true, "POST /v1/queue/flush": true, "POST /v1/disconnect": true,
		"POST /v1/agents/{id}/install": true, "POST /v1/agents/{id}/uninstall": true,
		"DELETE /v1/mappings/{id}": true, "DELETE /v1/pair/{id}": true,
	}
	body, known := bodies[route]
	if !known && !withoutBody[route] {
		body = "{}"
	}
	return method, path, body
}

func fixHasHeadlessBlock(body []byte) bool {
	_, ok := headlessBlock(body)
	return ok
}

// fixLocalEffects is what a refused command or route must leave as it was:
// preferences (pause, ignore), discovered projects and every agent's config.
func fixLocalEffects(t *testing.T, h *harness) map[string]string {
	t.Helper()
	effects := digestEntries(t, h.data, "preferences.json", "discovered.json")
	for path, digest := range digestEntries(t, h.home, ".claude", ".claude.json", ".codex", ".pi", ".config", ".agents") {
		effects["home/"+path] = digest
	}
	return effects
}

func TestHeadlessFixControlAPI_RefusesEveryMutatingRouteInTheTable(t *testing.T) {
	routes := fixControlRoutes(t)
	mutating := fixMutating(routes)
	if len(mutating) < 17 {
		t.Fatalf("only %d mutating routes found in %v", len(mutating), routes)
	}

	t.Run("bound headless root", func(t *testing.T) {
		hh := newHeadlessHarness(t)
		hh.env[envAllowInsecureLoopback] = "1"
		hh.start(t)
		hh.waitForSessions(t, 1)
		hh.waitForPolicy(t)
		bound, _ := os.ReadFile(filepath.Join(hh.data, "binding.json"))
		token, _ := os.ReadFile(hh.tokenPath)
		before := fixLocalEffects(t, hh.harness)
		for _, route := range mutating {
			method, path, body := fixRequest(route, hh.repo, hh.server.URL)
			status, reply := hh.control(t, method, path, body)
			if status < 400 {
				t.Errorf("%s (%s %s) answered %d in an operator-managed root: %s", route, method, path, status, reply)
				continue
			}
			if code := envelopeCode(t, reply); code != "headless_operator_managed" {
				t.Errorf("%s (%s %s): %d %s, want headless_operator_managed", route, method, path, status, code)
			}
		}
		assertSameDigest(t, "preferences, discovered projects and agent configs", before, fixLocalEffects(t, hh.harness))
		if writes := operatorManagedWrites(hh.server); len(writes) != 0 {
			t.Fatalf("refused routes reached the server: %v", writes)
		}
		hh.assertBindingAndTokenIntact(t, bound, token)
		// Reads remain.
		for _, path := range []string{"/v1/status", "/v1/version", "/v1/agents", "/v1/projects"} {
			if status, reply := hh.control(t, "GET", path, ""); status != http.StatusOK {
				t.Errorf("GET %s answered %d in an operator-managed root: %s", path, status, reply)
			}
		}
		if _, body := hh.control(t, "GET", "/v1/status", ""); !fixHasHeadlessBlock(body) {
			t.Errorf("status lost its headless report: %s", body)
		}
	})

	t.Run("desktop root is unchanged", func(t *testing.T) {
		h := newHarness(t)
		h.connect(t)
		api := h.api(t)
		// Signing out last keeps the connection the other routes act on.
		var calls []string
		for _, route := range mutating {
			if route != "POST /v1/disconnect" {
				calls = append(calls, route)
			}
		}
		calls = append(calls, "POST /v1/disconnect")
		for _, route := range calls {
			method, path, body := fixRequest(route, h.repo, h.server.URL)
			status, reply := api.call(t, method, path, body, "Content-Type", "application/json")
			if route == "POST /v1/pause" && status != http.StatusOK {
				t.Errorf("desktop pause answered %d: %s", status, reply)
			}
			if status >= 400 && envelopeCode(t, reply) == "headless_operator_managed" {
				t.Errorf("desktop %s (%s %s) was refused as operator-managed", route, method, path)
			}
		}
	})
}

func TestHeadlessFixCLI_RefusesEveryMutatingCommandInABoundRoot(t *testing.T) {
	t.Run("bound headless root", func(t *testing.T) {
		hh := newHeadlessHarness(t)
		hh.start(t)
		hh.waitForSessions(t, 1)
		hh.waitForPolicy(t)
		bound, _ := os.ReadFile(filepath.Join(hh.data, "binding.json"))
		token, _ := os.ReadFile(hh.tokenPath)
		before := fixLocalEffects(t, hh.harness)
		for _, command := range [][]string{
			{"pause"},
			{"resume"},
			{"projects", "map", hh.repo},
			{"projects", "ignore", hh.repo},
			{"projects", "unignore", hh.repo},
			{"agents", "install"},
			{"agents", "install", claudecode.ID},
			{"agents", "uninstall", claudecode.ID},
			{"rename", "desk"},
		} {
			if _, err := hh.cli(t, command...); errorCode(err) != "headless_operator_managed" {
				t.Errorf("%s: code %s (%v), want headless_operator_managed", strings.Join(command, " "), errorCode(err), err)
			}
		}
		assertSameDigest(t, "preferences, discovered projects and agent configs", before, fixLocalEffects(t, hh.harness))
		if writes := operatorManagedWrites(hh.server); len(writes) != 0 {
			t.Fatalf("refused commands reached the server: %v", writes)
		}
		hh.assertBindingAndTokenIntact(t, bound, token)
		// Reads remain.
		for _, command := range [][]string{{"status"}, {"status", "--human"}, {"projects", "list"}, {"agents", "list"}, {"agents", "status"}, {"version"}} {
			if _, err := hh.cli(t, command...); err != nil {
				t.Errorf("%s is a read and must still answer: %v", strings.Join(command, " "), err)
			}
		}
	})

	t.Run("desktop root is unchanged", func(t *testing.T) {
		h := newHarness(t)
		h.connect(t)
		if err := h.run(t, "pause"); err != nil {
			t.Fatalf("desktop pause: %v", err)
		}
		for _, command := range [][]string{
			{"resume"},
			{"projects", "ignore", h.repo},
			{"projects", "unignore", h.repo},
			{"agents", "install", claudecode.ID},
			{"agents", "uninstall", claudecode.ID},
		} {
			if err := h.run(t, command...); errorCode(err) == "headless_operator_managed" {
				t.Errorf("desktop %s was refused as operator-managed", strings.Join(command, " "))
			}
		}
		if _, err := os.Stat(store.Layout{Root: h.data}.Binding()); err == nil {
			t.Fatal("a desktop root gained a binding.json")
		}
	})
}
