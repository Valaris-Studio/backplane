# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exception hierarchy for git provider integrations.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token path lives in app/services/github_client.py — used by
hot paths (Done-gate, card service) that haven't been migrated yet.
"""

from app.exceptions import ValarisError


class GitProviderError(ValarisError):
    status_code = 502
    detail = "Git provider error"
    error_code = "git_provider_error"


class GitAuthError(GitProviderError):
    status_code = 401
    detail = "Git provider authentication failed"
    error_code = "git_auth_error"


class GitNotFoundError(GitProviderError):
    status_code = 404
    detail = "Git resource not found"
    error_code = "git_not_found"


class GitRateLimitError(GitProviderError):
    status_code = 429
    detail = "Git provider rate limit exceeded"
    error_code = "git_rate_limit"

    def __init__(
        self,
        detail: str | None = None,
        *,
        error_code: str | None = None,
        retry_after: int | None = None,
    ):
        super().__init__(detail, error_code=error_code)
        self.retry_after = retry_after


class GitConflictError(GitProviderError):
    status_code = 409
    detail = "Git provider conflict"
    error_code = "git_conflict"


class GitProviderUnavailable(GitProviderError):
    status_code = 503
    detail = "Git provider unavailable"
    error_code = "git_provider_unavailable"


class IntegrationsConfigError(ValarisError):
    # 503, not 500: the reader is a workspace admin who cannot fix a platform
    # env var — the message must route them to the operator, and a 500 reads
    # as "the app is broken" rather than "this deployment lacks a setting".
    status_code = 503
    detail = "Integrations layer misconfigured"
    error_code = "integrations_config_error"
