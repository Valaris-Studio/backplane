// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Card 0ac035df step 3b — the isolated CODEX_HOME is built on EVERY Codex
// launch (it carries the deny-floor rules), so whatever the operator's real
// ~/.codex/config.toml says about WHERE to send requests must travel with it.
// A host whose config selects a custom `model_provider` (a proxy base_url,
// with `env_key` naming the credential variable) keeps that provider's key in
// auth.json; with auth.json alone codex falls back to api.openai.com and every
// turn dies with 401 before the model runs — live-proved 2026-09-02 (see the
// RunnerPath* probes in codex_execpolicy_live_integration_test.go). Operator
// policy that would weaken the launch (sandbox_mode, approval_policy, foreign
// [mcp_servers.*]) is deliberately NOT carried.

// codexRoutingConfig is the routing slice of the real config.toml.
type codexRoutingConfig struct {
	TOML            string            // carried lines, ready to head the isolated config.toml
	ModelProvider   string            // top-level model_provider, unquoted; "" = codex's built-in openai
	ProviderEnvKeys map[string]string // [model_providers.<name>].env_key, unquoted, by provider name
}

// selectedProviderEnvKey names the env var the selected custom provider reads
// its credential from; "" when no custom provider (or no env_key) is selected.
func (c codexRoutingConfig) selectedProviderEnvKey() string {
	if c.ModelProvider == "" {
		return ""
	}
	return c.ProviderEnvKeys[c.ModelProvider]
}

const (
	codexProvidersKey = "model_providers"
	codexProjectsKey  = "projects"
)

// resolveRealCodexHome mirrors codex's own resolution: the configured
// CODEX_HOME, else ~/.codex. "" when neither is known.
func resolveRealCodexHome(configured string) string {
	if configured != "" {
		return configured
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".codex")
	}
	return ""
}

// loadCodexRoutingConfig reads <realCodexHome>/config.toml. A missing file is
// a plain `codex login` host (built-in provider): empty routing, no error. An
// unparsable file is an error naming the path and line — a silent fallback
// would route a proxied host to api.openai.com with the wrong key.
func loadCodexRoutingConfig(realCodexHome string) (codexRoutingConfig, error) {
	if realCodexHome == "" {
		return codexRoutingConfig{}, nil
	}
	path := filepath.Join(realCodexHome, "config.toml")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return codexRoutingConfig{}, nil
	}
	if err != nil {
		return codexRoutingConfig{}, fmt.Errorf("read real codex config %s: %w", path, err)
	}
	routing, err := carryCodexRoutingConfig(string(raw))
	if err != nil {
		return codexRoutingConfig{}, fmt.Errorf("real codex config %s: %w", path, err)
	}
	return routing, nil
}

