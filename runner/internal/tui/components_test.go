// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestBanner_PicksArtByWidth(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	tests := []struct {
		name     string
		width    int
		wantLogo bool
	}{
		{"far below threshold", 40, true},
		{"one column short", MinWordmarkCols - 1, true},
		{"exactly at threshold", MinWordmarkCols, false},
		{"wide terminal", 120, false},
		{"unknown width falls back to logo", 0, true},
		{"negative width falls back to logo", -1, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Banner(tc.width)
			isLogo := !strings.Contains(got, "██████")
			if isLogo != tc.wantLogo {
				t.Errorf("Banner(%d) wantLogo=%v, got:\n%s", tc.width, tc.wantLogo, got)
			}
			if tc.width > 0 && maxLineWidth(got) > tc.width {
				t.Errorf("Banner(%d) rendered %d cols — overflows the terminal",
					tc.width, maxLineWidth(got))
			}
		})
	}
}

func TestKeyHints_ContainsEveryPair(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	pairs := [][2]string{{"↑/↓", "navigate"}, {"↵", "select"}, {"q", "quit"}}
	got := KeyHints(pairs...)

	for _, p := range pairs {
		if !strings.Contains(got, p[0]) {
			t.Errorf("missing key %q in %q", p[0], got)
		}
		if !strings.Contains(got, p[1]) {
			t.Errorf("missing label %q in %q", p[1], got)
		}
	}
	if want := len(pairs) - 1; strings.Count(got, hintSeparator) != want {
		t.Errorf("want %d separators, got %d in %q", want, strings.Count(got, hintSeparator), got)
	}
	if strings.Contains(got, "\n") {
		t.Errorf("key hints must stay on one line: %q", got)
	}
}

func TestKeyHints_EmptyInputRendersNothing(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	if got := KeyHints(); got != "" {
		t.Errorf("KeyHints() with no pairs should be empty, got %q", got)
	}
}

func TestStatusLine_RendersAllThreeParts(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	tests := []struct {
		name             string
		icon, label, val string
		wantAll          []string
		wantSingleLine   bool
	}{
		{"full", "●", "runner", "online", []string{"●", "runner", "online"}, true},
		{"no icon", "", "cards", "12", []string{"cards", "12"}, true},
		{"empty value", "○", "board", "", []string{"○", "board"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := StatusLine(tc.icon, tc.label, tc.val)
			for _, want := range tc.wantAll {
				if !strings.Contains(got, want) {
					t.Errorf("StatusLine missing %q, got %q", want, got)
				}
			}
			if tc.wantSingleLine && strings.Contains(got, "\n") {
				t.Errorf("StatusLine must stay on one line: %q", got)
			}
			if strings.HasPrefix(got, " ") {
				t.Errorf("StatusLine should not start with padding when icon is %q: %q", tc.icon, got)
			}
		})
	}
}

func TestPanel_IncludesTitleAndBody(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	got := Panel("Runners", "two active", 40)
	for _, want := range []string{"Runners", "two active"} {
		if !strings.Contains(got, want) {
			t.Errorf("Panel missing %q, got:\n%s", want, got)
		}
	}
	if w := maxLineWidth(got); w > 40 {
		t.Errorf("Panel(width=40) rendered %d cols", w)
	}
}

func TestPanel_WrapsLongBodyWithinWidth(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	body := strings.Repeat("backplane ", 20)
	got := Panel("Log", body, 36)

	if w := maxLineWidth(got); w > 36 {
		t.Errorf("Panel did not wrap: rendered %d cols, want <= 36", w)
	}
	if lipgloss.Height(got) < 4 {
		t.Errorf("wrapped body should occupy multiple rows, got:\n%s", got)
	}
}

func TestPanel_NarrowWidthDoesNotPanic(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	for _, w := range []int{-5, 0, 1, 4} {
		if got := Panel("T", "body", w); got == "" {
			t.Errorf("Panel(width=%d) returned empty output", w)
		}
	}
}

