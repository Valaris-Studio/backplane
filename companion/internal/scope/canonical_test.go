// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

const (
	cafeComposed   = "Café"  // NFC, how the directory is created on disk
	cafeDecomposed = "Café" // NFD, how another tool may spell it
)

// requireCaseInsensitiveVolume skips unless root lives on a volume that
// resolves a case-swapped name to the same directory (the macOS default).
func requireCaseInsensitiveVolume(t *testing.T, root string) {
	t.Helper()
	probe := filepath.Join(root, "CaseProbe")
	mkdir(t, probe)
	defer os.Remove(probe)
	original, _ := os.Stat(probe)
	swapped, err := os.Stat(filepath.Join(root, "cASEpROBE"))
	if err != nil || !os.SameFile(original, swapped) {
		t.Skip("temp volume is case-sensitive")
	}
}

func withVolumeCaseSensitivity(t *testing.T, sensitive bool) {
	t.Helper()
	real := volumeIsCaseSensitive
	volumeIsCaseSensitive = func(string) bool { return sensitive }
	t.Cleanup(func() { volumeIsCaseSensitive = real })
}

// respell swaps the letter case of path below base, keeping base as is.
func respell(base, path string) string {
	relative := strings.TrimPrefix(path, base)
	return base + strings.Map(func(r rune) rune {
		if lower := strings.ToLower(string(r)); lower != string(r) {
			return []rune(lower)[0]
		}
		return []rune(strings.ToUpper(string(r)))[0]
	}, relative)
}

func TestCanonicalDir_ReturnsTheOnDiskSpellingOfAnotherCase(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	project := filepath.Join(f.home, "Code", "Shop")
	mkdir(t, filepath.Join(project, "Web"))
	for _, spelled := range []string{respell(f.root, project), respell(f.root, filepath.Join(project, "Web"))} {
		got, ok := CanonicalDir(spelled)
		want := project
		if strings.HasSuffix(spelled, "wEB") {
			want = filepath.Join(project, "Web")
		}
		if !ok || got != want {
			t.Errorf("CanonicalDir(%q) = %q, %v; want %q", spelled, got, ok, want)
		}
	}
}

func TestCanonicalDir_ReturnsTheOnDiskUnicodeNormalization(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	composed := filepath.Join(f.home, cafeComposed)
	mkdir(t, composed)
	if _, err := os.Stat(filepath.Join(f.home, cafeDecomposed)); err != nil {
		t.Skip("volume is normalization-sensitive")
	}
	if got, ok := CanonicalDir(filepath.Join(f.home, cafeDecomposed)); !ok || got != composed {
		t.Fatalf("CanonicalDir(NFD) = %q, %v; want the NFC name on disk %q", got, ok, composed)
	}
}

func TestCanonicalDir_KeepsTheGivenSpellingOnACaseSensitiveVolume(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	withVolumeCaseSensitivity(t, true)
	project := filepath.Join(f.home, "Shop")
	mkdir(t, project)
	spelled := respell(f.root, project)
	if got, ok := CanonicalDir(spelled); !ok || got != spelled {
		t.Fatalf("a case-sensitive volume must not fold case: CanonicalDir(%q) = %q, %v", spelled, got, ok)
	}
}

func TestCanonicalDir_StillResolvesSymlinksAndRefusesWhatIsNotADirectory(t *testing.T) {
	f := newFixture(t)
	project := filepath.Join(f.home, "Project")
	mkdir(t, project)
	alias := filepath.Join(f.home, "alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Skip(err)
	}
	if got, ok := CanonicalDir(alias); !ok || got != project {
		t.Errorf("symlink: %q, %v", got, ok)
	}
	file := filepath.Join(f.home, "notes.txt")
	write(t, file, "x")
	for _, path := range []string{"", "relative/dir", filepath.Join(f.home, "missing"), respell(f.root, filepath.Join(f.home, "missing")), file} {
		if got, ok := CanonicalDir(path); ok {
			t.Errorf("CanonicalDir(%q) = %q, want refusal", path, got)
		}
	}
}

