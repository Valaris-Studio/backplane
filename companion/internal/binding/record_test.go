// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
	"time"
)

func TestIdentityID_IsTheVersionedDigestOfItsThreeComponents(t *testing.T) {
	identity := primary()
	sum := sha256.Sum256([]byte("backplane-companion-binding/v1\n" + identity.Origin + "\n" + identity.InstallationID + "\n" + identity.OwnerEmail))
	want := hex.EncodeToString(sum[:])[:32]
	if got := identity.ID(); got != want {
		t.Fatalf("ID() = %q, want %q", got, want)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(identity.ID()) {
		t.Fatalf("ID() = %q is not 32 lowercase hex characters", identity.ID())
	}
}

func TestIdentityID_DiffersWhenAnyComponentDiffers(t *testing.T) {
	base := primary()
	otherOrigin, otherInstallation, otherOwner := base, base, base
	otherOrigin.Origin = "https://backplane.example.com:8443"
	otherInstallation.InstallationID = "7a1c0de5-0000-4000-8000-000000000009"
	otherOwner.OwnerEmail = "someone@example.com"
	seen := map[string]string{base.ID(): "base"}
	for name, identity := range map[string]Identity{"origin": otherOrigin, "installation": otherInstallation, "owner": otherOwner} {
		if earlier, taken := seen[identity.ID()]; taken {
			t.Errorf("another %s has the same ID as %s", name, earlier)
		}
		seen[identity.ID()] = name
	}
	if primary().ID() != base.ID() {
		t.Fatal("ID() is not stable for equal identities")
	}
}

func TestSave_WritesAnOwnerOnlyRecordThatLoadsBack(t *testing.T) {
	root := dataRoot(t)
	saved := recordFor(primary(), firstBoundAt)
	saved.LastVerifiedAt = switchedAt
	if err := Save(root, saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(root)
	if err != nil || loaded == nil {
		t.Fatalf("load: %+v, %v", loaded, err)
	}
	if loaded.Version != 1 || loaded.BindingID != saved.BindingID || loaded.Origin != saved.Origin ||
		loaded.InstallationID != saved.InstallationID || loaded.OwnerEmail != saved.OwnerEmail ||
		!loaded.BoundAt.Equal(saved.BoundAt) || !loaded.LastVerifiedAt.Equal(saved.LastVerifiedAt) {
		t.Fatalf("loaded %+v, saved %+v", *loaded, saved)
	}

	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "binding.json" {
		t.Fatalf("the data root holds %v (%v), want binding.json alone", entries, err)
	}
	info, err := os.Lstat(filepath.Join(root, "binding.json"))
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("binding.json: %v %v", info, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("binding.json has mode %v, want 0600", info.Mode().Perm())
	}
	fields := readJSONObject(t, filepath.Join(root, "binding.json"))
	for _, key := range []string{"version", "binding_id", "origin", "installation_id", "owner_email", "bound_at", "last_verified_at"} {
		if _, present := fields[key]; !present {
			t.Errorf("binding.json lacks %q: %v", key, fields)
		}
	}
}

func TestLoad_AnAbsentRecordIsNilWithoutError(t *testing.T) {
	if record, err := Load(dataRoot(t)); record != nil || err != nil {
		t.Fatalf("load of an unbound root: %+v, %v", record, err)
	}
}

func encodeRecordFields(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func validRecordFields(identity Identity) map[string]any {
	return map[string]any{
		"version":          1,
		"binding_id":       identity.ID(),
		"origin":           identity.Origin,
		"installation_id":  identity.InstallationID,
		"owner_email":      identity.OwnerEmail,
		"bound_at":         firstBoundAt.Format(time.RFC3339Nano),
		"last_verified_at": firstBoundAt.Format(time.RFC3339Nano),
	}
}

func replacing(fields map[string]any, key string, value any) map[string]any {
	copied := map[string]any{}
	for name, existing := range fields {
		copied[name] = existing
	}
	copied[key] = value
	return copied
}

func TestLoad_RefusesARecordItDidNotWrite(t *testing.T) {
	valid := validRecordFields(primary())
	control := dataRoot(t)
	writeFile(t, filepath.Join(control, "binding.json"), encodeRecordFields(t, valid))
	if record, err := Load(control); err != nil || record == nil || record.BindingID != primary().ID() {
		t.Fatalf("a hand-written valid record: %+v, %v", record, err)
	}
	for name, content := range map[string][]byte{
		"truncated":                  []byte(`{"version":1,"binding_id":`),
		"not an object":              []byte(`[]`),
		"empty object":               []byte(`{}`),
		"another version":            encodeRecordFields(t, replacing(valid, "version", 2)),
		"binding id of other fields": encodeRecordFields(t, replacing(valid, "binding_id", secondary().ID())),
	} {
		root := dataRoot(t)
		writeFile(t, filepath.Join(root, "binding.json"), content)
		if record, err := Load(root); err == nil || record != nil {
			t.Errorf("%s: loaded %+v, %v; want a refusal", name, record, err)
		}
	}
}

func TestLoad_RefusesASymlinkedRecord(t *testing.T) {
	root, elsewhere := dataRoot(t), dataRoot(t)
	if err := Save(elsewhere, recordFor(primary(), firstBoundAt)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(elsewhere, "binding.json"), filepath.Join(root, "binding.json")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if record, err := Load(root); err == nil || record != nil {
		t.Fatalf("loaded %+v, %v through a symlink", record, err)
	}
}

func TestSave_RefusesToWriteThroughASymlink(t *testing.T) {
	if err := Save(dataRoot(t), recordFor(primary(), firstBoundAt)); err != nil {
		t.Fatalf("control: save into a clean root: %v", err)
	}
	root := dataRoot(t)
	victim := filepath.Join(dataRoot(t), "victim.json")
	writeFile(t, victim, []byte("not a binding"))
	link := filepath.Join(root, "binding.json")
	if err := os.Symlink(victim, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if err := Save(root, recordFor(primary(), firstBoundAt)); err == nil {
		t.Fatal("saved through a symlink")
	}
	if data, err := os.ReadFile(victim); err != nil || string(data) != "not a binding" {
		t.Fatalf("the symlink's target was written: %q %v", data, err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the symlink was replaced: %v %v", info, err)
	}
}
