# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""URL helpers for the integrations layer.

The merge executor at app/services/merge_executor.py owns the runtime
clone/rebase pipeline and has its own copy of these helpers. We deliberately
duplicate (instead of importing across layers) so integrations/ never depends
on services/. Both copies must stay in sync if the rewrite scheme ever
changes — keep the regex / userinfo format identical.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit


def embed_token_in_https_url(url: str, token: str) -> str:
    """Return `url` with `x-access-token:<token>@` injected as userinfo.

    SSH URLs and empty tokens pass through untouched. If the URL already
    carries credentials, the userinfo segment is replaced rather than
    stacked.
    """
    if not token:
        return url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.hostname is None:
        return url
    netloc = f"x-access-token:{token}@{parts.hostname}"
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


_URL_USERINFO_PATTERN = re.compile(
    r"(?P<scheme>https?://)(?P<userinfo>[^/@\s]+@)"
)


def redact_url_credentials(text: str) -> str:
    """Replace every `scheme://userinfo@host` occurrence with
    `scheme://***@host`. Used to scrub PATs from log lines and
    error-message strings before they surface to operators.
    """
    return _URL_USERINFO_PATTERN.sub(r"\g<scheme>***@", text)
