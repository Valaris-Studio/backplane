# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Write-time SSRF guard for user-supplied delivery URLs.

Webhook URLs are fetched server-side on every matching event, so an
attacker who registers one against an internal address (cloud metadata,
loopback, RFC-1918) gains a server-side request primitive. Validate at
registration so a bad URL never reaches the emitter.

DNS is resolved once here and every returned address is checked; a
hostname that resolves to a mix of public and private A-records is still
rejected. This does NOT close a rebind-after-write / redirect-to-internal
window at delivery time — see the emitter follow-up note.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

from app.config import settings
from app.exceptions import BadRequestError


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # is_global is False for private/loopback/link-local/reserved/multicast/
    # unspecified — the union we want to reject. IPv4-mapped IPv6 (::ffff:a.b.c.d)
    # is unwrapped first so an embedded private v4 can't slip through.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not ip.is_global


def validate_delivery_url(url: str) -> None:
    """Raise BadRequestError if ``url`` is unsafe to fetch server-side."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()

    allowed_schemes = {"https", "http"} if settings.is_development else {"https"}
    if scheme not in allowed_schemes:
        raise BadRequestError(
            "Webhook URL must use https"
            + (" or http (development only)" if settings.is_development else ""),
            error_code="invalid_webhook_url",
        )

    host = parts.hostname
    if not host:
        raise BadRequestError(
            "Webhook URL must include a host", error_code="invalid_webhook_url"
        )

    try:
        resolved = socket.getaddrinfo(host, parts.port or None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        # A host that doesn't resolve is not an internal SSRF target — there is
        # nothing to reach. Delivery will simply fail later. Don't couple
        # registration to live DNS for the un-resolvable case.
        return

    for _family, _type, _proto, _canon, sockaddr in resolved:
        ip = ipaddress.ip_address(sockaddr[0])
        if _is_blocked_ip(ip):
            raise BadRequestError(
                f"Webhook URL resolves to a disallowed address: {ip}",
                error_code="invalid_webhook_url",
            )
