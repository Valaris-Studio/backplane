# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.exceptions import ValarisError
from app.integrations.git.exceptions import (
    GitProviderError,
    GitRateLimitError,
)


def test_git_rate_limit_error_carries_retry_after():
    err = GitRateLimitError("slow down", retry_after=42)

    assert err.retry_after == 42
    assert err.status_code == 429
    assert err.error_code == "git_rate_limit"


def test_git_provider_error_inherits_valaris_error():
    assert issubclass(GitProviderError, ValarisError)
