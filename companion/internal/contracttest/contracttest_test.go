// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package contracttest

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDirResolvesTheCorpusBesideCompanion(t *testing.T) {
	dir := Dir(t)
	if filepath.Base(dir) != "rich-capture" || filepath.Base(filepath.Dir(dir)) != "contracts" {
		t.Fatalf("Dir() = %s", dir)
	}
}

func TestAMissingCorpusIsAnErrorNotAnEmptyPass(t *testing.T) {
	if _, err := dirFrom(filepath.Join(t.TempDir(), "a", "b", "c", "contracttest.go")); err == nil {
		t.Fatal("a copy without contracts/ must fail")
	}
}

func TestRecipesMaterializeAndMatchTheirDigests(t *testing.T) {
	claude := Recipes(t, "claude-code")
	if len(claude) != 3 {
		t.Fatalf("claude-code recipes = %d, want 3", len(claude))
	}
	for _, recipe := range claude {
		if !strings.Contains(recipe.NativePath, "/tool-results/") || len(recipe.Body) < 40000 {
			t.Fatalf("unexpected recipe %s (%d bytes)", recipe.NativePath, len(recipe.Body))
		}
	}
	if pi := Recipes(t, "pi"); len(pi) != 1 || len(pi[0].Body) != 126001 {
		t.Fatalf("pi recipes = %+v", pi)
	}
}

func TestRecipeGrammarRefusesAnythingElse(t *testing.T) {
	for _, recipe := range []string{`python3 -c "import os; os.system('x')"`, `sh -c "echo hi"`, `python3 -c "print('a'*3); print(1)"`} {
		if _, err := materialize(recipe); err == nil {
			t.Errorf("%q materialized", recipe)
		}
	}
	if body, err := materialize(`python3 -c "print('B'*3)"`); err != nil || string(body) != "BBB\n" {
		t.Fatalf("materialize = %q, %v", body, err)
	}
}

func TestWireCorpusIsComplete(t *testing.T) {
	if valid, invalid := WireExamples(t), InvalidWireExamples(t); len(valid) < 40 || len(invalid) < 40 {
		t.Fatalf("wire corpus: %d valid, %d invalid", len(valid), len(invalid))
	}
	if vectors := PlacementVectors(t); len(vectors) < 17 {
		t.Fatalf("placement vectors = %d", len(vectors))
	}
}
