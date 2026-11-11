// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

//go:embed plugin/plugin.yaml
var pluginManifest []byte

//go:embed plugin/__init__.py.tmpl
var pluginTemplate []byte

// argvPlaceholder is the template's one substitution: the Python literal
// of the command the plugin runs, or None.
const argvPlaceholder = "__COMPANION_ARGV__"

// RenderPlugin returns the observer plugin's files by name, with the
// companion's absolute path in the command it runs.
func RenderPlugin(executable string) (map[string][]byte, error) {
	if !filepath.IsAbs(executable) {
		return nil, agent.ErrConfigInvalid
	}
	var argv bytes.Buffer
	encoder := json.NewEncoder(&argv)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{executable, "hook", "hermes"}); err != nil {
		return nil, err
	}
	// A JSON array of strings is also a Python list literal, so the path
	// needs no further quoting and never passes through a shell.
	return renderPlugin(bytes.TrimSpace(argv.Bytes())), nil
}

// RenderSocketOnlyPlugin returns the rendering baked into a worker image:
// it spawns nothing and forwards only over the hook socket named by
// BACKPLANE_COMPANION_HOOK_SOCKET, registering no hook without it.
func RenderSocketOnlyPlugin() map[string][]byte {
	return renderPlugin([]byte("None"))
}

func renderPlugin(argvLiteral []byte) map[string][]byte {
	source := bytes.Replace(pluginTemplate, []byte(argvPlaceholder), argvLiteral, 1)
	return map[string][]byte{"plugin.yaml": bytes.Clone(pluginManifest), "__init__.py": source}
}
