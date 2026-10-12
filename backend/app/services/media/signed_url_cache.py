# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Process-local cache of signed GET URLs, keyed by object key.

INVARIANT: consult it only inside a route body, after `Depends(get_workspace)`
has authorised the caller. It holds no authorisation of its own, so moving it
into middleware or any path-keyed layer would let a cache hit stand in for a
membership check. Pinned by `test_media_auth_runs_before_signed_url_cache`.
"""

import time
from collections import OrderedDict
from collections.abc import Callable

SIGNED_URL_TTL_SECONDS = 15 * 60
REDIRECT_MAX_AGE_SECONDS = 5 * 60
# A URL handed out may sit in the browser's redirect cache for
# REDIRECT_MAX_AGE_SECONDS, so it must have at least that much life left.
MIN_REMAINING_SECONDS = 6 * 60
DEFAULT_MAX_ENTRIES = 10_000


class SignedUrlCache:
    def __init__(
        self,
        clock: Callable[[], float] = time.monotonic,
        max_entries: int = DEFAULT_MAX_ENTRIES,
    ) -> None:
        self._clock = clock
        self._max_entries = max_entries
        self._entries: OrderedDict[str, tuple[str, float]] = OrderedDict()

    def __len__(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()

    def get(self, key: str) -> str | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        url, expires_at = entry
        if expires_at - self._clock() < MIN_REMAINING_SECONDS:
            del self._entries[key]
            return None
        return url

    def put(self, key: str, url: str) -> None:
        self._entries[key] = (url, self._clock() + SIGNED_URL_TTL_SECONDS)
        self._entries.move_to_end(key)
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)


signed_url_cache = SignedUrlCache()
