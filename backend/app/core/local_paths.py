# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
from urllib.parse import unquote, urlsplit

# An absolute POSIX, drive-letter or UNC path that starts a token. The
# lookbehind keeps URLs (`https://host/...`) and relative paths intact.
_ABSOLUTE_PATH = re.compile(r"(?<![\w.~:/\\])(?:/|[A-Za-z]:[\\/]|\\\\)[^\s'\"`,;:)]+")
PATH_PLACEHOLDER = "[path]"


def scrub_local_paths(text: str) -> str:
    """Device diagnostic text with no local path left: file:// URLs placed,
    home directories (every spelling) rewritten to ~name, and any other
    absolute path replaced by [path]. Homes first, so a path with a space
    in it keeps no fragment of the home directory."""
    text = _FILE_URL.sub(lambda url: _placed_file_url(url, []), text)
    text = _OTHER_HOMES.sub(r"\1~\2", text)
    return _ABSOLUTE_PATH.sub(PATH_PLACEHOLDER, text)


# --- placing event paths (server twin of companion/internal/privacy PlaceEvent) ---

# In a value that is a path: a home directory on macOS (any case: its file
# system is case-insensitive, and under WSL's /mnt/<drive>), Linux (including
# /var/home) or Windows, plain or URL-encoded, preceded by a boundary; it
# becomes ~name. Mirrors the companion's otherHomes.
_OTHER_HOMES = re.compile(
    r"(?i)(^|[^a-z0-9_.\-%])"
    r"(?:(?:/mnt/[a-z])?/users/|(?:/var)?/home/|[a-z]:[\\/]users[\\/]"
    r"|%2f(?:users|(?:var%2f)?home)%2f)"
    r"([^/\\\s\"'`%]+)"
)
# In prose only the unmistakable forms, so web routes (`GET /users/42/x`) and
# words (`/home/about`) survive: macOS /Users/<name>/ in its canonical case
# (also under WSL) and /home/<name>/ followed by a further segment. The
# boundary excludes `/` and `:` so URL paths are left alone; file:// URLs are
# placed separately.
_PROSE_MAC_HOMES = re.compile(
    r"(^|[^A-Za-z0-9_.\-%/:])(?:/mnt/[a-z])?/Users/([^/\\\s\"'`%]+)(?=/)"
)
_PROSE_LINUX_HOMES = re.compile(
    r"(^|[^A-Za-z0-9_.\-%/:])/home/([^/\\\s\"'`%]+)(?=/[^/\s\"'`])"
)
# Forms no web route takes, rewritten in prose too, in any case: Windows
# drive homes, WSL /mnt/<drive>/Users, URL-encoded /Users and /home.
# Accepted gaps: `cd /home/bob` (no further segment) and lowercase /users/...
_PROSE_UNAMBIGUOUS_HOMES = re.compile(
    r"(?i)(^|[^a-z0-9_.\-%])"
    r"(?:[a-z]:[\\/]users[\\/]|/mnt/[a-z]/users/|%2f(?:users|(?:var%2f)?home)%2f)"
    r"([^/\\\s\"'`%]+)"
)
# file:// URLs, with or without a host (`file://laptop/...`).
_FILE_URL = re.compile(r"(?i)file://([^/\s\"'`<>]*)(/[^\s\"'`<>]*)")
# Windows extended-length prefix in front of a drive path (\\?\C:\...).
_EXTENDED_PREFIX = re.compile(r"\\\\\?\\(?=[A-Za-z]:[\\/])")
_ROOT_HOME = "/root"
_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_DRIVE_AFTER_SLASH = re.compile(r"^/[A-Za-z]:[\\/]")


def _is_name_char(char: str) -> bool:
    return char.isalnum() or char in "_.-" or ord(char) >= 0x80


# A path separator as it appears in text: plain, either way round on
# Windows, or JSON-escaped (`\/`, `\\`).
_SEPARATOR = re.compile(r"\\\\|\\/|[\\/]")
_POSIX_SEPARATOR = r"(?:\\/|/)"
_ANY_SEPARATOR = r"(?:\\\\|\\/|[\\/])"
# Roots on file systems that ignore case: Windows drives and shares, and
# macOS's /Users and /Volumes. A Linux root's case is significant.
_CASE_INSENSITIVE_ROOT = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/Users/|/Volumes/)")


