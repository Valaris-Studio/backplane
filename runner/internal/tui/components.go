// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// hintSeparator divides key/label pairs in a footer.
const hintSeparator = " · "

// Checklist state glyphs. Each is exactly one cell wide so rows stay aligned.
const (
	glyphPending = "·"
	glyphRunning = "⟳"
	glyphOK      = "✓"
	glyphFail    = "✗"
	glyphWarn    = "!"
)

// Banner renders the brand art sized to the terminal: the full wordmark at
// MinWordmarkCols or wider, the compact logo below that. A non-positive width
// means "unknown", which takes the narrow path.
func Banner(width int) string {
	if width <= 0 || width < MinWordmarkCols {
		return Logo()
	}
	return Wordmark()
}

// KeyHints renders a footer of key/label pairs, e.g.
//
//	KeyHints([2]string{"↑/↓", "navigate"}, [2]string{"q", "quit"})
//	↑/↓ navigate · q quit
//
// Each pair is {key, label}. Empty input renders nothing so callers can pass
// a conditionally-built slice without guarding.
func KeyHints(pairs ...[2]string) string {
	if len(pairs) == 0 {
		return ""
	}
	th := New()
	hints := make([]string, 0, len(pairs))
	for _, p := range pairs {
		key, label := p[0], p[1]
		switch {
		case key == "" && label == "":
			continue
		case label == "":
			hints = append(hints, th.KeyCap.Render(key))
		case key == "":
			hints = append(hints, th.KeyHint.Render(label))
		default:
			hints = append(hints, th.KeyCap.Render(key)+" "+th.KeyHint.Render(label))
		}
	}
	return strings.Join(hints, th.Subtle.Render(hintSeparator))
}

// StatusLine renders a single "icon label value" row, with the value
// emphasized against a muted label. An empty icon or value is simply omitted
// rather than leaving a hole in the alignment.
func StatusLine(icon, label, value string) string {
	th := New()
	parts := make([]string, 0, 3)
	if icon != "" {
		parts = append(parts, th.Accent.Render(icon))
	}
	if label != "" {
		parts = append(parts, th.Subtle.Render(label))
	}
	if value != "" {
		parts = append(parts, th.Subtitle.Render(value))
	}
	return strings.Join(parts, " ")
}

// A Panel's chrome, split by who accounts for it. lipgloss's Width() sets the
// content+padding box and draws the border OUTSIDE it, so the two must be
// subtracted at different stages: the border to get the box, the padding to get
// the text column inside it. Folding both into one constant is what made bodies
// wrap twice.
const (
	panelBorderCols  = 2
	panelPaddingCols = 2
	panelChromeCols  = panelBorderCols + panelPaddingCols
)

// panelMinInner is the narrowest inner width that can still show content.
const panelMinInner = 4

// maxPanelCols caps how wide a panel grows on a roomy terminal. Prose past
// roughly this measure is harder to scan, and a panel stretched to the far edge
// of a 200-column window reads as unrelated to the narrow content beneath it.
const maxPanelCols = 84

// PanelWidth is the outer width a panel should render at inside a terminal of
// the given width: the terminal, capped at a readable measure. Steps size their
// panels with this and pass the same value to Panel and PanelBodyWidth, so the
// body is wrapped to the width the border actually gets.
func PanelWidth(width int) int {
	if width <= 0 || width > maxPanelCols {
		return maxPanelCols
	}
	return width
}

// PanelBodyWidth is the width a body must be pre-wrapped to so Panel does not
// wrap it a second time: the text column left after the border and the padding.
// Wrap plain prose to exactly this, then style it, then hand it to Panel at the
// SAME outer width.
func PanelBodyWidth(width int) int {
	if body := panelInnerWidth(width) - panelPaddingCols; body > 0 {
		return body
	}
	return 1
}

// panelInnerWidth is what Panel hands to lipgloss's Width(): the content box
// plus its horizontal padding, with the border drawn outside that.
func panelInnerWidth(width int) int {
	if inner := width - panelBorderCols; inner >= panelMinInner {
		return inner
	}
	return panelMinInner
}