func TestChecklist_GlyphPerState(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	tests := []struct {
		name  string
		state CheckState
		glyph string
	}{
		{"pending", StatePending, glyphPending},
		{"running", StateRunning, glyphRunning},
		{"ok", StateOK, glyphOK},
		{"fail", StateFail, glyphFail},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Checklist([]ChecklistItem{{Label: "clone repo", State: tc.state}})
			if !strings.Contains(got, tc.glyph) {
				t.Errorf("state %v should render %q, got %q", tc.state, tc.glyph, got)
			}
			if !strings.Contains(got, "clone repo") {
				t.Errorf("checklist dropped its label: %q", got)
			}
			for _, other := range []string{glyphPending, glyphRunning, glyphOK, glyphFail} {
				if other != tc.glyph && strings.Contains(got, other) {
					t.Errorf("state %v also rendered foreign glyph %q: %q", tc.state, other, got)
				}
			}
		})
	}
}

// StateWarn is the degraded-but-usable rung between OK and Fail: doctor needs
// to say "gh is not authenticated" without flunking a machine that runs gitea.
func TestChecklist_WarnHasItsOwnGlyphAndColor(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	got := Checklist([]ChecklistItem{{Label: "forge cli", State: StateWarn, Detail: "not authenticated"}})

	if !strings.Contains(got, glyphWarn) {
		t.Errorf("StateWarn should render %q, got %q", glyphWarn, got)
	}
	for _, other := range []string{glyphPending, glyphRunning, glyphOK, glyphFail} {
		if strings.Contains(got, other) {
			t.Errorf("StateWarn also rendered foreign glyph %q: %q", other, got)
		}
	}
	if !strings.Contains(got, "not authenticated") {
		t.Errorf("warn row dropped its detail: %q", got)
	}
}

func TestChecklist_WarnIsDistinctFromEveryOtherState(t *testing.T) {
	states := []CheckState{StatePending, StateRunning, StateOK, StateFail, StateWarn}
	seen := make(map[string]CheckState, len(states))
	th := New()

	for _, s := range states {
		glyph, _ := checkStyles(th, s)
		if prior, dup := seen[glyph]; dup {
			t.Errorf("states %v and %v share the glyph %q", prior, s, glyph)
		}
		seen[glyph] = s
	}
}

func TestChecklist_OneRowPerItem(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	items := []ChecklistItem{
		{Label: "resolve config", State: StateOK},
		{Label: "clone repo", State: StateRunning},
		{Label: "run tests", State: StatePending},
	}
	got := Checklist(items)
	if n := lipgloss.Height(got); n != len(items) {
		t.Errorf("want %d rows, got %d:\n%s", len(items), n, got)
	}
	for _, it := range items {
		if !strings.Contains(got, it.Label) {
			t.Errorf("missing label %q", it.Label)
		}
	}
}

func TestChecklist_EmptyRendersNothing(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	if got := Checklist(nil); got != "" {
		t.Errorf("empty checklist should render nothing, got %q", got)
	}
}

func TestChecklist_DetailAnnotatesRow(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	got := Checklist([]ChecklistItem{
		{Label: "run tests", State: StateFail, Detail: "3 failing"},
	})
	if !strings.Contains(got, "3 failing") {
		t.Errorf("checklist should render the item detail, got %q", got)
	}
}

func TestComponents_PlainWhenColorDisabled(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	outputs := map[string]string{
		"banner":     Banner(100),
		"keyhints":   KeyHints([2]string{"q", "quit"}),
		"statusline": StatusLine("●", "runner", "online"),
		"panel":      Panel("Title", "body", 30),
		"checklist":  Checklist([]ChecklistItem{{Label: "step", State: StateOK}}),
	}
	for name, out := range outputs {
		if strings.ContainsRune(out, escape) {
			t.Errorf("%s leaked an ANSI escape under ForcePlain: %q", name, out)
		}
	}
}