func TestCanonicalDir_ResolvesASymlinkSpelledInAnotherCase(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	project := filepath.Join(f.home, "Project")
	mkdir(t, project)
	alias := filepath.Join(f.home, "Alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Skip(err)
	}
	if got, ok := CanonicalDir(respell(f.root, alias)); !ok || got != project {
		t.Fatalf("CanonicalDir(respelled symlink) = %q, %v; want %q", got, ok, project)
	}
}

func TestVolumeCaseSensitivity_ProbesTheRealVolume(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	if volumeIsCaseSensitive(f.home) {
		t.Fatal("probe calls the case-insensitive temp volume case-sensitive")
	}
	if sensitive, known := caseSensitiveByLookup(f.home); !known || sensitive {
		t.Fatalf("lookup probe: sensitive=%v known=%v", sensitive, known)
	}
}

func TestDecide_RefusesAnIgnoredPathSpelledInAnotherCase(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	repo := f.repo(t, "Shop", "git@github.com:acme/shop.git")
	inside := filepath.Join(repo, "web")
	mkdir(t, inside)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: repo, Enabled: true}}
	for name, ignored := range map[string]string{"stored as on disk": repo, "stored in another case": respell(f.root, repo)} {
		for _, cwd := range []string{repo, respell(f.root, repo), respell(f.root, inside)} {
			input := f.input(cwd)
			input.IgnoredPaths = []string{ignored}
			if decision := Decide(input); decision.InScope || decision.Reason != ReasonIgnored {
				t.Errorf("%s, cwd %q: %+v", name, cwd, decision)
			}
		}
	}
}

func TestDecide_RefusesAnIgnoredPathSpelledInAnotherNormalization(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	composed := filepath.Join(f.home, cafeComposed)
	mkdir(t, composed)
	decomposed := filepath.Join(f.home, cafeDecomposed)
	if _, err := os.Stat(decomposed); err != nil {
		t.Skip("volume is normalization-sensitive")
	}
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.home + "/", Enabled: true}}
	for _, pair := range [][2]string{{composed, decomposed}, {decomposed, composed}} {
		input := f.input(pair[1])
		input.IgnoredPaths = []string{pair[0]}
		if decision := Decide(input); decision.InScope || decision.Reason != ReasonIgnored {
			t.Errorf("ignored %q, cwd %q: %+v", pair[0], pair[1], decision)
		}
	}
}

func TestDecide_ExcludeGlobMatchesAnotherCaseOnACaseInsensitiveVolume(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	client := filepath.Join(f.home, "clients", "northwind")
	mkdir(t, client)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.home + "/", Enabled: true}}
	for _, glob := range []string{"~/Clients/**", "~/CLIENTS/*", "NorthWind", "/" + strings.ToUpper(strings.TrimPrefix(client, "/"))} {
		f.cached.Policy.Installation.ExcludeGlobs = []string{glob}
		for _, cwd := range []string{client, respell(f.root, client)} {
			if decision := Decide(f.input(cwd)); decision.InScope || decision.Reason != ReasonExcluded {
				t.Errorf("glob %q, cwd %q: %+v", glob, cwd, decision)
			}
		}
	}
}

func TestDecide_ExcludeGlobMatchesAnotherNormalization(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	inside := filepath.Join(f.home, cafeComposed, "site")
	mkdir(t, inside)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.home + "/", Enabled: true}}
	f.cached.Policy.Installation.ExcludeGlobs = []string{"~/" + cafeDecomposed + "/**"}
	if decision := Decide(f.input(inside)); decision.InScope || decision.Reason != ReasonExcluded {
		t.Fatalf("NFD glob vs NFC folder: %+v", decision)
	}
}

func TestDecide_ExcludeGlobKeepsCaseOnACaseSensitiveVolume(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	withVolumeCaseSensitivity(t, true)
	client := filepath.Join(f.home, "clients", "northwind")
	mkdir(t, client)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.home, Enabled: true}}
	f.cached.Policy.Installation.ExcludeGlobs = []string{"~/Clients/**"}
	if decision := Decide(f.input(client)); !decision.InScope || decision.Reason != ReasonMapped {
		t.Fatalf("a case-sensitive volume must not fold a glob's case: %+v", decision)
	}
	f.cached.Policy.Installation.ExcludeGlobs = []string{"~/clients/**"}
	if decision := Decide(f.input(client)); decision.InScope || decision.Reason != ReasonExcluded {
		t.Fatalf("the exact-case glob still excludes: %+v", decision)
	}
}

