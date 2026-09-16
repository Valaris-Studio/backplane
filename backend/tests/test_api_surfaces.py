# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The api_surfaces map is the enforcement point for OSS API stability promises.

A route added without a classification fails `test_every_route_is_classified`
rather than silently inheriting a stability guarantee nobody decided to make.
"""

from pathlib import Path

import pytest
from fastapi.routing import APIRoute

from app.core.api_surfaces import SURFACES, classify_route, surface_for_path
from app.main import create_app


@pytest.fixture(scope="module")
def app():
    return create_app()


@pytest.fixture(scope="module")
def api_routes(app):
    return [
        route
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/api/")
    ]


def test_every_route_is_classified(api_routes):
    unclassified = [
        f"{sorted(route.methods - {'HEAD', 'OPTIONS'})} {route.path}"
        for route in api_routes
        if classify_route(route) is None
    ]
    assert not unclassified, (
        "Routes with no entry in app/core/api_surfaces.py. Add each to the "
        "surface whose stability promise you intend to make (see "
        "docs/api-surfaces.md):\n  " + "\n  ".join(sorted(unclassified))
    )


def test_classification_is_one_of_the_three_surfaces(api_routes):
    for route in api_routes:
        assert classify_route(route) in SURFACES


def test_openapi_stamps_x_surface_on_every_operation(app):
    schema = app.openapi()
    missing = [
        f"{method.upper()} {path}"
        for path, operations in schema["paths"].items()
        for method, operation in operations.items()
        if method in {"get", "post", "put", "patch", "delete"}
        and operation.get("x-surface") not in SURFACES
    ]
    assert not missing, f"operations missing x-surface: {sorted(missing)}"


def test_swagger_tag_grouping_is_unchanged(app):
    """x-surface is a vendor extension: it must not introduce visible tags."""
    schema = app.openapi()
    route_tags = {
        tag
        for route in app.routes
        if isinstance(route, APIRoute)
        for tag in route.tags
    }
    schema_tags = {
        tag
        for operations in schema["paths"].values()
        for operation in operations.values()
        if isinstance(operation, dict)
        for tag in operation.get("tags", [])
    }
    assert schema_tags <= route_tags
    assert not schema_tags & SURFACES


def test_runner_telemetry_is_not_public():
    assert surface_for_path("POST", "/api/agents/me/heartbeat") == "runner"
    assert surface_for_path("GET", "/api/agents/me/config") == "runner"
    assert (
        surface_for_path(
            "GET", "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"
        )
        == "runner"
    )
    assert surface_for_path("POST", "/api/workspaces/{slug}/merge-queue/enqueue") == (
        "runner"
    )


def test_mcp_parity_crud_is_public():
    assert surface_for_path("GET", "/api/workspaces/{slug}/boards") == "public"
    assert (
        surface_for_path(
            "PATCH", "/api/workspaces/{slug}/boards/{board_id}/cards/{card_id}"
        )
        == "public"
    )
    assert surface_for_path("GET", "/api/workspaces/{slug}/notes") == "public"


def test_loop_templates_are_public_but_loop_control_is_not():
    """Templates carry an MCP-parity stability promise; loop control does not.

    The split is the whole point of the promotion: an adopter can build on the
    template CRUD/fit/preview surface, while `PUT /loop` and `PATCH
    /loop/state` stay console contracts that move whenever the console needs.
    """
    assert surface_for_path("GET", "/api/workspaces/{slug}/loop-templates") == "public"
    assert (
        surface_for_path("POST", "/api/workspaces/{slug}/loop-templates/{ref}/publish")
        == "public"
    )
    assert (
        surface_for_path("GET", "/api/workspaces/{slug}/loop-templates/{ref}/export")
        == "public"
    )
    assert (
        surface_for_path(
            "GET",
            "/api/workspaces/{slug}/boards/{board_id}/loop-templates/{ref}/fit",
        )
        == "public"
    )
    assert (
        surface_for_path(
            "GET", "/api/workspaces/{slug}/boards/{board_id}/loop/binding"
        )
        == "public"
    )
    assert (
        surface_for_path(
            "GET", "/api/workspaces/{slug}/boards/{board_id}/loop/binding/diff"
        )
        == "public"
    )
    assert surface_for_path("PUT", "/api/workspaces/{slug}/boards/{board_id}/loop") == (
        "internal"
    )
    assert (
        surface_for_path("PATCH", "/api/workspaces/{slug}/boards/{board_id}/loop/state")
        == "internal"
    )
    assert (
        surface_for_path(
            "GET", "/api/workspaces/{slug}/boards/{board_id}/loop/readiness"
        )
        == "internal"
    )


def test_docs_page_documents_every_surface():
    doc = Path(__file__).resolve().parents[2] / "docs" / "api-surfaces.md"
    assert doc.exists(), "docs/api-surfaces.md is the human-readable half of the map"
    text = doc.read_text()
    for surface in SURFACES:
        assert f"`{surface}`" in text, f"{surface} surface undocumented"
    assert "x-surface" in text


def test_docs_page_places_templates_on_the_public_row():
    """The prose half must not still sell templates as a no-promise contract.

    `_RULES` and the doc are read by different audiences; the table row is the
    only place an adopter learns which promise a subtree makes, so a promotion
    that lands in code alone is the drift this test exists to catch.
    """
    doc = Path(__file__).resolve().parents[2] / "docs" / "api-surfaces.md"
    rows = {
        surface: line
        for line in doc.read_text().splitlines()
        if line.startswith("| `")
        for surface in SURFACES
        if line.startswith(f"| `{surface}`")
    }
    assert "loop template" in rows["public"].lower(), (
        "the public row must name loop templates now that /loop-templates and "
        "/loop/binding are promoted"
    )
    assert "template" not in rows["internal"].lower(), (
        "the internal row still lists templates — it now covers loop CONTROL only"
    )