// ------------------------------------------------------- wrapped checklist --

// ansiSequence matches a complete SGR sequence. Anything ESC-introduced that
// this does not match is a sequence something cut in half.
var ansiSequence = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// The defect: doctor wrapped the STYLED checklist, so a break could land in
// the middle of an escape sequence and emit a truncated reset.
func TestChecklistWrapped_NeverSplitsAnEscapeSequence(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	got := ChecklistWrapped([]ChecklistItem{{
		Label:  "mcp config",
		State:  StateFail,
		Detail: "no MCP server config found — the runner reaches the platform through MCP tools",
	}}, 48)

	assertEveryEscapeIsWellFormed(t, got)
}

func TestChecklistWrapped_StyledAndPlainBreakAtTheSameWords(t *testing.T) {
	const detail = "no MCP server config found — the runner reaches the platform through MCP tools"
	items := []ChecklistItem{{Label: "mcp config", State: StateFail, Detail: detail}}

	styledRestore := forceProfileTrueColor()
	styled := ChecklistWrapped(items, 48)
	styledRestore()

	plainRestore := ForcePlain()
	plain := ChecklistWrapped(items, 48)
	plainRestore()

	if got := stripANSI(styled); got != plain {
		t.Errorf("styled wrap broke at different words than plain:\nstyled: %q\nplain:  %q", got, plain)
	}
}

func TestChecklistWrapped_HangsContinuationsUnderTheLabel(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	got := ChecklistWrapped([]ChecklistItem{{
		Label:  "work dir",
		State:  StateOK,
		Detail: "/home/operator/backplane-runner/repos and then some trailing prose to force a wrap",
	}}, 48)

	lines := strings.Split(stripANSI(got), "\n")
	if len(lines) < 3 {
		t.Fatalf("expected the detail to wrap onto its own continuation, got %q", lines)
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, checklistDetailIndent) {
			t.Errorf("continuation %q should keep the hanging indent:\n%s", l, strings.Join(lines, "\n"))
		}
	}
}

// Every line inside a Panel must occupy the same number of display cells, or
// the right border stops forming a straight column.
func TestPanel_WrappedChecklistKeepsTheRightBorderStraight(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	const width = 76
	body := ChecklistWrapped([]ChecklistItem{
		{Label: "coding agents", State: StateOK, Detail: "on PATH: claude, codex"},
		{Label: "mcp config", State: StateFail, Detail: "no MCP server config found — the runner reaches the platform through MCP tools"},
		{Label: "work dir", State: StateOK, Detail: "/home/operator/backplane-runner/repos (outside any git worktree)"},
	}, width-4)

	out := Panel("doctor — this machine", body, width)
	assertEveryEscapeIsWellFormed(t, out)

	lines := strings.Split(out, "\n")
	want := lipgloss.Width(lines[0])
	for i, l := range lines {
		if got := lipgloss.Width(l); got != want {
			t.Errorf("line %d is %d cells wide, want %d — the right border drifts:\n%s", i, got, want, stripANSI(out))
		}
	}
}

// A body pre-wrapped to PanelBodyWidth must survive Panel untouched. Wrapping
// to the raw inner width instead re-folds the longest line and strands its
// tail at the left margin, without the hanging indent.
func TestPanelBodyWidth_PreWrappedBodyIsNotWrappedTwice(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	const width = 76
	body := WrapHanging(
		"→ credentials: export VALARIS_API_KEY and VALARIS_WORKSPACE, or set them in a runner.yaml the runner can find",
		PanelBodyWidth(width), "  ")

	// Panel adds the two border rows around whatever body it was handed.
	const borderRows = 2
	got := lipgloss.Height(Panel("", body, width)) - borderRows
	want := lipgloss.Height(body)
	if got != want {
		t.Errorf("Panel re-wrapped a pre-wrapped body: %d body lines became %d", want, got)
	}
}