// shrinkToFit narrows a panel to the width its content actually needs, never
// past max. A short body — a handful of "label value" rows — inside a panel
// stretched to the terminal edge reads as a box someone forgot to fill.
func shrinkToFit(body, title string, max int) int {
	needed := lipgloss.Width(title)
	for _, line := range strings.Split(body, "\n") {
		if w := lipgloss.Width(line); w > needed {
			needed = w
		}
	}
	// The body is measured at its natural width; the panel must also fit its
	// border and padding around it.
	if needed += panelChromeCols; needed < max {
		return needed
	}
	return max
}

// Panel renders body inside a rounded border with title on the top edge,
// wrapping the body to fit. Width is the total outer width including the
// border; it is clamped up to a floor that can still show content.
func Panel(title, body string, width int) string {
	th := New()
	inner := panelInnerWidth(width)

	// Only th.Panel's own Width pass may size the body. Padding it to `inner`
	// first would make every line exactly the limit the second pass wraps at,
	// and lipgloss breaks a line AT the limit — stranding its last word alone
	// on the next row.
	content := body
	if title != "" {
		heading := th.PanelTitle.Render(truncateCells(title, inner))
		content = heading + "\n" + content
	}
	return th.Panel.Width(inner).Render(content)
}

// CheckState is the lifecycle of one checklist row.
type CheckState int

const (
	StatePending CheckState = iota
	StateRunning
	StateOK
	StateFail
	// StateWarn is degraded-but-usable: worth surfacing, not worth failing on.
	StateWarn
)

// ChecklistItem is one row: a label, its state, and optional trailing detail
// (an error summary, a count, a duration).
type ChecklistItem struct {
	Label  string
	State  CheckState
	Detail string
}

// Checklist renders one row per item, each led by its state glyph. Rows are
// newline-joined with no trailing newline, so callers compose it freely.
func Checklist(items []ChecklistItem) string {
	return ChecklistWrapped(items, 0)
}

// checklistDetailIndent hangs a wrapped detail under its label rather than at
// the left margin, where it would read as a new check.
const checklistDetailIndent = "  "

// ChecklistWrapped is Checklist with each row broken to fit width display
// cells. Wrapping happens on the PLAIN label and detail, before any style is
// applied — measuring or splitting a styled string would count escape bytes as
// columns and can cut a sequence in half. A non-positive width does not wrap.
func ChecklistWrapped(items []ChecklistItem, width int) string {
	if len(items) == 0 {
		return ""
	}
	th := New()
	rows := make([]string, 0, len(items))
	for _, it := range items {
		glyph, labelStyle := checkStyles(th, it.State)
		// The glyph and its trailing space are chrome the wrapper must budget
		// for, since they precede the label on the first line.
		const glyphCols = 2
		row := glyph + " " + renderWrapped(labelStyle, it.Label, width-glyphCols, checklistDetailIndent)
		if it.Detail != "" {
			row += "\n" + renderWrapped(th.Subtle, checklistDetailIndent+it.Detail, width, checklistDetailIndent)
		}
		rows = append(rows, row)
	}
	return strings.Join(rows, "\n")
}

// Prose wraps plain text to fit inside a panel of the given OUTER width and
// styles it, in that order. Handing raw prose to Panel instead lets lipgloss
// fold it at the inner width and then fold the padded result again, which
// strands a single word on its own line.
func Prose(style lipgloss.Style, text string, panelWidth int) string {
	return renderWrapped(style, text, PanelBodyWidth(panelWidth), "")
}

// renderWrapped wraps plain text, then styles each resulting line on its own so
// every line opens and closes its own escape sequence — a single Render over
// embedded newlines would leave continuation lines outside the styled span.
func renderWrapped(style lipgloss.Style, text string, width int, indent string) string {
	lines := strings.Split(fitOverlongTokens(WrapHanging(text, width, indent), width), "\n")
	for i, line := range lines {
		lines[i] = style.Render(line)
	}
	return strings.Join(lines, "\n")
}

