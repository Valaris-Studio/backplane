# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Which X-Forwarded-For entry is the real client.

Every proxy APPENDS the peer it saw, so an XFF chain is only trustworthy from
the right: the rightmost entry was written by the hop nearest us, and everything
left of the first hop we don't control was written by the caller. The client is
therefore the rightmost entry that is not one of our own proxies — never the
leftmost (that is whatever the caller typed).

A hop *count* can't express this: the same backend is reached directly
(client → GFE, 1 hop) and through the load balancer (client, LB, 2 hops), and
both arrive at a public run.app URL a caller can hit with any header. Listing
the proxies' addresses instead composes across paths — a caller can't originate
from Google's LB address, so peeling it never peels a real client.
"""

import hmac
import ipaddress
from collections.abc import Iterable
from functools import lru_cache

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

EDGE_FORWARDED_FOR_HEADER = "X-Backplane-Edge-Forwarded-For"
EDGE_SECRET_HEADER = "X-Backplane-Edge-Secret"


@lru_cache(maxsize=8)
def parse_trusted_proxies(raw: str) -> tuple[IPNetwork, ...]:
    """Comma-separated IPs/CIDRs. Raises ValueError on a bad entry."""
    return tuple(
        ipaddress.ip_network(entry.strip(), strict=False)
        for entry in raw.split(",")
        if entry.strip()
    )


def nearest_untrusted_hop(
    forwarded_for: str, trusted_proxies: Iterable[IPNetwork]
) -> str | None:
    """The rightmost hop that isn't one of our proxies, or None if unusable.

    A malformed entry ends the walk with None rather than being skipped: the
    hops we read were written by proxies that only write IPs, so garbage there
    means the chain didn't come through the proxies we think it did.
    """
    trusted = tuple(trusted_proxies)
    for entry in reversed(forwarded_for.split(",")):
        try:
            hop = ipaddress.ip_address(entry.strip())
        except ValueError:
            return None
        if not any(hop in network for network in trusted):
            return str(hop)
    return None


def joined_header(headers, name: str) -> str:
    """All values of a repeatable header, in arrival order, as one chain.

    `headers.get` returns only the FIRST line, so a caller who sends their own
    X-Forwarded-For line ahead of the one Google appends would otherwise pick
    the chain we read.
    """
    if hasattr(headers, "getlist"):
        values = headers.getlist(name.lower())
    else:
        values = [
            value for key, value in headers.items() if key.lower() == name.lower()
        ]
    return ",".join(values)


def edge_secret_valid(headers, expected_secret: str) -> bool:
    if not expected_secret:
        return False
    provided = (
        headers.get(EDGE_SECRET_HEADER) or headers.get(EDGE_SECRET_HEADER.lower()) or ""
    )
    return hmac.compare_digest(provided.encode(), expected_secret.encode())


def client_ip_from_headers(headers, peer: str, *, forwarded_for_trusted: bool) -> str:
    """The edge proxy's vouched-for chain first, then X-Forwarded-For when the
    deployment guarantees a hop we control appended to it, else the peer."""
    # Deferred: app.config validates FORWARDED_TRUSTED_PROXIES with this module.
    from app.config import settings

    trusted_proxies = parse_trusted_proxies(settings.FORWARDED_TRUSTED_PROXIES)
    if edge_secret_valid(headers, settings.EDGE_PROXY_SECRET):
        edge_chain = joined_header(headers, EDGE_FORWARDED_FOR_HEADER)
        edge_client = nearest_untrusted_hop(edge_chain, trusted_proxies)
        if edge_client:
            return edge_client
    if not forwarded_for_trusted:
        return peer
    forwarded_for = joined_header(headers, "X-Forwarded-For")
    return nearest_untrusted_hop(forwarded_for, trusted_proxies) or peer
