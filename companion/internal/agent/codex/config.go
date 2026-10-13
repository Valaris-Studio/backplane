// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// config.toml is edited as text so the user's comments and layout survive:
// the companion appends one marker-delimited block and at most one marked
// log_user_prompt line, and every edit is verified by re-parsing the result
// and comparing it with the intended change before anything is written.
const (
	blockBegin = "# BEGIN backplane-companion: Codex telemetry for Backplane capture (managed; do not edit)"
	// noFinalNewline marks a block appended to a file that did not end in a
	// newline, so uninstall can restore the file byte for byte.
	noFinalNewline = " [source had no final newline]"
	blockEnd       = "# END backplane-companion"
	promptMarker   = " # managed by backplane-companion"
)

var (
	errConflictingExporter = errors.New(agent.ProblemConflictExistingOTel)
	otelHeader             = regexp.MustCompile(`^\s*\[\s*otel\s*\]\s*(#.*)?$`)
	otelInlineOrDotted     = regexp.MustCompile(`^\s*otel\s*(=|\.)`)
	tableHeader            = regexp.MustCompile(`^\s*\[`)
	// managedLine matches what blockBody writes, and nothing a user or Codex
	// would add after it.
	managedLine = regexp.MustCompile(`^(\[otel\]|\[otel\.(exporter|trace_exporter)\.otlp-http\]|endpoint = "[^"]*"|protocol = "json"|log_user_prompt = (true|false))$`)
)

type configFile struct {
	text   string
	exists bool
	mode   os.FileMode
}

func readConfig(path string) (configFile, error) {
	for _, candidate := range []string{filepath.Dir(path), path} {
		if err := store.RejectSymlink(candidate); err != nil {
			return configFile{}, errors.Join(agent.ErrConfigSymlink, err)
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return configFile{mode: 0o600}, nil
	}
	if err != nil {
		return configFile{}, err
	}
	file := configFile{text: string(data), exists: true, mode: 0o600}
	if info, err := os.Stat(path); err == nil {
		file.mode = info.Mode().Perm()
	}
	return file, nil
}

func parseTOML(text string) (map[string]any, error) {
	parsed := map[string]any{}
	if err := toml.Unmarshal([]byte(text), &parsed); err != nil {
		return nil, fmt.Errorf("%w: config.toml: %v", agent.ErrConfigInvalid, err)
	}
	return parsed, nil
}

// managedLines marks the lines the companion wrote. Codex rewrites
// config.toml with toml_edit, which keeps a comment after the last table as
// a trailing document comment: the tables Codex adds (project trust, hook
// trusted_hash, [tui], ...) land between our block and its END marker, which
// ends up last in the file. So the block is not "BEGIN through END" but
// BEGIN followed by our own table headers and keys only; it ends at the first
// other line, and the END marker is ours wherever it sits.
func managedLines(lines []string) (managed []bool, found bool) {
	managed = make([]bool, len(lines))
	inBlock := false
	pendingBlanks := []int{}
	// Blank lines inside the block are ours only when more of the block
	// follows them; before a foreign line they belong to it.
	claimPendingBlanks := func() {
		for _, blank := range pendingBlanks {
			managed[blank] = true
		}
		pendingBlanks = pendingBlanks[:0]
	}
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case trimmed == blockBegin || trimmed == blockBegin+noFinalNewline:
			managed[index], inBlock, found = true, true, true
			pendingBlanks = pendingBlanks[:0]
		case trimmed == blockEnd:
			managed[index], inBlock = true, false
			claimPendingBlanks()
		case inBlock && strings.TrimSpace(trimmed) == "":
			pendingBlanks = append(pendingBlanks, index)
		case inBlock && managedLine.MatchString(trimmed):
			managed[index] = true
			claimPendingBlanks()
		case strings.HasSuffix(trimmed, promptMarker):
			managed[index], found = true, true
		default:
			inBlock = false
			pendingBlanks = pendingBlanks[:0]
		}
	}
	return managed, found
}

// withoutManaged removes the lines the companion wrote, with the blank line
// we add before the block.
func withoutManaged(text string) (string, bool) {
	lines := strings.SplitAfter(text, "\n")
	managed, found := managedLines(lines)
	kept := make([]string, 0, len(lines))
	restoreNoNewline := false
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == blockBegin || trimmed == blockBegin+noFinalNewline {
			restoreNoNewline = trimmed != blockBegin
			if count := len(kept); count > 0 && strings.TrimSpace(kept[count-1]) == "" {
				kept = kept[:count-1]
			}
		}
		if !managed[index] {
			kept = append(kept, line)
			// What Codex appended after the block keeps its own final newline.
			if strings.TrimSpace(line) != "" {
				restoreNoNewline = false
			}
		}
	}
	text = strings.Join(kept, "")
	if restoreNoNewline {
		text = strings.TrimSuffix(text, "\n")
	}
	return text, found
}

