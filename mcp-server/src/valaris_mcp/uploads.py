# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Bytes for upload_resource, from a local file or inline base64.

Local-file policy (the tool reads the disk of whoever runs the server):
- stdio transport only: under HTTP the "local" disk is the server host's.
- The real path (symlinks resolved) must sit inside an upload root: the
  working directory, or the `VALARIS_MCP_UPLOAD_ROOTS` list when set. The
  filesystem root is never an upload root.
- Secret-looking paths are refused with no override parameter, because a
  model can be steered into passing one; a human who means it uploads in the UI.
  Components are matched case- and Unicode-folded (macOS and Windows open
  `.AWS/config` as `.aws/config`), and only below the upload root, which the
  operator chose.
- Regular files only, opened without following a final symlink and without
  blocking on a FIFO, read up to a size cap.
- Hard-linked files are refused: a path-string denylist cannot vouch for what
  a hard link points at. A deliberate limit, not a bug.
- The opened fd must be the inode that was checked, and (where the kernel can
  say) live at a path that passes the same checks.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import mimetypes
import os
import re
import stat
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePath

# The backend's local-storage PUT ceiling, so a file that passes here lands in every storage mode.
MAX_PATH_UPLOAD_BYTES = 25 * 1024 * 1024
# Inline base64 costs model output tokens and an HTTP request body; it is for small generated files.
MAX_BASE64_UPLOAD_BYTES = 5 * 1024 * 1024

UPLOAD_ROOTS_ENV = "VALARIS_MCP_UPLOAD_ROOTS"
TRANSPORT_ENV = "MCP_TRANSPORT"

DEFAULT_CONTENT_TYPE = "application/octet-stream"
RASTER_IMAGE_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"}
)

# Matched against case- and Unicode-folded path components (see _fold): macOS
# and Windows filesystems open `.AWS/config` as `.aws/config`.
_SECRET_DIRS = frozenset(
    {
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        ".azure",
        ".git",
        ".password-store",
        ".terraform.d",
        ".codex",
        ".claude",
    }
)
_SECRET_DIR_PAIRS = frozenset({(".config", "gcloud"), (".config", "gh")})
# Backplane's own local apps keep device tokens in a `Backplane…`/`backplane-…`
# directory under the OS app-data dir (macOS Application Support, XDG state,
# Windows AppData\Local or Roaming).
_APP_DATA_PARENTS = frozenset({"application support", "state", "local", "roaming"})
_BACKPLANE_APP_DATA_PREFIX = "backplane"
# A platform data dir can be relocated by env (e.g. a `BACKPLANE_<APP>_HOME`);
# whatever such a variable names is treated as secret.
_PLATFORM_DATA_DIR_ENV_RE = re.compile(r"^(?:BACKPLANE|VALARIS)_\w+_(?:HOME|DIR)$")
_SECRET_FILES = frozenset(
    {
        ".env",
        ".envrc",
        ".netrc",
        ".pgpass",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        ".htpasswd",
        ".vault-token",
        ".mcp.json",
        ".claude.json",
        "claude_desktop_config.json",
        "credentials",
        "credentials.json",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
)
_SECRET_PREFIXES = ("kubeconfig",)
_SECRET_SUFFIXES = (
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".kdbx",
    ".ppk",
    ".tfstate",
    ".tfvars",
    ".tfvars.json",
)
# GCP service-account keys: service-account-prod.json, myserviceaccount.json, ci-sa.json.
_SERVICE_ACCOUNT_KEY_RE = re.compile(r"(service[-_]?account.*|-sa)\.json$")
_ENV_TEMPLATE_SUFFIXES = frozenset({"example", "sample", "template", "dist"})

# type/subtype (RFC 6838 restricted names), optionally `; key=value` params.
_CONTENT_TYPE_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*"
    r"(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$"
)
_DATA_URL_RE = re.compile(r"^data:([^;,]*)(?:;[^,]*)?;base64,", re.IGNORECASE)
_WHITESPACE_RE = re.compile(r"\s+")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_FILENAME_CHARS = 255


class UploadRefused(Exception):
    def __init__(self, message: str, error_code: str = "invalid_upload") -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True)
class UploadPayload:
    data: bytes
    filename: str
    content_type: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


