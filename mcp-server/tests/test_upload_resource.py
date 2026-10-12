# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""upload_resource: get an upload URL, PUT the bytes, register the resource,
all in one call, so an agent never needs a shell or a signed URL.

Local files are read only over stdio, inside the upload roots, never through
a symlink that leaves them, never a secret-looking path, and within a size cap.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import httpx
import pytest

from valaris_mcp.client import ValarisClient

RESOURCE_ID = "6f1c2a9e-0b7d-4e47-9a51-3d8c1f0e2b44"
CONTENT_PATH = f"/api/workspaces/test/resources/{RESOURCE_ID}/content"
SIGNED_PUT = "https://storage.googleapis.com/b/ws/obj/a.png?X-Goog-Signature=secretsig"
GCS_PATH = "ws-id/obj-id/a.png"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
PDF = b"%PDF-1.7\n" + b"x" * 40
PNG_SIZE = len(PNG)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _created(name="a.png", mime="image/png", size=PNG_SIZE) -> dict:
    return {
        "id": RESOURCE_ID,
        "name": name,
        "resource_type": "file",
        "gcs_path": GCS_PATH,
        "mime_type": mime,
        "size_bytes": size,
    }


def _http_error(status: int, body: dict, method="POST") -> httpx.HTTPStatusError:
    request = httpx.Request(method, "http://test/api/workspaces/test/resources")
    response = httpx.Response(status, json=body, request=request)
    return httpx.HTTPStatusError("error", request=request, response=response)


@pytest.fixture
def backend(mock_client):
    """The upload-url → create_resource exchange of a healthy backend."""

    def respond(created: dict):
        mock_client.post.side_effect = [
            {"upload_url": SIGNED_PUT, "gcs_path": GCS_PATH},
            created,
        ]

    respond(_created())
    mock_client.put_bytes.return_value = None
    mock_client.respond = respond
    return mock_client


@pytest.fixture
def stdio(monkeypatch):
    monkeypatch.delenv("MCP_TRANSPORT", raising=False)
    monkeypatch.delenv("VALARIS_MCP_UPLOAD_ROOTS", raising=False)


@pytest.fixture
def upload_root(tmp_path, monkeypatch, stdio):
    root = tmp_path / "project"
    root.mkdir()
    monkeypatch.chdir(root)
    return root


async def _upload(ctx, **kwargs) -> dict:
    from valaris_mcp.tools.resources import upload_resource

    return json.loads(await upload_resource("test", ctx=ctx, **kwargs))


# -- base64 ------------------------------------------------------------------


@pytest.mark.anyio
async def test_base64_upload_puts_the_bytes_and_returns_the_stable_link(backend, ctx):
    result = await _upload(ctx, content_base64=_b64(PNG), filename="a.png", description="login")

    upload_path, upload_body = backend.post.call_args_list[0].args
    assert upload_path == "/workspaces/test/resources/upload-url"
    assert upload_body == {"filename": "a.png", "content_type": "image/png"}
    backend.put_bytes.assert_awaited_once_with(SIGNED_PUT, PNG, "image/png")
    create_path, create_body = backend.post.call_args_list[1].args
    assert create_path == "/workspaces/test/resources"
    assert create_body == {
        "name": "a.png",
        "resource_type": "file",
        "gcs_path": GCS_PATH,
        "description": "login",
    }
    assert result["id"] == RESOURCE_ID
    assert result["content_url"] == CONTENT_PATH
    assert result["embed_markdown"] == f"![a.png]({CONTENT_PATH})"
    assert "embed_markdown" in result["_hint"]


@pytest.mark.anyio
async def test_board_and_folder_scope_both_calls(backend, ctx):
    await _upload(ctx, content_base64=_b64(PNG), filename="a.png", board_id="b1", parent_id="f1")

    assert (
        backend.post.call_args_list[0].args[0] == "/workspaces/test/boards/b1/resources/upload-url"
    )
    create_path, create_body = backend.post.call_args_list[1].args
    assert create_path == "/workspaces/test/boards/b1/resources"
    assert create_body["parent_id"] == "f1"


@pytest.mark.anyio
async def test_a_non_image_embeds_as_the_attachment_form(backend, ctx):
    backend.respond(_created(name="spec [v2].pdf", mime="application/pdf", size=len(PDF)))
    result = await _upload(ctx, content_base64=_b64(PDF), filename="spec [v2].pdf")

    assert backend.put_bytes.await_args.args[2] == "application/pdf"
    assert result["embed_markdown"] == (
        f'[spec \\[v2\\].pdf]({CONTENT_PATH} "attachment; size={len(PDF)}; type=application/pdf")'
    )


