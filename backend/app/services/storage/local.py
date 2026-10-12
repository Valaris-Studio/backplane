# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
from urllib.parse import quote

from fastapi.responses import FileResponse

from app.config import settings
from app.exceptions import ForbiddenError

FORBIDDEN_SEGMENTS = {"..", "~"}

# Stored files are served from the app's own origin under the viewer's session,
# so an uploaded .html/.svg would otherwise run as the app (stored XSS).
# `sandbox` gives an opened file an opaque origin; img/style allowances only
# let the browser's own image viewer render.
STORED_FILE_CSP = (
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; "
    "frame-ancestors 'none'; sandbox"
)

# Raster formats cannot carry script. SVG is deliberately absent: it is a
# document format and is always forced to download.
INLINE_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"})


def local_storage_path(key: str) -> Path:
    if any(segment in FORBIDDEN_SEGMENTS for segment in Path(key).parts):
        raise ForbiddenError("Invalid path")
    # LOCAL_STORAGE_DIR defaults to a RELATIVE path ("data/resources") that
    # resolves against the process CWD — same hazard class as the runner
    # base_dir incident. Deployments should pin an absolute dir.
    base = Path(settings.LOCAL_STORAGE_DIR)
    resolved = (base / key).resolve()
    if not resolved.is_relative_to(base.resolve()):
        raise ForbiddenError("Invalid path")
    return resolved


def existing_local_file(key: str) -> Path | None:
    try:
        path = local_storage_path(key)
    except ForbiddenError:
        return None
    return path if path.is_file() else None


def is_inline_safe_image(filename: str) -> bool:
    return Path(filename).suffix.lower() in INLINE_IMAGE_EXTENSIONS


def content_disposition(filename: str, *, inline: bool) -> str:
    disposition_type = "inline" if inline else "attachment"
    return f"{disposition_type}; filename*=UTF-8''{quote(filename, safe='')}"


def hardened_file_response(path: Path, filename: str) -> FileResponse:
    return FileResponse(
        path,
        headers={
            # identity opts this response out of GZipMiddleware (it skips
            # anything with a Content-Encoding already set): re-gzipping
            # uploads wastes CPU and, on the streaming branch, strips
            # Content-Length — breaking range/resumable downloads.
            "Content-Encoding": "identity",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": STORED_FILE_CSP,
            "Content-Disposition": content_disposition(
                filename, inline=is_inline_safe_image(filename)
            ),
        },
    )
