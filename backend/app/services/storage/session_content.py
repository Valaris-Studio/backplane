# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Where session content bodies live (keys: app/core/session_content_keys.py).

The same store serves both deployments: the bucket when GCS_BUCKET is set,
otherwise LOCAL_STORAGE_DIR on disk, which needs no cloud account. Store
calls are blocking; `stored()` runs them off the event loop. A missing object
raises FileNotFoundError; anything else the backend raises means it could not
be asked."""

import logging
import os
import shutil
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.exceptions import StorageBackendUnavailableError

logger = logging.getLogger(__name__)

READ_PIECE_BYTES = 1 << 20
# Every bucket call is bounded, so a request holds its connection for at
# most this long per call (one 4 MiB chunk, or a compose).
GCS_CALL_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class ContentObject:
    key: str
    size: int
    updated_at: datetime


class ContentStore(Protocol):
    backend: str

    def put(self, key: str, data: bytes) -> None: ...
    def compose(self, sources: list[str], destination: str) -> None: ...
    def stat(self, key: str) -> ContentObject | None: ...
    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes: ...
    def iter_bytes(self, key: str) -> Iterator[bytes]: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> int: ...
    def list_objects(
        self, prefix: str, page_token: str | None = None, limit: int = 1000
    ) -> tuple[list[ContentObject], str | None]: ...
    def list_prefixes(self, prefix: str) -> list[str]: ...


_stores: dict[tuple[str, str], "ContentStore"] = {}


def content_store() -> ContentStore:
    """The configured store, one per process and location, so the bucket
    client and its credentials are reused across requests."""
    location = (
        ("gcs", settings.GCS_BUCKET)
        if settings.GCS_BUCKET
        else ("local", settings.LOCAL_STORAGE_DIR)
    )
    store = _stores.get(location)
    if store is None:
        backend, where = location
        store = GCSContentStore(where) if backend == "gcs" else LocalContentStore(where)
        _stores[location] = store
    return store


def store_for(backend: str) -> ContentStore | None:
    """The configured store if it is the one `backend` names."""
    store = content_store()
    return store if store.backend == backend else None


class LocalContentStore:
    """Bodies as files under LOCAL_STORAGE_DIR. Writes land under a temporary
    name and are renamed into place after fsync, so a reader never sees a
    partial object."""

    backend = "local"

    def __init__(self, base_dir: str):
        self.base = Path(base_dir)

    def _path(self, key: str) -> Path:
        if key.startswith(("/", "\\")) or ".." in key.split("/") or "\x00" in key:
            raise ValueError("Invalid content key")
        base = self.base.resolve()
        # resolve() follows symlinks, so a linked directory cannot lead out.
        path = (base / key).resolve()
        if path != base and not path.is_relative_to(base):
            raise ValueError("Invalid content key")
        return path

    def _key(self, path: Path) -> str:
        return path.relative_to(self.base.resolve()).as_posix()

    def _write(self, path: Path, pieces: Iterator[bytes]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".partial-")
        try:
            with os.fdopen(descriptor, "wb") as handle:
                for piece in pieces:
                    handle.write(piece)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    def put(self, key: str, data: bytes) -> None:
        self._write(self._path(key), iter([data]))

    def compose(self, sources: list[str], destination: str) -> None:
        paths = [self._path(source) for source in sources]
        for path in paths:
            if not path.is_file():
                raise FileNotFoundError(self._key(path))
        self._write(
            self._path(destination),
            (piece for path in paths for piece in self._pieces(path)),
        )

    def stat(self, key: str) -> ContentObject | None:
        path = self._path(key)
        if not path.is_file():
            return None
        info = path.stat()
        return ContentObject(
            key=key,
            size=info.st_size,
            updated_at=datetime.fromtimestamp(info.st_mtime, timezone.utc),
        )

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes:
        with self._path(key).open("rb") as handle:
            handle.seek(offset)
            return handle.read() if length is None else handle.read(length)

    def iter_bytes(self, key: str) -> Iterator[bytes]:
        return self._pieces(self._path(key))

    @staticmethod
    def _pieces(path: Path) -> Iterator[bytes]:
        with path.open("rb") as handle:
            while piece := handle.read(READ_PIECE_BYTES):
                yield piece

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> int:
        doomed = [path for path in self._files_under(prefix)]
        for path in doomed:
            path.unlink(missing_ok=True)
        directory = self._path(prefix) if prefix.endswith("/") else None
        if directory is not None and directory.is_dir():
            shutil.rmtree(directory, ignore_errors=True)
        return len(doomed)

    def _files_under(self, prefix: str) -> list[Path]:
        # The deepest directory the prefix names whole, then a string match.
        top = self._path(prefix.rsplit("/", 1)[0]) if "/" in prefix else self.base
        if not top.is_dir():
            return []
        return sorted(
            (
                path
                for path in top.rglob("*")
                if path.is_file()
                and not path.name.startswith(".partial-")
                and self._key(path).startswith(prefix)
            ),
            key=self._key,
        )

    def list_objects(
        self, prefix: str, page_token: str | None = None, limit: int = 1000
    ) -> tuple[list[ContentObject], str | None]:
        keys = [self._key(path) for path in self._files_under(prefix)]
        if page_token is not None:
            keys = [key for key in keys if key > page_token]
        page = [self.stat(key) for key in keys[:limit]]
        return page, (page[-1].key if len(keys) > limit else None)

    def list_prefixes(self, prefix: str) -> list[str]:
        directory = self._path(prefix)
        if not directory.is_dir():
            return []
        return sorted(
            f"{prefix}{child.name}/" for child in directory.iterdir() if child.is_dir()
        )


class GCSContentStore:
    """Bodies as objects in the configured bucket. Chunks are composed into
    the body server-side (at most 32 sources per compose, which MAX_CHUNKS
    respects). Honors STORAGE_EMULATOR_HOST for emulator runs."""

    backend = "gcs"

    def __init__(self, bucket_name: str, client=None):
        self.bucket_name = bucket_name
        self._client = client

    def _bucket(self):
        if self._client is None:
            from google.cloud import storage

            self._client = storage.Client()
        return self._client.bucket(self.bucket_name)

    @staticmethod
    def _missing(error: Exception, key: str) -> FileNotFoundError:
        return FileNotFoundError(f"{key}: {error}")

    def put(self, key: str, data: bytes) -> None:
        self._bucket().blob(key).upload_from_string(
            data,
            content_type="application/octet-stream",
            timeout=GCS_CALL_TIMEOUT_SECONDS,
        )

    def compose(self, sources: list[str], destination: str) -> None:
        from google.api_core.exceptions import NotFound

        bucket = self._bucket()
        try:
            bucket.blob(destination).compose(
                [bucket.blob(key) for key in sources], timeout=GCS_CALL_TIMEOUT_SECONDS
            )
        except NotFound as error:
            raise self._missing(error, destination) from error

    def stat(self, key: str) -> ContentObject | None:
        blob = self._bucket().get_blob(key, timeout=GCS_CALL_TIMEOUT_SECONDS)
        if blob is None:
            return None
        return ContentObject(key=key, size=blob.size, updated_at=blob.updated)

    def read(self, key: str, offset: int = 0, length: int | None = None) -> bytes:
        from google.api_core.exceptions import NotFound

        if length == 0:
            return b""
        end = None if length is None else offset + length - 1
        try:
            return (
                self._bucket()
                .blob(key)
                .download_as_bytes(
                    start=offset, end=end, timeout=GCS_CALL_TIMEOUT_SECONDS
                )
            )
        except NotFound as error:
            raise self._missing(error, key) from error

    def iter_bytes(self, key: str) -> Iterator[bytes]:
        stored = self.stat(key)
        if stored is None:
            raise FileNotFoundError(key)
        for offset in range(0, stored.size, READ_PIECE_BYTES):
            yield self.read(key, offset, READ_PIECE_BYTES)

    def delete(self, key: str) -> None:
        from google.api_core.exceptions import NotFound

        try:
            self._bucket().blob(key).delete(timeout=GCS_CALL_TIMEOUT_SECONDS)
        except NotFound:
            pass

    def delete_prefix(self, prefix: str) -> int:
        from google.api_core.exceptions import NotFound

        deleted = 0
        blobs = self._bucket().list_blobs(
            prefix=prefix, timeout=GCS_CALL_TIMEOUT_SECONDS
        )
        for blob in list(blobs):
            try:
                blob.delete(timeout=GCS_CALL_TIMEOUT_SECONDS)
            except NotFound:
                continue
            deleted += 1
        return deleted

    def list_objects(
        self, prefix: str, page_token: str | None = None, limit: int = 1000
    ) -> tuple[list[ContentObject], str | None]:
        # The token is the last key returned, as for the local store: a
        # key-ordered resume survives restarts and needs no opaque state.
        # start_offset is inclusive, so the token's own object comes back too.
        blobs = [
            blob
            for blob in self._bucket().list_blobs(
                prefix=prefix,
                start_offset=page_token,
                max_results=limit + (2 if page_token else 1),
                timeout=GCS_CALL_TIMEOUT_SECONDS,
            )
            if page_token is None or blob.name > page_token
        ]
        page = [
            ContentObject(key=blob.name, size=blob.size, updated_at=blob.updated)
            for blob in blobs[:limit]
        ]
        return page, (page[-1].key if len(blobs) > limit else None)

    def list_prefixes(self, prefix: str) -> list[str]:
        iterator = self._bucket().list_blobs(
            prefix=prefix, delimiter="/", timeout=GCS_CALL_TIMEOUT_SECONDS
        )
        for _ in iterator:
            pass
        return sorted(iterator.prefixes)


async def stored(call, *args):
    """A store call off the event loop; a store that cannot be asked is a
    retryable 503, a missing object stays FileNotFoundError."""
    try:
        return await run_in_threadpool(call, *args)
    except (FileNotFoundError, ValueError):
        raise
    except Exception as error:
        logger.warning("session content store unavailable: %s", error)
        raise StorageBackendUnavailableError(
            "Content storage is unavailable; retry later"
        ) from error