@pytest.mark.anyio
async def test_a_data_url_is_accepted_and_its_type_is_the_declared_one(backend, ctx):
    await _upload(ctx, content_base64="data:image/png;base64," + _b64(PNG), filename="shot")

    assert backend.put_bytes.await_args.args[2] == "image/png"


@pytest.mark.anyio
@pytest.mark.parametrize("bad", ["not base64!!", "QUJD=", "", "   "])
async def test_invalid_base64_is_refused_before_any_backend_call(backend, ctx, bad):
    result = await _upload(ctx, content_base64=bad, filename="a.bin")

    assert result["error"] is True
    assert "base64" in result["message"]
    backend.post.assert_not_called()
    backend.put_bytes.assert_not_called()


@pytest.mark.anyio
async def test_base64_over_the_cap_is_refused_before_decoding(backend, ctx, monkeypatch):
    from valaris_mcp import uploads

    monkeypatch.setattr(uploads, "MAX_BASE64_UPLOAD_BYTES", 16)
    result = await _upload(ctx, content_base64=_b64(b"x" * 17), filename="a.txt")

    assert result["error"] is True
    assert "16" in result["message"] and "path" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_base64_needs_a_filename(backend, ctx):
    result = await _upload(ctx, content_base64=_b64(PNG))

    assert result["error"] is True and "filename" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("kwargs", [{}, {"content_base64": "QUJD", "path": "a.txt"}])
async def test_exactly_one_source_is_required(backend, ctx, stdio, kwargs):
    result = await _upload(ctx, filename="a.txt", **kwargs)

    assert result["error"] is True
    assert "path" in result["message"] and "content_base64" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("filename", ["../a.png", "a/b.png", "a\\b.png", "..", "a\x00.png", " "])
async def test_unsafe_filenames_are_refused(backend, ctx, filename):
    result = await _upload(ctx, content_base64=_b64(PNG), filename=filename)

    assert result["error"] is True and "filename" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_an_empty_file_is_refused(backend, ctx, upload_root):
    (upload_root / "empty.txt").write_bytes(b"")
    result = await _upload(ctx, path="empty.txt")

    assert result["error"] is True and "empty" in result["message"]
    backend.post.assert_not_called()


# -- content type ------------------------------------------------------------


@pytest.mark.anyio
async def test_declared_type_that_contradicts_the_bytes_is_refused(backend, ctx):
    result = await _upload(
        ctx, content_base64=_b64(PDF), filename="a.png", content_type="image/png"
    )

    assert result["error"] is True and result["error_code"] == "content_type_mismatch"
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_image_extension_on_non_image_bytes_is_refused(backend, ctx):
    result = await _upload(ctx, content_base64=_b64(b"<html><script>x</script>"), filename="a.png")

    assert result["error"] is True and result["error_code"] == "content_type_mismatch"


@pytest.mark.anyio
async def test_image_bytes_declared_as_html_are_refused(backend, ctx):
    result = await _upload(
        ctx, content_base64=_b64(PNG), filename="a.html", content_type="text/html"
    )

    assert result["error"] is True and result["error_code"] == "content_type_mismatch"


@pytest.mark.anyio
async def test_text_keeps_its_declared_type(backend, ctx):
    await _upload(
        ctx, content_base64=_b64(b"# hi\n"), filename="a.md", content_type="text/markdown"
    )

    assert backend.put_bytes.await_args.args[2] == "text/markdown"


@pytest.mark.anyio
async def test_unknown_bytes_fall_back_to_the_extension_then_octet_stream(backend, ctx):
    await _upload(ctx, content_base64=_b64(b"a,b\n1,2\n"), filename="t.csv")
    assert backend.put_bytes.await_args.args[2] == "text/csv"

    backend.respond(_created())
    await _upload(ctx, content_base64=_b64(b"\x01\x02"), filename="blob")
    assert backend.put_bytes.await_args.args[2] == "application/octet-stream"


@pytest.mark.anyio
@pytest.mark.parametrize("bad", ["png", "image/", "text/html\r\nX-Evil: 1", "a/b c"])
async def test_malformed_content_types_are_refused(backend, ctx, bad):
    result = await _upload(ctx, content_base64=_b64(b"hi"), filename="a.txt", content_type=bad)

    assert result["error"] is True and "content_type" in result["message"]
    backend.post.assert_not_called()


# -- local path --------------------------------------------------------------