def _anchor_pattern(root: str) -> re.Pattern:
    """`root` as it may be spelled in text: separators in any form its system
    accepts or JSON escapes, and in any case where its file system ignores it."""
    windows = bool(_DRIVE.match(root) or root.startswith("\\\\"))
    separators = "/\\" if windows else "/"
    separator = _ANY_SEPARATOR if windows else _POSIX_SEPARATOR
    pattern = "".join(
        separator if char in separators else re.escape(char) for char in root
    )
    flags = re.IGNORECASE if _CASE_INSENSITIVE_ROOT.match(root) else 0
    return re.compile(pattern, flags)


def _replace_anchor(text: str, anchor: str, *, relative: bool, replacement: str) -> str:
    """Rewrite each occurrence of `anchor` that is a whole path prefix: inside a
    root it becomes the relative remainder (`.` for the root itself), anywhere
    else `replacement`."""
    pattern = _anchor_pattern(anchor)
    out, kept_from, search_from = [], 0, 0
    while match := pattern.search(text, search_from):
        index, end = match.span()
        search_from = end
        if (index > 0 and _is_name_char(text[index - 1])) or (
            end < len(text) and _is_name_char(text[end])
        ):
            continue
        out.append(text[kept_from:index])
        separator = _SEPARATOR.match(text, end)
        if not relative:
            out.append(replacement)
        elif (
            separator
            and separator.end() < len(text)
            and _is_name_char(text[separator.end()])
        ):
            end = separator.end()
        else:
            out.append(".")
        kept_from = search_from = end
    out.append(text[kept_from:])
    return "".join(out)


def _anchors(roots: list[str]) -> list[str]:
    anchors = []
    for root in sorted(roots, key=len, reverse=True):
        root = root.rstrip("/\\")
        # A filesystem root anchors nothing.
        if len(root) < 2 or (len(root) == 2 and root[1] == ":"):
            continue
        anchors.append(root)
    return anchors


def _place_path(path: str, roots: list[str]) -> str:
    """A value that is a path: relative inside a mapping root, ~name under any
    home directory spelling."""
    path = _EXTENDED_PREFIX.sub("", path)
    for root in _anchors(roots):
        path = _replace_anchor(path, root, relative=True, replacement=".")
    path = _replace_anchor(path, _ROOT_HOME, relative=False, replacement="~root")
    return _OTHER_HOMES.sub(r"\1~\2", path)


def _placed_file_url(url: re.Match, roots: list[str]) -> str:
    host, path = url[1], _place_path(url[2], roots)
    # A host needs its separator back when the path became `~name/...`.
    return "file://" + host + ("/" if host and not path.startswith("/") else "") + path


def place_text(text: str, roots: list[str]) -> str:
    """Local paths inside free text (a prompt, a command, a message): paths in
    a mapping root become relative, file:// URLs are placed like path values,
    and only unmistakable home directories become ~name. Nothing else in the
    text changes."""
    for root in _anchors(roots):
        text = _replace_anchor(text, root, relative=True, replacement=".")
    text = _FILE_URL.sub(lambda url: _placed_file_url(url, roots), text)
    text = _PROSE_UNAMBIGUOUS_HOMES.sub(r"\1~\2", text)
    text = _PROSE_MAC_HOMES.sub(r"\1~\2", text)
    return _PROSE_LINUX_HOMES.sub(r"\1~\2", text)


def local_path_of(value: str) -> str | None:
    """The local path a whole value names, if it is one: surrounding space
    trimmed and a file:// URL decoded (`file:///C:/x` → `C:/x`)."""
    candidate = value.strip()
    if candidate.lower().startswith("file://"):
        path = unquote(urlsplit(candidate).path)
        return path[1:] if _DRIVE_AFTER_SLASH.match(path) else path or None
    if not candidate or any(char.isspace() for char in candidate):
        return None
    # A URL-encoded path (`%2Fhome%2F...`) stays encoded; the home patterns
    # cover the encoded spelling.
    if (
        candidate.startswith(("/", "\\"))
        or _DRIVE.match(candidate)
        or (candidate[:3].lower() == "%2f")
    ):
        return candidate
    return None


def place_value(value: str, roots: list[str]) -> str:
    path = local_path_of(value)
    return _place_path(path, roots) if path is not None else place_text(value, roots)


def place_event(value, roots: list[str]):
    """A copy of an event with every string value and member name placed.
    When two member names place to the same one, the first by original name
    wins, as on the device."""
    if isinstance(value, str):
        return place_value(value, roots)
    if isinstance(value, dict):
        placed = {}
        for key in sorted(value):
            placed_key = place_value(key, roots) if isinstance(key, str) else key
            if placed_key not in placed:
                placed[placed_key] = place_event(value[key], roots)
        return placed
    if isinstance(value, list):
        return [place_event(child, roots) for child in value]
    return value
