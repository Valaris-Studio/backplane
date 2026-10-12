# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reuse a signed URL while enough life remains for the browser to use it.

A 302 is cached by the browser for up to 5 minutes, so a URL handed out must
outlive that; reuse stops at 6 minutes left and the next request re-signs.
"""

from app.services.media.signed_url_cache import (
    MIN_REMAINING_SECONDS,
    SIGNED_URL_TTL_SECONDS,
    SignedUrlCache,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_cache_reuses_url_within_window():
    clock = FakeClock()
    cache = SignedUrlCache(clock=clock)
    cache.put("k", "https://signed/1")

    clock.now += SIGNED_URL_TTL_SECONDS - MIN_REMAINING_SECONDS
    assert cache.get("k") == "https://signed/1"


def test_cache_drops_url_near_expiry():
    clock = FakeClock()
    cache = SignedUrlCache(clock=clock)
    cache.put("k", "https://signed/1")

    clock.now += SIGNED_URL_TTL_SECONDS - MIN_REMAINING_SECONDS + 1
    assert cache.get("k") is None


def test_cache_misses_unknown_key():
    assert SignedUrlCache().get("nope") is None


def test_cache_window_outlives_the_redirect_cache():
    assert MIN_REMAINING_SECONDS > 300
    assert SIGNED_URL_TTL_SECONDS == 15 * 60


def test_cache_is_bounded():
    clock = FakeClock()
    cache = SignedUrlCache(clock=clock, max_entries=3)
    for i in range(5):
        cache.put(f"k{i}", f"u{i}")

    assert len(cache) == 3
    assert cache.get("k4") == "u4"
    assert cache.get("k0") is None
