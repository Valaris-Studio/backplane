# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the PAR-3c MCP merge-queue tool extensions."""

from __future__ import annotations

import json

import pytest


@pytest.mark.anyio
async def test_enqueue_for_merge_passes_through(mock_client, ctx):
    """Tool POSTs {card_id} to /re-enqueue and surfaces the response + hint."""
    from valaris_mcp.tools.merge_queue import enqueue_for_merge

    mock_client.post.return_value = {
        "id": "e1",
        "card_id": "c1",
        "state": "queued",
    }
    raw = await enqueue_for_merge("default", "c1", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/default/merge-queue/re-enqueue", {"card_id": "c1"}
    )
    body = json.loads(raw)
    assert body["state"] == "queued"
    assert body["card_id"] == "c1"
    assert "_hint" in body


@pytest.mark.anyio
async def test_enqueue_pr_for_merge_posts_initial_enqueue(mock_client, ctx):
    """Card 51810501: the loop-landing path needs a real INITIAL enqueue —
    the older enqueue_for_merge tool only re-queues after consolidation."""
    from valaris_mcp.tools.merge_queue import enqueue_pr_for_merge

    mock_client.post.return_value = {
        "id": "e2",
        "card_id": "c9",
        "state": "queued",
    }
    raw = await enqueue_pr_for_merge(
        "default",
        card_id="c9",
        git_repo_id="r1",
        pr_url="https://github.com/acme/acme/pull/12",
        pr_branch="feat/landing",
        ctx=ctx,
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/default/merge-queue/enqueue",
        {
            "card_id": "c9",
            "repo_id": "r1",
            "pr_url": "https://github.com/acme/acme/pull/12",
            "pr_branch": "feat/landing",
        },
    )
    body = json.loads(raw)
    assert body["state"] == "queued"
    assert "_hint" in body


@pytest.mark.anyio
async def test_enqueue_pr_for_merge_forwards_integration_branch(mock_client, ctx):
    from valaris_mcp.tools.merge_queue import enqueue_pr_for_merge

    mock_client.post.return_value = {"id": "e3", "state": "queued"}
    await enqueue_pr_for_merge(
        "default",
        card_id="c9",
        git_repo_id="r1",
        pr_url="https://github.com/acme/acme/pull/12",
        pr_branch="feat/landing",
        integration_branch="develop",
        ctx=ctx,
    )
    sent = mock_client.post.call_args[0][1]
    assert sent["integration_branch"] == "develop"


@pytest.mark.anyio
async def test_list_merge_queue_omits_the_window_by_default(mock_client, ctx):
    """No window asked for, no query param sent — merged stays excluded."""
    from valaris_mcp.tools.merge_queue import list_merge_queue

    mock_client.get.return_value = []
    await list_merge_queue("default", ctx=ctx)
    mock_client.get.assert_called_once_with("/workspaces/default/merge-queue")


@pytest.mark.anyio
async def test_list_merge_queue_forwards_merged_window(mock_client, ctx):
    """Card 8f37a122: the agent surface can reach recently-merged entries too."""
    from valaris_mcp.tools.merge_queue import list_merge_queue

    mock_client.get.return_value = [{"id": "e1", "state": "merged"}]
    raw = await list_merge_queue("default", merged_within_hours=24, ctx=ctx)
    mock_client.get.assert_called_once_with(
        "/workspaces/default/merge-queue", merged_within_hours=24
    )
    assert json.loads(raw)[0]["state"] == "merged"
