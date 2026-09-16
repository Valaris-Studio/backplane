# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.lowlevel.server import NotificationOptions, request_ctx

from valaris_mcp.allowlist import install_hand
from valaris_mcp.catalog import finalize_tool_surface
from valaris_mcp.client import ValarisClient
from valaris_mcp.hand import HandState, load_hand
from valaris_mcp.toolsets import load_toolsets
from valaris_mcp.tracking import ExecutionTracker, normalize_tool_result


def server_version() -> str:
    # The PyPI distribution is `backplane-mcp` (D5 rename, 2026-07-30);
    # `valaris-mcp` covers pre-rename source checkouts still installed under
    # the old dist name.
    for dist in ("backplane-mcp", "valaris-mcp"):
        try:
            return _pkg_version(dist)
        except PackageNotFoundError:
            continue
    # Running from source without an installed dist — not fatal.
    return "unknown"


@dataclass
class AppContext:
    client: ValarisClient
    tracker: ExecutionTracker
    # The session's live hand: the list filter, the call gate, get_server_info
    # and enable_toolsets all read/mutate this one object. Unrestricted by
    # default so contexts built outside the lifespan see every tool.
    hand: HandState = field(default_factory=lambda: HandState(None, None, None))


_TRACKING_INSTALLED = "_valaris_tracking_installed"


def _current_tracker(installed: ExecutionTracker) -> ExecutionTracker:
    # Under streamable-http every session runs its own lifespan against the
    # one shared tool manager; the request context carries that session's
    # AppContext. No request (stdio startup, direct calls) → install-time tracker.
    try:
        lifespan_context = request_ctx.get().lifespan_context
    except LookupError:
        return installed
    return getattr(lifespan_context, "tracker", installed)


def install_tracking(server: Any, tracker: ExecutionTracker) -> None:
    """Wrap the tool manager's call_tool to intercept every tool call.

    Installed at most once per tool manager and resolving the tracker per
    request (same shape as `install_hand`): stacking a closure per session
    would record every call on every session's tracker that ever existed.
    A raised call is recorded with its text and the exception, then re-raised.
    """
    manager = server._tool_manager
    if getattr(manager, _TRACKING_INSTALLED, False):
        return
    setattr(manager, _TRACKING_INSTALLED, True)
    original = manager.call_tool

    async def tracked(name, arguments, **kwargs):
        current = _current_tracker(tracker)
        await current.before_tool_call(name, arguments)
        try:
            result = await original(name, arguments, **kwargs)
        except Exception as exc:
            await current.after_tool_call(name, str(exc), error=exc)
            raise
        result = normalize_tool_result(result)
        await current.after_tool_call(name, result)
        return result

    manager.call_tool = tracked


@asynccontextmanager
async def app_lifespan(server: FastMCP):
    client = ValarisClient()
    tracker = ExecutionTracker(client)
    # Order matters: hand installed first (becomes inner), tracker second
    # (becomes outer). Tracker sees every attempted tool call — including
    # denied ones — so denials are visible in execution rows for forensics.
    # Both install once per tool manager and resolve this session's hand /
    # tracker from the request context on every call, so later sessions
    # re-entering here neither restack nor reorder the wrappers. The order
    # holds because the hand is env-derived and identical for every session:
    # install_hand skips an unrestricted hand without stamping its sentinel,
    # so a per-session hand that turned restricted later would land OUTSIDE
    # the tracker and its denials would go unrecorded.
    # See docs/pipeline-design/05-mcp-allowlist-enforcement.md §3.3.
    hand = load_hand()
    install_hand(server, hand)
    install_tracking(server, tracker)
    try:
        yield AppContext(client=client, tracker=tracker, hand=hand)
    finally:
        await tracker.finalize()
        await client.close()


