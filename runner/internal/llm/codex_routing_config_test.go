// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// lineNumberPattern matches the `line N` locator an error must carry.
var lineNumberPattern = regexp.MustCompile(`\bline \d+\b`)

// Round 2 (adversarial review) — carryCodexRoutingConfig is a line filter,
// and the review found real-world config.toml shapes it either rejects or
// silently drops even though codex itself accepts them (every shape below
// was verified with `CODEX_HOME=<dir> codex mcp list` → exit 0 on codex-cli
// 0.144.1). A rejected shape fails EVERY launch on that host; a dropped
// shape routes the host to api.openai.com with the wrong key. Each case
// carries the expected lines verbatim and, where codex is on PATH, proves
// the carried output still loads in codex.

// routingShapeCase is one real-world config.toml shape.
type routingShapeCase struct {
	name string
	raw  string
	// wantCarried lines must appear verbatim (after per-line TrimSpace) in
	// routing.TOML; wantAbsent substrings must not.
	wantCarried   []string
	wantAbsent    []string
	wantProvider  string
	wantEnvKeys   map[string]string
	forbidEnvKeys []string // provider names that must NOT get an env_key entry
}

var routingShapeCases = []routingShapeCase{
	{
		name: "table_header_with_trailing_comment",
		raw: "model_provider = \"p\"\n" +
			"[model_providers.p] # my proxy\n" +
			"name = \"p\"\nbase_url = \"https://x.test/v1\"\nenv_key = \"K\"\n",
		wantCarried:  []string{`model_provider = "p"`, `name = "p"`, `base_url = "https://x.test/v1"`, `env_key = "K"`},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name: "utf8_bom_on_first_line",
		raw: "\ufeffmodel = \"x\"\nmodel_provider = \"p\"\n" +
			"[model_providers.p]\nname = \"p\"\nenv_key = \"K\"\n",
		wantCarried:  []string{`model = "x"`, `model_provider = "p"`, `env_key = "K"`},
		wantAbsent:   []string{"\ufeff"},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name: "top_level_dotted_keys",
		raw: "model_providers.p.name = \"p\"\n" +
			"model_providers.p.base_url = \"https://x.test/v1\"\n" +
			"model_providers.p.env_key = \"K\"\n" +
			"projects.\"/x\".trust_level = \"trusted\"\n" +
			"model_provider = \"p\"\n",
		wantCarried: []string{
			`model_providers.p.name = "p"`,
			`model_providers.p.base_url = "https://x.test/v1"`,
			`model_providers.p.env_key = "K"`,
			`projects."/x".trust_level = "trusted"`,
			`model_provider = "p"`,
		},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name: "single_line_inline_table",
		raw: "model_providers = { p = { name = \"p\", base_url = \"https://x.test/v1\", env_key = \"K\" } }\n" +
			"model_provider = \"p\"\n",
		wantCarried:  []string{`model_providers = { p = { name = "p", base_url = "https://x.test/v1", env_key = "K" } }`, `model_provider = "p"`},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name: "http_headers_subtable",
		raw: "model_provider = \"p\"\n[model_providers.p]\nname = \"p\"\nbase_url = \"https://x.test/v1\"\nenv_key = \"K\"\n" +
			"[model_providers.p.http_headers]\nX-Foo = \"bar\"\nenv_key = \"NOT_A_PROVIDER_KEY\"\n",
		wantCarried:   []string{`[model_providers.p.http_headers]`, `X-Foo = "bar"`},
		wantProvider:  "p",
		wantEnvKeys:   map[string]string{"p": "K"},
		forbidEnvKeys: []string{"p.http_headers"},
	},
	{
		name:         "crlf_line_endings",
		raw:          "model = \"x\"\r\nmodel_provider = \"p\"\r\n[model_providers.p]\r\nname = \"p\"\r\nenv_key = \"K\"\r\n",
		wantCarried:  []string{`model = "x"`, `model_provider = "p"`, `[model_providers.p]`, `env_key = "K"`},
		wantAbsent:   []string{"\r"},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name:        "comment_only_and_blank_lines",
		raw:         "# just a comment\n\n   \n# another\n",
		wantCarried: nil,
	},
	{
		name: "multiline_basic_string_in_dropped_key",
		raw: "model = \"x\"\n" +
			"model_instructions = \"\"\"\nabc\nthis is not toml\n\"\"\"\n" +
			"model_provider = \"p\"\n[model_providers.p]\nname = \"p\"\nenv_key = \"K\"\n",
		wantCarried:  []string{`model = "x"`, `model_provider = "p"`, `env_key = "K"`},
		wantAbsent:   []string{"abc", "this is not toml"},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	{
		name: "real_config_already_has_mcp_servers_valaris",
		raw: "model_provider = \"p\"\n[model_providers.p]\nname = \"p\"\nenv_key = \"K\"\n" +
			"[mcp_servers.valaris]\ncommand = \"old-runner\"\n",
		wantCarried:  []string{`env_key = "K"`},
		wantAbsent:   []string{"[mcp_servers.valaris]", "old-runner"},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "K"},
	},
	// Round 3 (delta review): several providers in ONE inline table. Every
	// provider's env_key must be recorded — a single-slot record picks one at
	// random over a Go map, so injection for the SELECTED provider (q) would
	// only work by luck.
	{
		name: "multi_provider_inline_table_selects_second",
		raw: "model_providers = { p = { name = \"p\", base_url = \"https://p.test/v1\", env_key = \"P_KEY\" }, q = { name = \"q\", base_url = \"https://q.test/v1\", env_key = \"Q_KEY\" } }\n" +
			"model_provider = \"q\"\n",
		wantCarried: []string{
			`model_providers = { p = { name = "p", base_url = "https://p.test/v1", env_key = "P_KEY" }, q = { name = "q", base_url = "https://q.test/v1", env_key = "Q_KEY" } }`,
			`model_provider = "q"`,
		},
		wantProvider: "q",
		wantEnvKeys:  map[string]string{"p": "P_KEY", "q": "Q_KEY"},
	},
	// Round 3: whitespace around the dot inside a table header (codex accepts
	// `[ model_providers . p ]`) must not turn the table into a dropped one.
	{
		name: "table_header_with_whitespace_around_dot",
		raw: "model_provider = \"p\"\n[ model_providers . p ]\n" +
			"name = \"p\"\nbase_url = \"https://p.test/v1\"\nenv_key = \"P_KEY\"\n",
		wantCarried:  []string{`model_provider = "p"`, `name = "p"`, `base_url = "https://p.test/v1"`, `env_key = "P_KEY"`},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "P_KEY"},
	},
	// Round 3: an inline table spread over several lines (codex's parser
	// accepts it) must be carried WHOLE — a partial copy is a broken config.
	{
		name: "multi_line_inline_table",
		raw: "model_providers = {\n" +
			"  p = { name = \"p\", base_url = \"https://p.test/v1\", env_key = \"P_KEY\" },\n" +
			"}\n" +
			"model_provider = \"p\"\n",
		wantCarried: []string{
			`model_providers = {`,
			`p = { name = "p", base_url = "https://p.test/v1", env_key = "P_KEY" },`,
			`}`,
			`model_provider = "p"`,
		},
		wantProvider: "p",
		wantEnvKeys:  map[string]string{"p": "P_KEY"},
	},
}