// carryCodexRoutingConfig is a table-aware LINE FILTER over config.toml, not
// a TOML parser: it tracks the current `[table]` header and copies verbatim
//   - the top-level `model` / `model_provider` keys,
//   - top-level dotted keys and inline tables rooted at `model_providers` /
//     `projects` (`model_providers.p.base_url = …`, `projects = { … }`),
//   - every `[model_providers.*]` / `[projects.*]` table and their sub-tables,
//
// and drops everything else. That is enough because codex's own config.toml
// is flat `key = value` tables, and copying lines verbatim cannot change a
// value's meaning. go.mod deliberately carries no TOML dependency. Multi-line
// arrays/inline tables are tracked by bracket balance and triple-quoted
// strings by their delimiter, so a dropped multi-line value never leaks and
// a carried one travels whole. Obvious breakage is rejected rather than
// half-copied.
// Errors locate the problem by LINE NUMBER only: a failing line can hold
// secrets, and the error lands in runner logs and execution records.
func carryCodexRoutingConfig(raw string) (codexRoutingConfig, error) {
	raw = strings.TrimPrefix(raw, "\ufeff") // UTF-8 BOM, written by some Windows editors
	routing := codexRoutingConfig{ProviderEnvKeys: map[string]string{}}
	var out strings.Builder

	var tableSegments []string // current [table] header, split; nil = top level
	carryTable := false        // current table is one we copy
	carryValue := false        // the open multi-line top-level value is carried
	openBrackets := 0          // unclosed [ / { on the current multi-line value
	openedAtLine := 0          // where that value (or multi-line string) opened
	stringDelim := ""          // `"""` or `'''` while inside a multi-line string
	// A top-level `model_providers = { … }` inline table is scanned for every
	// provider's env_key once its (possibly multi-line) value is complete.
	var inlineProviders strings.Builder
	collectingInlineProviders := false
	finishInlineProviders := func() {
		for provider, envKey := range inlineTableEnvKeys(inlineProviders.String()) {
			routing.ProviderEnvKeys[provider] = envKey
		}
		inlineProviders.Reset()
		collectingInlineProviders = false
	}
	for i, line := range strings.Split(raw, "\n") {
		lineNo := i + 1
		trimmed := strings.TrimSpace(line)

		if stringDelim != "" {
			if carryValue {
				out.WriteString(trimmed + "\n")
			}
			if strings.Contains(trimmed, stringDelim) {
				stringDelim = ""
			}
			continue
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if openBrackets > 0 {
			// Continuation of a multi-line top-level value.
			openBrackets += bracketBalance(trimmed)
			if carryValue {
				out.WriteString(trimmed + "\n")
			}
			if collectingInlineProviders {
				inlineProviders.WriteString("\n" + trimmed)
				if openBrackets == 0 {
					finishInlineProviders()
				}
			}
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			header := strings.TrimSpace(stripTOMLComment(trimmed))
			if !strings.HasSuffix(header, "]") {
				return routing, fmt.Errorf("line %d: unclosed table header", lineNo)
			}
			// Whitespace around `.` is legal (`[ model_providers . p ]`); the
			// split segments are the normalized name.
			segments, ok := tomlKeySegments(strings.Trim(header, "[]"))
			tableSegments = segments
			if !ok {
				tableSegments = []string{""} // unparsable header: a table we never carry
			}
			carryTable = ok && isRoutingRoot(segments[0])
			if carryTable {
				out.WriteString("\n" + header + "\n")
			}
			continue
		}

		key, value, isAssignment, err := splitTOMLAssignment(trimmed)
		if err != nil {
			return routing, fmt.Errorf("line %d: %w", lineNo, err)
		}
		topLevel := tableSegments == nil
		if topLevel && !isAssignment {
			return routing, fmt.Errorf("line %d: expected `key = value`", lineNo)
		}

		carry := carryTable
		var keySegments []string
		if isAssignment {
			keySegments, _ = tomlKeySegments(key)
		}
		if topLevel {
			carry = key == "model" || key == "model_provider" || isRoutingRoot(keySegments[0])
			if key == "model_provider" {
				routing.ModelProvider = unquoteTOMLString(value)
			}
		}
		if isAssignment {
			if envKey, provider, ok := providerEnvKeyDeclared(tableSegments, keySegments, value); ok {
				routing.ProviderEnvKeys[provider] = envKey
			}
			if delim := openMultilineString(value); delim != "" {
				stringDelim, openedAtLine, carryValue = delim, lineNo, carry
			} else if balance := bracketBalance(value); balance > 0 {
				openBrackets, openedAtLine, carryValue = balance, lineNo, carry
			}
			if topLevel && len(keySegments) == 1 && keySegments[0] == codexProvidersKey {
				inlineProviders.WriteString(value)
				collectingInlineProviders = true
				if openBrackets == 0 {
					finishInlineProviders()
				}
			}
		}
		if carry {
			out.WriteString(trimmed + "\n")
		}
	}
	if openBrackets > 0 || stringDelim != "" {
		return routing, fmt.Errorf("line %d: unterminated multi-line value", openedAtLine)
	}
	routing.TOML = out.String()
	return routing, nil
}

func isRoutingRoot(segment string) bool {
	return segment == codexProvidersKey || segment == codexProjectsKey
}

// providerEnvKeyDeclared recognizes the line shapes codex accepts for a
// provider's env_key and reports the provider it belongs to:
//
//	[model_providers.p]            env_key = "K"
//	model_providers.p.env_key = "K"
//
// (The inline-table shape `model_providers = { p = { env_key = "K" } }` is
// scanned whole by inlineTableEnvKeys once its value is complete.) A
// sub-table such as [model_providers.p.http_headers] is NOT the provider, so
// an env_key there is ignored.
func providerEnvKeyDeclared(tableSegments, keySegments []string, value string) (envKey, provider string, ok bool) {
	switch {
	case tableSegments == nil && len(keySegments) == 3 && keySegments[0] == codexProvidersKey && keySegments[2] == "env_key":
		return unquoteTOMLString(value), keySegments[1], true
	case len(tableSegments) == 2 && tableSegments[0] == codexProvidersKey && len(keySegments) == 1 && keySegments[0] == "env_key":
		return unquoteTOMLString(value), tableSegments[1], true
	}
	return "", "", false
}

// inlineTableEnvKeys reads `{ p = { …, env_key = "K", … }, q = { … } }` and
// maps each depth-1 provider to its env_key. Nested tables inside a provider
// (http_headers = { … }) are blanked before the env_key search so their keys
// cannot masquerade as the provider's.
func inlineTableEnvKeys(inline string) map[string]string {
	inline = strings.TrimSpace(inline)
	if !strings.HasPrefix(inline, "{") || !strings.HasSuffix(inline, "}") {
		return nil
	}
	body := inline[1 : len(inline)-1]
	found := map[string]string{}
	consumedUntil := 0 // end of the last provider span; matches inside it are nested tables, not providers
	for _, m := range inlineProviderPattern.FindAllStringSubmatchIndex(body, -1) {
		if m[0] < consumedUntil {
			continue
		}
		name := body[m[2]:m[3]]
		span := balancedBraceSpan(body[m[4]:])
		if span == "" {
			continue
		}
		consumedUntil = m[4] + len(span)
		if env := inlineEnvKeyPattern.FindStringSubmatch(blankNestedBraces(span)); env != nil {
			found[unquoteTOMLString(name)] = env[1] + env[2] // one of the two quote groups matched
		}
	}
	return found
}

var (
	// `name = {` at inline-table depth 1; name may be bare or quoted.
	inlineProviderPattern = regexp.MustCompile(`(?:^|[,{])\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(\{)`)
	inlineEnvKeyPattern   = regexp.MustCompile(`(?:^|[,{])\s*env_key\s*=\s*(?:"([^"]*)"|'([^']*)')`)
)

// balancedBraceSpan returns the `{…}` span opening at s[0], or "" if unbalanced.
func balancedBraceSpan(s string) string {
	depth := 0
	var quote rune
	for i, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '{':
			depth++
		case r == '}':
			depth--
			if depth == 0 {
				return s[:i+1]
			}
		}
	}
	return ""
}

