# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
from urllib.parse import urlsplit

# scp-like syntax git accepts for SSH remotes: [user@]host:path (no scheme).
_SCP_REMOTE = re.compile(r"^(?:[^@/\s]+@)?(?P<host>[^:/\s]+):(?P<path>[^\s]+)$")
# An already-normalized key (`host/owner/repo`); the host must look like one.
_BARE_KEY = re.compile(r"^(?P<host>[^/\s:@]+\.[^/\s:@]+)/(?P<path>\S+)$")


def normalize_repo_url(url: str | None) -> str | None:
    """Reduce a git remote to lowercase `host/owner/repo`, the key repos match on.

    HTTPS, SSH, scp-like and already-normalized spellings of one remote
    collapse to the same key: credentials, port, trailing slash and `.git` are
    dropped and the whole key is lowercased. The companion applies the same
    rule, so both sides must change together. Local paths and file:// URLs
    have no key.
    """
    if not url:
        return None
    url = url.strip()
    if "://" in url:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https", "ssh", "git"} or not parts.hostname:
            return None
        host, path = parts.hostname, parts.path
    elif match := _SCP_REMOTE.match(url) or _BARE_KEY.match(url):
        host, path = match["host"], match["path"]
    else:
        return None
    path = path.strip("/").removesuffix(".git").strip("/")
    if not path or "/" not in path:
        return None
    return f"{host}/{path}".lower()