type telemetryPlan struct {
	base          string
	baseParsed    map[string]any
	managePrompt  bool
	promptPresent bool
	hasOtelHeader bool
}

func planTelemetry(text string) (telemetryPlan, error) {
	base, _ := withoutManaged(text)
	parsed, err := parseTOML(base)
	if err != nil {
		return telemetryPlan{}, err
	}
	plan := telemetryPlan{base: base, baseParsed: parsed}
	otel, hasOtel := parsed["otel"].(map[string]any)
	if hasOtel && (otel["exporter"] != nil || otel["trace_exporter"] != nil) {
		return plan, errConflictingExporter
	}
	inRootTable := true
	for _, line := range strings.Split(base, "\n") {
		if otelHeader.MatchString(line) {
			plan.hasOtelHeader = true
		}
		if tableHeader.MatchString(line) {
			inRootTable = false
		}
		// A root-level inline or dotted otel cannot be extended with
		// sub-tables; otel keys inside other tables are unrelated.
		if inRootTable && otelInlineOrDotted.MatchString(line) {
			return plan, errConflictingExporter
		}
	}
	_, plan.promptPresent = otel["log_user_prompt"]
	plan.managePrompt = !plan.promptPresent && (plan.hasOtelHeader || !hasOtel)
	return plan, nil
}

func exporterTable(endpoint, signal string) map[string]any {
	return map[string]any{"otlp-http": map[string]any{"endpoint": endpoint + "/v1/" + signal, "protocol": "json"}}
}

func promptLine(telemetry agent.Telemetry) string {
	return fmt.Sprintf("log_user_prompt = %t", telemetry.LogUserPrompt)
}

func blockBody(plan telemetryPlan, telemetry agent.Telemetry) string {
	var body strings.Builder
	if plan.managePrompt && !plan.hasOtelHeader {
		body.WriteString("[otel]\n" + promptLine(telemetry) + "\n\n")
	}
	fmt.Fprintf(&body, "[otel.exporter.otlp-http]\nendpoint = %q\nprotocol = \"json\"\n\n", telemetry.Endpoint+"/v1/logs")
	fmt.Fprintf(&body, "[otel.trace_exporter.otlp-http]\nendpoint = %q\nprotocol = \"json\"\n", telemetry.Endpoint+"/v1/traces")
	return body.String()
}

// renderManaged returns text with the managed block and prompt line as
// telemetry wants them: refreshed in place when already present (other
// tools, including Codex, may have appended tables after it), otherwise
// appended.
func renderManaged(text string, plan telemetryPlan, telemetry agent.Telemetry) string {
	if refreshed, ok := refreshManaged(text, plan, telemetry); ok {
		return refreshed
	}
	return appendManaged(plan, telemetry)
}

func refreshManaged(text string, plan telemetryPlan, telemetry agent.Telemetry) (string, bool) {
	lines := strings.SplitAfter(text, "\n")
	managed, _ := managedLines(lines)
	var out strings.Builder
	sawBlock, sawPrompt := false, false
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case trimmed == blockBegin || trimmed == blockBegin+noFinalNewline:
			if !sawBlock {
				out.WriteString(trimmed + "\n" + blockBody(plan, telemetry) + blockEnd + "\n")
			}
			sawBlock = true
		case strings.HasSuffix(trimmed, promptMarker):
			sawPrompt = true
			if plan.managePrompt && plan.hasOtelHeader {
				out.WriteString(promptLine(telemetry) + promptMarker + "\n")
			}
		case !managed[index]:
			out.WriteString(line)
		}
	}
	if !sawBlock || plan.managePrompt && plan.hasOtelHeader && !sawPrompt {
		return "", false
	}
	return out.String(), true
}

func appendManaged(plan telemetryPlan, telemetry agent.Telemetry) string {
	text := plan.base
	if plan.managePrompt && plan.hasOtelHeader {
		lines := strings.SplitAfter(text, "\n")
		for index, line := range lines {
			if otelHeader.MatchString(strings.TrimRight(line, "\r\n")) {
				lines = append(lines[:index+1], append([]string{promptLine(telemetry) + promptMarker + "\n"}, lines[index+1:]...)...)
				break
			}
		}
		text = strings.Join(lines, "")
	}
	separator, begin := "", blockBegin
	if text != "" {
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
			begin += noFinalNewline
		}
		separator = "\n"
	}
	return text + separator + begin + "\n" + blockBody(plan, telemetry) + blockEnd + "\n"
}

