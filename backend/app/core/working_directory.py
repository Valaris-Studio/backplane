# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A session's working directory as Backplane keeps and shows it: the bound
folder's name plus the path inside it (`backplane/packages/api`), or only a
folder's own name when it lies outside the mapping. Never a device path."""

import re
from pathlib import PurePosixPath, PureWindowsPath

from app.core.local_paths import local_path_of

_WINDOWS_ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")
_SEPARATORS = re.compile(r"[\\/]+")
_DRIVE_NAME = re.compile(r"^[A-Za-z]:$")
# Win32 extended-length spellings: \\?\UNC\server\share and \\?\C:\dir.
_EXTENDED_UNC = re.compile(r"^\\\\\?\\UNC\\", re.IGNORECASE)
_EXTENDED = re.compile(r"^\\\\\?\\")


def device_path(value: str) -> str | None:
    """`value` when it is an absolute path of some device, spaces and all,
    with a file:// URL decoded and an extended-length prefix removed."""
    candidate = value.strip()
    if candidate.lower().startswith("file://"):
        decoded = local_path_of(candidate)
        if decoded is None:
            return None
        candidate = decoded
    candidate = _EXTENDED.sub("", _EXTENDED_UNC.sub(r"\\\\", candidate))
    if candidate.startswith(("/", "\\")) or _WINDOWS_ABSOLUTE.match(candidate):
        return candidate
    return None


def folder_name(path: str | None) -> str | None:
    """The last segment of a path; a filesystem or drive root names nothing."""
    if not path:
        return None
    name = _SEPARATORS.split(path.strip().rstrip("\\/"))[-1]
    if name in ("", ".", "..") or _DRIVE_NAME.match(name):
        return None
    return name


def _flavor(path: str):
    return PureWindowsPath if _WINDOWS_ABSOLUTE.match(path) else PurePosixPath


def _inside(path: str, root: str) -> str | None:
    """`path` relative to `root` with forward slashes (`.` for the root), or
    None when it lies elsewhere."""
    flavor = _flavor(root)
    if flavor is not _flavor(path):
        return None
    try:
        return flavor(path).relative_to(flavor(root)).as_posix()
    except ValueError:
        return None


def folder_path(working_directory: str | None, root: str | None) -> str | None:
    """The working directory as the bound folder's name plus the path inside
    it. A folder outside the mapping, or any absolute path when the mapping
    has no root, keeps only its own name; a relative path climbing out (`..`)
    likewise."""
    if not working_directory or not working_directory.strip():
        return None
    root_path = device_path(root) if root else None
    root_name = folder_name(root_path)
    absolute = device_path(working_directory)
    if absolute is not None:
        inside = _inside(absolute, root_path) if root_path else None
        if inside is None:
            return folder_name(absolute)
        relative = inside
    else:
        segments = [
            segment
            for segment in _SEPARATORS.split(working_directory.strip())
            if segment not in ("", ".")
        ]
        if ".." in segments:
            return folder_name(working_directory)
        relative = "/".join(segments) or "."
    if relative == ".":
        return root_name
    return f"{root_name}/{relative}" if root_name else relative


def without_device_path(working_directory: str | None) -> str | None:
    """An absolute device path keeps only its folder's name; anything else was
    already placed. For values stored before folder paths, and members that
    placement could not recognise as paths."""
    absolute = device_path(working_directory) if working_directory else None
    return folder_name(absolute) if absolute is not None else working_directory


# Members that name a working directory wherever an event carries one, Beacon's
# raw copy of the native payload included (the companion names the same ones).
_WORKING_DIRECTORY_MEMBERS = frozenset({"cwd", "working_directory", "workdir"})


def without_device_working_directories(value):
    """A copy of an event whose working directory members name no device path."""
    if isinstance(value, dict):
        return {
            key: without_device_path(child)
            if key.lower() in _WORKING_DIRECTORY_MEMBERS and isinstance(child, str)
            else without_device_working_directories(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [without_device_working_directories(child) for child in value]
    return value