// blankNestedBraces replaces every `{…}` nested inside the outer span with
// spaces so a regex over the result only sees the span's own keys.
func blankNestedBraces(span string) string {
	b := []rune(span)
	depth := 0
	var quote rune
	for i, r := range b {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '{':
			depth++
			if depth > 1 {
				b[i] = ' '
			}
		case r == '}':
			if depth > 1 {
				b[i] = ' '
			}
			depth--
		default:
			if depth > 1 {
				b[i] = ' '
			}
		}
	}
	return string(b)
}

// openMultilineString reports the delimiter when value opens a `"""`/`”'`
// string that does not close on the same line.
func openMultilineString(value string) string {
	for _, delim := range []string{`"""`, `'''`} {
		if strings.HasPrefix(value, delim) && strings.Count(value, delim) == 1 {
			return delim
		}
	}
	return ""
}

// splitTOMLAssignment recognizes a `key = value` line. A line without a
// well-formed key before its first `=` (array/inline-table continuations such
// as `"--serve",`) is not an assignment and not an error; `key = = value` is.
func splitTOMLAssignment(line string) (key, value string, isAssignment bool, err error) {
	rawKey, rawValue, found := strings.Cut(line, "=")
	if !found {
		return "", "", false, nil
	}
	key = strings.TrimSpace(rawKey)
	if _, ok := tomlKeySegments(key); !ok {
		return "", "", false, nil
	}
	value = strings.TrimSpace(rawValue)
	if strings.HasPrefix(value, "=") {
		return "", "", false, errors.New("malformed assignment (`= =`)")
	}
	return key, value, true, nil
}