// ------------------------------------------------------------------ Prose --

// The defect: Panel padded the body to the inner width and then word-wrapped
// that padded block at the same limit, so a line landing exactly on the limit
// folded and stranded its last word alone on the next row.
func TestProse_PanelDoesNotReflowAPreWrappedBody(t *testing.T) {
	defer ForcePlain()()

	const prose = "The runner clones every repo it works on here and hard-resets those clones " +
		"between cards — anything you leave in them is lost. Expect one full checkout per repo " +
		"of disk. Pick a fresh directory that is NOT inside an existing git worktree."

	// Panel adds a title row and the two border rows around the body.
	const chromeRows = 3
	for _, width := range []int{40, 56, 60, 72, 84, 100} {
		body := Prose(New().Subtitle, prose, width)
		got := lipgloss.Height(Panel("t", body, width)) - chromeRows
		if want := lipgloss.Height(body); got != want {
			t.Errorf("width %d: Panel reflowed a pre-wrapped body — %d lines became %d:\n%s",
				width, want, got, Panel("t", body, width))
		}
	}
}

// An orphan is a line holding one word that would have fit on the line above.
// It is the visible symptom of a double wrap, and it survives assertions that
// only check "no line exceeds the width". Asserted on the RENDERED panel: the
// orphan is created by Panel refolding, so checking the body alone misses it.
func TestProse_PanelLeavesNoOrphanedWord(t *testing.T) {
	defer ForcePlain()()

	for _, width := range []int{40, 56, 60, 72, 84, 100} {
		rendered := Panel("t", Prose(New().Subtitle, workDirConsequences, width), width)
		lines := panelBodyLines(stripANSI(rendered))
		for i := 1; i < len(lines); i++ {
			if len(strings.Fields(lines[i])) != 1 {
				continue
			}
			joined := lipgloss.Width(lines[i-1]) + 1 + lipgloss.Width(lines[i])
			if joined <= PanelBodyWidth(width) {
				t.Errorf("width %d: %q is orphaned — it fits on the previous line (%d <= %d):\n%s",
					width, lines[i], joined, PanelBodyWidth(width), rendered)
			}
		}
	}
}

// panelBodyLines strips the border rows and the side chrome, leaving the text
// column with its padding trimmed so widths measure the words alone.
func panelBodyLines(plainPanel string) []string {
	var out []string
	for _, line := range strings.Split(plainPanel, "\n") {
		if !strings.HasPrefix(line, "│") {
			continue
		}
		out = append(out, strings.TrimSpace(strings.Trim(line, "│")))
	}
	// Drop the title row.
	if len(out) > 0 {
		out = out[1:]
	}
	return out
}

func TestProse_NoLineExceedsThePanelBodyWidth(t *testing.T) {
	defer ForcePlain()()

	for _, width := range []int{40, 56, 60, 72, 84, 100} {
		for _, line := range strings.Split(Prose(New().Subtitle, workDirConsequences, width), "\n") {
			// A single word wider than the column is left intact by design.
			if lipgloss.Width(line) > PanelBodyWidth(width) && len(strings.Fields(line)) > 1 {
				t.Errorf("width %d: %q is %d cells, over the %d-cell body column",
					width, line, lipgloss.Width(line), PanelBodyWidth(width))
			}
		}
	}
}

// Panel's geometry is only trustworthy if the width it is asked for is the
// width it occupies — steps size neighbouring content against that number.
func TestPanel_RendersAtTheRequestedOuterWidth(t *testing.T) {
	defer ForcePlain()()

	for _, width := range []int{20, 40, 60, 84, 120} {
		got := lipgloss.Width(Panel("title", Prose(New().Subtitle, workDirConsequences, width), width))
		if got != width {
			t.Errorf("Panel(width=%d) rendered %d cells wide", width, got)
		}
	}
}