@pytest.mark.anyio
async def test_a_file_in_the_working_directory_uploads_under_its_own_name(
    backend, ctx, upload_root
):
    (upload_root / "docs").mkdir()
    (upload_root / "docs" / "spec.pdf").write_bytes(PDF)
    backend.respond(_created(name="spec.pdf", mime="application/pdf", size=len(PDF)))

    result = await _upload(ctx, path="docs/spec.pdf")

    assert backend.post.call_args_list[0].args[1] == {
        "filename": "spec.pdf",
        "content_type": "application/pdf",
    }
    backend.put_bytes.assert_awaited_once_with(SIGNED_PUT, PDF, "application/pdf")
    assert result["content_url"] == CONTENT_PATH


@pytest.mark.anyio
async def test_an_absolute_path_inside_the_root_is_fine(backend, ctx, upload_root):
    (upload_root / "a.png").write_bytes(PNG)
    result = await _upload(ctx, path=str(upload_root / "a.png"), filename="renamed.png")

    assert "error" not in result
    assert backend.post.call_args_list[0].args[1]["filename"] == "renamed.png"


@pytest.mark.anyio
async def test_http_transport_refuses_local_paths(backend, ctx, upload_root, monkeypatch):
    (upload_root / "a.png").write_bytes(PNG)
    monkeypatch.setenv("MCP_TRANSPORT", "streamable-http")

    result = await _upload(ctx, path="a.png")

    assert result["error"] is True and result["error_code"] == "path_not_allowed"
    assert "content_base64" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_traversal_out_of_the_root_is_refused(backend, ctx, upload_root):
    (upload_root.parent / "outside.txt").write_text("secret-ish")

    result = await _upload(ctx, path="../outside.txt")

    assert result["error"] is True and result["error_code"] == "path_not_allowed"
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_an_absolute_path_outside_the_root_is_refused(backend, ctx, upload_root):
    outside = upload_root.parent / "outside.txt"
    outside.write_text("x")

    result = await _upload(ctx, path=str(outside))

    assert result["error"] is True and result["error_code"] == "path_not_allowed"


@pytest.mark.anyio
async def test_a_symlink_leaving_the_root_is_refused(backend, ctx, upload_root):
    outside = upload_root.parent / "outside.txt"
    outside.write_text("x")
    (upload_root / "innocent.txt").symlink_to(outside)

    result = await _upload(ctx, path="innocent.txt")

    assert result["error"] is True and result["error_code"] == "path_not_allowed"
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_a_symlink_staying_inside_the_root_is_followed(backend, ctx, upload_root):
    (upload_root / "real.png").write_bytes(PNG)
    (upload_root / "alias.png").symlink_to(upload_root / "real.png")

    result = await _upload(ctx, path="alias.png")

    assert "error" not in result
    backend.put_bytes.assert_awaited_once_with(SIGNED_PUT, PNG, "image/png")


@pytest.mark.anyio
async def test_a_directory_is_refused(backend, ctx, upload_root):
    (upload_root / "dir").mkdir()

    result = await _upload(ctx, path="dir")

    assert result["error"] is True and "regular file" in result["message"]


@pytest.mark.anyio
async def test_a_fifo_is_refused_without_blocking(backend, ctx, upload_root):
    os.mkfifo(upload_root / "pipe")

    result = await _upload(ctx, path="pipe", filename="pipe.txt")

    assert result["error"] is True and "regular file" in result["message"]


@pytest.mark.anyio
async def test_a_device_file_is_refused(backend, ctx, upload_root, monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_UPLOAD_ROOTS", "/dev")

    result = await _upload(ctx, path="/dev/null", filename="null.txt")

    assert result["error"] is True and "regular file" in result["message"]


@pytest.mark.anyio
async def test_a_missing_file_is_reported(backend, ctx, upload_root):
    result = await _upload(ctx, path="nope.txt")

    assert result["error"] is True and "not found" in result["message"]


@pytest.mark.anyio
async def test_a_file_over_the_cap_is_refused(backend, ctx, upload_root, monkeypatch):
    from valaris_mcp import uploads

    monkeypatch.setattr(uploads, "MAX_PATH_UPLOAD_BYTES", 8)
    (upload_root / "big.txt").write_bytes(b"x" * 9)

    result = await _upload(ctx, path="big.txt")

    assert result["error"] is True and "8" in result["message"]
    backend.post.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "secret",
    [
        ".env",
        ".env.local",
        "config/.env.production",
        ".ssh/id_ed25519",
        ".ssh/config",
        ".aws/credentials",
        ".git/config",
        ".config/gcloud/application_default_credentials.json",
        "id_rsa",
        "server.pem",
        "tls.key",
        "store.p12",
        ".netrc",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        ".mcp.json",
        "terraform.tfstate",
    ],
)
async def test_secret_looking_paths_are_refused(backend, ctx, upload_root, secret):
    target = upload_root / secret
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("TOKEN=hunter2")

    result = await _upload(ctx, path=secret, filename="notes.txt")

    assert result["error"] is True and result["error_code"] == "secret_path_refused"
    assert "hunter2" not in json.dumps(result)
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_a_symlink_to_a_secret_inside_the_root_is_refused(backend, ctx, upload_root):
    (upload_root / ".env").write_text("TOKEN=hunter2")
    (upload_root / "readme.txt").symlink_to(upload_root / ".env")

    result = await _upload(ctx, path="readme.txt")

    assert result["error"] is True and result["error_code"] == "secret_path_refused"


