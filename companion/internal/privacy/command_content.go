// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// WithholdCommandContent digests the file content a command carries and keeps
// the command around it: apply_patch envelopes, unified diffs, heredoc bodies
// that write a file or feed a patch tool or a file-writing script, and
// echo/printf/here-string text written to a file. Commands are sent at the
// standard level; the files they write are not. It is idempotent. The backend
// ingest runs the same detector; testdata/edit_content_vectors.json holds the
// cases both must pass.
func WithholdCommandContent(text string) string {
	if document, isJSON := jsonDocument(text); isJSON {
		if withheld, changed := withholdCommandContentIn(document); changed {
			return encodeJSON(withheld)
		}
		return text
	}
	text = WithholdPatchEnvelopes(text)
	text = withholdShellContent(text)
	text = withholdUnifiedDiffs(text)
	if !strings.Contains(text, "\n") {
		// A command can sit in a JavaScript string with its newlines escaped,
		// as Codex's exec tool sends it.
		text = escapedNewlineLiteral.ReplaceAllStringFunc(text, withholdInLiteral)
	}
	return text
}

var escapedNewlineLiteral = regexp.MustCompile(`"(?:[^"\\\n]|\\.)*\\n(?:[^"\\\n]|\\.)*"`)

func withholdInLiteral(literal string) string {
	var decoded string
	if json.Unmarshal([]byte(literal), &decoded) != nil {
		return literal
	}
	if withheld := WithholdCommandContent(decoded); withheld != decoded {
		return encodeJSON(withheld)
	}
	return literal
}

// jsonDocument decodes text that is a JSON object or array, such as Codex's
// tool arguments ({"cmd": …} or an argv list).
func jsonDocument(text string) (any, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var document any
	if decoder.Decode(&document) != nil || decoder.More() {
		return nil, false
	}
	return document, true
}

func withholdCommandContentIn(value any) (any, bool) {
	switch typed := value.(type) {
	case string:
		withheld := WithholdCommandContent(typed)
		return withheld, withheld != typed
	case map[string]any:
		out, changed := make(map[string]any, len(typed)), false
		for key, child := range typed {
			var childChanged bool
			out[key], childChanged = withholdCommandContentIn(child)
			changed = changed || childChanged
		}
		return out, changed
	case []any:
		out, changed := make([]any, len(typed)), false
		for index, child := range typed {
			var childChanged bool
			out[index], childChanged = withholdCommandContentIn(child)
			changed = changed || childChanged
		}
		return out, changed
	}
	return value, false
}