// isCurrent reports whether the parsed configuration already routes
// telemetry as wanted, wherever the managed block sits.
func isCurrent(parsed map[string]any, plan telemetryPlan, telemetry agent.Telemetry) bool {
	otel, _ := parsed["otel"].(map[string]any)
	if !reflect.DeepEqual(otel["exporter"], exporterTable(telemetry.Endpoint, "logs")) || !reflect.DeepEqual(otel["trace_exporter"], exporterTable(telemetry.Endpoint, "traces")) {
		return false
	}
	return !plan.managePrompt || otel["log_user_prompt"] == telemetry.LogUserPrompt
}

// expectedManaged is what the managed text must parse to: the user's own
// configuration plus exactly our keys.
func expectedManaged(plan telemetryPlan, telemetry agent.Telemetry) (map[string]any, error) {
	expected, err := parseTOML(plan.base)
	if err != nil {
		return nil, err
	}
	otel, _ := expected["otel"].(map[string]any)
	if otel == nil {
		otel = map[string]any{}
		expected["otel"] = otel
	}
	otel["exporter"] = exporterTable(telemetry.Endpoint, "logs")
	otel["trace_exporter"] = exporterTable(telemetry.Endpoint, "traces")
	if plan.managePrompt {
		otel["log_user_prompt"] = telemetry.LogUserPrompt
	}
	return expected, nil
}

// configureTelemetry points Codex's log and trace exporters at the gate. It
// reports errConflictingExporter, and writes nothing, when the user already
// configured an exporter. Without create it only refreshes an existing block.
func configureTelemetry(path string, telemetry agent.Telemetry, create bool) (bool, error) {
	if telemetry.Endpoint == "" {
		return false, fmt.Errorf("%w: no telemetry endpoint", agent.ErrConfigInvalid)
	}
	file, err := readConfig(path)
	if err != nil {
		return false, err
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return false, err
	}
	_, managed := withoutManaged(file.text)
	if !managed && !create {
		return false, nil
	}
	plan, err := planTelemetry(file.text)
	if err != nil {
		return false, err
	}
	if managed && isCurrent(parsed, plan, telemetry) {
		return false, nil
	}
	desired := renderManaged(file.text, plan, telemetry)
	expected, err := expectedManaged(plan, telemetry)
	if err != nil {
		return false, err
	}
	if err := verify(desired, expected); err != nil {
		return false, err
	}
	if err := verifyOnlyManagedChanged(file.text, desired); err != nil {
		return false, err
	}
	return true, writeConfig(path, file, desired)
}

func removeTelemetry(path string) error {
	file, err := readConfig(path)
	if err != nil || !file.exists {
		return err
	}
	base, managed := withoutManaged(file.text)
	if !managed {
		return nil
	}
	if err := verifyRemoval(file.text, base); err != nil {
		return err
	}
	return writeConfig(path, file, base)
}

// verifyRemoval checks that removing our lines changes nothing else. A file
// the user made invalid next to our block (e.g. a second [otel] table)
// cannot be compared parsed, so it is checked line by line instead and
// uninstall stays the way to recover it.
func verifyRemoval(before, after string) error {
	if _, err := parseTOML(before); err == nil {
		return verifyOnlyManagedChanged(before, after)
	}
	if _, err := parseTOML(after); err != nil {
		return err
	}
	if !keepsForeignLinesInTheirTables(before) || !claimsAtMostOneBlockBody(before) {
		return fmt.Errorf("%w: config.toml edit would change unrelated settings", agent.ErrConfigInvalid)
	}
	return nil
}

// keepsForeignLinesInTheirTables reports whether removing our lines from
// text leaves every other key in its table: a kept key right after one of our
// table's lines would otherwise move into whatever table precedes the block.
func keepsForeignLinesInTheirTables(text string) bool {
	lines := strings.SplitAfter(text, "\n")
	managed, _ := managedLines(lines)
	followsOurTable := false
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if managed[index] {
			followsOurTable = followsOurTable || managedLine.MatchString(trimmed)
			continue
		}
		if content := strings.TrimSpace(trimmed); content == "" || strings.HasPrefix(content, "#") {
			continue
		}
		if followsOurTable && !tableHeader.MatchString(trimmed) {
			return false
		}
		followsOurTable = false
	}
	return true
}

