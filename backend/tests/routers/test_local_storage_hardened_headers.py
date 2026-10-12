# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local-storage downloads are served same-origin, under the viewer's session.

Any member can upload `.html`/`.svg` and get a co-member to open the download
link, so without these headers a stored file executes as the app (stored XSS
on every install without GCS_BUCKET). Only a raster-image allowlist may render
inline; everything else is forced to download, and every response is
nosniff + sandboxed by CSP.
"""

import uuid
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import settings
from app.models.workspace import Workspace

# Stricter than the app-wide default-deny CSP: `sandbox` gives an opened file
# an opaque origin (no session, no forms, no top navigation).
EXPECTED_CSP = (
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; "
    "frame-ancestors 'none'; sandbox"
)


async def _upload_and_download(
    client: AsyncClient, workspace: Workspace, filename: str, content: bytes, *, media: bool = False
):
    prefix = "media/" if media else ""
    file_path = f"{prefix}{workspace.id}/{uuid.uuid4()}/{filename}"
    upload = await client.put(f"/api/local-storage/upload/{file_path}", content=content)
    assert upload.status_code == 200
    return await client.get(f"/api/local-storage/download/{file_path}")


def _assert_hardened(resp) -> None:
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-security-policy"] == EXPECTED_CSP


@pytest.fixture
def local_storage_dir(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    return tmp_path


async def test_html_download_is_forced_attachment_and_sandboxed(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path
):
    payload = b"<script>fetch('/api/me')</script>"
    resp = await _upload_and_download(client, test_workspace, "evil.html", payload)

    assert resp.status_code == 200
    assert resp.content == payload
    _assert_hardened(resp)
    assert resp.headers["content-disposition"] == "attachment; filename*=UTF-8''evil.html"


async def test_svg_download_is_always_attachment(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path
):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    resp = await _upload_and_download(client, test_workspace, "logo.svg", svg, media=True)

    assert resp.status_code == 200
    _assert_hardened(resp)
    assert resp.headers["content-disposition"].startswith("attachment;")


@pytest.mark.parametrize("filename", ["photo.png", "photo.JPG", "a.jpeg", "b.gif", "c.webp", "d.avif"])
async def test_raster_image_renders_inline_with_hardening(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path, filename: str
):
    resp = await _upload_and_download(client, test_workspace, filename, b"\x89PNG fake", media=True)

    assert resp.status_code == 200
    _assert_hardened(resp)
    assert resp.headers["content-disposition"].startswith("inline;")


@pytest.mark.parametrize("filename", ["blob.weird", "README", "page.htm", "doc.xhtml", "notes.txt"])
async def test_non_allowlisted_or_extensionless_download_is_attachment(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path, filename: str
):
    resp = await _upload_and_download(client, test_workspace, filename, b"data")

    assert resp.status_code == 200
    _assert_hardened(resp)
    assert resp.headers["content-disposition"].startswith("attachment;")


async def test_html_disguised_as_png_cannot_be_sniffed(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path
):
    """Inline is decided by extension, so nosniff is what stops HTML bytes in a
    `.png` from being rendered as a document."""
    resp = await _upload_and_download(client, test_workspace, "x.png", b"<html><script>1</script>")

    assert resp.headers["content-type"] == "image/png"
    _assert_hardened(resp)


async def test_non_ascii_filename_is_rfc5987_encoded(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path
):
    resp = await _upload_and_download(client, test_workspace, 'año "final".pdf', b"%PDF")

    assert resp.status_code == 200
    assert (
        resp.headers["content-disposition"]
        == "attachment; filename*=UTF-8''a%C3%B1o%20%22final%22.pdf"
    )


async def test_hardened_download_keeps_identity_encoding(
    client: AsyncClient, test_workspace: Workspace, local_storage_dir: Path
):
    content = b"<p>x</p>" * 1024
    file_path = f"{test_workspace.id}/{uuid.uuid4()}/big.html"
    await client.put(f"/api/local-storage/upload/{file_path}", content=content)

    resp = await client.get(
        f"/api/local-storage/download/{file_path}", headers={"Accept-Encoding": "gzip"}
    )

    assert resp.headers.get("content-encoding") == "identity"
    assert resp.headers["content-length"] == str(len(content))
    _assert_hardened(resp)