@pytest.mark.anyio
@pytest.mark.parametrize("template", [".env.example", ".env.sample", "id_ed25519.pub"])
async def test_secret_templates_and_public_keys_are_allowed(backend, ctx, upload_root, template):
    (upload_root / template).write_text("KEY=\n")

    result = await _upload(ctx, path=template, filename="t.txt")

    assert "error" not in result


@pytest.mark.anyio
async def test_the_filesystem_root_is_never_an_upload_root(backend, ctx, stdio, monkeypatch):
    monkeypatch.chdir("/")

    result = await _upload(ctx, path="etc/hosts")

    assert result["error"] is True and result["error_code"] == "path_not_allowed"
    assert "VALARIS_MCP_UPLOAD_ROOTS" in result["message"]


@pytest.mark.anyio
async def test_configured_roots_replace_the_working_directory(
    backend, ctx, upload_root, monkeypatch, tmp_path
):
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "a.png").write_bytes(PNG)
    (upload_root / "b.png").write_bytes(PNG)
    monkeypatch.setenv("VALARIS_MCP_UPLOAD_ROOTS", str(shared))

    assert "error" not in await _upload(ctx, path=str(shared / "a.png"))
    refused = await _upload(ctx, path="b.png")
    assert refused["error_code"] == "path_not_allowed"


# -- failures and redaction --------------------------------------------------


@pytest.mark.anyio
async def test_object_not_uploaded_tells_the_agent_to_retry(backend, ctx):
    backend.post.side_effect = [
        {"upload_url": SIGNED_PUT, "gcs_path": GCS_PATH},
        _http_error(422, {"detail": "No uploaded object", "error_code": "object_not_uploaded"}),
    ]

    result = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")

    assert result["error"] is True and result["status"] == 422
    assert result["error_code"] == "object_not_uploaded"
    assert "upload_resource" in result["_hint"]
    assert "secretsig" not in json.dumps(result)


@pytest.mark.anyio
async def test_a_failed_put_never_echoes_the_signed_url(backend, ctx):
    request = httpx.Request("PUT", SIGNED_PUT)
    backend.put_bytes.side_effect = httpx.HTTPStatusError(
        f"Client error '403 Forbidden' for url '{SIGNED_PUT}'",
        request=request,
        response=httpx.Response(
            403, text=f"<Error>SignatureDoesNotMatch {SIGNED_PUT}</Error>", request=request
        ),
    )

    result = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")

    assert result["error"] is True and result["status"] == 403
    assert "storage" in result["message"]
    assert "secretsig" not in json.dumps(result) and "X-Goog" not in json.dumps(result)
    assert len(backend.post.call_args_list) == 1


@pytest.mark.anyio
async def test_a_put_transport_error_never_echoes_the_signed_url(backend, ctx):
    backend.put_bytes.side_effect = httpx.ConnectError(f"boom {SIGNED_PUT}")

    result = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")

    assert result["error"] is True and "secretsig" not in json.dumps(result)


@pytest.mark.anyio
async def test_the_result_carries_no_signed_url(backend, ctx):
    raw = json.dumps(await _upload(ctx, content_base64=_b64(PNG), filename="a.png"))

    assert "upload_url" not in raw and "secretsig" not in raw


# -- idempotency -------------------------------------------------------------


@pytest.mark.anyio
async def test_a_retry_of_the_same_upload_returns_the_existing_resource(backend, ctx):
    first = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")
    backend.get.return_value = _created()

    again = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")

    assert len(backend.post.call_args_list) == 2
    backend.put_bytes.assert_awaited_once()
    assert again["id"] == first["id"] and again["content_url"] == CONTENT_PATH
    assert again["already_uploaded"] is True


