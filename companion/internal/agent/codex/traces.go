// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// maxTraceConfigBytes bounds the config.toml read on the daemon's poll path;
// a larger file is not judged, so its traces are assumed to arrive.
const maxTraceConfigBytes = 1 << 20

// desktopOriginators name the clients known to run on Codex Desktop's
// app-server, which exports no traces. Any other client may.
var desktopOriginators = map[string]bool{"Codex Desktop": true}

// readTraceConfig is a seam for tests that count config reads.
var readTraceConfig = func(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxTraceConfigBytes+1))
	if err == nil && len(data) > maxTraceConfigBytes {
		err = errors.New("config.toml over the read bound")
	}
	return data, err
}

// traceConfig is config.toml's trace exporter as of the file's size and
// modification time; the daemon asks on every poll while a session is
// unclaimed, so the file is parsed again only once it changed.
type traceConfig struct {
	path     string
	size     int64
	modTime  time.Time
	exporter any
	// known: the file was read and parsed.
	known bool
}

var (
	traceConfigMu     sync.Mutex
	cachedTraceConfig traceConfig
)

// ExportsTraces reports whether the session a rollout cursor describes may
// deliver its usage as traces to the companion's gate: not when its rollout
// names Codex Desktop, otherwise only while config.toml points the trace
// exporter at the gate. When that cannot be told, traces are assumed to
// arrive.
func (Codex) ExportsTraces(env agent.Env, cursor json.RawMessage) bool {
	var session rolloutCursor
	if json.Unmarshal(cursor, &session) == nil && session.Desktop {
		return false
	}
	if env.Telemetry.Endpoint == "" {
		return true
	}
	exporter, known := traceExporter(configPath(env))
	return !known || reflect.DeepEqual(exporter, exporterTable(env.Telemetry.Endpoint, "traces"))
}

func traceExporter(path string) (any, bool) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, true
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxTraceConfigBytes {
		return nil, false
	}
	traceConfigMu.Lock()
	defer traceConfigMu.Unlock()
	cached := cachedTraceConfig
	if cached.path == path && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
		return cached.exporter, cached.known
	}
	cached = traceConfig{path: path, size: info.Size(), modTime: info.ModTime()}
	if data, err := readTraceConfig(path); err == nil {
		if parsed, err := parseTOML(string(data)); err == nil {
			otel, _ := parsed["otel"].(map[string]any)
			cached.exporter, cached.known = otel["trace_exporter"], true
		}
	}
	cachedTraceConfig = cached
	return cached.exporter, cached.known
}