mcp = FastMCP(
    "Valaris",
    instructions="""\
MCP server for the Backplane platform — an agentic project management \
system for software factory operations.

ENTITY HIERARCHY:
  Workspace → Boards (projects), Notes, Resources, Channels, Members
  Board → Columns → Cards, plus Definitions, Notes, Resources, Git Repos, Activity

ROLES & WORKFLOWS:
  This server supports 4 specialized roles, each with dedicated prompts:

  Project Initializer (prompt: init_project)
    Bootstrap a project from a brief → board, columns, definition, cards, notes, channels.

  Secretary / Manager (prompts: standup, triage, status)
    Analyze board state, generate reports, identify risks, suggest actions.

  Architect / Orchestrator (prompts: plan_work, decompose_card, sprint)
    Decompose objectives into cards, break down large cards, plan sprints.

  Coding Agent (prompts: pickup, implement, ship)
    Claim cards, implement changes, move through the board lifecycle.

    Pickup (Pipeline mode): `next_assignment` is THE
    pickup path — never search+claim manually. The backend scheduler
    applies all role-aware filters (column type, label, participant,
    untyped-column exclusion, role-scoped preconditions like open-PR
    gating) and atomically returns one reserved card plus its bundled
    context (board, column, repo, default branch, stage_action).
    Pickup (Loop mode): the board's configured prompt owns selection,
    dependency checks and search_cards + move_card. There is no atomic reservation;
    do not call next_assignment. completion_query stops the run; it is not
    a selection filter. Apply the prompt's scope to every candidate read.
    Pickup (Interactive agents/humans): claiming = move_card into the
    column resolved by column_type (never by column NAME) +
    add_card_participant (see the pickup prompt). Never call
    `next_assignment` interactively.

GETTING STARTED:
  1. Start any workflow with get_project_context — returns definition, board summary, \
notes, git repos, and recent activity in one call.
  2. Use the appropriate prompt for your role (e.g., invoke the "standup" prompt).
  3. Follow the phased instructions in the prompt (GATHER → ANALYZE → ACT → VERIFY).

COMPOSITE TOOLS (use these to reduce round-trips):
  get_project_context: Full board briefing in one call (definition + summary + notes + repos + activity)
  next_assignment: Backend-owned scheduler — atomically reserve the next eligible card for a role; replaces runner-side search+claim
  search_cards: Text search and filter cards (by priority, type, status, label, assignee, overdue)
  get_board_health: Computed metrics — health score, stale/overdue/unassigned cards, velocity
  bulk_create_cards: Create up to 50 cards in one request (essential for plan_work)
  list_executions: Run history for a workspace (status/runner/role/card filters compose; status="inflight" surfaces zombie rows — verify a row's agent_id before cancel_execution)
  list_approvals: Discover approval requests without an approval_id in hand (status="pending" for approvers), then decide_approval

COMMON WORKFLOWS:
  New project: init_project prompt, or manually: create_board → create_column × N → update_definition → create_card × N
  Daily standup: standup prompt, or: get_board_health → get_workspace_metrics → list_activity → create_note
  Sprint planning: sprint prompt, or: get_project_context → move_card × N into the sprint staging column (the backlog-typed column nearest the active-typed one by position; boards with a single backlog-typed column skip the move and mark sprint membership via due_date + a "sprint" label) → add_card_participant
  Card lifecycle: interactive pickup → implement → ship prompts; pipeline mode uses next_assignment → log_execution_start and configured stages; loop mode follows its configured prompt and backend completion gates

COMPLETION POLICY:
  get_completion_policy resolves board > workspace > legacy whole-object policy.
  get_completion_status reads current exact candidate acceptance and public attempts.
  submit_completion_candidate records this source execution and the real open PR
  or operator-selected evidence. request_landing requests authorized queue landing.
  retry_completion schedules a fresh failed phase. Independent source review and
  exact merged-commit validation are separate gates. A merge alone is not Done.
  Only human workspace admins select policy or evidence-only mode. Review/validation
  claim, lease and result operations belong to the runner control plane, never tools.

SKILLS:
  Skills are versioned procedural knowledge bundles — a SKILL.md plus text \
support files — living in the workspace library. Boards select from that \
library via bindings; a board's EFFECTIVE set is its enabled bindings \
resolved to a published version (pin or latest). list_skills(board_id) \
shows the effective set; list_skill_bindings_raw shows the raw operator rows.
  Interactive agents install skills themselves: list_skills for the board's \
effective set → get_skill for each → write every file verbatim into your \
local skills dir. Pipeline/loop runners skip this — the runner \
pre-materializes the board's effective set into the repo automatically.
  Credential identity controls skill authoring: propose_skill requires a
runner-bound key. A human-key interactive AI receives 403 on that tool;
prepare the bundle for an authorized human workspace admin to create a draft and publish in the workspace
Skills Library. No MCP draft-authoring tool exists. Runner proposals wait for
human approval; no agent session publishes. Loop runners may propose only
on boards with skills_proposal_enabled (see set_board_loop).
  Authoring, editing, and archiving skills are deliberately human/UI-only — \
no MCP tools exist for them; catalog activation (activate_catalog_skill) \
also rejects runner-bound callers.

DISCOVERY & IDENTITY:
  get_server_info: this server's version + full tool surface + which tools are enabled in THIS session (toolsets ∩ allowlist) + backend reachability. Call it when a tool seems "missing" — usually a toolset outside the current hand (widen with enable_toolsets) or version/allowlist drift, not an actual gap. Retired tools stay callable for one minor version as deprecated aliases (deprecated_aliases names them with their replacement); they are outside every toolset and every result they return carries `_deprecated`.
  Toolsets: the initial hand comes from VALARIS_MCP_TOOLSETS (unset = the interactive default hand; a runner launch that sets only VALARIS_MCP_ALLOWLIST gets every toolset — the allowlist is its hand). To use a tool outside the hand, call enable_toolsets(toolset_ids=[...]) — it widens THIS session at runtime and the server requests tools/list_changed, but notification delivery does not prove your client refreshed its catalog. If tools remain absent, apply enable_toolsets.restart_env to the MCP server startup configuration, restart the server/connection and start a new agent session (remote HTTP requires the server operator). The allowlist is a ceiling it never lifts. get_server_info.toolsets shows what is loaded and what else exists.
  whoami: the current user behind this session (id/email/name) — distinct from get_agent_config (the runner's identity).
  list_workspace_members: resolve members by name/email → user_id (get_workspace does NOT return members). Needed before adding card participants.

NEAR-NEIGHBOUR TOOLS (pick by contract, not by name):
  Merge queue: enqueue_pr_for_merge enqueues a card's PR for the first time; enqueue_for_merge only re-queues an EXISTING entry after conflict consolidation (404 without one).
  Board loop: get_board_loop is the complete loop config (prompts, tools, rails, state); get_board_loop_binding_raw is only the raw template binding (template, version, slot values, drift) and 404s not_bound on raw prompts. Edit either via set_board_loop.
  Loop templates (ref = system slug or template UUID): get_loop_template(view=...) is every read — "full" (default), "profile" (identity + track record), "preview" (render prompts for a board without binding), "fit" (board pre-flight; apply_loop_template_fixes closes its fix_ids), "lint" (repo-specific facts); export_loop_template/import_loop_template move a template envelope between workspaces (import is a dry run by default). Creating, editing, publishing, duplicating, archiving, restoring, importing and apply_loop_template_fixes are admin + human keys only (runner keys get 403). The fit, preview and lint views, export and apply_fixes act on the DRAFT half; binding a board reads the PUBLISHED version, so a draft-only requirement means "publish first".
  Runner levers: pause_agent for containment (in-flight card still finishes; cancel_execution ends a stuck one), update_agent(is_active=false) for retirement, restart_agent to relaunch on fresh config, update_agent(hard_delete=true) only to erase a runner that should never have existed. get_agent_budget_status is the per-runner spend view; get_workspace_metrics(view="cost") the workspace-wide one.

KEY CONVENTIONS:
  - All tools require workspace_slug — get it from list_workspaces
  - Cards need column_id — get it from get_board which returns columns with their IDs
  - Columns carry a semantic column_type (backlog, active, review, done, blocked, or null = untyped) — resolve movement/claim targets by column_type, never by display name
  - card_id on card and dependency tools, and note_id on get_note, accept a full UUID or a unique id PREFIX (≥4 chars) resolved within the board/scope; an ambiguous prefix errors listing the candidates.
  - Card dependencies gate next_assignment: a card is eligible only once every prerequisite sits in a done-typed column. get_card_dependency_status answers "is it unblocked?"; run validate_board_dependencies before sprint planning or when a card seems stuck.
  - On rework, clear the stale stage by pipeline_role (remove_card_participant(pipeline_role=...)), not by user_id — in multi-runner deployments the implementer is a different user than the mediator.
  - move_card uses fractional indexing: position is a float between neighbors
  - Notes and Resources have dual scope: pass board_id for board-level, omit for workspace-level
  - Reading notes: get_note(note_id) for one note; add format="markdown" for readable, token-cheap content instead of raw ProseMirror JSON. list_notes(summary_only=True) drops bodies when you only need titles.
  - Writing notes: send bodies as markdown (#–### headings, **bold**, *italic*, `code`, fenced code, -/1. lists, [links](url), > quotes); the backend normalizes markdown, HTML, plain text or ProseMirror JSON into canonical ProseMirror — never hand-encode ProseMirror. update_note has three modes: mode="replace" (default) REPLACES the whole body; mode="append" adds blocks at the end (additive — a retry appends twice); mode="section" + anchor_heading rewrites one heading's section (idempotent). Prefer append/section for logs, trackers and long pinned notes.
  - Definitions are per-board: content is structured JSON (shallow-merged on update)
  - Definition content schema: objectives, tech_stack, constraints, no_gos, acceptance_criteria, timeline, team, references

ENUMS:
  card_type: task, issue, feature, bug
  priority: none, low, medium, high, urgent
  participant_role: hero (responsible), viewer, stakeholder, helper
  member_role: owner, admin, member, viewer
  channel_type: email, slack, whatsapp, phone, website, other
  resource_type: file, folder
  git_provider: github, gitlab, bitbucket, gitea, other
  entity_type (activity): board, column, card, note, resource, definition, channel, git_repo, workspace, member, agent
  action (activity): created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed, dependencies_replaced
  webhook events: activity.<entity>.<action> (e.g. activity.card.moved, activity.note.updated; member events are activity.member.added_member / activity.member.removed_member), approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed. Bare card.*/column.* names are deprecated aliases of activity.card.*/activity.column.*.\
""",
    lifespan=app_lifespan,
)

