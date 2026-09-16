# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _repos_path(client, slug: str, board_id: str) -> str:
    return f"{client.board(slug, board_id)}/git-repos"


@mcp.tool()
@handle_api_errors
async def list_git_repos(
    workspace_slug: str,
    board_id: str,
    ctx: Context = None,
) -> str:
    """List the git repos linked to a board.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(_repos_path(client, workspace_slug, board_id))
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_git_repo(
    workspace_slug: str,
    board_id: str,
    name: str,
    url: str,
    provider: str,
    default_branch: str = "main",
    description: str = "",
    require_branch_protection: bool = True,
    slug: str | None = None,
    ctx: Context = None,
) -> str:
    """Link a git repo to a board.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        name: Display name.
        url: Repository URL.
        provider: github|gitlab|bitbucket|gitea|other.
        default_branch: Default branch name.
        description: Optional description.
        require_branch_protection: Runner arms branch protection at first clone
            (default True); False for human-owned repos.
        slug: Per-card git_repo_slug selector on multi-repo boards; derived from
            name when omitted.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        "name": name,
        "url": url,
        "provider": provider,
        "default_branch": default_branch,
        "description": description,
        "require_branch_protection": require_branch_protection,
    }
    if slug is not None:
        body["slug"] = slug
    result = await client.post(
        _repos_path(client, workspace_slug, board_id), body
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_git_repo(
    workspace_slug: str,
    board_id: str,
    repo_id: str,
    name: str | None = None,
    url: str | None = None,
    provider: str | None = None,
    default_branch: str | None = None,
    integration_branch: str | None = None,
    description: str | None = None,
    require_branch_protection: bool | None = None,
    slug: str | None = None,
    ctx: Context = None,
) -> str:
    """Update a linked git repo; only passed fields change.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        repo_id: Git repo UUID.
        name: New display name.
        url: New URL.
        provider: New provider.
        default_branch: New default branch.
        integration_branch: Staging branch that git.base_ref="integration_branch"
            stages fork from; empty keeps default_branch.
        description: New description.
        require_branch_protection: Toggle the policy.
        slug: New board-unique slug; changes which cards' git_repo_slug resolve here.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "url": url,
            "provider": provider,
            "default_branch": default_branch,
            "integration_branch": integration_branch,
            "description": description,
            "require_branch_protection": require_branch_protection,
            "slug": slug,
        }.items()
        if v is not None
    }
    path = f"{_repos_path(client, workspace_slug, board_id)}/{repo_id}"
    result = await client.put(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_git_repo(
    workspace_slug: str,
    board_id: str,
    repo_id: str,
    ctx: Context = None,
) -> str:
    """Unlink a git repo from a board.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        repo_id: Git repo UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_repos_path(client, workspace_slug, board_id)}/{repo_id}"
    await client.delete(path)
    return f"Git repo {repo_id} unlinked from board {board_id}."
