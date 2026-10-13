# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The content store contract, run against both implementations: the local
directory every self-hoster gets, and GCS. The GCS leg needs an emulator
(fsouza/fake-gcs-server) named by SESSION_CONTENT_GCS_EMULATOR; it qualifies
the client calls, not a real bucket's IAM or latency."""

import hashlib
import os
import uuid

import pytest

from app.config import settings
from app.services.storage.session_content import (
    GCSContentStore,
    LocalContentStore,
    content_store,
)
from tests.rich_capture import integration_leg_unavailable

PREFIX = "session-content/v1/ws/owner/inst/session/content/"


def _gcs_store(monkeypatch) -> GCSContentStore:
    emulator = os.environ.get("SESSION_CONTENT_GCS_EMULATOR")
    if not emulator:
        integration_leg_unavailable(
            "Requires SESSION_CONTENT_GCS_EMULATOR (fake-gcs-server)"
        )
    from google.cloud import storage

    monkeypatch.setenv("STORAGE_EMULATOR_HOST", emulator)
    bucket = "rc02-" + uuid.uuid4().hex[:12]
    storage.Client().create_bucket(bucket)
    return GCSContentStore(bucket)


@pytest.fixture(params=["local", "gcs"])
def store(request, tmp_path, monkeypatch):
    if request.param == "local":
        return LocalContentStore(str(tmp_path / "storage"))
    return _gcs_store(monkeypatch)


def test_composed_chunks_read_back_whole_and_by_range(store):
    chunks = [os.urandom(1000), os.urandom(1000), b"tail"]
    for index, chunk in enumerate(chunks):
        store.put(f"{PREFIX}staging/{index:02d}", chunk)
    store.compose(
        [f"{PREFIX}staging/{index:02d}" for index in range(3)], f"{PREFIX}body"
    )
    body = b"".join(chunks)
    assert store.read(f"{PREFIX}body") == body
    assert store.read(f"{PREFIX}body", offset=990, length=20) == body[990:1010]
    assert b"".join(store.iter_bytes(f"{PREFIX}body")) == body
    stored = store.stat(f"{PREFIX}body")
    assert stored.size == len(body)
    assert hashlib.sha256(b"".join(store.iter_bytes(stored.key))).hexdigest() == (
        hashlib.sha256(body).hexdigest()
    )
    assert store.stat(f"{PREFIX}missing") is None


def test_rewriting_a_key_replaces_it(store):
    store.put(f"{PREFIX}staging/00", b"first")
    store.put(f"{PREFIX}staging/00", b"second")
    assert store.read(f"{PREFIX}staging/00") == b"second"


def test_deleting_a_prefix_removes_everything_under_it_only(store):
    sibling = "session-content/v1/ws/owner/inst/session/other/body"
    store.put(f"{PREFIX}staging/00", b"a")
    store.put(f"{PREFIX}body", b"ab")
    store.put(sibling, b"kept")
    assert store.delete_prefix(PREFIX) == 2
    assert store.stat(f"{PREFIX}body") is None
    assert store.read(sibling) == b"kept"
    assert store.delete_prefix(PREFIX) == 0


def test_listing_pages_resume_from_their_token(store):
    keys = sorted(f"{PREFIX}{index:03d}" for index in range(5))
    for key in keys:
        store.put(key, b".")
    first, token = store.list_objects("session-content/v1/ws/", limit=3)
    assert [item.key for item in first] == keys[:3]
    assert all(item.updated_at.tzinfo is not None for item in first)
    rest, end = store.list_objects("session-content/v1/ws/", page_token=token, limit=3)
    assert [item.key for item in rest] == keys[3:]
    assert end is None


def test_child_prefixes_name_the_next_key_level(store):
    store.put("session-content/v1/ws-a/o/i/s/c/body", b".")
    store.put("session-content/v1/ws-b/o/i/s/c/body", b".")
    assert store.list_prefixes("session-content/v1/") == [
        "session-content/v1/ws-a/",
        "session-content/v1/ws-b/",
    ]


def test_local_mode_needs_no_cloud_credentials(tmp_path, monkeypatch):
    import google.auth

    def no_credentials(*_args, **_kwargs):
        raise google.auth.exceptions.DefaultCredentialsError("no credentials here")

    monkeypatch.setattr(google.auth, "default", no_credentials)
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.setattr(settings, "GCS_BUCKET", "")
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    store = content_store()
    assert isinstance(store, LocalContentStore)
    store.put(f"{PREFIX}staging/00", b"offline")
    store.compose([f"{PREFIX}staging/00"], f"{PREFIX}body")
    assert store.read(f"{PREFIX}body") == b"offline"


def test_local_keys_never_leave_the_storage_directory(tmp_path):
    base = tmp_path / "storage"
    outside = tmp_path / "outside"
    outside.mkdir()
    (base / "session-content").mkdir(parents=True)
    (base / "session-content" / "linked").symlink_to(outside, target_is_directory=True)
    store = LocalContentStore(str(base))
    for key in [
        "session-content/../../escape",
        "/etc/passwd",
        "session-content/linked/body",
    ]:
        with pytest.raises(ValueError):
            store.put(key, b"x")
    assert list(outside.iterdir()) == []