func TestPanelWidth_CapsAtAReadableMeasureButNeverExceedsTheTerminal(t *testing.T) {
	tests := []struct {
		width, want int
	}{
		{40, 40},
		{maxPanelCols, maxPanelCols},
		{200, maxPanelCols},
		{0, maxPanelCols},
	}
	for _, tc := range tests {
		if got := PanelWidth(tc.width); got != tc.want {
			t.Errorf("PanelWidth(%d) = %d, want %d", tc.width, got, tc.want)
		}
	}
}

// ------------------------------------------------------------ WrapHanging --

func TestWrapHanging_IndentsContinuationLines(t *testing.T) {
	got := WrapHanging("✓ work dir a fairly long detail that must wrap somewhere", 24, "  ")

	lines := strings.Split(got, "\n")
	if len(lines) < 2 {
		t.Fatalf("expected the line to wrap, got %q", got)
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, "  ") {
			t.Errorf("continuation %q should be indented:\n%s", l, got)
		}
	}
	for _, l := range lines {
		if lipgloss.Width(l) > 24 && len(strings.Fields(l)) > 1 {
			t.Errorf("line exceeds the wrap width: %q", l)
		}
	}
}

// A path or URL is more useful intact than broken to fit.
func TestWrapHanging_DoesNotBreakLongTokens(t *testing.T) {
	const path = "/very/long/path/that/exceeds/the/wrap/width/mcp-config.json"

	got := WrapHanging("✓ mcp config "+path, 20, "  ")

	if !strings.Contains(got, path) {
		t.Errorf("wrap split a long token:\n%s", got)
	}
}

// The defect: WrapHanging left an overlong path intact, so lipgloss re-wrapped
// it inside Panel and broke it at a hyphen — "…/configs/mcp-" then
// "config.example.json" back at the left margin, reading as two files and one
// stray check. A token that cannot fit must arrive pre-shortened to the column
// so nothing downstream is tempted to split it.
func TestChecklistWrapped_NeverBreaksAPathAtAHyphen(t *testing.T) {
	const path = "/home/operator/projects/example/runner-checkout/runner/configs/mcp-config.example.json"
	const width = 76

	body := ChecklistWrapped([]ChecklistItem{
		{Label: "mcp config", State: StateOK, Detail: path},
	}, PanelBodyWidth(width))

	for _, line := range strings.Split(stripANSI(Panel("doctor", body, width)), "\n") {
		if strings.HasSuffix(strings.TrimRight(line, " │"), "-") {
			t.Errorf("a line ends mid-token at a hyphen:\n%s", stripANSI(Panel("doctor", body, width)))
		}
	}
}

// Whatever shortening the path receives, it must still name one unambiguous
// file: the leading directories and the full basename both survive.
func TestChecklistWrapped_ShortenedPathStaysUnambiguous(t *testing.T) {
	const path = "/home/operator/projects/example/runner-checkout/runner/configs/mcp-config.example.json"

	got := stripANSI(ChecklistWrapped([]ChecklistItem{
		{Label: "mcp config", State: StateOK, Detail: path},
	}, PanelBodyWidth(76)))

	if !strings.Contains(got, "mcp-config.example.json") {
		t.Errorf("the basename must survive shortening — otherwise the row names no file:\n%s", got)
	}
	if !strings.Contains(got, "/home/operator") {
		t.Errorf("the leading path must survive shortening:\n%s", got)
	}
}

// Every continuation of a wrapped row keeps the hanging indent, so a long
// detail never reads as a new check at the left margin.
func TestChecklistWrapped_ContinuationsKeepTheHangingIndent(t *testing.T) {
	got := stripANSI(ChecklistWrapped([]ChecklistItem{{
		Label:  "mcp config",
		State:  StateOK,
		Detail: "/home/operator/projects/example/runner-checkout/runner/configs/mcp-config.example.json is the template shipped in every checkout",
	}}, PanelBodyWidth(76)))

	lines := strings.Split(got, "\n")
	if len(lines) < 3 {
		t.Fatalf("expected the detail to wrap across lines, got:\n%s", got)
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, checklistDetailIndent) {
			t.Errorf("continuation %q lost the hanging indent:\n%s", l, got)
		}
	}
}

