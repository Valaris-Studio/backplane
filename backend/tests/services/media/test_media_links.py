# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure canonicalisation of stored media links (WP2 §2/§3).

Signed GCS URLs expire after minutes, so rich text must store the stable,
authenticated app path instead. The same function runs on every save and in
the one-off rewrite script, so it must never raise, must leave anything it
cannot map untouched (and report it), and must be a fixed point.
"""

import json
import uuid

import pytest

from app.services.media.links import (
    MediaLinkContext,
    STABLE_MEDIA_LINK,
    canonicalize_definition,
    canonicalize_rich_text,
    collect_resource_keys,
    collect_definition_resource_keys,
    media_content_path,
    resource_content_path,
)

BUCKET = "valaris-media"
WS = uuid.UUID("11111111-1111-4111-8111-111111111111")
OTHER_WS = uuid.UUID("22222222-2222-4222-8222-222222222222")
OBJ = uuid.UUID("33333333-3333-4333-8333-333333333333")
RESOURCE_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
RESOURCE_KEY = f"{WS}/{OBJ}/spec sheet.pdf"
SIG = "X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=x&X-Goog-Expires=3600&X-Goog-Signature=abc123"


def ctx(**overrides) -> MediaLinkContext:
    defaults = dict(
        workspace_id=WS,
        workspace_slug="acme",
        bucket=BUCKET,
        resource_ids_by_key={RESOURCE_KEY: RESOURCE_ID},
    )
    defaults.update(overrides)
    return MediaLinkContext(**defaults)


def signed(key: str, bucket: str = BUCKET, host_style: bool = False) -> str:
    from urllib.parse import quote

    if host_style:
        return f"https://{bucket}.storage.googleapis.com/{quote(key)}?{SIG}"
    return f"https://storage.googleapis.com/{bucket}/{quote(key)}?{SIG}"


MEDIA_KEY = f"media/{WS}/{OBJ}/screen shot.png"
STABLE_MEDIA = f"/api/workspaces/acme/media/{OBJ}/screen%20shot.png"
STABLE_RESOURCE = f"/api/workspaces/acme/resources/{RESOURCE_ID}/content"


def doc(*nodes) -> str:
    return json.dumps({"type": "doc", "content": list(nodes)})


def image(src: str) -> dict:
    return {"type": "image", "attrs": {"src": src, "alt": "x"}}


# --- path builders ---------------------------------------------------------


def test_media_content_path_percent_encodes_filename():
    assert media_content_path("acme", OBJ, "a b#?.png") == (
        f"/api/workspaces/acme/media/{OBJ}/a%20b%23%3F.png"
    )


def test_stable_forms_match_the_shared_regex():
    assert STABLE_MEDIA_LINK.match(STABLE_MEDIA)
    assert STABLE_MEDIA_LINK.match(resource_content_path("acme", RESOURCE_ID))
    assert not STABLE_MEDIA_LINK.match("/api/workspaces/acme/notes/x")


# --- PM documents ----------------------------------------------------------


def test_canonicalize_rewrites_path_style_signed_image_url():
    out, report = canonicalize_rich_text(doc(image(signed(MEDIA_KEY))), ctx())

    assert json.loads(out)["content"][0]["attrs"]["src"] == STABLE_MEDIA
    assert report.rewritten == 1
    assert report.unmapped == []


def test_canonicalize_rewrites_host_style_signed_url():
    out, _ = canonicalize_rich_text(doc(image(signed(MEDIA_KEY, host_style=True))), ctx())

    assert json.loads(out)["content"][0]["attrs"]["src"] == STABLE_MEDIA


def test_canonicalize_maps_resource_key_to_content_path():
    attachment = {"type": "fileAttachment", "attrs": {"src": signed(RESOURCE_KEY), "filename": "s.pdf"}}
    out, report = canonicalize_rich_text(doc(attachment), ctx())

    assert json.loads(out)["content"][0]["attrs"]["src"] == STABLE_RESOURCE
    assert report.rewritten == 1


def test_canonicalize_walks_nested_nodes_and_link_marks():
    nested = {
        "type": "bulletList",
        "content": [
            {
                "type": "listItem",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            image(signed(MEDIA_KEY)),
                            {
                                "type": "text",
                                "text": "spec",
                                "marks": [{"type": "link", "attrs": {"href": signed(RESOURCE_KEY)}}],
                            },
                        ],
                    }
                ],
            }
        ],
    }
    out, report = canonicalize_rich_text(doc(nested), ctx())

    paragraph = json.loads(out)["content"][0]["content"][0]["content"][0]
    assert paragraph["content"][0]["attrs"]["src"] == STABLE_MEDIA
    assert paragraph["content"][1]["marks"][0]["attrs"]["href"] == STABLE_RESOURCE
    assert report.rewritten == 2


def test_canonicalize_rewrites_absolute_and_relative_local_storage_urls():
    local_abs = f"http://localhost:5173/api/local-storage/download/{MEDIA_KEY}"
    local_rel = f"/api/local-storage/download/{RESOURCE_KEY}"
    out, report = canonicalize_rich_text(doc(image(local_abs), image(local_rel)), ctx(bucket=""))

    nodes = json.loads(out)["content"]
    assert nodes[0]["attrs"]["src"] == STABLE_MEDIA
    assert nodes[1]["attrs"]["src"] == STABLE_RESOURCE
    assert report.rewritten == 2


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        (signed(MEDIA_KEY, bucket="someone-else"), "foreign_bucket"),
        (signed(f"media/{OTHER_WS}/{OBJ}/x.png"), "cross_workspace"),
        (signed(f"{WS}/55555555-5555-4555-8555-555555555555/orphan.pdf"), "unknown_resource"),
        (signed(f"{OTHER_WS}/{OBJ}/x.pdf"), "cross_workspace"),
        (signed("media/not-a-uuid/x/y.png"), "unrecognised_key"),
    ],
)
def test_canonicalize_leaves_unmappable_storage_urls_and_reports_them(url, reason):
    original = doc(image(url))
    out, report = canonicalize_rich_text(original, ctx())

    assert out == original
    assert report.rewritten == 0
    assert [(u.url, u.reason) for u in report.unmapped] == [(url, reason)]


def test_canonicalize_leaves_non_media_urls_byte_identical():
    original = doc(
        image("https://example.com/cat.png"),
        image(STABLE_MEDIA),
        {"type": "paragraph", "content": [{"type": "text", "text": signed(MEDIA_KEY)}]},
    )
    out, report = canonicalize_rich_text(original, ctx())

    assert out == original
    assert report.rewritten == 0
    assert report.unmapped == []


def test_canonicalize_is_a_fixed_point():
    once, _ = canonicalize_rich_text(doc(image(signed(MEDIA_KEY)), image(signed(RESOURCE_KEY))), ctx())
    twice, report = canonicalize_rich_text(once, ctx())

    assert twice == once
    assert report.rewritten == 0


def test_canonicalize_ignores_gcs_urls_when_no_bucket_is_configured():
    original = doc(image(signed(MEDIA_KEY)))
    out, report = canonicalize_rich_text(original, ctx(bucket=""))

    assert out == original
    assert report.rewritten == 0


# --- non-JSON fallback -----------------------------------------------------


def test_canonicalize_rewrites_markdown_and_html_in_plain_strings():
    raw = f"See ![shot]({signed(MEDIA_KEY)}) and <img src=\"{signed(RESOURCE_KEY)}\"> ok"
    out, report = canonicalize_rich_text(raw, ctx())

    assert out == f"See ![shot]({STABLE_MEDIA}) and <img src=\"{STABLE_RESOURCE}\"> ok"
    assert report.rewritten == 2


@pytest.mark.parametrize(
    "legacy",
    ["", "plain board description", "{not json", '{"type": "paragraph"}', "[1, 2]", "null"],
)
def test_canonicalize_never_raises_on_legacy_text(legacy):
    out, report = canonicalize_rich_text(legacy, ctx())

    assert out == legacy
    assert report.rewritten == 0


# --- definitions -----------------------------------------------------------


def _definition_content() -> dict:
    return {
        "objective": "ship",
        "decisions": [
            {"title": "a", "rationale": "plain text rationale"},
            {"title": "b", "rationale": doc(image(signed(MEDIA_KEY)))},
        ],
        "scope": doc(image(signed(RESOURCE_KEY))),
    }


def test_canonicalize_definition_rewrites_scope_and_nested_rationale():
    scope = doc(image(signed(MEDIA_KEY)))
    new_scope, new_content, report = canonicalize_definition(scope, _definition_content(), ctx())

    assert json.loads(new_scope)["content"][0]["attrs"]["src"] == STABLE_MEDIA
    rationale = json.loads(new_content["decisions"][1]["rationale"])
    assert rationale["content"][0]["attrs"]["src"] == STABLE_MEDIA
    assert json.loads(new_content["scope"])["content"][0]["attrs"]["src"] == STABLE_RESOURCE
    assert report.rewritten == 3


def test_canonicalize_definition_keeps_other_keys_byte_identical():
    content = _definition_content()
    _, new_content, _ = canonicalize_definition(None, content, ctx())

    assert new_content["objective"] == "ship"
    assert new_content["decisions"][0] == {"title": "a", "rationale": "plain text rationale"}
    assert new_content["decisions"][1]["title"] == "b"
    # Input is never mutated — the caller may still hold it.
    assert content == _definition_content()


def test_canonicalize_definition_tolerates_odd_shapes():
    weird = {"decisions": "not a list", "scope": 7}
    scope, content, report = canonicalize_definition("plain", weird, ctx())

    assert (scope, content, report.rewritten) == ("plain", weird, 0)
    assert canonicalize_definition(None, None, ctx())[:2] == (None, None)
    assert canonicalize_definition(None, {"decisions": [None, 3, {"rationale": None}]}, ctx())[2].rewritten == 0


def test_canonicalize_definition_is_idempotent():
    scope, content, _ = canonicalize_definition(doc(image(signed(MEDIA_KEY))), _definition_content(), ctx())
    scope2, content2, report = canonicalize_definition(scope, content, ctx())

    assert (scope2, content2, report.rewritten) == (scope, content, 0)


# --- key collection (feeds the resource lookup) ----------------------------


def test_collect_resource_keys_returns_own_workspace_resource_shaped_keys():
    value = doc(image(signed(RESOURCE_KEY)), image(signed(MEDIA_KEY)), image(signed(f"{OTHER_WS}/{OBJ}/x")))

    assert collect_resource_keys(value, ctx()) == {RESOURCE_KEY}


def test_collect_definition_resource_keys_reads_nested_strings():
    keys = collect_definition_resource_keys(None, _definition_content(), ctx())

    assert keys == {RESOURCE_KEY}


# --- absolute links to our own stable paths (pre-PR-B frontend) -----------
# The old editor stored `window.location.origin + public_url`. Only an origin
# this deployment itself serves is stripped: a foreign host whose path merely
# looks like ours is a different link and must stay exactly as written.

APP_ORIGIN = "https://intern.example.studio"


def test_canonicalize_strips_own_origin_from_stable_media_and_resource_paths():
    resource_path = resource_content_path("acme", RESOURCE_ID)
    original = doc(
        image(APP_ORIGIN + STABLE_MEDIA),
        image("HTTPS://Intern.Example.Studio:443" + resource_path),
    )
    out, report = canonicalize_rich_text(original, ctx(app_origins=frozenset({APP_ORIGIN})))

    assert [n["attrs"]["src"] for n in json.loads(out)["content"]] == [STABLE_MEDIA, resource_path]
    assert report.rewritten == 2


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example" + STABLE_MEDIA,
        "http://intern.example.studio" + STABLE_MEDIA,
        APP_ORIGIN + "/api/workspaces/acme/notes/123",
        APP_ORIGIN + STABLE_MEDIA + "?download=1",
        APP_ORIGIN + STABLE_MEDIA + "#frag",
        APP_ORIGIN + f"/api/workspaces/acme/media/{OBJ}/a/b.png",
        "https://user@intern.example.studio" + STABLE_MEDIA,
    ],
)
def test_canonicalize_leaves_foreign_or_non_stable_absolute_links_alone(url):
    original = doc(image(url))
    out, report = canonicalize_rich_text(original, ctx(app_origins=frozenset({APP_ORIGIN})))

    assert out == original
    assert (report.rewritten, report.unmapped) == (0, [])


def test_canonicalize_absolute_own_origin_needs_configured_origins_and_is_a_fixed_point():
    original = doc(image(APP_ORIGIN + STABLE_MEDIA))

    assert canonicalize_rich_text(original, ctx())[0] == original
    once, _ = canonicalize_rich_text(original, ctx(app_origins=frozenset({APP_ORIGIN})))
    twice, report = canonicalize_rich_text(once, ctx(app_origins=frozenset({APP_ORIGIN})))
    assert (twice, report.rewritten) == (once, 0)


def test_app_origins_from_settings_normalises_configured_urls(monkeypatch):
    from app.config import settings
    from app.services.media.links import app_origins_from_settings

    monkeypatch.setattr(settings, "FRONTEND_URL", "https://Intern.Example.Studio/")
    monkeypatch.setattr(settings, "API_URL", "http://api.example:80")
    monkeypatch.setattr(settings, "CORS_ORIGINS", "http://localhost:5173, ")

    assert app_origins_from_settings() == frozenset(
        {"https://intern.example.studio", "http://api.example", "http://localhost:5173"}
    )
