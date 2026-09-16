# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase A Piece 2 — end-to-end brand-new role proof.

Single contract test the card asks for: prove a workspace can register a
brand-new role end-to-end without any backend code change. If any step
rejects the unknown role, that's the bug — fix the rejection, don't paper
over it (feedback_extensibility_no_limits.md).
"""

import copy

from httpx import AsyncClient

from app.models.workspace import Workspace
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


async def test_brand_new_role_round_trip(
    client: AsyncClient, test_workspace: Workspace
):
    pipeline = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    pipeline["stages"].append(
        {
            "role": "archivist",
            "discover": {"strategy": "column_scan", "column_type": "done"},
            "claim": {"participant_role": "helper"},
            "git": {"action": "none"},
            "llm": {
                "enabled": True,
                "stage": "archive",
                "post_process_kind": "produces_note",
            },
            "on_success": {"add_label": "archived"},
        }
    )

    patch_resp = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={
            "role_labels": {
                "archivist": {"display_name": "Archivist", "color": "#abcdef"}
            },
            "pipeline_config": pipeline,
        },
    )
    assert patch_resp.status_code == 200, patch_resp.text

    labels_resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/role-labels"
    )
    assert labels_resp.status_code == 200, labels_resp.text
    labels = labels_resp.json()
    assert "archivist" in labels
    assert labels["archivist"]["display_name"] == "Archivist"
    assert labels["archivist"]["color"] == "#abcdef"
    assert "orchestrator" in labels  # defaults still merged in

    defaults_resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/prompt-configs/defaults",
        params={"role": "archivist"},
    )
    assert defaults_resp.status_code == 200, defaults_resp.text
    synthesized = defaults_resp.json()
    assert synthesized, "expected synthesized default for archivist/archive"
    assert any(
        d["role"] == "archivist" and d["stage"] == "archive" for d in synthesized
    )

    create_resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/prompt-configs",
        json={
            "name": "Archivist Archive",
            "slug": "archivist-archive",
            "team_role": "archivist",
            "stage": "archive",
            "content": "You are the archivist. Your stage is archive.",
        },
    )
    assert create_resp.status_code in (200, 201), create_resp.text
    body = create_resp.json()
    assert body["team_role"] == "archivist"
    assert body["stage"] == "archive"