// The right border must stay a straight column even when the body carries a
// path too long for it. Run with color ON: styled lines are where a stray
// re-wrap shows up.
func TestPanel_LongPathKeepsTheRightBorderStraight(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	const width = 76
	body := ChecklistWrapped([]ChecklistItem{
		{Label: "mcp config", State: StateOK, Detail: "/home/operator/projects/example/runner-checkout/runner/configs/mcp-config.example.json"},
		{Label: "work dir", State: StateOK, Detail: "/home/operator/backplane-runner/repos (outside any git worktree)"},
	}, PanelBodyWidth(width))

	out := Panel("doctor — this machine", body, width)
	assertEveryEscapeIsWellFormed(t, out)

	lines := strings.Split(out, "\n")
	want := lipgloss.Width(lines[0])
	for i, l := range lines {
		if got := lipgloss.Width(l); got != want {
			t.Errorf("line %d is %d cells wide, want %d — the right border drifts:\n%s", i, got, want, stripANSI(out))
		}
	}
	// Two borders, a title, and one label+detail line per check. A path that
	// still spilled onto a continuation would add a line here.
	if len(lines) != 7 {
		t.Errorf("a shortened path must occupy one line per row, got %d lines:\n%s", len(lines), stripANSI(out))
	}
}

func TestWrapHanging_PreservesShortLinesVerbatim(t *testing.T) {
	const s = "✓ git git version 2.44.0"

	if got := WrapHanging(s, 60, "  "); got != s {
		t.Errorf("a line that fits must be untouched: %q", got)
	}
}

// Width is display cells, not bytes: an em dash and accented runes must not
// eat the budget of the multiple bytes they encode to.
func TestWrapHanging_MeasuresDisplayCellsNotBytes(t *testing.T) {
	const line = "reaches — the — platform"

	if got := WrapHanging(line, 24, "  "); got != line {
		t.Errorf("multi-byte runes were counted as multiple columns: %q", got)
	}
}

// assertEveryEscapeIsWellFormed proves no line was cut mid-sequence. Two
// signatures catch that: an ESC that no complete SGR sequence accounts for,
// and — the shape the real defect produced — a line that opens a styled span
// and never closes it with a full ESC[0m reset. A split that eats the "0"
// leaves a bare ESC[m, which is syntactically valid SGR but arrives on a line
// whose opener was severed, so balance is what actually distinguishes it.
func assertEveryEscapeIsWellFormed(t *testing.T, s string) {
	t.Helper()
	if !strings.ContainsRune(s, escape) {
		t.Fatal("expected styled output — the defect only manifests with color on")
	}
	if got := stripANSI(s); strings.ContainsRune(got, escape) {
		t.Errorf("output carries an ESC no complete SGR sequence accounts for:\n%q", s)
	}
	for i, line := range strings.Split(s, "\n") {
		opens, closes := 0, 0
		for _, seq := range ansiSequence.FindAllString(line, -1) {
			if isSGRReset(seq) {
				closes++
			} else {
				opens++
			}
		}
		if opens != closes {
			t.Errorf("line %d opens %d styled spans and closes %d — a wrap split a sequence:\n%q",
				i, opens, closes, line)
		}
	}
}

// isSGRReset reports the full reset lipgloss closes a span with. A bare ESC[m
// is deliberately NOT counted: it is the fragment a mid-sequence split leaves
// behind, and treating it as a reset would hide the very defect under test.
func isSGRReset(seq string) bool { return seq == "\x1b[0m" }

// stripANSI removes every well-formed SGR sequence, leaving the display text —
// and leaving any malformed remnant behind for assertions to catch.
func stripANSI(s string) string {
	return ansiSequence.ReplaceAllString(s, "")
}
