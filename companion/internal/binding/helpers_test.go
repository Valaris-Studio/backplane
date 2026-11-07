// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

var (
	firstBoundAt   = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	switchedAt     = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	switchedBackAt = time.Date(2026, 10, 24, 8, 30, 0, 0, time.UTC)
)

func primary() Identity {
	return Identity{
		Origin:         "https://backplane.example.com",
		InstallationID: "7a1c0de5-0000-4000-8000-000000000001",
		OwnerEmail:     "owner@example.com",
	}
}

func secondary() Identity {
	return Identity{
		Origin:         "https://bp2.example.com",
		InstallationID: "7a1c0de5-0000-4000-8000-000000000002",
		OwnerEmail:     "owner@example.com",
	}
}

var (
	scopedFiles = []string{
		"installation.json", "policy.json", "admission.json", "ledger.json", "threads.json",
		"capture-windows.json", "mapped-roots.json", "suppressed-sessions.json", "discovered.json",
	}
	scopedDirs = []string{"queue", "inbox", "work", "otel", "usage", "rich"}
)

func isScopedDir(name string) bool {
	for _, dir := range scopedDirs {
		if dir == name {
			return true
		}
	}
	return false
}

func isScoped(name string) bool {
	if isScopedDir(name) {
		return true
	}
	for _, file := range scopedFiles {
		if file == name {
			return true
		}
	}
	return false
}

func topLevel(path string) string { return strings.SplitN(path, "/", 2)[0] }

func dataRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// writeConnectionState fills the named connection-scoped entries (all of
// them when none are named) with bytes unique to tag and entry.
func writeConnectionState(t *testing.T, root, tag string, names ...string) {
	t.Helper()
	if len(names) == 0 {
		names = append(append(names, scopedFiles...), scopedDirs...)
	}
	for _, name := range names {
		if !isScopedDir(name) {
			writeFile(t, filepath.Join(root, name), []byte(fmt.Sprintf(`{"binding":%q,"entry":%q}`+"\n", tag, name)))
			continue
		}
		writeFile(t, filepath.Join(root, name, tag+"-0001.rec"), []byte(tag+"/"+name+"\x00\x01\xfe\xff first record"))
		writeFile(t, filepath.Join(root, name, "nested", tag+"-0002.rec"), []byte(tag+"/"+name+"\x00\x02 second record"))
	}
}

// writeDeviceState fills the entries that belong to the device rather than
// to any binding.
func writeDeviceState(t *testing.T, root string) {
	t.Helper()
	for path, data := range map[string]string{
		"preferences.json": `{"paused":false,"ignored":["/srv/private"]}`,
		"otel.json":        `{"enabled":true}`,
		"health.json":      `{"ok":true}`,
		"state.lock":       "",
		"daemon.lock":      "",
		"session.lock":     "",
		"logs/daemon.log":  "daemon started\n",
	} {
		writeFile(t, filepath.Join(root, path), []byte(data))
	}
}

func recordFor(identity Identity, boundAt time.Time) Record {
	return Record{
		Version:        1,
		BindingID:      identity.ID(),
		Origin:         identity.Origin,
		InstallationID: identity.InstallationID,
		OwnerEmail:     identity.OwnerEmail,
		BoundAt:        boundAt,
		LastVerifiedAt: boundAt,
	}
}

// bind makes root a data root bound to identity with a full set of
// connection state tagged tag beside the device's own files.
func bind(t *testing.T, root string, identity Identity, boundAt time.Time, tag string) {
	t.Helper()
	writeDeviceState(t, root)
	writeConnectionState(t, root, tag)
	if err := Save(root, recordFor(identity, boundAt)); err != nil {
		t.Fatal(err)
	}
}

// tree maps each slash-separated path under a root to "dir", the target of a
// symlink, or the sha256 of a file's bytes.
type tree map[string]string

func snapshot(t *testing.T, root string) tree {
	t.Helper()
	entries := tree{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			entries[relative] = "symlink:" + target
			return err
		case entry.IsDir():
			entries[relative] = "dir"
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			entries[relative] = hex.EncodeToString(sum[:])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

// isRecordPath is the active binding.json or a quarantined copy of it; their
// bytes carry timestamps, so they are compared field by field instead.
func isRecordPath(path string) bool {
	parts := strings.Split(path, "/")
	return path == "binding.json" || (len(parts) == 3 && parts[0] == "quarantine" && parts[2] == "binding.json")
}

func withoutRecords(entries tree) tree {
	kept := tree{}
	for path, entry := range entries {
		if !isRecordPath(path) {
			kept[path] = entry
		}
	}
	return kept
}

// quarantined is before after a switch away from bindingID: every
// connection-scoped entry moved under quarantine/<bindingID>/ unchanged and
// everything else left in place.
func quarantined(before tree, bindingID string) tree {
	after := tree{"quarantine": "dir", "quarantine/" + bindingID: "dir"}
	for path, entry := range withoutRecords(before) {
		if isScoped(topLevel(path)) {
			after["quarantine/"+bindingID+"/"+path] = entry
		} else {
			after[path] = entry
		}
	}
	return after
}

func requireTree(t *testing.T, got, want tree) {
	t.Helper()
	var differences []string
	for path, entry := range want {
		switch actual, present := got[path]; {
		case !present:
			differences = append(differences, "missing "+path)
		case actual != entry:
			differences = append(differences, "changed "+path)
		}
	}
	for path := range got {
		if _, expected := want[path]; !expected {
			differences = append(differences, "unexpected "+path)
		}
	}
	if len(differences) > 0 {
		sort.Strings(differences)
		t.Fatalf("data root differs from the expected tree:\n  %s", strings.Join(differences, "\n  "))
	}
}

func requireActiveRecord(t *testing.T, root string, identity Identity, boundAt time.Time) {
	t.Helper()
	record, err := Load(root)
	if err != nil || record == nil {
		t.Fatalf("load the active binding: %+v, %v", record, err)
	}
	if record.Version != 1 || record.BindingID != identity.ID() || record.Origin != identity.Origin ||
		record.InstallationID != identity.InstallationID || record.OwnerEmail != identity.OwnerEmail {
		t.Fatalf("active binding %+v, want %+v (%s)", *record, identity, identity.ID())
	}
	if !record.BoundAt.Equal(boundAt) {
		t.Fatalf("active binding bound at %v, want %v", record.BoundAt, boundAt)
	}
}

func readJSONObject(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]any{}
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatalf("%s: %v", filepath.Base(path), err)
	}
	return fields
}