@pytest.mark.anyio
async def test_different_bytes_or_scope_upload_again(backend, ctx):
    await _upload(ctx, content_base64=_b64(PNG), filename="a.png")
    backend.respond(_created())
    await _upload(ctx, content_base64=_b64(PNG + b"\x01"), filename="a.png")
    backend.respond(_created())
    await _upload(ctx, content_base64=_b64(PNG), filename="a.png", board_id="b1")

    assert backend.put_bytes.await_count == 3


@pytest.mark.anyio
async def test_a_deleted_earlier_upload_is_uploaded_again(backend, ctx):
    await _upload(ctx, content_base64=_b64(PNG), filename="a.png")
    backend.get.side_effect = _http_error(404, {"detail": "Resource not found"}, method="GET")
    backend.respond(_created())

    result = await _upload(ctx, content_base64=_b64(PNG), filename="a.png")

    assert backend.put_bytes.await_count == 2
    assert "already_uploaded" not in result


# -- client: the PUT itself --------------------------------------------------


def _capturing_client(monkeypatch) -> tuple[ValarisClient, list[httpx.Request]]:
    from valaris_mcp import client as client_module

    monkeypatch.setattr(client_module, "API_KEY", "vlr_test_key")
    monkeypatch.setattr(client_module, "IAP_AUDIENCE", "")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"status": "ok"})

    transport = httpx.MockTransport(handler)
    vc = ValarisClient()
    vc._http = httpx.AsyncClient(
        base_url="http://backend", headers=vc._http.headers, transport=transport
    )
    vc._storage_transport = transport
    return vc, seen


@pytest.mark.anyio
async def test_a_signed_storage_url_never_receives_the_api_key(monkeypatch):
    vc, seen = _capturing_client(monkeypatch)

    await vc.put_bytes(SIGNED_PUT, PNG, "image/png")

    (request,) = seen
    assert str(request.url) == SIGNED_PUT
    assert "authorization" not in request.headers
    assert request.headers["content-type"] == "image/png"
    assert request.content == PNG


@pytest.mark.anyio
async def test_a_local_storage_path_goes_through_the_authenticated_api(monkeypatch):
    vc, seen = _capturing_client(monkeypatch)

    await vc.put_bytes(f"/api/local-storage/upload/{GCS_PATH}", PNG, "image/png")

    (request,) = seen
    assert str(request.url) == f"http://backend/api/local-storage/upload/{GCS_PATH}"
    assert request.headers["authorization"] == "Bearer vlr_test_key"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://x/y", "//evil.example/x", "relative/x"]
)
async def test_other_upload_urls_are_refused(monkeypatch, url):
    vc, seen = _capturing_client(monkeypatch)

    with pytest.raises(ValueError):
        await vc.put_bytes(url, PNG, "image/png")
    assert seen == []


# -- surface -----------------------------------------------------------------


def test_upload_resource_is_a_non_destructive_write_in_the_default_hand():
    from valaris_mcp.catalog import TOOL_META
    from valaris_mcp.toolsets import default_hand

    meta = TOOL_META["upload_resource"]
    assert (meta.category, meta.kind, meta.destructive) == ("resources", "write", False)
    assert "upload_resource" in default_hand()


def test_the_description_points_at_the_docs():
    from valaris_mcp.tools.resources import upload_resource

    summary = upload_resource.__doc__.split("\n")[0]
    assert "content_url" in summary and "See docs." in summary


def test_both_changelogs_announce_upload_resource():
    repo = Path(__file__).resolve().parents[2]
    mcp_text = (repo / "mcp-server" / "CHANGELOG.md").read_text()
    start = mcp_text.index("## [0.9.2]")
    assert "upload_resource" in mcp_text[start : mcp_text.index("## [0.9.1]", start)]
    root_text = (repo / "CHANGELOG.md").read_text()
    entry = root_text[root_text.index("## MCP server 0.9.2") :]
    entry = entry[: entry.index("\n## ", 1)]
    assert "upload_resource" in entry


@pytest.mark.anyio
async def test_the_http_client_log_never_carries_the_signature(monkeypatch, caplog):
    # MCP clients persist the server's stderr, where httpx logs every request URL.
    vc, _ = _capturing_client(monkeypatch)

    with caplog.at_level("INFO", logger="httpx"):
        await vc.put_bytes(SIGNED_PUT, PNG, "image/png")

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "storage.googleapis.com" in logged
    assert "secretsig" not in logged