def is_stdio_transport() -> bool:
    return os.environ.get(TRANSPORT_ENV, "stdio") == "stdio"


def validate_filename(filename: str | None) -> str:
    name = (filename or "").strip()
    if (
        not name.strip(".")
        or "/" in name
        or "\\" in name
        or _CONTROL_CHARS_RE.search(name)
        or len(name) > MAX_FILENAME_CHARS
    ):
        raise UploadRefused(
            "filename must be a plain file name: no slashes, control characters or dots-only, "
            f"at most {MAX_FILENAME_CHARS} characters."
        )
    return name


def decode_base64(content_base64: str) -> tuple[bytes, str | None]:
    """The bytes and, for a `data:` URL, the media type it declares."""
    max_encoded_chars = -(-MAX_BASE64_UPLOAD_BYTES // 3) * 4
    # Before any copy of the input; the slack covers line breaks and a data: URL prefix.
    if len(content_base64) > max_encoded_chars + max_encoded_chars // 16 + 1024:
        raise UploadRefused(
            f"content_base64 is over the {MAX_BASE64_UPLOAD_BYTES} byte inline cap; "
            "pass a local path instead (stdio only)."
        )
    text = content_base64.strip()
    declared_type = None
    if match := _DATA_URL_RE.match(text):
        declared_type = match.group(1) or None
        text = text[match.end() :]
    text = _WHITESPACE_RE.sub("", text)
    if len(text) > max_encoded_chars:
        raise UploadRefused(
            f"content_base64 is over the {MAX_BASE64_UPLOAD_BYTES} byte inline cap; "
            "pass a local path instead (stdio only)."
        )
    if not text:
        raise UploadRefused("content_base64 is empty.")
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise UploadRefused("content_base64 is not valid base64.") from None
    if len(data) > MAX_BASE64_UPLOAD_BYTES:
        raise UploadRefused(
            f"content_base64 is over the {MAX_BASE64_UPLOAD_BYTES} byte inline cap; "
            "pass a local path instead (stdio only)."
        )
    if not data:
        raise UploadRefused("content_base64 decodes to an empty file.")
    return data, declared_type


def upload_roots() -> list[Path]:
    configured = os.environ.get(UPLOAD_ROOTS_ENV, "").strip()
    candidates = configured.split(os.pathsep) if configured else [os.getcwd()]
    roots = []
    for candidate in candidates:
        if not candidate.strip():
            continue
        root = Path(os.path.realpath(candidate.strip()))
        if root.parent != root:
            roots.append(root)
    return roots


_CASE_INSENSITIVE_FS = sys.platform in ("darwin", "win32")


def _fold(text: str) -> str:
    # NFKC also folds macOS's decomposed (NFD) names and look-alikes such as a fullwidth "．ｓｓｈ".
    return unicodedata.normalize("NFKC", text).casefold()


def _within(path: PurePath, root: PurePath) -> bool:
    if not _CASE_INSENSITIVE_FS:
        return path == root or path.is_relative_to(root)
    folded_root = [_fold(part) for part in root.parts]
    return [_fold(part) for part in path.parts[: len(folded_root)]] == folded_root


def _containing_root(path: PurePath, roots: list[Path]) -> Path | None:
    return next((root for root in roots if _within(path, root)), None)


def _platform_data_dirs() -> list[Path]:
    return [
        Path(os.path.realpath(value.strip()))
        for name, value in os.environ.items()
        if name != UPLOAD_ROOTS_ENV and _PLATFORM_DATA_DIR_ENV_RE.match(name) and value.strip()
    ]


def _is_secret_path(path: PurePath, roots: list[Path]) -> bool:
    """Only the part below the upload root is matched: the operator chose the root
    (agent worktrees often live under .claude/worktrees), the model chose the rest."""
    resolved = Path(os.path.realpath(path))
    if any(_within(resolved, data_dir) for data_dir in _platform_data_dirs()):
        return True
    folded = [_fold(part) for part in path.parts]
    root = _containing_root(path, roots)
    first_chosen = len(root.parts) if root else 0
    if first_chosen >= len(folded):
        return False
    for index in range(first_chosen, len(folded)):
        part, parent = folded[index], folded[index - 1] if index > 0 else ""
        if part in _SECRET_DIRS or (parent, part) in _SECRET_DIR_PAIRS:
            return True
        if parent in _APP_DATA_PARENTS and part.startswith(_BACKPLANE_APP_DATA_PREFIX):
            return True
    name = folded[-1]
    if name in _SECRET_FILES or name.startswith(_SECRET_PREFIXES):
        return True
    if name.startswith(".env.") and name.rsplit(".", 1)[-1] not in _ENV_TEMPLATE_SUFFIXES:
        return True
    return name.endswith(_SECRET_SUFFIXES) or _SERVICE_ACCOUNT_KEY_RE.search(name) is not None


def _secret_refusal() -> UploadRefused:
    return UploadRefused(
        "That path looks like a secret (keys, credentials, .env, VCS, agent or cloud config); "
        "upload_resource never reads it. Upload it in the app if you really mean to.",
        "secret_path_refused",
    )


def _outside_roots_refusal(roots: list[Path]) -> UploadRefused:
    return UploadRefused(
        f"path resolves outside the upload roots ({', '.join(map(str, roots))}). "
        f"Symlinks are resolved first; set {UPLOAD_ROOTS_ENV} to allow other directories.",
        "path_not_allowed",
    )


def _file_identity_of(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def _file_identity(path: Path) -> tuple[int, int]:
    return _file_identity_of(os.lstat(path))


def _open_file_path(fd: int) -> str | None:
    """Where the kernel says an open fd lives, or None where it cannot say."""
    try:
        if sys.platform == "darwin":
            import fcntl

            raw = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024)
            return os.fsdecode(raw.split(b"\0", 1)[0])
        proc_link = f"/proc/self/fd/{fd}"
        if os.path.exists(proc_link):
            return os.readlink(proc_link)
    except OSError:
        return None
    return None


def _read_up_to(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit
    while remaining > 0:
        chunk = os.read(fd, min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_checked_fd(
    fd: int, path: str, checked_identity: tuple[int, int], roots: list[Path]
) -> bytes:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise UploadRefused(f"{path} is not a regular file (directory, device, pipe or socket).")
    # A path string says nothing about what a hard link points at (an innocent name
    # can be ~/.ssh/id_ed25519), so the denylist cannot vouch for one. Deliberate limit.
    if info.st_nlink > 1:
        raise UploadRefused(
            f"{path} has more than one hard link, and upload_resource refuses hard-linked "
            "files because their name cannot show what they are. Upload a copy instead.",
            "hardlink_refused",
        )
    # Closes the window between the path checks and the open: a file or parent
    # directory swapped in between is another inode, or the kernel reports it elsewhere.
    if _file_identity_of(info) != checked_identity:
        raise UploadRefused(f"{path} changed while it was being opened; retry.", "path_changed")
    if (opened_at := _open_file_path(fd)) is not None:
        opened = Path(opened_at)
        if _is_secret_path(opened, roots):
            raise _secret_refusal()
        if _containing_root(opened, roots) is None:
            raise _outside_roots_refusal(roots)
    if info.st_size > MAX_PATH_UPLOAD_BYTES:
        raise UploadRefused(f"{path} is over the {MAX_PATH_UPLOAD_BYTES} byte upload cap.")
    # Read one byte past the cap: a file that grew after fstat must not slip through.
    return _read_up_to(fd, MAX_PATH_UPLOAD_BYTES + 1)


def read_local_file(path: str) -> tuple[bytes, str]:
    """The file's bytes and its base name, under the local-file policy above."""
    if not is_stdio_transport():
        raise UploadRefused(
            "path is only read over the stdio transport; this server runs over HTTP, "
            "so send the bytes as content_base64.",
            "path_not_allowed",
        )
    roots = upload_roots()
    if not roots:
        raise UploadRefused(
            "No upload root: the working directory is the filesystem root. "
            f"Set {UPLOAD_ROOTS_ENV} to the directories uploads may come from.",
            "path_not_allowed",
        )
    requested = Path(path).expanduser()
    if not requested.is_absolute():
        requested = Path(os.getcwd()) / requested
    requested = Path(os.path.normpath(requested))
    real = Path(os.path.realpath(requested))
    if _is_secret_path(requested, roots) or _is_secret_path(real, roots):
        raise _secret_refusal()
    if _containing_root(real, roots) is None:
        raise _outside_roots_refusal(roots)
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | getattr(os, "O_BINARY", 0)
    )
    try:
        checked_identity = _file_identity(real)
        fd = os.open(real, flags)
    except FileNotFoundError:
        raise UploadRefused(f"File not found: {path}") from None
    except OSError as exc:
        raise UploadRefused(f"Cannot open {path}: {exc.strerror}") from None
    try:
        data = _read_checked_fd(fd, path, checked_identity, roots)
    finally:
        os.close(fd)
    if len(data) > MAX_PATH_UPLOAD_BYTES:
        raise UploadRefused(f"{path} is over the {MAX_PATH_UPLOAD_BYTES} byte upload cap.")
    if not data:
        raise UploadRefused(f"{path} is an empty file.")
    return data, real.name


def sniff_content_type(data: bytes) -> str | None:
    """The type the bytes prove, for formats a browser would render from a signature."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"):
        return "image/avif"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    return None


_SIGNED_TYPES = RASTER_IMAGE_TYPES | {"application/pdf"}


def resolve_content_type(data: bytes, filename: str, declared: str | None) -> str:
    """Declared, else signature, else extension, else octet-stream — and never a
    type the bytes contradict (an image type on non-image bytes, or the reverse)."""
    if declared is not None:
        declared = declared.strip()
        if not _CONTENT_TYPE_RE.match(declared):
            raise UploadRefused("content_type must be a MIME type like image/png or text/plain.")
    sniffed = sniff_content_type(data)
    claimed = declared or mimetypes.guess_type(filename)[0]
    if claimed is None:
        return sniffed or DEFAULT_CONTENT_TYPE
    claimed_base = claimed.split(";", 1)[0].strip().lower()
    contradicts = (
        sniffed is not None and claimed_base not in (sniffed, DEFAULT_CONTENT_TYPE)
    ) or (claimed_base in _SIGNED_TYPES and sniffed != claimed_base)
    if contradicts:
        raise UploadRefused(
            f"The bytes are {sniffed or 'not a recognised image or PDF'}, but the "
            f"{'content_type' if declared else 'filename extension'} says {claimed_base}.",
            "content_type_mismatch",
        )
    return claimed


def load_payload(
    path: str | None,
    content_base64: str | None,
    filename: str | None,
    content_type: str | None,
) -> UploadPayload:
    if (path is None) == (content_base64 is None):
        raise UploadRefused(
            "Pass exactly one of path (a local file, stdio only) or content_base64."
        )
    if content_base64 is not None:
        if filename is None:
            raise UploadRefused("content_base64 needs a filename.")
        name = validate_filename(filename)
        data, data_url_type = decode_base64(content_base64)
        declared = content_type or data_url_type
    else:
        data, base_name = read_local_file(path)
        name = validate_filename(filename if filename is not None else base_name)
        declared = content_type
    return UploadPayload(
        data=data, filename=name, content_type=resolve_content_type(data, name, declared)
    )


# -- markdown embed (the note attachment form the backend parses) ------------

_LABEL_SPECIALS_RE = re.compile(r"([\\\[\]*_`~<])")
_ENTITY_LIKE_RE = re.compile(r"&(?=#?[A-Za-z0-9]+;)")
_NEEDS_ANGLE_DESTINATION_RE = re.compile(r"[\s()<>]")


def _label(text: str) -> str:
    return _ENTITY_LIKE_RE.sub(r"\\&", _LABEL_SPECIALS_RE.sub(r"\\\1", text))


def _destination(src: str) -> str:
    if _NEEDS_ANGLE_DESTINATION_RE.search(src):
        return "<" + src.replace("<", "\\<").replace(">", "\\>") + ">"
    return src


def embed_markdown(
    name: str, content_url: str, mime_type: str | None, size_bytes: int | None
) -> str:
    base_type = (mime_type or "").split(";", 1)[0].strip().lower()
    if base_type in RASTER_IMAGE_TYPES:
        return f"![{_label(name)}]({_destination(content_url)})"
    params = ["attachment"]
    if isinstance(size_bytes, int) and size_bytes > 0:
        params.append(f"size={size_bytes}")
    if base_type and base_type != DEFAULT_CONTENT_TYPE:
        params.append(f"type={base_type}")
    return f'[{_label(name)}]({_destination(content_url)} "{"; ".join(params)}")'