// WrapHanging word-wraps each line of plain text to width display cells,
// indenting continuations so a long line stays visually attached to the one it
// continues. Words wider than the available width are left overlong rather
// than broken mid-token — a path or URL is more useful intact than aligned.
// Callers that render into a fixed column (renderWrapped) shorten what is left
// overlong; callers that own their own line, like doctor's fix hints, keep it.
//
// PLAIN TEXT ONLY: styled input would have its escape bytes counted as columns
// and could be split mid-sequence. Wrap first, style after.
func WrapHanging(text string, width int, indent string) string {
	if width <= lipgloss.Width(indent)+1 {
		return text
	}

	var out []string
	for _, line := range strings.Split(text, "\n") {
		// A leading indent on the input is the caller hanging the whole block;
		// preserve it instead of letting Fields eat it.
		lead := line[:len(line)-len(strings.TrimLeft(line, " "))]
		fields := strings.Fields(line)
		if len(fields) == 0 {
			out = append(out, "")
			continue
		}
		current := lead + fields[0]
		for _, word := range fields[1:] {
			if lipgloss.Width(current)+1+lipgloss.Width(word) > width {
				out = append(out, current)
				current = indent + word
				continue
			}
			current += " " + word
		}
		out = append(out, current)
	}
	return strings.Join(out, "\n")
}

// fitOverlongTokens shortens any line WrapHanging had to leave overlong,
// because leaving it is not free: lipgloss re-wraps an over-width line inside
// Panel, and it treats a hyphen as a break opportunity. A path then splits into
// ".../configs/mcp-" and "config.example.json" — two half-names, the second
// stranded at the left margin without the hanging indent, and the styled span
// severed mid-escape. Shortening here means nothing downstream is ever tempted
// to break the token at all.
func fitOverlongTokens(text string, width int) string {
	if width <= 0 {
		return text
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if lipgloss.Width(line) <= width {
			continue
		}
		lead := line[:len(line)-len(strings.TrimLeft(line, " "))]
		lines[i] = lead + ellipsizeMiddle(strings.TrimLeft(line, " "), width-lipgloss.Width(lead))
	}
	return strings.Join(lines, "\n")
}

// ellipsizeMiddle drops cells from the MIDDLE, keeping the head and the tail.
// For the paths this exists to serve, both ends are the identifying parts — the
// root says which tree, the basename says which file — and it is the
// interchangeable directories between them that can go. Trimming the tail
// instead would leave "…/configs/mcp-conf", which names nothing.
func ellipsizeMiddle(s string, width int) string {
	if width <= 0 || lipgloss.Width(s) <= width {
		return s
	}
	if width <= 1 {
		return "…"
	}
	runes := []rune(s)
	// The head keeps the smaller half so the basename — the part that answers
	// "which file?" — is the one that survives a tight budget intact.
	head := (width - 1) / 2
	tail := width - 1 - head
	for head+tail > 0 {
		candidate := string(runes[:head]) + "…" + string(runes[len(runes)-tail:])
		if lipgloss.Width(candidate) <= width {
			return candidate
		}
		if tail > head {
			tail--
		} else {
			head--
		}
	}
	return "…"
}

func checkStyles(th Theme, s CheckState) (glyph string, label lipgloss.Style) {
	switch s {
	case StateRunning:
		return th.Accent.Render(glyphRunning), th.Subtitle
	case StateOK:
		return th.Success.Render(glyphOK), th.Subtitle
	case StateFail:
		return th.Error.Render(glyphFail), th.Error
	case StateWarn:
		return th.Warn.Render(glyphWarn), th.Warn
	default:
		return th.Subtle.Render(glyphPending), th.Subtle
	}
}

// truncateCells shortens s to at most width display cells, appending an
// ellipsis when it cuts. Measured in cells, not bytes, so wide runes and
// multi-byte glyphs are handled correctly.
func truncateCells(s string, width int) string {
	if width <= 0 || lipgloss.Width(s) <= width {
		return s
	}
	if width == 1 {
		return "…"
	}
	runes := []rune(s)
	for len(runes) > 0 {
		candidate := string(runes) + "…"
		if lipgloss.Width(candidate) <= width {
			return candidate
		}
		runes = runes[:len(runes)-1]
	}
	return "…"
}
