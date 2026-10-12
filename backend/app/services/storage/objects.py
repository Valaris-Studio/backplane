# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import mimetypes

from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.services.gcs import ObjectStat, get_gcs_service
from app.services.storage.local import existing_local_file


async def stat_stored_object(key: str) -> ObjectStat | None:
    """Type and size of an uploaded object, or None when nothing was uploaded.

    Raises ObjectStoreUnavailableError when the bucket cannot be asked."""
    if settings.GCS_BUCKET:
        # The GCS client is blocking network I/O; keep it off the event loop.
        return await run_in_threadpool(get_gcs_service().stat_object, key)
    path = existing_local_file(key)
    if path is None:
        return None
    content_type, _ = mimetypes.guess_type(path.name)
    return ObjectStat(content_type=content_type, size_bytes=path.stat().st_size)