func encodeJSON(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

type span struct{ start, end int }

var (
	digestOnly   = regexp.MustCompile(`^\[omitted \d+ bytes sha256:[0-9a-f]{16}\]$`)
	digestPrefix = regexp.MustCompile(`^\[omitted \d+ bytes sha256:[0-9a-f]{16}\]`)
)

// withholdSpans digests each span of text, outermost first, leaving spans
// that already are a digest as they are.
func withholdSpans(text string, spans []span) string {
	if len(spans) == 0 {
		return text
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	var out strings.Builder
	at := 0
	for _, withheld := range spans {
		if withheld.start < at || withheld.end <= withheld.start {
			continue
		}
		content := text[withheld.start:withheld.end]
		out.WriteString(text[at:withheld.start])
		if digestOnly.MatchString(content) {
			out.WriteString(content)
		} else {
			out.WriteString(digestText(content))
		}
		at = withheld.end
	}
	out.WriteString(text[at:])
	return out.String()
}

func withholdShellContent(text string) string {
	var spans []span
	for _, pipeline := range parseShell(text) {
		for index, command := range pipeline {
			later := pipeline[index+1:]
			writes := command.writesFile() || anyCommand(later, (*shellCommand).receivesIntoFile)
			for _, heredoc := range command.heredocs {
				body := text[heredoc.body.start:heredoc.body.end]
				if writes || command.receivesIntoFile() || feedsFileWritingScript(command, later, body) {
					spans = append(spans, heredoc.body)
				}
			}
			for _, word := range command.hereStrings {
				if (writes || command.receivesIntoFile()) && !onlyVariables(word.value) {
					spans = append(spans, word.span)
				}
			}
			if name := command.name(); (name == "echo" || name == "printf") && writes {
				if arguments := command.arguments(); len(arguments) > 0 && !onlyVariables(joinValues(arguments)) {
					spans = append(spans, span{arguments[0].start, arguments[len(arguments)-1].end})
				}
			}
		}
	}
	return withholdSpans(text, spans)
}

func anyCommand(commands []*shellCommand, test func(*shellCommand) bool) bool {
	for _, command := range commands {
		if test(command) {
			return true
		}
	}
	return false
}

func feedsFileWritingScript(command *shellCommand, later []*shellCommand, body string) bool {
	for _, reader := range append([]*shellCommand{command}, later...) {
		if reader.readsScriptFromStdin() && scriptWritesFiles(reader.name(), body) {
			return true
		}
	}
	return false
}

var (
	interpreters = regexp.MustCompile(`^(?:python[0-9.]*|node|nodejs|ruby|perl|bash|sh|zsh|dash|ksh)$`)
	shells       = regexp.MustCompile(`^(?:bash|sh|zsh|dash|ksh)$`)
	// File writes in a Python, Node, Ruby or Perl script read from stdin.
	scriptFileWrite  = regexp.MustCompile(`open\([^()]*,\s*(?:mode\s*=\s*)?['"][wax]b?\+?['"]|\.write_(?:text|bytes)\(|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\(|\bfs\.write|\bFile\.write|\bFile\.open\([^()]*['"][wa]|\bopen\s*\(?\s*(?:my\s+)?\$\w+\s*,\s*['"]\+?>`)
	onlyVariableText = regexp.MustCompile(`^\s*(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s*)+$`)
	deviceFiles      = map[string]bool{"/dev/null": true, "/dev/stdout": true, "/dev/stderr": true, "/dev/tty": true, "/dev/fd/1": true, "/dev/fd/2": true}
)

func scriptWritesFiles(interpreter, script string) bool {
	if !shells.MatchString(interpreter) {
		return scriptFileWrite.MatchString(script)
	}
	return anyCommandOfAny(parseShell(script), (*shellCommand).receivesIntoFile)
}

func anyCommandOfAny(pipelines [][]*shellCommand, test func(*shellCommand) bool) bool {
	for _, pipeline := range pipelines {
		if anyCommand(pipeline, test) {
			return true
		}
	}
	return false
}

func onlyVariables(text string) bool { return onlyVariableText.MatchString(text) }

func joinValues(words []shellWord) string {
	values := make([]string, 0, len(words))
	for _, word := range words {
		if !strings.HasPrefix(word.value, "-") {
			values = append(values, word.value)
		}
	}
	return strings.Join(values, " ")
}

type shellWord struct {
	span
	// value is the word with its quoting removed.
	value string
}

type shellRedirect struct {
	operator, fd string
	target       shellWord
}

type shellHeredoc struct {
	body      span
	delimiter string
	// strip is what the operator lets precede the terminator: tabs (<<-) or
	// any blanks (<<~).
	strip string
}

type shellCommand struct {
	words       []shellWord
	redirects   []shellRedirect
	heredocs    []*shellHeredoc
	hereStrings []shellWord
}

// commandPrefixes run the command that follows them.
var commandPrefixes = map[string]bool{"sudo": true, "env": true, "command": true, "exec": true, "time": true, "nohup": true}

// wrappers run a command given among their arguments, after options and
// values of their own (a container, a niceness, a timeout). Only commands
// that can write a file are looked for there.
var (
	wrappers            = map[string]bool{"docker": true, "podman": true, "kubectl": true, "nice": true, "ionice": true, "timeout": true, "stdbuf": true, "xargs": true, "doas": true, "chroot": true, "flock": true}
	fileWritingCommands = map[string]bool{"tee": true, "dd": true, "sponge": true, "install": true, "cp": true, "patch": true, "apply_patch": true, "git": true, "echo": true, "printf": true, "cat": true}
)

var assignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

func (c *shellCommand) nameIndex() int {
	afterPrefix := false
	for index, word := range c.words {
		switch {
		case assignment.MatchString(word.value), commandPrefixes[word.value]:
			afterPrefix = true
		case afterPrefix && strings.HasPrefix(word.value, "-"):
		case wrappers[path.Base(word.value)]:
			// The wrapped command is the first argument named like one
			// that can take what it reads into a file.
			for nested := index + 1; nested < len(c.words); nested++ {
				if name := path.Base(c.words[nested].value); fileWritingCommands[name] || interpreters.MatchString(name) {
					return nested
				}
			}
			return index
		default:
			return index
		}
	}
	return -1
}

func (c *shellCommand) name() string {
	if index := c.nameIndex(); index >= 0 {
		return path.Base(c.words[index].value)
	}
	return ""
}

func (c *shellCommand) arguments() []shellWord {
	if index := c.nameIndex(); index >= 0 {
		return c.words[index+1:]
	}
	return nil
}

func (c *shellCommand) writesFile() bool {
	for _, redirect := range c.redirects {
		target := redirect.target.value
		if inner, isProcess := strings.CutPrefix(target, ">("); isProcess {
			if anyCommandOfAny(parseShell(strings.TrimSuffix(inner, ")")), (*shellCommand).receivesIntoFile) {
				return true
			}
			continue
		}
		toStdout := redirect.fd == "" || redirect.fd == "1" || redirect.fd == "&"
		switch redirect.operator {
		case ">", ">>", ">|", "&>", "&>>":
			if toStdout && target != "" && !strings.HasPrefix(target, "&") && !deviceFiles[target] {
				return true
			}
		}
	}
	return false
}

func (c *shellCommand) isTee() bool { return c.name() == "tee" }

func (c *shellCommand) isPatchTool() bool {
	switch c.name() {
	case "patch", "apply_patch":
		return true
	case "git":
		arguments := c.arguments()
		return len(arguments) > 0 && (arguments[0].value == "apply" || arguments[0].value == "am")
	}
	return false
}

// receivesIntoFile reports a command in a pipeline that puts what it reads
// into a file.
func (c *shellCommand) receivesIntoFile() bool {
	return c.writesFile() || c.isTee() || c.isPatchTool() || c.copiesStdinToFile()
}

// copiesStdinToFile reports dd of=<file>, sponge <file>, and install or cp
// from /dev/stdin.
func (c *shellCommand) copiesStdinToFile() bool {
	arguments := c.arguments()
	switch c.name() {
	case "dd":
		for _, argument := range arguments {
			if target, isOutput := strings.CutPrefix(argument.value, "of="); isOutput && !deviceFiles[target] {
				return true
			}
		}
	case "sponge":
		return slices.ContainsFunc(arguments, func(argument shellWord) bool { return !strings.HasPrefix(argument.value, "-") })
	case "install", "cp":
		return slices.ContainsFunc(arguments, func(argument shellWord) bool { return argument.value == "/dev/stdin" })
	}
	return false
}

func (c *shellCommand) readsScriptFromStdin() bool {
	if !interpreters.MatchString(c.name()) {
		return false
	}
	for _, argument := range c.arguments() {
		switch {
		case argument.value == "-c" || argument.value == "-e" || argument.value == "-E" || argument.value == "-m" || argument.value == "--eval":
			return false
		case !strings.HasPrefix(argument.value, "-"):
			return false
		}
	}
	return true
}

// shellParser reads the shell grammar file content travels in: words and
// quoting, pipelines and their separators, redirects, here-strings and
// heredoc bodies. It never fails; text it cannot place becomes words.
type shellParser struct {
	text      string
	at        int
	pipelines [][]*shellCommand
	pipeline  []*shellCommand
	command   *shellCommand
	pending   []*shellHeredoc
}

var redirectOperator = regexp.MustCompile(`^(?:(\d*)(<<<|<<-|<<~|<<|<>|<&|>&|>>|>\||<|>)|(&>>|&>))`)

func parseShell(text string) [][]*shellCommand {
	parser := &shellParser{text: text, command: &shellCommand{}}
	for parser.at < len(text) {
		rest := text[parser.at:]
		switch c := text[parser.at]; {
		case c == ' ' || c == '\t' || c == '\r':
			parser.at++
		case c == '\n':
			parser.at++
			parser.readHeredocBodies()
			parser.endPipeline()
		case c == '#':
			if end := strings.IndexByte(rest, '\n'); end >= 0 {
				parser.at += end
			} else {
				parser.at = len(text)
			}
		case strings.HasPrefix(rest, "&&") || strings.HasPrefix(rest, "||"):
			parser.at += 2
			parser.endPipeline()
		case c == '|':
			parser.at++
			if strings.HasPrefix(text[parser.at:], "&") {
				parser.at++
			}
			parser.endCommand()
		case c == ';' || c == '(' || c == ')' || c == '&' && !strings.HasPrefix(rest, "&>"):
			parser.at++
			parser.endPipeline()
		default:
			if !parser.readRedirect() {
				parser.command.words = append(parser.command.words, parser.readWord())
			}
		}
	}
	parser.endPipeline()
	return parser.pipelines
}

func (p *shellParser) endCommand() {
	command := p.command
	if len(command.words)+len(command.redirects)+len(command.heredocs)+len(command.hereStrings) > 0 {
		p.pipeline = append(p.pipeline, command)
	}
	p.command = &shellCommand{}
}

func (p *shellParser) endPipeline() {
	p.endCommand()
	if len(p.pipeline) > 0 {
		p.pipelines = append(p.pipelines, p.pipeline)
	}
	p.pipeline = nil
}

func (p *shellParser) readRedirect() bool {
	match := redirectOperator.FindStringSubmatch(p.text[p.at:])
	if match == nil {
		return false
	}
	p.at += len(match[0])
	fd, operator := match[1], match[2]
	if match[3] != "" {
		fd, operator = "&", match[3]
	}
	for p.at < len(p.text) && (p.text[p.at] == ' ' || p.text[p.at] == '\t') {
		p.at++
	}
	var target shellWord
	switch rest := p.text[p.at:]; {
	case strings.HasPrefix(rest, ">(") || strings.HasPrefix(rest, "<("):
		// A process substitution: the target is the command it runs.
		start := p.at
		p.at = skipBalanced(p.text, p.at+1)
		target = shellWord{span: span{start, p.at}, value: p.text[start:p.at]}
	case p.at < len(p.text) && !strings.ContainsRune("\n;|&<>()", rune(p.text[p.at])):
		target = p.readWord()
	}
	switch operator {
	case "<<", "<<-", "<<~":
		heredoc := &shellHeredoc{delimiter: target.value}
		if operator == "<<-" {
			heredoc.strip = "\t"
		} else if operator == "<<~" {
			heredoc.strip = " \t"
		}
		p.command.heredocs = append(p.command.heredocs, heredoc)
		p.pending = append(p.pending, heredoc)
	case "<<<":
		p.command.hereStrings = append(p.command.hereStrings, target)
	default:
		p.command.redirects = append(p.command.redirects, shellRedirect{operator: operator, fd: fd, target: target})
	}
	return true
}

func (p *shellParser) readWord() shellWord {
	start := p.at
	// A digest left by an earlier pass is one word, spaces and all.
	if digest := digestPrefix.FindString(p.text[p.at:]); digest != "" {
		p.at += len(digest)
		return shellWord{span: span{start, p.at}, value: digest}
	}
	var value strings.Builder
	text := p.text
	for p.at < len(text) {
		c := text[p.at]
		switch {
		case strings.IndexByte(" \t\r\n;|&<>()", c) >= 0:
			if p.at == start {
				p.at++
			}
			return shellWord{span: span{start, p.at}, value: value.String()}
		case c == '\\':
			if p.at+1 < len(text) {
				value.WriteByte(text[p.at+1])
			}
			p.at += 2
		case c == '\'':
			end := strings.IndexByte(text[p.at+1:], '\'')
			if end < 0 {
				value.WriteString(text[p.at+1:])
				p.at = len(text)
				continue
			}
			value.WriteString(text[p.at+1 : p.at+1+end])
			p.at += end + 2
		case c == '"':
			p.at++
			for p.at < len(text) && text[p.at] != '"' {
				if text[p.at] == '\\' && p.at+1 < len(text) {
					p.at++
				}
				value.WriteByte(text[p.at])
				p.at++
			}
			p.at++
		case c == '$' && p.at+1 < len(text) && text[p.at+1] == '\'':
			p.at += 2
			for p.at < len(text) && text[p.at] != '\'' {
				if text[p.at] == '\\' && p.at+1 < len(text) {
					value.WriteByte(text[p.at])
					p.at++
				}
				value.WriteByte(text[p.at])
				p.at++
			}
			p.at++
		case c == '$' && p.at+1 < len(text) && text[p.at+1] == '(':
			from := p.at
			p.at = skipBalanced(text, p.at+1)
			value.WriteString(text[from:min(p.at, len(text))])
		case c == '`':
			end := strings.IndexByte(text[p.at+1:], '`')
			if end < 0 {
				p.at = len(text)
				continue
			}
			value.WriteString(text[p.at : p.at+end+2])
			p.at += end + 2
		default:
			value.WriteByte(c)
			p.at++
		}
	}
	p.at = min(p.at, len(text))
	return shellWord{span: span{start, p.at}, value: value.String()}
}

// skipBalanced returns the index after the parenthesis that closes the one
// at open, skipping quoted text.
func skipBalanced(text string, open int) int {
	depth := 0
	for at := open; at < len(text); at++ {
		switch text[at] {
		case '\\':
			at++
		case '\'':
			if end := strings.IndexByte(text[at+1:], '\''); end >= 0 {
				at += end + 1
			} else {
				return len(text)
			}
		case '"':
			for at++; at < len(text) && text[at] != '"'; at++ {
				if text[at] == '\\' {
					at++
				}
			}
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return at + 1
			}
		}
	}
	return len(text)
}

// readHeredocBodies reads the bodies of the heredocs opened on the line that
// just ended, in order; a body without its terminator runs to the end.
func (p *shellParser) readHeredocBodies() {
	for _, heredoc := range p.pending {
		bodyStart := p.at
		for {
			if p.at >= len(p.text) {
				heredoc.body = span{bodyStart, len(p.text)}
				break
			}
			lineEnd := len(p.text)
			if newline := strings.IndexByte(p.text[p.at:], '\n'); newline >= 0 {
				lineEnd = p.at + newline
			}
			line := strings.TrimSuffix(p.text[p.at:lineEnd], "\r")
			if strings.TrimLeft(line, heredoc.strip) == heredoc.delimiter {
				end := max(p.at-1, bodyStart)
				if end > bodyStart && p.text[end-1] == '\r' {
					end--
				}
				heredoc.body = span{bodyStart, end}
				p.at = lineEnd
				if p.at < len(p.text) {
					p.at++
				}
				break
			}
			p.at = lineEnd + 1
		}
	}
	p.pending = nil
}

var (
	diffOldHeader  = regexp.MustCompile(`(?:^|[\s'"])(--- \S)`)
	diffNewHeader  = regexp.MustCompile(`^\s*\+\+\+ \S`)
	diffHunkHeader = regexp.MustCompile(`^\s*@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@`)
	diffPreamble   = regexp.MustCompile(`^(?:diff --git |index [0-9a-f]+\.\.|new file mode |deleted file mode |similarity index |rename (?:from|to) |old mode |new mode )`)
)

// withholdUnifiedDiffs digests every unified diff in text: its file headers,
// the git preamble above them and each hunk, sized by the hunk headers'
// counts so that text after the diff is kept.
func withholdUnifiedDiffs(text string) string {
	lines := lineSpans(text)
	lineText := func(index int) string {
		return strings.TrimSuffix(text[lines[index].start:lines[index].end], "\r")
	}
	isFileHeader := func(index int) bool {
		return index+2 < len(lines) && diffNewHeader.MatchString(lineText(index+1)) && diffHunkHeader.MatchString(lineText(index+2))
	}
	var spans []span
	for index := 0; index < len(lines); index++ {
		header := diffOldHeader.FindStringSubmatchIndex(lineText(index))
		if header == nil || !isFileHeader(index) {
			continue
		}
		start := lines[index].start + header[2]
		if header[2] == 0 {
			for above := index - 1; above >= 0 && diffPreamble.MatchString(lineText(above)); above-- {
				start = lines[above].start
			}
		}
		next := index + 2
		for {
			next = consumeHunks(lineText, len(lines), next)
			preamble := next
			for preamble < len(lines) && diffPreamble.MatchString(lineText(preamble)) {
				preamble++
			}
			if preamble >= len(lines) || !strings.HasPrefix(lineText(preamble), "--- ") || !isFileHeader(preamble) {
				break
			}
			next = preamble + 2
		}
		spans = append(spans, span{start, lines[next-1].end})
		index = next - 1
	}
	return withholdSpans(text, spans)
}

// consumeHunks reads the hunks starting at the hunk header on line at and
// returns the line after them. A header's counts are not trusted to end a
// hunk, so an understated one cannot leave lines outside: every line that
// reads as diff body is consumed, and blank lines too when diff body follows
// them, so a diff's last blank lines and the text after it are kept.
func consumeHunks(lineText func(int) string, count, at int) int {
	for ; at < count; at++ {
		line := lineText(at)
		if line != "" {
			if !isDiffBody(line) {
				return at
			}
			continue
		}
		next := at
		for next < count && lineText(next) == "" {
			next++
		}
		if next == count || !isDiffBody(lineText(next)) {
			return at
		}
		at = next - 1
	}
	return at
}

func isDiffBody(line string) bool {
	return diffHunkHeader.MatchString(line) || strings.ContainsRune(" +-\\", rune(line[0]))
}

func lineSpans(text string) []span {
	var lines []span
	start := 0
	for {
		newline := strings.IndexByte(text[start:], '\n')
		if newline < 0 {
			return append(lines, span{start, len(text)})
		}
		lines = append(lines, span{start, start + newline})
		start += newline + 1
	}
}
