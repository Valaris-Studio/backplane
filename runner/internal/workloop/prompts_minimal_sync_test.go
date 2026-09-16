// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestMinimalAgenticPromptTemplate_MatchesBackend locks the Go literal in
// prompts_minimal.go against Python's MINIMAL_AGENTIC_PROMPT_TEMPLATE
// (backend/app/services/agents/prompt_defaults.py). Both strings are
// hand-maintained and the backend is authoritative — when runner falls back
// to the minimal prompt it MUST render exactly what the backend would have
// stored as a synthesized default.
//
// Normalization is intentionally minimal: only the role/stage placeholder
// syntax differs between engines (Python `<<ROLE>>` sentinels vs Go
// `{{.Role}}` template tokens). Both sides are rewritten to a neutral
// sentinel and then compared byte-for-byte. Any other divergence — extra
// conditionals, whitespace, reordered lines — is real drift and fails.
func TestMinimalAgenticPromptTemplate_MatchesBackend(t *testing.T) {
	pyPath := backendPromptDefaultsPath(t)
	raw, err := os.ReadFile(pyPath)
	if err != nil {
		t.Fatalf("read backend prompt_defaults.py: %v", err)
	}

	pyLiteral := extractPythonTemplateLiteral(t, string(raw))
	pyNormalized := normalizePythonMinimalTemplate(pyLiteral)
	goNormalized := normalizeGoMinimalTemplate(minimalAgenticPromptTemplate)

	if pyNormalized != goNormalized {
		t.Errorf(
			"minimal prompt drift between backend Python and runner Go.\n\n"+
				"Backend source: %s\n\n"+
				"=== Backend (normalized) ===\n%s\n=== end backend ===\n\n"+
				"=== Runner (normalized) ===\n%s\n=== end runner ===\n\n"+
				"First-diff context:\n%s\n\n"+
				"Update both literals together, then re-run.",
			pyPath, pyNormalized, goNormalized, firstDiffContext(pyNormalized, goNormalized),
		)
	}
}

// backendPromptDefaultsPath resolves backend/app/services/agents/prompt_defaults.py
// relative to this test file. The test is skipped (not failed) if the backend
// tree is not present — e.g., when the runner module is vendored or copied
// without the rest of the repo.
func backendPromptDefaultsPath(t *testing.T) string {
	t.Helper()
	// prompts_minimal_sync_test.go lives at runner/internal/workloop/;
	// the repo root is three levels up.
	rel := filepath.Join("..", "..", "..", "backend", "app", "services", "agents", "prompt_defaults.py")
	abs, err := filepath.Abs(rel)
	if err != nil {
		t.Fatalf("resolving backend path: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Skipf("backend source not reachable at %s — sync test requires monorepo checkout", abs)
	}
	return abs
}

// extractPythonTemplateLiteral pulls the MINIMAL_AGENTIC_PROMPT_TEMPLATE
// triple-quoted body from the Python source. The literal starts with `"""\`
// (explicit line continuation to suppress the leading newline) and ends at
// the matching `"""`. The template body never contains a `"""` sequence so
// a non-greedy match is safe.
func extractPythonTemplateLiteral(t *testing.T, src string) string {
	t.Helper()
	re := regexp.MustCompile(`(?s)MINIMAL_AGENTIC_PROMPT_TEMPLATE\s*=\s*"""\\?\n(.*?)"""`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("MINIMAL_AGENTIC_PROMPT_TEMPLATE literal not found in backend source")
	}
	return m[1]
}

// normalizePythonMinimalTemplate rewrites the backend's `<<ROLE>>` / `<<STAGE>>`
// sentinels to neutral placeholders and strips the `<<POST_PROCESS_IMPERATIVE>>`
// slot. The imperative is backend-only (synthesized when an operator sets
// `post_process_kind` on a custom stage) and is never part of the runner
// fallback — runner's template is the "nothing authored" baseline. The
// remaining bytes are already valid Go-template source (the comment above
// the backend constant guarantees this).
func normalizePythonMinimalTemplate(tpl string) string {
	s := strings.ReplaceAll(tpl, "<<ROLE>>", "ROLE_PLACEHOLDER")
	s = strings.ReplaceAll(s, "<<STAGE>>", "STAGE_PLACEHOLDER")
	s = strings.ReplaceAll(s, "<<POST_PROCESS_IMPERATIVE>>", "")
	return s
}

// normalizeGoMinimalTemplate rewrites Go's `{{.Role}}` / `{{.Stage}}` tokens
// to the same neutral placeholders. Nothing else is touched.
func normalizeGoMinimalTemplate(tpl string) string {
	s := strings.ReplaceAll(tpl, "{{.Role}}", "ROLE_PLACEHOLDER")
	s = strings.ReplaceAll(s, "{{.Stage}}", "STAGE_PLACEHOLDER")
	return s
}

// firstDiffContext returns a short excerpt around the first byte where the
// two strings diverge, to make mismatch messages actionable without printing
// the full templates twice.
func firstDiffContext(a, b string) string {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			start := i - 40
			if start < 0 {
				start = 0
			}
			endA := i + 40
			if endA > len(a) {
				endA = len(a)
			}
			endB := i + 40
			if endB > len(b) {
				endB = len(b)
			}
			return "backend@" + quoteSnippet(a[start:endA]) +
				"\nintern@ " + quoteSnippet(b[start:endB])
		}
	}
	if len(a) != len(b) {
		return "strings share a common prefix but differ in length (backend=" +
			itoa(len(a)) + ", runner=" + itoa(len(b)) + ")"
	}
	return "(no byte-level difference — check invisible characters)"
}

func quoteSnippet(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\n", "\\n"), "\t", "\\t")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