func trimmedLines(doc string) map[string]bool {
	set := map[string]bool{}
	for _, line := range strings.Split(doc, "\n") {
		set[strings.TrimSpace(line)] = true
	}
	return set
}

func TestCarryCodexRoutingConfig_RealWorldShapes(t *testing.T) {
	_, codexErr := exec.LookPath("codex")

	for _, c := range routingShapeCases {
		t.Run(c.name, func(t *testing.T) {
			routing, err := carryCodexRoutingConfig(c.raw)
			if err != nil {
				t.Fatalf("codex accepts this config shape; the runner rejected it: %v\nraw:\n%q", err, c.raw)
			}
			lines := trimmedLines(routing.TOML)
			for _, want := range c.wantCarried {
				if !lines[want] {
					t.Errorf("carried TOML missing verbatim line %q:\n%s", want, routing.TOML)
				}
			}
			for _, absent := range c.wantAbsent {
				if strings.Contains(routing.TOML, absent) {
					t.Errorf("carried TOML must not contain %q:\n%q", absent, routing.TOML)
				}
			}
			if routing.ModelProvider != c.wantProvider {
				t.Errorf("ModelProvider = %q, want %q", routing.ModelProvider, c.wantProvider)
			}
			for provider, key := range c.wantEnvKeys {
				if got := routing.ProviderEnvKeys[provider]; got != key {
					t.Errorf("ProviderEnvKeys[%q] = %q, want %q (env_key injection depends on it)", provider, got, key)
				}
			}
			for _, provider := range c.forbidEnvKeys {
				if got, ok := routing.ProviderEnvKeys[provider]; ok {
					t.Errorf("ProviderEnvKeys must not carry a sub-table entry %q=%q", provider, got)
				}
			}

			if codexErr != nil || routing.TOML == "" {
				return
			}
			// Ground truth: the carried slice must itself be a config codex loads.
			home := t.TempDir()
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(routing.TOML), 0o600); err != nil {
				t.Fatalf("write carried config: %v", err)
			}
			cmd := exec.Command("codex", "mcp", "list")
			cmd.Env = append(filterEnv(os.Environ(), "CODEX_HOME"), "CODEX_HOME="+home)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Errorf("codex rejected the carried config (`codex mcp list` under CODEX_HOME=%s): %v\n%s\ncarried:\n%s", home, err, out, routing.TOML)
			}
		})
	}
}