// blockBodyLineLimits is how often each line blockBody writes can occur in
// it. The scanner claims any line of our format inside the block, so a user
// copy of one of our tables there would be claimed too; the line-by-line
// removal check refuses a block holding more than one body's worth.
var blockBodyLineLimits = []struct {
	line  *regexp.Regexp
	limit int
}{
	{regexp.MustCompile(`^\[otel\]$`), 1},
	{regexp.MustCompile(`^\[otel\.exporter\.otlp-http\]$`), 1},
	{regexp.MustCompile(`^\[otel\.trace_exporter\.otlp-http\]$`), 1},
	{regexp.MustCompile(`^log_user_prompt = `), 1},
	{regexp.MustCompile(`^endpoint = `), 2},
	{regexp.MustCompile(`^protocol = `), 2},
}

func claimsAtMostOneBlockBody(text string) bool {
	lines := strings.SplitAfter(text, "\n")
	managed, _ := managedLines(lines)
	counts := make([]int, len(blockBodyLineLimits))
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if !managed[index] || !managedLine.MatchString(trimmed) {
			continue
		}
		for kind, limit := range blockBodyLineLimits {
			if limit.line.MatchString(trimmed) {
				if counts[kind]++; counts[kind] > limit.limit {
					return false
				}
			}
		}
	}
	return true
}

// managedKeys are the paths of every key the companion may write.
var managedKeys = [][]string{
	{"otel", "exporter", "otlp-http", "endpoint"},
	{"otel", "exporter", "otlp-http", "protocol"},
	{"otel", "trace_exporter", "otlp-http", "endpoint"},
	{"otel", "trace_exporter", "otlp-http", "protocol"},
	{"otel", "log_user_prompt"},
}

// verifyOnlyManagedChanged refuses an edit that would change, move or drop
// any setting outside managedKeys, e.g. one the user typed into our block.
func verifyOnlyManagedChanged(before, after string) error {
	beforeParsed, err := parseTOML(before)
	if err != nil {
		return err
	}
	afterParsed, err := parseTOML(after)
	if err != nil {
		return err
	}
	for _, key := range managedKeys {
		withoutKey(beforeParsed, key)
		withoutKey(afterParsed, key)
	}
	if !reflect.DeepEqual(beforeParsed, afterParsed) {
		return fmt.Errorf("%w: config.toml edit would change unrelated settings", agent.ErrConfigInvalid)
	}
	return nil
}

// withoutKey deletes the key at path and the tables it leaves empty.
func withoutKey(table map[string]any, path []string) {
	if len(path) == 1 {
		delete(table, path[0])
		return
	}
	nested, ok := table[path[0]].(map[string]any)
	if !ok {
		return
	}
	withoutKey(nested, path[1:])
	if len(nested) == 0 {
		delete(table, path[0])
	}
}

func verify(text string, expected map[string]any) error {
	actual, err := parseTOML(text)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, expected) {
		return fmt.Errorf("%w: config.toml edit would change unrelated settings", agent.ErrConfigInvalid)
	}
	return nil
}

func writeConfig(path string, file configFile, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	original := []byte(file.text)
	// Codex may rewrite config.toml (e.g. when the user trusts a hook); never
	// replace a version we did not read.
	return store.WriteFileAtomicIf(path, []byte(text), file.mode, func() error {
		current, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if !bytes.Equal(current, original) {
			return agent.ErrConfigChanged
		}
		return nil
	})
}

type telemetryStatus struct {
	problems []string
	notes    []string
}

func telemetryState(path string, telemetry agent.Telemetry) telemetryStatus {
	file, err := readConfig(path)
	if err != nil {
		return telemetryStatus{problems: []string{agent.ProblemConfigUnreadable}}
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return telemetryStatus{problems: []string{agent.ProblemConfigInvalid}}
	}
	_, managed := withoutManaged(file.text)
	plan, err := planTelemetry(file.text)
	status := telemetryStatus{}
	if plan.promptPresent {
		status.notes = append(status.notes, "log_user_prompt_set_by_user")
	}
	switch {
	case errors.Is(err, errConflictingExporter):
		status.problems = append(status.problems, agent.ProblemConflictExistingOTel)
	case err != nil:
		status.problems = append(status.problems, agent.ProblemConfigInvalid)
	case !managed:
		status.problems = append(status.problems, agent.ComponentProblem("otel", agent.ProblemMissing))
	case !isCurrent(parsed, plan, telemetry):
		status.problems = append(status.problems, agent.ComponentProblem("otel", agent.ProblemStale))
	}
	return status
}
