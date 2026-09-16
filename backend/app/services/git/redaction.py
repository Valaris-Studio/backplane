# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Credential redaction for text that reaches a database column or a user.

git and gh echo the full clone URL — embedded PAT included — into stderr on an
auth failure. Every path that persists such text (merge queue `error_message`,
git_connections.last_error) runs it through here first.

Lives in the git package rather than merge_executor so the connection service
can redact without importing a merge service.
"""

import re

# Matches `<scheme>://<userinfo>@<host>` so we can rewrite the userinfo to
# `***` without parsing.
_URL_USERINFO_PATTERN = re.compile(r"(?P<scheme>https?://)(?P<userinfo>[^/@\s]+@)")


def redact_url_credentials(text: str) -> str:
    """Replace `scheme://userinfo@host` with `scheme://***@host` everywhere in
    the given string. Strings without an HTTPS userinfo segment pass through
    unchanged."""
    return _URL_USERINFO_PATTERN.sub(r"\g<scheme>***@", text)
