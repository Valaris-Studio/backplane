# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""File content carried inside commands, withheld at the standard level.

Commands are kept at standard; the files they write are not. This is the
ingest's twin of the companion's detector (companion/internal/privacy/
command_content.go and edit_content.go); both run the cases in
companion/internal/privacy/testdata/edit_content_vectors.json, so keep the two
in step and add a vector before changing either.
"""

import hashlib
import json
import posixpath
import re
from dataclasses import dataclass, field

_OMITTED_PREFIX = "[omitted "
_DIGEST_ONLY = re.compile(r"\[omitted \d+ bytes sha256:[0-9a-f]{16}\]")


def digest_text(text: str) -> str:
    # The companion's digest format, so either side's reduction reads alike.
    encoded = text.encode()
    return f"{_OMITTED_PREFIX}{len(encoded)} bytes sha256:{hashlib.sha256(encoded).hexdigest()[:16]}]"


# A real apply_patch envelope opens with a file operation on the line after its
# begin marker. That newline may be raw or escaped (once in a JS string, twice
# when that string sits in JSON), the header may be indented, and the markers
# are matched in any case. A bare mention of the markers is not a patch.
_PATCH_START = (
    r"\*\*\* Begin Patch[ \t]*(?:\\+r)?(?:\\+n|\r?\n)(?:[ \t]|\\+t)*"
    r"\*\*\* (?:Add File|Update File|Delete File|Move to):"
)
_PATCH_ENVELOPE = re.compile(_PATCH_START + r".*?\*\*\* End Patch", re.S | re.I)
# One cut short before its end marker runs to the end of the value.
_UNTERMINATED_PATCH = re.compile(_PATCH_START + r".*", re.S | re.I)


def _digest_match(match: re.Match) -> str:
    return digest_text(match.group(0))


def without_patch_envelopes(text: str) -> str:
    return _UNTERMINATED_PATCH.sub(
        _digest_match, _PATCH_ENVELOPE.sub(_digest_match, text)
    )


def without_command_content(value):
    """`value` with the file content its commands carry digested: apply_patch
    envelopes, unified diffs, heredoc bodies that write a file or feed a patch
    tool or a file-writing script, and echo/printf/here-string text written to
    a file. Strings inside dicts and lists are reduced too. Idempotent."""
    if isinstance(value, dict):
        return {key: without_command_content(child) for key, child in value.items()}
    if isinstance(value, list):
        return [without_command_content(child) for child in value]
    if not isinstance(value, str):
        return value
    document = _json_document(value)
    if document is not None:
        withheld = without_command_content(document)
        return _encode_json(withheld) if withheld != document else value
    text = without_patch_envelopes(value)
    text = _without_shell_content(text)
    text = _without_unified_diffs(text)
    if "\n" not in text:
        # A command can sit in a JavaScript string with its newlines escaped,
        # as Codex's exec tool sends it.
        text = _ESCAPED_NEWLINE_LITERAL.sub(_without_content_in_literal, text)
    return text


_ESCAPED_NEWLINE_LITERAL = re.compile(r'"(?:[^"\\\n]|\\.)*\\n(?:[^"\\\n]|\\.)*"')


def _without_content_in_literal(match: re.Match) -> str:
    literal = match.group(0)
    try:
        decoded = json.loads(literal)
    except ValueError:
        return literal
    withheld = without_command_content(decoded)
    return _encode_json(withheld) if withheld != decoded else literal


def _json_document(text: str):
    if not text.strip().startswith(("{", "[")):
        return None
    try:
        document = json.loads(text)
    except ValueError:
        return None
    return document if isinstance(document, (dict, list)) else None


def _encode_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _without_spans(text: str, spans: list[tuple[int, int]]) -> str:
    out, at = [], 0
    for start, end in sorted(spans):
        if start < at or end <= start:
            continue
        content = text[start:end]
        out.append(text[at:start])
        out.append(content if _DIGEST_ONLY.fullmatch(content) else digest_text(content))
        at = end
    out.append(text[at:])
    return "".join(out)


# --- the shell grammar file content travels in ------------------------------


@dataclass
class _Word:
    start: int
    end: int
    value: str  # the word with its quoting removed


@dataclass
class _Redirect:
    operator: str
    fd: str
    target: _Word


@dataclass
class _Heredoc:
    delimiter: str
    strip: str  # what may precede the terminator: tabs (<<-) or blanks (<<~)
    body: tuple[int, int] = (0, 0)


_COMMAND_PREFIXES = {"sudo", "env", "command", "exec", "time", "nohup"}
# Wrappers run a command given among their arguments, after options and values
# of their own (a container, a niceness, a timeout). Only commands that can
# write a file are looked for there.
_WRAPPERS = {
    "docker",
    "podman",
    "kubectl",
    "nice",
    "ionice",
    "timeout",
    "stdbuf",
    "xargs",
    "doas",
    "chroot",
    "flock",
}
_FILE_WRITING_COMMANDS = {
    "tee",
    "dd",
    "sponge",
    "install",
    "cp",
    "patch",
    "apply_patch",
    "git",
    "echo",
    "printf",
    "cat",
}
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
_INTERPRETERS = re.compile(
    r"(?:python[0-9.]*|node|nodejs|ruby|perl|bash|sh|zsh|dash|ksh)"
)
_SHELLS = re.compile(r"(?:bash|sh|zsh|dash|ksh)")
# File writes in a Python, Node, Ruby or Perl script read from stdin.
_SCRIPT_FILE_WRITE = re.compile(
    r"open\([^()]*,\s*(?:mode\s*=\s*)?['\"][wax]b?\+?['\"]|\.write_(?:text|bytes)\("
    r"|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\("
    r"|\bfs\.write|\bFile\.write|\bFile\.open\([^()]*['\"][wa]"
    r"|\bopen\s*\(?\s*(?:my\s+)?\$\w+\s*,\s*['\"]\+?>"
)
_ONLY_VARIABLES = re.compile(r"\s*(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s*)+")
_DEVICE_FILES = {
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "/dev/fd/1",
    "/dev/fd/2",
}
_STDIN_SCRIPT_FLAGS = {"-c", "-e", "-E", "-m", "--eval"}


@dataclass
class _Command:
    words: list[_Word] = field(default_factory=list)
    redirects: list[_Redirect] = field(default_factory=list)
    heredocs: list[_Heredoc] = field(default_factory=list)
    here_strings: list[_Word] = field(default_factory=list)

    def name_index(self) -> int:
        after_prefix = False
        for index, word in enumerate(self.words):
            if _ASSIGNMENT.match(word.value) or word.value in _COMMAND_PREFIXES:
                after_prefix = True
            elif after_prefix and word.value.startswith("-"):
                continue
            elif posixpath.basename(word.value) in _WRAPPERS:
                for nested in range(index + 1, len(self.words)):
                    name = posixpath.basename(self.words[nested].value)
                    if name in _FILE_WRITING_COMMANDS or _INTERPRETERS.fullmatch(name):
                        return nested
                return index
            else:
                return index
        return -1

    def name(self) -> str:
        index = self.name_index()
        return posixpath.basename(self.words[index].value) if index >= 0 else ""

    def arguments(self) -> list[_Word]:
        index = self.name_index()
        return self.words[index + 1 :] if index >= 0 else []

    def writes_file(self) -> bool:
        for redirect in self.redirects:
            target = redirect.target.value
            if target.startswith(">("):
                inner = target[2:].removesuffix(")")
                if any(
                    command.receives_into_file()
                    for pipeline in _parse_shell(inner)
                    for command in pipeline
                ):
                    return True
                continue
            if (
                redirect.operator in (">", ">>", ">|", "&>", "&>>")
                and redirect.fd in ("", "1", "&")
                and target
                and not target.startswith("&")
                and target not in _DEVICE_FILES
            ):
                return True
        return False

    def is_tee(self) -> bool:
        return self.name() == "tee"

    def is_patch_tool(self) -> bool:
        name = self.name()
        if name in ("patch", "apply_patch"):
            return True
        arguments = self.arguments()
        return (
            name == "git" and bool(arguments) and arguments[0].value in ("apply", "am")
        )

    def receives_into_file(self) -> bool:
        return (
            self.writes_file()
            or self.is_tee()
            or self.is_patch_tool()
            or self.copies_stdin_to_file()
        )

    def copies_stdin_to_file(self) -> bool:
        """dd of=<file>, sponge <file>, and install or cp from /dev/stdin."""
        name, arguments = self.name(), [argument.value for argument in self.arguments()]
        if name == "dd":
            return any(
                value.startswith("of=") and value[3:] not in _DEVICE_FILES
                for value in arguments
            )
        if name == "sponge":
            return any(not value.startswith("-") for value in arguments)
        if name in ("install", "cp"):
            return "/dev/stdin" in arguments
        return False

    def reads_script_from_stdin(self) -> bool:
        if not _INTERPRETERS.fullmatch(self.name()):
            return False
        return all(
            argument.value not in _STDIN_SCRIPT_FLAGS and argument.value.startswith("-")
            for argument in self.arguments()
        )


_REDIRECT = re.compile(r"(?:(\d*)(<<<|<<-|<<~|<<|<>|<&|>&|>>|>\||<|>)|(&>>|&>))")
_DIGEST_PREFIX = re.compile(r"\[omitted \d+ bytes sha256:[0-9a-f]{16}\]")
_WORD_END = " \t\r\n;|&<>()"


class _ShellParser:
    """Words and quoting, pipelines and their separators, redirects,
    here-strings and heredoc bodies. It never fails; text it cannot place
    becomes words."""

    def __init__(self, text: str):
        self.text = text
        self.at = 0
        self.pipelines: list[list[_Command]] = []
        self.pipeline: list[_Command] = []
        self.command = _Command()
        self.pending: list[_Heredoc] = []

    def parse(self) -> list[list[_Command]]:
        text = self.text
        while self.at < len(text):
            c, rest = text[self.at], text[self.at :]
            if c in " \t\r":
                self.at += 1
            elif c == "\n":
                self.at += 1
                self.read_heredoc_bodies()
                self.end_pipeline()
            elif c == "#":
                newline = rest.find("\n")
                self.at = self.at + newline if newline >= 0 else len(text)
            elif rest.startswith(("&&", "||")):
                self.at += 2
                self.end_pipeline()
            elif c == "|":
                self.at += 1
                if text[self.at : self.at + 1] == "&":
                    self.at += 1
                self.end_command()
            elif c in ";()" or (c == "&" and not rest.startswith("&>")):
                self.at += 1
                self.end_pipeline()
            elif not self.read_redirect():
                self.command.words.append(self.read_word())
        self.end_pipeline()
        return self.pipelines

    def end_command(self):
        command = self.command
        if (
            command.words
            or command.redirects
            or command.heredocs
            or command.here_strings
        ):
            self.pipeline.append(command)
        self.command = _Command()

    def end_pipeline(self):
        self.end_command()
        if self.pipeline:
            self.pipelines.append(self.pipeline)
        self.pipeline = []

    def read_redirect(self) -> bool:
        match = _REDIRECT.match(self.text, self.at)
        if not match:
            return False
        self.at = match.end()
        fd, operator = match.group(1), match.group(2)
        if match.group(3):
            fd, operator = "&", match.group(3)
        while self.at < len(self.text) and self.text[self.at] in " \t":
            self.at += 1
        target = _Word(self.at, self.at, "")
        if self.text.startswith((">(", "<("), self.at):
            # A process substitution: the target is the command it runs.
            start = self.at
            self.at = _skip_balanced(self.text, self.at + 1)
            target = _Word(start, self.at, self.text[start : self.at])
        elif self.at < len(self.text) and self.text[self.at] not in "\n;|&<>()":
            target = self.read_word()
        if operator in ("<<", "<<-", "<<~"):
            strip = {"<<-": "\t", "<<~": " \t"}.get(operator, "")
            heredoc = _Heredoc(target.value, strip)
            self.command.heredocs.append(heredoc)
            self.pending.append(heredoc)
        elif operator == "<<<":
            self.command.here_strings.append(target)
        else:
            self.command.redirects.append(_Redirect(operator, fd, target))
        return True

    def read_word(self) -> _Word:
        text, start = self.text, self.at
        # A digest left by an earlier pass is one word, spaces and all.
        digest = _DIGEST_PREFIX.match(text, self.at)
        if digest:
            self.at = digest.end()
            return _Word(start, self.at, digest.group(0))
        value = []
        while self.at < len(text):
            c = text[self.at]
            if c in _WORD_END:
                if self.at == start:
                    self.at += 1
                return _Word(start, self.at, "".join(value))
            if c == "\\":
                value.append(text[self.at + 1 : self.at + 2])
                self.at += 2
            elif c == "'":
                end = text.find("'", self.at + 1)
                if end < 0:
                    value.append(text[self.at + 1 :])
                    self.at = len(text)
                    continue
                value.append(text[self.at + 1 : end])
                self.at = end + 1
            elif c == '"':
                self.at += 1
                while self.at < len(text) and text[self.at] != '"':
                    if text[self.at] == "\\" and self.at + 1 < len(text):
                        self.at += 1
                    value.append(text[self.at])
                    self.at += 1
                self.at += 1
            elif c == "$" and text[self.at + 1 : self.at + 2] == "'":
                self.at += 2
                while self.at < len(text) and text[self.at] != "'":
                    if text[self.at] == "\\" and self.at + 1 < len(text):
                        value.append(text[self.at])
                        self.at += 1
                    value.append(text[self.at])
                    self.at += 1
                self.at += 1
            elif c == "$" and text[self.at + 1 : self.at + 2] == "(":
                begin = self.at
                self.at = _skip_balanced(text, self.at + 1)
                value.append(text[begin : self.at])
            elif c == "`":
                end = text.find("`", self.at + 1)
                if end < 0:
                    self.at = len(text)
                    continue
                value.append(text[self.at : end + 1])
                self.at = end + 1
            else:
                value.append(c)
                self.at += 1
        self.at = min(self.at, len(text))
        return _Word(start, self.at, "".join(value))

    def read_heredoc_bodies(self):
        """The bodies of the heredocs opened on the line that just ended, in
        order; a body without its terminator runs to the end."""
        text = self.text
        for heredoc in self.pending:
            body_start = self.at
            while True:
                if self.at >= len(text):
                    heredoc.body = (body_start, len(text))
                    break
                newline = text.find("\n", self.at)
                line_end = newline if newline >= 0 else len(text)
                line = text[self.at : line_end].removesuffix("\r")
                if line.lstrip(heredoc.strip) == heredoc.delimiter:
                    end = max(self.at - 1, body_start)
                    if end > body_start and text[end - 1] == "\r":
                        end -= 1
                    heredoc.body = (body_start, end)
                    self.at = min(line_end + 1, len(text))
                    break
                self.at = line_end + 1
        self.pending = []


def _skip_balanced(text: str, open_at: int) -> int:
    """The index after the parenthesis that closes the one at `open_at`,
    skipping quoted text."""
    depth, at = 0, open_at
    while at < len(text):
        c = text[at]
        if c == "\\":
            at += 1
        elif c == "'":
            end = text.find("'", at + 1)
            if end < 0:
                return len(text)
            at = end
        elif c == '"':
            at += 1
            while at < len(text) and text[at] != '"':
                if text[at] == "\\":
                    at += 1
                at += 1
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return at + 1
        at += 1
    return len(text)


def _parse_shell(text: str) -> list[list[_Command]]:
    return _ShellParser(text).parse()


def _only_variables(text: str) -> bool:
    return bool(_ONLY_VARIABLES.fullmatch(text))


def _join_values(words: list[_Word]) -> str:
    return " ".join(word.value for word in words if not word.value.startswith("-"))


def _script_writes_files(interpreter: str, script: str) -> bool:
    if not _SHELLS.fullmatch(interpreter):
        return bool(_SCRIPT_FILE_WRITE.search(script))
    return any(
        command.receives_into_file()
        for pipeline in _parse_shell(script)
        for command in pipeline
    )


def _without_shell_content(text: str) -> str:
    spans = []
    for pipeline in _parse_shell(text):
        for index, command in enumerate(pipeline):
            later = pipeline[index + 1 :]
            writes = command.writes_file() or any(
                other.receives_into_file() for other in later
            )
            for heredoc in command.heredocs:
                body = text[heredoc.body[0] : heredoc.body[1]]
                feeds_script = any(
                    reader.reads_script_from_stdin()
                    and _script_writes_files(reader.name(), body)
                    for reader in [command, *later]
                )
                if writes or command.receives_into_file() or feeds_script:
                    spans.append(heredoc.body)
            for word in command.here_strings:
                if (writes or command.receives_into_file()) and not _only_variables(
                    word.value
                ):
                    spans.append((word.start, word.end))
            if command.name() in ("echo", "printf") and writes:
                arguments = command.arguments()
                if arguments and not _only_variables(_join_values(arguments)):
                    spans.append((arguments[0].start, arguments[-1].end))
    return _without_spans(text, spans)


# --- unified diffs -----------------------------------------------------------

_DIFF_OLD_HEADER = re.compile(r"(?:^|[\s'\"])(--- \S)")
_DIFF_NEW_HEADER = re.compile(r"\s*\+\+\+ \S")
_DIFF_HUNK_HEADER = re.compile(r"\s*@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@")
_DIFF_PREAMBLE = re.compile(
    r"(?:diff --git |index [0-9a-f]+\.\.|new file mode |deleted file mode |similarity index "
    r"|rename (?:from|to) |old mode |new mode )"
)


def _without_unified_diffs(text: str) -> str:
    """Every unified diff in `text` digested: its file headers, the git
    preamble above them and each hunk, sized by the hunk headers' counts so
    that text after the diff is kept."""
    lines, start = [], 0
    while True:
        newline = text.find("\n", start)
        if newline < 0:
            lines.append((start, len(text)))
            break
        lines.append((start, newline))
        start = newline + 1

    def line_text(index: int) -> str:
        return text[lines[index][0] : lines[index][1]].removesuffix("\r")

    def is_file_header(index: int) -> bool:
        return (
            index + 2 < len(lines)
            and bool(_DIFF_NEW_HEADER.match(line_text(index + 1)))
            and bool(_DIFF_HUNK_HEADER.match(line_text(index + 2)))
        )

    spans, index = [], 0
    while index < len(lines):
        header = _DIFF_OLD_HEADER.search(line_text(index))
        if not header or not is_file_header(index):
            index += 1
            continue
        start = lines[index][0] + header.start(1)
        if header.start(1) == 0:
            above = index - 1
            while above >= 0 and _DIFF_PREAMBLE.match(line_text(above)):
                start = lines[above][0]
                above -= 1
        after = index + 2
        while True:
            after = _consume_hunks(line_text, len(lines), after)
            preamble = after
            while preamble < len(lines) and _DIFF_PREAMBLE.match(line_text(preamble)):
                preamble += 1
            if (
                preamble >= len(lines)
                or not line_text(preamble).startswith("--- ")
                or not is_file_header(preamble)
            ):
                break
            after = preamble + 2
        spans.append((start, lines[after - 1][1]))
        index = after
    return _without_spans(text, spans)


def _consume_hunks(line_text, count: int, at: int) -> int:
    """The line after the hunks that start at the hunk header on line `at`.
    A header's counts are not trusted to end a hunk, so an understated one
    cannot leave lines outside: every line that reads as diff body is
    consumed, and blank lines too when diff body follows them, so a diff's
    last blank lines and the text after it are kept."""
    while at < count:
        line = line_text(at)
        if line:
            if not _is_diff_body(line):
                return at
            at += 1
            continue
        after = at
        while after < count and line_text(after) == "":
            after += 1
        if after == count or not _is_diff_body(line_text(after)):
            return at
        at = after
    return at


def _is_diff_body(line: str) -> bool:
    return bool(_DIFF_HUNK_HEADER.match(line)) or line[0] in " +-\\"