# FastMCP exposes no version parameter; left None, the low-level Server
# advertises the MCP SDK's own version in the initialize handshake. Stamp
# Backplane's so clients see the actual server release.
mcp._mcp_server.version = server_version()

# FastMCP never advertises `tools.listChanged`, yet enable_toolsets changes the
# listing mid-session and sends the notification; a client that was not told
# the capability may ignore it. Wrap the low-level handshake so the
# capability is declared, leaving any experimental capabilities untouched.
_create_initialization_options = mcp._mcp_server.create_initialization_options


def _advertise_tool_list_changed(notification_options=None, experimental_capabilities=None):
    options = notification_options or NotificationOptions()
    options.tools_changed = True
    return _create_initialization_options(options, experimental_capabilities)


mcp._mcp_server.create_initialization_options = _advertise_tool_list_changed

# Import tool modules to register them with the server
import valaris_mcp.tools.workspaces  # noqa: F401, E402
import valaris_mcp.tools.workspace_config  # noqa: F401, E402
import valaris_mcp.tools.boards  # noqa: F401, E402
import valaris_mcp.tools.loop_templates  # noqa: F401, E402
import valaris_mcp.tools.skills  # noqa: F401, E402
import valaris_mcp.tools.cards  # noqa: F401, E402
import valaris_mcp.tools.card_dependencies  # noqa: F401, E402
import valaris_mcp.tools.columns  # noqa: F401, E402
import valaris_mcp.tools.notes  # noqa: F401, E402
import valaris_mcp.tools.activity  # noqa: F401, E402
import valaris_mcp.tools.definitions  # noqa: F401, E402
import valaris_mcp.tools.resources  # noqa: F401, E402
import valaris_mcp.tools.channels  # noqa: F401, E402
import valaris_mcp.tools.git_repos  # noqa: F401, E402
import valaris_mcp.tools.context  # noqa: F401, E402
import valaris_mcp.tools.search  # noqa: F401, E402
import valaris_mcp.tools.health  # noqa: F401, E402
import valaris_mcp.tools.metrics  # noqa: F401, E402
import valaris_mcp.tools.bulk  # noqa: F401, E402
import valaris_mcp.tools.agents  # noqa: F401, E402
import valaris_mcp.tools.assignments  # noqa: F401, E402
import valaris_mcp.tools.approvals  # noqa: F401, E402
import valaris_mcp.tools.teams  # noqa: F401, E402
import valaris_mcp.tools.prompt_configs  # noqa: F401, E402
import valaris_mcp.tools.webhooks  # noqa: F401, E402
import valaris_mcp.tools.completion  # noqa: F401, E402
import valaris_mcp.tools.merge_queue  # noqa: F401, E402
import valaris_mcp.tools.server_info  # noqa: F401, E402
import valaris_mcp.tools.documentation  # noqa: F401, E402

# Every tool module has registered: apply the catalog (titles, annotations,
# docstring split into per-param descriptions, structured output off).
finalize_tool_surface(mcp)

import valaris_mcp.resources  # noqa: F401, E402
import valaris_mcp.prompts  # noqa: F401, E402


def main():
    # Validate the toolsets env before the transport starts: a bad id must be
    # one readable stderr line, not an anyio traceback out of the lifespan
    # (which keeps raising as the second line of defence).
    try:
        load_toolsets()
    except RuntimeError as exc:
        print(f"backplane-mcp: {exc}", file=sys.stderr)
        sys.exit(2)
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "streamable-http":
        # FastMCP.run() only takes transport/mount_path; the uvicorn bind
        # address is read from mcp.settings, so set it there before running.
        mcp.settings.host = os.environ.get("MCP_HOST", "0.0.0.0")
        mcp.settings.port = int(os.environ.get("MCP_PORT", "8001"))
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
