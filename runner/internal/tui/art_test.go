// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// maxLineWidth measures the widest rendered line, ignoring ANSI escapes.
func maxLineWidth(s string) int {
	widest := 0
	for _, line := range strings.Split(s, "\n") {
		if w := lipgloss.Width(line); w > widest {
			widest = w
		}
	}
	return widest
}

func TestArt_ColumnBudgets(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	tests := []struct {
		name   string
		render func() string
		budget int
	}{
		{"wordmark", Wordmark, WordmarkWidth},
		{"logo", Logo, LogoWidth},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := maxLineWidth(tc.render())
			if got > tc.budget {
				t.Errorf("%s is %d cols wide, exceeds its %d-col budget",
					tc.name, got, tc.budget)
			}
		})
	}
}

func TestWordmarkWidth_FitsNarrowestFullTerminal(t *testing.T) {
	if WordmarkWidth > MinWordmarkCols {
		t.Errorf("WordmarkWidth %d exceeds MinWordmarkCols %d — Banner would pick "+
			"Wordmark at a width it cannot fit", WordmarkWidth, MinWordmarkCols)
	}
	if LogoWidth >= WordmarkWidth {
		t.Errorf("LogoWidth %d must be narrower than WordmarkWidth %d",
			LogoWidth, WordmarkWidth)
	}
}

func TestWordmark_RowsAreUniformWidth(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	lines := strings.Split(strings.TrimRight(Wordmark(), "\n"), "\n")
	if len(lines) < 5 {
		t.Fatalf("wordmark should have at least 5 rows of lettering, got %d", len(lines))
	}
	// The glyph rows (all but the tagline) must be flush so the gradient reads
	// as a solid block rather than a ragged edge.
	for i, line := range lines[:5] {
		if w := lipgloss.Width(line); w != WordmarkWidth {
			t.Errorf("glyph row %d is %d cols, want a flush %d", i, w, WordmarkWidth)
		}
	}
}

func TestWordmark_IncludesTagline(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	if !strings.Contains(Wordmark(), Tagline) {
		t.Errorf("wordmark should carry the tagline %q", Tagline)
	}
}

func TestLogo_IdentifiesTheProduct(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	if !strings.Contains(strings.ToLower(Logo()), "backplane") {
		t.Errorf("narrow logo must still name the product, got:\n%s", Logo())
	}
}

func TestArt_PlainWhenColorDisabled(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	for name, out := range map[string]string{"wordmark": Wordmark(), "logo": Logo()} {
		if strings.ContainsRune(out, escape) {
			t.Errorf("%s leaked an ANSI escape under ForcePlain", name)
		}
	}
}

func TestArt_GradientColorsWhenEnabled(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	out := Wordmark()
	if !strings.ContainsRune(out, escape) {
		t.Error("wordmark should be gradient-colored when the profile supports color")
	}
	// A gradient means distinct colors per row, not one flat foreground.
	seen := map[string]struct{}{}
	for _, line := range strings.Split(out, "\n") {
		if idx := strings.IndexRune(line, 'm'); idx > 0 && strings.ContainsRune(line, escape) {
			seen[line[:idx]] = struct{}{}
		}
	}
	if len(seen) < 2 {
		t.Errorf("wordmark rows share a single color — no gradient (%d distinct prefixes)", len(seen))
	}
}