// tomlKeySegments splits a (possibly dotted) key into unquoted segments:
// bare segments allow letters, digits, `_`, `-`; quoted segments (`"…"` or
// `'…'`) allow anything. ok is false for an empty or malformed key.
func tomlKeySegments(key string) (segments []string, ok bool) {
	runes := []rune(strings.TrimSpace(key))
	if len(runes) == 0 {
		return nil, false
	}
	var cur strings.Builder
	var quote rune
	quotedSegment := false
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			if cur.Len() > 0 {
				return nil, false
			}
			quote, quotedSegment = r, true
		case r == '.':
			if cur.Len() == 0 && !quotedSegment {
				return nil, false
			}
			segments = append(segments, cur.String())
			cur.Reset()
			quotedSegment = false
		case r == ' ' || r == '\t':
			// Whitespace around dots is legal TOML; anywhere else it is garbage.
			next := i + 1
			for next < len(runes) && (runes[next] == ' ' || runes[next] == '\t') {
				next++
			}
			afterDot := cur.Len() == 0 && !quotedSegment && len(segments) > 0
			if next < len(runes) && runes[next] != '.' && !afterDot {
				return nil, false
			}
			i = next - 1
		case r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'):
			if quotedSegment {
				return nil, false
			}
			cur.WriteRune(r)
		default:
			return nil, false
		}
	}
	if quote != 0 || (cur.Len() == 0 && !quotedSegment) {
		return nil, false
	}
	return append(segments, cur.String()), true
}

// stripTOMLComment drops an unquoted trailing `# comment`.
func stripTOMLComment(line string) string {
	var quote rune
	for i, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '#':
			return line[:i]
		}
	}
	return line
}

// bracketBalance counts unclosed `[`/`{` on a line, ignoring quoted text and
// trailing comments, so a multi-line array is recognized as one value.
func bracketBalance(line string) int {
	balance := 0
	var quote rune
	for _, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
		case r == '#':
			return balance
		case r == '[' || r == '{':
			balance++
		case r == ']' || r == '}':
			balance--
		}
	}
	return balance
}

// unquoteTOMLString strips the quotes of a basic or literal TOML string
// (dropping a trailing comment); other values are returned trimmed.
func unquoteTOMLString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') {
		if end := strings.IndexByte(value[1:], value[0]); end >= 0 {
			return value[1 : 1+end]
		}
	}
	return strings.TrimSpace(stripTOMLComment(value))
}

// codexProviderKeyFromAuth bridges a custom provider's credential: codex
// reads it ONLY from the env var the provider's `env_key` names, while
// `codex login --api-key` stores it in auth.json under that same name. The
// runner injects it when the process env lacks it (empty counts as absent);
// a value already present in the env always wins and auth.json is not
// consulted. Nothing is injected on a built-in-provider host.
func codexProviderKeyFromAuth(realCodexHome string, getenv func(string) string) (name, secret string, ok bool) {
	routing, err := loadCodexRoutingConfig(realCodexHome)
	if err != nil {
		return "", "", false
	}
	name = routing.selectedProviderEnvKey()
	if name == "" || getenv(name) != "" {
		return "", "", false
	}
	raw, err := os.ReadFile(filepath.Join(realCodexHome, "auth.json"))
	if err != nil {
		return "", "", false
	}
	var auth map[string]any
	if json.Unmarshal(raw, &auth) != nil {
		return "", "", false
	}
	secret, _ = auth[name].(string)
	if secret == "" {
		return "", "", false
	}
	return name, secret, true
}
