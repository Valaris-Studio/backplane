# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Which stability promise each REST route makes.

Adopters see one flat Swagger at /api/docs; without this map nothing separates
the MCP-parity CRUD they can build on from runner wire protocol and internal
console contracts that change whenever the platform needs them to. Each
operation is stamped with the `x-surface` vendor extension at schema-generation
time (app/main.py) — no router edits, no change to Swagger tag grouping.

Adding a route means adding it here. tests/test_api_surfaces.py fails on any
route that resolves to no surface, so the promise is always a decision rather
than an accident. Prose half: docs/api-surfaces.md.
"""

from fastapi.routing import APIRoute

SURFACES = frozenset({"public", "internal", "runner"})

_HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})

# Matched most-specific-first: an entry wins over any shorter prefix, so a
# single runner endpoint can be carved out of an otherwise public subtree.
# `None` method means "every method on this prefix".
_RULES: tuple[tuple[str | None, str, str], ...] = (
    # --- runner: the Go runner's wire protocol, versioned with the binary ---
    ("POST", "/api/agents/me/heartbeat", "runner"),
    (None, "/api/agents/me/config", "runner"),
    (None, "/api/agents/me/budget-status", "runner"),
    (None, "/api/agents/me", "runner"),
    ("POST", "/api/agents/{agent_id}/poll", "runner"),
    ("POST", "/api/agents/{agent_id}/executions", "runner"),
    ("PATCH", "/api/agents/{agent_id}/executions/{execution_id}", "runner"),
    ("POST", "/api/agents/{agent_id}/executions/{execution_id}/warnings", "runner"),
    (
        "POST",
        "/api/agents/{agent_id}/executions/{execution_id}/tool-invocations",
        "runner",
    ),
    (None, "/api/workspaces/{slug}/agents/{agent_id}/next-assignment", "runner"),
    (None, "/api/workspaces/{slug}/boards/{board_id}/runner-config", "runner"),
    # Worker-side enqueue: the runner hands a landed branch to the merge queue.
    # Operator-facing reads/cancel on the same prefix stay public (below).
    ("POST", "/api/workspaces/{slug}/merge-queue/enqueue", "runner"),
    ("POST", "/api/workspaces/{slug}/merge-queue/re-enqueue", "runner"),
    # --- internal: console/ops contracts, no compatibility promise ---
    (None, "/api/agents/{agent_id}/rotate-key", "internal"),
    (None, "/api/agents/{agent_id}/export-config", "internal"),
    (None, "/api/auth/oidc", "internal"),
    (None, "/api/oauth/github", "internal"),
    (None, "/api/workspaces/{slug}/oauth/github", "internal"),
    (None, "/api/config/lifecycle-kinds", "internal"),
    (None, "/api/workspaces/{slug}/role-labels", "internal"),
    (None, "/api/workspaces/{slug}/alerts", "internal"),
    (None, "/api/workspaces/{slug}/cost-breaker", "internal"),
    (None, "/api/workspaces/{slug}/improvement", "internal"),
    (None, "/api/workspaces/{slug}/sensors", "internal"),
    (None, "/api/workspaces/{slug}/metrics", "internal"),
    (None, "/api/notifications", "internal"),
    (None, "/api/integrations", "internal"),
    (None, "/api/media", "internal"),
    (None, "/api/local-storage", "internal"),
    (None, "/api/workspaces/{slug}/media", "internal"),
    (None, "/api/workspaces/{slug}/boards/{board_id}/loop", "internal"),
    (None, "/api/workspaces/{slug}/boards/{board_id}/health", "internal"),
    (None, "/api/workspaces/{slug}/config/bundle", "internal"),
    (None, "/api/workspaces/{slug}/members/{user_id}/temporary-password", "internal"),
    (None, "/api/workspaces/{slug}/executions", "internal"),
    # --- public: MCP-parity CRUD, auth basics, health ---
    # Templates were promoted out of `internal` on 2026-08-17 (spec f52328b3):
    # they gained a full MCP twin surface, so adopters can build on them. Loop
    # CONTROL (`PUT /loop`, `PATCH /loop/state`, readiness, history) stays
    # internal — hence this carve-out for the authoring reads that hang off the
    # same `/loop` prefix. `/loop-templates` needs no entry: it falls through to
    # the `/api/workspaces` public catch-all, and the `/loop` rule cannot claim
    # it (prefix matching requires a `/` boundary).
    (None, "/api/workspaces/{slug}/boards/{board_id}/loop/binding", "public"),
    (None, "/api/health", "public"),
    (None, "/api/ready", "public"),
    ("GET", "/api/documentation", "public"),
    (None, "/api/auth", "public"),
    (None, "/api/me", "public"),
    (None, "/api/agents", "public"),
    (None, "/api/workspaces", "public"),
)

# Longest prefix first so carve-outs beat their parent subtree; a
# method-specific rule beats the catch-all at the same path length.
_ORDERED_RULES = tuple(
    sorted(_RULES, key=lambda rule: (-len(rule[1]), rule[0] is None))
)


def surface_for_path(method: str, path: str) -> str | None:
    """Resolve one (method, templated path) to its surface, or None if unmapped."""
    method = method.upper()
    for rule_method, prefix, surface in _ORDERED_RULES:
        if rule_method is not None and rule_method != method:
            continue
        if path == prefix or path.startswith(prefix + "/"):
            return surface
    return None


def classify_route(route: APIRoute) -> str | None:
    """Resolve an APIRoute, requiring all of its methods to agree.

    A route serving several methods that land on different surfaces would make
    `x-surface` ambiguous for the operation group, so it is reported unmapped
    and the completeness test fails rather than picking one arbitrarily.
    """
    methods = (route.methods or set()) & _HTTP_METHODS
    if not methods:
        return None
    surfaces = {surface_for_path(method, route.path) for method in methods}
    if len(surfaces) != 1:
        return None
    return surfaces.pop()
