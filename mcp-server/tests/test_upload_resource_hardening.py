# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WP5 security review fixes for upload_resource's local-file policy.

The secret-path denylist must hold on case-insensitive filesystems (macOS,
Windows), cover common credential names, refuse hardlinks (a path string
says nothing about what a hardlink points at), and verify the opened file is
the one that was checked. Signed URLs must stay out of every log record.
"""

# ruff: noqa: F811  (the shared fixtures are imported, then requested by name)
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

from tests.test_upload_resource import (  # noqa: F401  (backend, stdio, upload_root are fixtures)
    PNG,
    SIGNED_PUT,
    _b64,
    _upload,
    backend,
    stdio,
    upload_root,
)


def _plant(root, relative: str, content: str = "TOKEN=hunter2"):
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return target


# -- HIGH: case-insensitive filesystems ---------------------------------------


@pytest.mark.anyio
@pytest.mark.parametrize(
    "secret",
    [
        ".AWS/config",
        ".KUBE/config",
        ".config/GCLOUD/credentials.db",
        ".Config/Gh/hosts.yml",
        ".SSH/known_hosts",
        ".GIT/HEAD",
        ".Docker/config.json",
        ".GnuPG/pubring.kbx",
        ".ENV",
        "ID_RSA",
        "Server.PEM",
        "．ssh/config",  # fullwidth dot: NFKC folds it to ".ssh"
        "．env",
    ],
)
async def test_secret_paths_are_refused_whatever_their_case(backend, ctx, upload_root, secret):
    _plant(upload_root, secret)

    result = await _upload(ctx, path=secret, filename="notes.txt")

    assert result["error"] is True and result["error_code"] == "secret_path_refused", result
    backend.post.assert_not_called()


# -- MEDIUM: credential names the first list missed ---------------------------


@pytest.mark.anyio
@pytest.mark.parametrize(
    "secret",
    [
        "credentials.json",
        "service-account-prod.json",
        "service_account.json",
        "prod-sa.json",
        "myServiceAccount.json",
        ".envrc",
        "terraform.tfvars",
        "prod.auto.tfvars",
        "secrets.tfvars.json",
        ".vault-token",
        ".git-credentials",
        ".codex/auth.json",
        ".codex/config.toml",
        ".claude/agent-token.json",
        "kubeconfig",
        "kubeconfig-prod.yaml",
        "cert.pfx",
    ],
)
async def test_common_credential_files_are_refused(backend, ctx, upload_root, secret):
    _plant(upload_root, secret)

    result = await _upload(ctx, path=secret, filename="notes.txt")

    assert result["error"] is True and result["error_code"] == "secret_path_refused", result


@pytest.mark.anyio
@pytest.mark.parametrize(
    "app_data",
    [
        "Library/Application Support/Backplane Helper/device.json",
        ".local/state/backplane-helper/device.json",
        "AppData/Local/Backplane/Helper/device.json",
        "AppData/Roaming/Backplane/token.json",
    ],
)
async def test_backplane_app_data_directories_are_refused(backend, ctx, upload_root, app_data):
    _plant(upload_root, app_data)

    result = await _upload(ctx, path=app_data, filename="notes.txt")

    assert result["error_code"] == "secret_path_refused"


@pytest.mark.anyio
async def test_a_project_folder_named_backplane_still_uploads(backend, ctx, upload_root):
    _plant(upload_root, "docs/backplane/overview.md", "plain\n")

    assert "error" not in await _upload(ctx, path="docs/backplane/overview.md")


@pytest.mark.anyio
@pytest.mark.parametrize(
    "env_name",
    ["BACKPLANE_HELPER_HOME", "BACKPLANE_AGENT_DIR", "VALARIS_TOOL_HOME", "VALARIS_CACHE_DIR"],
)
async def test_a_data_dir_relocated_by_a_platform_env_var_is_refused(
    backend, ctx, upload_root, monkeypatch, env_name
):
    _plant(upload_root, "relocated-data/device.json")
    monkeypatch.setenv(env_name, str(upload_root / "relocated-data"))

    result = await _upload(ctx, path="relocated-data/device.json", filename="notes.txt")

    assert result["error_code"] == "secret_path_refused"
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_a_relocated_data_dir_is_matched_through_symlinks_and_case(
    backend, ctx, upload_root, monkeypatch
):
    _plant(upload_root, "Relocated-Data/device.json")
    (upload_root / "alias").symlink_to(upload_root / "Relocated-Data")
    spelled = (
        "relocated-data" if os.path.exists(upload_root / "relocated-data") else "Relocated-Data"
    )
    monkeypatch.setenv("BACKPLANE_HELPER_HOME", str(upload_root / spelled))

    result = await _upload(ctx, path="alias/device.json", filename="notes.txt")

    assert result["error_code"] == "secret_path_refused"


@pytest.mark.anyio
async def test_upload_roots_and_unrelated_env_vars_do_not_refuse(
    backend, ctx, upload_root, monkeypatch
):
    (upload_root / "a.png").write_bytes(PNG)
    monkeypatch.setenv("VALARIS_MCP_UPLOAD_ROOTS", str(upload_root))
    monkeypatch.setenv("BACKPLANE_EMPTY_DIR", "")
    monkeypatch.setenv("SOMETHING_ELSE_HOME", str(upload_root))
    monkeypatch.setenv("BACKPLANE_HOME_URL", str(upload_root))

    assert "error" not in await _upload(ctx, path="a.png")


@pytest.mark.anyio
@pytest.mark.parametrize(
    "innocent", ["docs/claude-notes.md", "sa.json", "account.json", "envrc.md", "vars.tf"]
)
async def test_ordinary_names_near_the_denylist_still_upload(backend, ctx, upload_root, innocent):
    _plant(upload_root, innocent, "plain text\n")

    result = await _upload(ctx, path=innocent, filename="notes.txt")

    assert "error" not in result, result


@pytest.mark.anyio
async def test_an_upload_root_inside_a_config_dir_is_the_operators_choice(
    backend, ctx, tmp_path, stdio, monkeypatch
):
    # Agent worktrees commonly live under .claude/worktrees/<name>; only the
    # part of the path the model chose (below the root) is matched.
    worktree = tmp_path / ".claude" / "worktrees" / "wt"
    worktree.mkdir(parents=True)
    (worktree / "a.png").write_bytes(PNG)
    monkeypatch.chdir(worktree)

    result = await _upload(ctx, path="a.png")

    assert "error" not in result, result


@pytest.mark.anyio
async def test_a_secret_dir_below_a_config_dir_root_is_still_refused(
    backend, ctx, tmp_path, stdio, monkeypatch
):
    worktree = tmp_path / ".claude" / "worktrees" / "wt"
    _plant(worktree, ".aws/credentials")
    monkeypatch.chdir(worktree)

    result = await _upload(ctx, path=".aws/credentials", filename="notes.txt")

    assert result["error_code"] == "secret_path_refused"


# -- MEDIUM: hardlinks ---------------------------------------------------------


@pytest.mark.anyio
async def test_a_hardlinked_file_is_refused(backend, ctx, upload_root):
    key = _plant(upload_root, ".ssh/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----")
    os.link(key, upload_root / "totally_fine_notes.txt")

    result = await _upload(ctx, path="totally_fine_notes.txt")

    assert result["error"] is True and result["error_code"] == "hardlink_refused"
    assert "hard link" in result["message"]
    assert "BEGIN" not in str(result)
    backend.post.assert_not_called()


# -- LOW: the opened file is the checked file ----------------------------------


@pytest.mark.anyio
async def test_a_file_swapped_between_check_and_open_is_refused(
    backend, ctx, upload_root, monkeypatch
):
    from valaris_mcp import uploads

    (upload_root / "a.png").write_bytes(PNG)
    other = _plant(upload_root, "other.txt", "x")
    monkeypatch.setattr(
        uploads, "_file_identity", lambda path: uploads._file_identity_of(os.lstat(other))
    )

    result = await _upload(ctx, path="a.png")

    assert result["error"] is True and result["error_code"] == "path_changed"
    backend.post.assert_not_called()


@pytest.mark.anyio
async def test_an_open_fd_that_resolves_to_a_secret_is_refused(
    backend, ctx, upload_root, monkeypatch
):
    from valaris_mcp import uploads

    (upload_root / "a.png").write_bytes(PNG)
    monkeypatch.setattr(
        uploads, "_open_file_path", lambda fd: str(upload_root / ".ssh" / "id_rsa")
    )

    result = await _upload(ctx, path="a.png")

    assert result["error_code"] == "secret_path_refused"


@pytest.mark.anyio
async def test_an_open_fd_that_resolves_outside_the_roots_is_refused(
    backend, ctx, upload_root, monkeypatch
):
    from valaris_mcp import uploads

    (upload_root / "a.png").write_bytes(PNG)
    monkeypatch.setattr(
        uploads, "_open_file_path", lambda fd: str(upload_root.parent / "elsewhere.png")
    )

    result = await _upload(ctx, path="a.png")

    assert result["error_code"] == "path_not_allowed"


@pytest.mark.anyio
async def test_the_open_fd_path_check_passes_for_a_normal_file(backend, ctx, upload_root):
    from valaris_mcp import uploads

    (upload_root / "a.png").write_bytes(PNG)
    fd = os.open(upload_root / "a.png", os.O_RDONLY)
    try:
        resolved = uploads._open_file_path(fd)
    finally:
        os.close(fd)
    if resolved is not None:
        assert os.path.samefile(resolved, upload_root / "a.png")
    assert "error" not in await _upload(ctx, path="a.png")


# -- LOW: base64 length before any pass over it --------------------------------


@pytest.mark.anyio
async def test_oversized_base64_is_refused_before_any_regex_pass(backend, ctx, monkeypatch):
    from valaris_mcp import uploads

    class Exploding:
        def sub(self, *args, **kwargs):
            raise AssertionError("whitespace pass ran before the length check")

        def match(self, *args, **kwargs):
            raise AssertionError("data-URL pass ran before the length check")

    monkeypatch.setattr(uploads, "MAX_BASE64_UPLOAD_BYTES", 16)
    monkeypatch.setattr(uploads, "_WHITESPACE_RE", Exploding())
    monkeypatch.setattr(uploads, "_DATA_URL_RE", Exploding())

    result = await _upload(ctx, content_base64=" " * 10_000 + _b64(b"x" * 64), filename="a.txt")

    assert result["error"] is True and "16" in result["message"]


# -- LOW: every log record, not just httpx's -----------------------------------


@pytest.mark.parametrize(
    "logger_name", ["urllib3.connectionpool", "httpcore.http11", "some.other.dependency"]
)
def test_signed_urls_are_redacted_in_any_logger(caplog, logger_name):
    import valaris_mcp.client  # noqa: F401  (installs the redaction)

    with caplog.at_level(logging.DEBUG, logger=logger_name):
        logging.getLogger(logger_name).debug("PUT %s -> %d", SIGNED_PUT, 200)
        logging.getLogger(logger_name).warning(f"retrying {SIGNED_PUT}")

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "storage.googleapis.com" in logged
    assert "secretsig" not in logged


def test_redaction_leaves_a_record_whose_args_do_not_format_to_logging():
    import valaris_mcp.client  # noqa: F401

    factory = logging.getLogRecordFactory()
    record = factory("odd", logging.INFO, __file__, 1, "%d items", ("not-a-number",), None)

    assert getattr(factory, "_redacts_signed_urls", False)
    assert (record.msg, record.args) == ("%d items", ("not-a-number",))


# -- docs: what an agent reads before uploading --------------------------------

PROMPT_INJECTION = {
    "en": "prompt injection",
    "es": "inyección de prompt",
    "pt-BR": "injeção de prompt",
}


def _tool_entry(locale: str) -> str:
    catalog = json.loads(
        (
            Path(__file__).resolve().parents[2] / "backend/app/data/product-documentation.json"
        ).read_text()
    )
    section = next(s for s in catalog["locales"][locale] if s["slug"] == "mcp-tool-catalog")
    markdown = section["markdown"]
    start = markdown.index('<a id="tool-upload_resource"></a>')
    return markdown[start : markdown.index('<a id="tool-', start + 1)]


@pytest.mark.parametrize("locale", ["en", "es", "pt-BR"])
def test_the_reference_says_upload_only_what_the_user_asked_for(locale):
    entry = _tool_entry(locale)

    assert PROMPT_INJECTION[locale] in entry.lower()
    assert "hardlink_refused" in entry
    assert "credentials.json" in entry and ".claude" in entry


def test_the_wire_description_names_the_explicit_request_rule():
    from valaris_mcp.tools.resources import upload_resource

    assert "user asked" in upload_resource.__doc__.split("\n")[0]