// When the real config already wires [mcp_servers.valaris] (an operator who
// configured the MCP server by hand), the runner's block must be the only
// one in the launch home — two tables with the same name is a TOML error.
func TestCodexLaunchHome_RunnerMCPBlockWinsOverRealConfig(t *testing.T) {
	real := writeFakeRealCodexHome(t,
		"model_provider = \"p\"\n[model_providers.p]\nname = \"p\"\nenv_key = \"K\"\n[mcp_servers.valaris]\ncommand = \"old-runner\"\nargs = []\n",
		`{"auth_mode":"apikey","K":"sk"}`)
	home, cleanup, err := codexLaunchHome(codexHomeSpec{
		RealCodexHome:   real,
		MCPTemplatePath: writeStaticTemplate(t),
		AllowedTools:    []string{"mcp__valaris__get_card"},
		DenyRules:       renderCodexDenyRules(SafeToolDenyFloor),
	})
	if err != nil {
		t.Fatalf("codexLaunchHome: %v", err)
	}
	defer cleanup()
	doc := readCodexConfigToml(t, home)
	if n := strings.Count(doc, "[mcp_servers.valaris]"); n != 1 {
		t.Errorf("want exactly one [mcp_servers.valaris] table, got %d:\n%s", n, doc)
	}
	if strings.Contains(doc, "old-runner") {
		t.Errorf("the real config's MCP block must be dropped in favor of the runner's:\n%s", doc)
	}
	assertTOMLValue(t, doc, "mcp_servers.valaris", "command", `"bash"`)
}

// Error hygiene: a malformed config may carry secrets on the very line that
// fails (VALARIS_API_KEY, Authorization headers). The error must locate the
// problem (path + line number) without echoing the line's content — it ends
// up in runner logs and Backplane execution records.
func TestCarryCodexRoutingConfig_ErrorsNeverEchoConfigContent(t *testing.T) {
	const apiKey = "vlr_secret"
	const bearer = "Bearer xyz"
	cases := map[string]string{
		"malformed_assignment_with_secret": "model = \"x\"\nVALARIS_API_KEY = = \"" + apiKey + "\"\n",
		"unclosed_header_with_secret":      "model = \"x\"\n[model_providers.p # Authorization = \"" + bearer + "\"\n",
		"garbage_line_with_secret":         "model = \"x\"\nthis is not toml " + bearer + " VALARIS_API_KEY=" + apiKey + "\n",
		"unterminated_value_with_secret":   "model = \"x\"\nnotify = [\n\"" + bearer + "\",\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			real := writeFakeRealCodexHome(t, raw, `{"auth_mode":"apikey"}`)
			configPath := filepath.Join(real, "config.toml")

			_, err := loadCodexRoutingConfig(real)
			if err == nil {
				t.Fatalf("malformed config must be rejected:\n%q", raw)
			}
			msg := err.Error()
			if !strings.Contains(msg, configPath) {
				t.Errorf("error must name the config path %s: %v", configPath, err)
			}
			if !lineNumberPattern.MatchString(msg) {
				t.Errorf("error must carry a line number (`line N`): %v", err)
			}
			for _, secret := range []string{apiKey, bearer} {
				if strings.Contains(msg, secret) {
					t.Errorf("error echoes config content %q: %v", secret, err)
				}
			}
		})
	}
}
