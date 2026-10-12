# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Turn stored-object URLs in rich text into stable, authenticated app paths.

A signed GCS URL expires minutes after it is minted, so storing one in a note
leaves a broken image. Every save, and the one-off rewrite script, runs these
pure functions so only the stable forms are ever stored:

    /api/workspaces/{slug}/media/{object_id}/{filename}
    /api/workspaces/{slug}/resources/{resource_id}/content

Absolute links to those paths on this deployment's own origin are made
relative too. They never raise: legacy rows hold plain text, markdown or HTML, and a save
must not start failing because of a link it cannot map. Anything unmappable
(a foreign bucket, another workspace's key, an unknown resource) is left
byte-identical and reported.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from urllib.parse import quote, unquote, urlsplit

from app.config import settings
from app.schemas.resources.resource import validate_storage_filename

GCS_HOST = "storage.googleapis.com"
LOCAL_DOWNLOAD_PREFIX = "/api/local-storage/download/"
STABLE_PATH_PREFIX = "/api/workspaces/"

STABLE_MEDIA_LINK = re.compile(
    r"^/api/workspaces/(?P<slug>[^/]+)/"
    r"(?:media/(?P<object_id>[0-9a-fA-F-]{36})/(?P<filename>[^/?#]+)"
    r"|resources/(?P<resource_id>[0-9a-fA-F-]{36})/content)$"
)

# Raw-string fallback: markdown `](url)` and HTML `src="url"` / `href='url'`.
_MARKDOWN_LINK = re.compile(r"(?P<lead>\]\()(?P<url>[^)\s]+)(?P<trail>\))")
_HTML_ATTRIBUTE = re.compile(r"""(?P<lead>\b(?:src|href)=(?P<quote>["']))(?P<url>.*?)(?P<trail>(?P=quote))""")


@dataclass(frozen=True)
class MediaLinkContext:
    workspace_id: uuid.UUID
    workspace_slug: str
    # Empty in local-storage mode: no GCS URL can then be ours.
    bucket: str
    resource_ids_by_key: Mapping[str, uuid.UUID] = field(default_factory=dict)
    # Normalised origins this deployment serves (see app_origins_from_settings).
    app_origins: frozenset[str] = frozenset()


@dataclass(frozen=True)
class UnmappedLink:
    url: str
    reason: str


@dataclass
class LinkRewriteReport:
    rewritten: int = 0
    unmapped: list[UnmappedLink] = field(default_factory=list)

    def merge(self, other: LinkRewriteReport) -> None:
        self.rewritten += other.rewritten
        self.unmapped.extend(other.unmapped)


def media_content_path(workspace_slug: str, object_id: uuid.UUID | str, filename: str) -> str:
    return f"/api/workspaces/{workspace_slug}/media/{object_id}/{quote(filename, safe='')}"


def resource_content_path(workspace_slug: str, resource_id: uuid.UUID | str) -> str:
    return f"/api/workspaces/{workspace_slug}/resources/{resource_id}/content"


_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_origin(url: str) -> str | None:
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname or parts.username or parts.password:
        return None
    if port is None or port == _DEFAULT_PORTS[scheme]:
        return f"{scheme}://{parts.hostname.lower()}"
    return f"{scheme}://{parts.hostname.lower()}:{port}"


def app_origins_from_settings() -> frozenset[str]:
    configured = [settings.FRONTEND_URL, settings.API_URL, *settings.cors_origins_list]
    return frozenset(origin for url in configured if url and (origin := normalize_origin(url)))


def _own_origin_stable_path(url: str, ctx: MediaLinkContext) -> str | None:
    """`https://<our origin>/api/workspaces/…` → the same relative path.

    The pre-PR-B editor stored `window.location.origin + public_url`. Only an
    origin this deployment serves is stripped, never "any host with a
    stable-looking path": rewriting a foreign link would silently retarget it
    from someone else's server to ours. Stripping our own origin is lossless —
    the relative path resolves to the very same route."""
    origin = normalize_origin(url)
    if origin is None or origin not in ctx.app_origins:
        return None
    parts = urlsplit(url)
    if parts.query or parts.fragment or not STABLE_MEDIA_LINK.match(parts.path):
        return None
    return parts.path


def storage_key_from_url(url: str, bucket: str) -> tuple[str | None, str | None]:
    """Return (key, None) for one of our stored-object URLs, (None, reason)
    for a storage URL we cannot claim, and (None, None) for anything else."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None, None
    host = (parts.hostname or "").lower()
    if host == GCS_HOST or host.endswith("." + GCS_HOST):
        if host == GCS_HOST:
            url_bucket, _, raw_key = parts.path.lstrip("/").partition("/")
        else:
            url_bucket, raw_key = host[: -len("." + GCS_HOST)], parts.path.lstrip("/")
        if not bucket or url_bucket != bucket:
            return None, "foreign_bucket"
        return unquote(raw_key), None
    if parts.path.startswith(LOCAL_DOWNLOAD_PREFIX) and (
        not parts.scheme or parts.scheme in ("http", "https")
    ):
        return unquote(parts.path[len(LOCAL_DOWNLOAD_PREFIX) :]), None
    return None, None


def _parse_key(key: str) -> tuple[str, uuid.UUID, uuid.UUID, str] | None:
    """Split a minted key into (kind, workspace_id, object_id, filename)."""
    segments = key.split("/")
    kind = "resource"
    if len(segments) == 4 and segments[0] == "media":
        kind, segments = "media", segments[1:]
    if len(segments) != 3:
        return None
    try:
        workspace_id = uuid.UUID(segments[0])
        object_id = uuid.UUID(segments[1])
        filename = validate_storage_filename(segments[2])
    except ValueError:
        return None
    if filename != segments[2]:
        return None
    return kind, workspace_id, object_id, filename


def _stable_path_for(url: str, ctx: MediaLinkContext) -> tuple[str | None, str | None]:
    own_path = _own_origin_stable_path(url, ctx)
    if own_path is not None:
        return own_path, None
    key, refusal = storage_key_from_url(url, ctx.bucket)
    if key is None:
        return None, refusal
    parsed = _parse_key(key)
    if parsed is None:
        return None, "unrecognised_key"
    kind, workspace_id, object_id, filename = parsed
    if workspace_id != ctx.workspace_id:
        return None, "cross_workspace"
    if kind == "media":
        return media_content_path(ctx.workspace_slug, object_id, filename), None
    resource_id = ctx.resource_ids_by_key.get(key)
    if resource_id is None:
        return None, "unknown_resource"
    return resource_content_path(ctx.workspace_slug, resource_id), None


def _url_rewriter(ctx: MediaLinkContext, report: LinkRewriteReport) -> Callable[[str], str]:
    def rewrite(url: str) -> str:
        stable, refusal = _stable_path_for(url, ctx)
        if stable is not None:
            report.rewritten += 1
            return stable
        if refusal is not None:
            report.unmapped.append(UnmappedLink(url=url, reason=refusal))
        return url

    return rewrite


def _walk_pm_node(node: object, rewrite: Callable[[str], str]) -> None:
    if isinstance(node, list):
        for child in node:
            _walk_pm_node(child, rewrite)
        return
    if not isinstance(node, dict):
        return
    attrs = node.get("attrs")
    if isinstance(attrs, dict):
        for attr in ("src", "href"):
            if isinstance(attrs.get(attr), str):
                attrs[attr] = rewrite(attrs[attr])
    for mark in node.get("marks") or []:
        if isinstance(mark, dict) and isinstance(mark.get("attrs"), dict):
            href = mark["attrs"].get("href")
            if isinstance(href, str):
                mark["attrs"]["href"] = rewrite(href)
    _walk_pm_node(node.get("content"), rewrite)


def _rewrite_raw_string(value: str, rewrite: Callable[[str], str]) -> str:
    def substitute(match: re.Match) -> str:
        return f"{match['lead']}{rewrite(match['url'])}{match['trail']}"

    return _HTML_ATTRIBUTE.sub(substitute, _MARKDOWN_LINK.sub(substitute, value))


def _parse_pm_doc(value: str) -> dict | None:
    if not value.lstrip().startswith("{"):
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) and parsed.get("type") == "doc" else None


def _apply(value: str, rewrite: Callable[[str], str], report: LinkRewriteReport) -> str:
    rewritten_before = report.rewritten
    pm_doc = _parse_pm_doc(value)
    if pm_doc is None:
        return _rewrite_raw_string(value, rewrite)
    _walk_pm_node(pm_doc, rewrite)
    # Re-serialise only on a real change: an untouched row stays byte-identical,
    # which the rewrite script's compare-and-swap relies on.
    return json.dumps(pm_doc) if report.rewritten > rewritten_before else value


def canonicalize_rich_text(value: str, ctx: MediaLinkContext) -> tuple[str, LinkRewriteReport]:
    report = LinkRewriteReport()
    if not isinstance(value, str) or not value:
        return value, report
    return _apply(value, _url_rewriter(ctx, report), report), report


def definition_rich_text_leaves(content: dict) -> list[tuple[dict, str]]:
    """(container, key) pairs whose value is an independently serialised PM
    string: the overflow `scope` key and every `decisions[].rationale`."""
    leaves: list[tuple[dict, str]] = []
    if isinstance(content.get("scope"), str):
        leaves.append((content, "scope"))
    decisions = content.get("decisions")
    if isinstance(decisions, list):
        for decision in decisions:
            if isinstance(decision, dict) and isinstance(decision.get("rationale"), str):
                leaves.append((decision, "rationale"))
    return leaves


def canonicalize_definition(
    scope: str | None, content: dict | None, ctx: MediaLinkContext
) -> tuple[str | None, dict | None, LinkRewriteReport]:
    report = LinkRewriteReport()
    new_scope = scope
    if isinstance(scope, str):
        new_scope, scope_report = canonicalize_rich_text(scope, ctx)
        report.merge(scope_report)
    if not isinstance(content, dict):
        return new_scope, content, report

    new_content = copy.deepcopy(content)
    leaves_changed = False
    for container, key in definition_rich_text_leaves(new_content):
        rewritten, leaf_report = canonicalize_rich_text(container[key], ctx)
        report.merge(leaf_report)
        if rewritten != container[key]:
            container[key] = rewritten
            leaves_changed = True
    return new_scope, (new_content if leaves_changed else content), report


def _resource_key_collector(ctx: MediaLinkContext, keys: set[str]) -> Callable[[str], str]:
    def collect(url: str) -> str:
        key, _ = storage_key_from_url(url, ctx.bucket)
        parsed = _parse_key(key) if key else None
        if parsed and parsed[0] == "resource" and parsed[1] == ctx.workspace_id:
            keys.add(key)
        return url

    return collect


def collect_resource_keys(value: str | None, ctx: MediaLinkContext) -> set[str]:
    """Own-workspace resource keys referenced by `value`; the caller resolves
    them to resource ids before canonicalising."""
    keys: set[str] = set()
    if isinstance(value, str) and value:
        _apply(value, _resource_key_collector(ctx, keys), LinkRewriteReport())
    return keys


def collect_definition_resource_keys(
    scope: str | None, content: dict | None, ctx: MediaLinkContext
) -> set[str]:
    keys = collect_resource_keys(scope, ctx)
    if isinstance(content, dict):
        for container, key in definition_rich_text_leaves(content):
            keys |= collect_resource_keys(container[key], ctx)
    return keys