func timeField(t *testing.T, fields map[string]any, key string) time.Time {
	t.Helper()
	text, _ := fields[key].(string)
	at, err := time.Parse(time.RFC3339Nano, text)
	if err != nil || at.IsZero() {
		t.Fatalf("%s = %v is not a timestamp", key, fields[key])
	}
	return at
}

// requireQuarantinedRecord checks the copy of binding.json a switch leaves
// beside the entries it quarantined.
func requireQuarantinedRecord(t *testing.T, root string, identity Identity, boundAt time.Time) {
	t.Helper()
	fields := readJSONObject(t, filepath.Join(root, "quarantine", identity.ID(), "binding.json"))
	for key, want := range map[string]string{
		"binding_id":      identity.ID(),
		"origin":          identity.Origin,
		"installation_id": identity.InstallationID,
		"owner_email":     identity.OwnerEmail,
	} {
		if fields[key] != want {
			t.Errorf("quarantined binding.json %s = %v, want %q", key, fields[key], want)
		}
	}
	if at := timeField(t, fields, "bound_at"); !at.Equal(boundAt) {
		t.Errorf("quarantined binding.json bound_at = %v, want %v", at, boundAt)
	}
	timeField(t, fields, "quarantined_at")
}

func requireOwnerOnlyDir(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		t.Fatalf("%s is not a directory: %v", path, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("%s has mode %v, want 0700", path, info.Mode().Perm())
	}
}

func errorChain(err error) []error {
	var chain []error
	pending := []error{err}
	for len(pending) > 0 {
		current := pending[0]
		pending = pending[1:]
		if current == nil {
			continue
		}
		chain = append(chain, current)
		switch wrapper := current.(type) {
		case interface{ Unwrap() error }:
			pending = append(pending, wrapper.Unwrap())
		case interface{ Unwrap() []error }:
			pending = append(pending, wrapper.Unwrap()...)
		}
	}
	return chain
}

// hasCode reports whether err, or an error it wraps, is the stable code
// itself or the code followed by ": detail".
func hasCode(err error, code string) bool {
	for _, link := range errorChain(err) {
		if text := link.Error(); text == code || strings.HasPrefix(text, code+":") {
			return true
		}
	}
	return false
}

func codeWithPrefix(err error, prefix string) string {
	for _, link := range errorChain(err) {
		if text := link.Error(); strings.HasPrefix(text, prefix) {
			return strings.SplitN(text, ":", 2)[0]
		}
	}
	return ""
}

var decisionNames = []struct {
	decision Decision
	name     string
}{
	{Fresh, "Fresh"},
	{Resume, "Resume"},
	{Switch, "Switch"},
	{HoldIdentityMismatch, "HoldIdentityMismatch"},
	{HoldUnverified, "HoldUnverified"},
	{HoldSwitchInProgress, "HoldSwitchInProgress"},
	{HoldUnboundState, "HoldUnboundState"},
}

func decisionName(decision Decision) string {
	for _, known := range decisionNames {
		if known.decision == decision {
			return known.name
		}
	}
	return fmt.Sprintf("Decision(%d)", int(decision))
}

// requireDecision also proves Decide only reads: the data root is the same
// tree before and after.
func requireDecision(t *testing.T, root string, configured Identity, verified *Identity, want Decision) {
	t.Helper()
	before := snapshot(t, root)
	got, err := Decide(root, configured, verified)
	if err != nil {
		t.Fatalf("decide: %v", err)
	}
	if got != want {
		t.Fatalf("decided %s, want %s", decisionName(got), decisionName(want))
	}
	requireTree(t, snapshot(t, root), before)
}

func resetSwitchHook(t *testing.T) {
	t.Helper()
	afterSwitchPhase = func(string) {}
	t.Cleanup(func() { afterSwitchPhase = func(string) {} })
}

type injectedCrash struct{ phase string }

// switchCrashingAfter runs a switch that dies right after phase, as a
// killed process would: the hook panics and nothing after it runs.
func switchCrashingAfter(t *testing.T, phase, root string, from, to Identity, now time.Time) {
	t.Helper()
	crashed := false
	afterSwitchPhase = func(reached string) {
		if reached == phase {
			crashed = true
			panic(injectedCrash{phase})
		}
	}
	func() {
		defer func() {
			afterSwitchPhase = func(string) {}
			if recovered := recover(); recovered != nil {
				if _, injected := recovered.(injectedCrash); !injected {
					panic(recovered)
				}
			}
		}()
		_ = SwitchTo(root, from, to, now)
	}()
	if !crashed {
		t.Fatalf("the switch never reached phase %q", phase)
	}
}