func TestDecide_MapsACwdSpelledInAnotherCaseToItsMappedRoot(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	repo := f.repo(t, "Shop", "git@github.com:acme/shop.git")
	src := filepath.Join(repo, "Src")
	mkdir(t, src)
	for name, root := range map[string]string{"stored as on disk": repo, "stored in another case": respell(f.root, repo)} {
		f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: root, Enabled: true, ContentLevel: "standard"}}
		decision := Decide(f.input(respell(f.root, src)))
		if !decision.InScope || decision.MappingID != "m1" || decision.Cwd != src {
			t.Fatalf("%s: %+v", name, decision)
		}
		if !slices.Contains(decision.Place.Roots, repo) || !slices.Contains(decision.Place.Roots, respell(f.root, repo)) {
			t.Errorf("%s: the agent's spelling of the root must be relativized too: %v", name, decision.Place.Roots)
		}
	}
}

func TestDecide_KeepsDistinctCaseFoldersDistinctOnACaseSensitiveVolume(t *testing.T) {
	f := newFixture(t)
	requireCaseInsensitiveVolume(t, f.root)
	withVolumeCaseSensitivity(t, true)
	repo := f.repo(t, "shop", "")
	respelled := respell(f.root, repo)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: respelled, Enabled: true}}
	input := f.input(repo)
	input.IgnoredPaths = []string{respelled}
	if decision := Decide(input); decision.Reason == ReasonIgnored || decision.MappingID == "m1" {
		t.Fatalf("a case-sensitive volume matched a differently-cased entry: %+v", decision)
	}
}

func TestDecide_RefusesAMissingCwdInAnyCase(t *testing.T) {
	f := newFixture(t)
	for _, cwd := range []string{filepath.Join(f.home, "gone"), respell(f.root, filepath.Join(f.home, "gone"))} {
		if decision := Decide(f.input(cwd)); decision.InScope || decision.Reason != ReasonInvalidCwd {
			t.Errorf("%q: %+v", cwd, decision)
		}
	}
}

func BenchmarkCanonicalDir(b *testing.B) {
	root, err := filepath.EvalSymlinks(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	deep := filepath.Join(root, "Users", "Someone", "Code", "Project", "Src", "Pkg")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		b.Fatal(err)
	}
	respelled := respell(root, deep)
	b.ResetTimer()
	for b.Loop() {
		if _, ok := CanonicalDir(respelled); !ok {
			b.Fatal("not canonical")
		}
	}
}

// lockedParent makes a directory the user can pass through but not list,
// with one child spelled Child inside it.
func lockedParent(t *testing.T, root string) (parent, child string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root reads any directory")
	}
	parent = filepath.Join(root, "locked")
	child = filepath.Join(parent, "Child")
	mkdir(t, child)
	if err := os.Chmod(parent, 0o100); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o700) })
	return parent, child
}

func TestSpellingFromEntries_RespellsEachComponentFromItsParent(t *testing.T) {
	f := newFixture(t)
	project := filepath.Join(f.home, "Project")
	mkdir(t, project)
	if got, ok := spellingFromEntries(filepath.Join(f.home, "PROJECT")); !ok || got != project {
		t.Fatalf("spellingFromEntries = %q, %v; want %q", got, ok, project)
	}
}

func TestSpellingFromEntries_UnreadableParentFailsClosed(t *testing.T) {
	f := newFixture(t)
	_, child := lockedParent(t, f.root)
	if got, ok := spellingFromEntries(child); ok {
		t.Fatalf("spellingFromEntries under an unlistable parent = %q, want refusal", got)
	}
}

func TestCanonical_OtherPlatformsFailClosed(t *testing.T) {
	f := newFixture(t)
	qualified := canonicalizationQualified
	canonicalizationQualified = false
	t.Cleanup(func() { canonicalizationQualified = qualified })
	if got, ok := CanonicalDir(f.home); ok {
		t.Fatalf("CanonicalDir on an unqualified platform = %q, want refusal", got)
	}
}
