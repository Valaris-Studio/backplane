# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.core.workspace import enforce_agent_scope
from app.database import async_session
from app.exceptions import ForbiddenError
from app.models.workspace import WorkspaceRole
from app.services.events.connection_manager import connection_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["events"])

# Subscription patterns that expose the observer-grade firehose rather than the
# board-sync slice. `*` is what the observer panel asks for; the three agentic
# namespaces carry runner internals (executions, approvals, agent lifecycle)
# that a workspace member has no view onto elsewhere in the UI.
#
# `card.*`/`column.*`/`activity.*` are deliberately ABSENT: useDomainSync drives
# live kanban updates off them for every member, so gating them would trade a
# cosmetic leak for a broken board.
PRIVILEGED_SUBSCRIPTION_PATTERNS = frozenset(
    {"*", "agent.*", "execution.*", "approval.*"}
)

_ROLE_RANK = {
    WorkspaceRole.owner: 0,
    WorkspaceRole.admin: 1,
    WorkspaceRole.member: 2,
    WorkspaceRole.viewer: 3,
}


def _may_observe(conn) -> bool:
    """Whether this connection may subscribe to observer-grade patterns.

    Agent connections are exempt from the human role hierarchy by design. An
    agent API key resolves to its CREATING USER, whose workspace role is
    incidental — a member-role human routinely owns a runner key — while the
    runner subscribes to `agent.*`/`execution.*`/`approval.*` as its normal
    control channel. Agents are bounded by `enforce_agent_scope` at connect
    time instead, which is the boundary that actually describes them.
    """
    if conn.agent_id is not None:
        return True
    role = getattr(conn, "workspace_role", None)
    if role is None:
        return False
    return _ROLE_RANK.get(role, 99) <= _ROLE_RANK[WorkspaceRole.admin]


def partition_subscriptions(conn, patterns: list[str]) -> tuple[list[str], list[str]]:
    """Split requested patterns into (allowed, denied), preserving order.

    Denial is per-pattern rather than per-frame: the browser client sends every
    registered pattern as one merged `{"subscribe": [...]}` list, so rejecting
    the whole frame because it contains `*` would silently take board sync down
    with the observer.
    """
    if _may_observe(conn):
        return list(patterns), []

    allowed: list[str] = []
    denied: list[str] = []
    for pattern in patterns:
        (denied if pattern in PRIVILEGED_SUBSCRIPTION_PATTERNS else allowed).append(
            pattern
        )
    return allowed, denied


@router.websocket("/ws/workspaces/{slug}/events")
async def workspace_events(websocket: WebSocket, slug: str):
    user, agent_id = await _authenticate_ws(websocket)
    if user is None:
        await websocket.close(code=4001, reason="Authentication failed")
        return

    workspace, workspace_role = await _resolve_workspace(slug, user, agent_id)
    if workspace is None:
        await websocket.close(code=4002, reason="Workspace not found")
        return

    await websocket.accept()
    conn = await connection_manager.connect(
        websocket, workspace.id, user.id, agent_id, workspace_role=workspace_role
    )
    logger.info(
        "WebSocket connected: user=%s workspace=%s agent=%s",
        user.email,
        slug,
        agent_id,
    )

    try:
        await _run_connection(websocket, conn)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket error")
    finally:
        await connection_manager.disconnect(conn)
        logger.info("WebSocket disconnected: user=%s workspace=%s", user.email, slug)


async def _authenticate_ws(websocket: WebSocket):
    """Authenticate WebSocket via query param token or headers."""
    async with async_session() as session:
        # Authorization header takes precedence over the query param — the
        # header never lands in proxy/access logs, unlike `?token=vlr_...`
        # (card 85f993da). The query param stays accepted so existing runners
        # keep working through the deprecation window.
        auth_header = websocket.headers.get(
            "authorization", ""
        ) or websocket.headers.get("Authorization", "")
        token = auth_header.removeprefix("Bearer ") if auth_header else ""
        if not token:
            token = websocket.query_params.get("token", "")

        if token.startswith("vlr_"):
            from app.models.agents.agent import Agent
            from app.services.api_key import ApiKeyService

            try:
                service = ApiKeyService(session)
                api_key = await service.verify_key(token)
                if not api_key:
                    return None, None
                await service.touch(api_key)

                from app.repositories.user import UserRepository

                user = await UserRepository(session).get_by_id(api_key.user_id)
                if not user:
                    return None, None

                # Check for linked agent
                from sqlalchemy import select

                result = await session.execute(
                    select(Agent).where(
                        Agent.api_key_id == api_key.id,
                        Agent.is_active.is_(True),
                    )
                )
                agent = result.scalar_one_or_none()
                agent_id = agent.id if agent else None
                return user, agent_id
            except Exception:
                return None, None

        # Header-based auth (IAP or dev mode)
        from app.core.auth import (
            email_domain_allowed,
            forwarded_for_is_trusted,
            log_auth_rejected,
            normalize_email,
            proxy_secret_valid,
            session_user_id,
        )
        from app.exceptions import ForbiddenError

        client = getattr(websocket, "client", None)
        client_ip = client.host if client else "unknown"
        if forwarded_for_is_trusted(websocket.headers.get):
            forwarded = websocket.headers.get("x-forwarded-for", "")
            client_ip = forwarded.split(",")[0].strip() or client_ip

        # OIDC session cookie — browsers send cookies on the WS handshake, so
        # this needs no query-param token (which would leak into access logs).
        if not settings.is_development:
            from app.repositories.user import UserRepository

            cookies = getattr(websocket, "cookies", {}) or {}
            try:
                uid = session_user_id(cookies.get)
            except ForbiddenError:
                log_auth_rejected(
                    "invalid_session", tier="session", path="ws", client_ip=client_ip
                )
                return None, None
            if uid is not None:
                user = await UserRepository(session).get_by_id(uid)
                if not user:
                    log_auth_rejected(
                        "session_user_not_found",
                        tier="session",
                        path="ws",
                        client_ip=client_ip,
                    )
                    return None, None
                return user, None

        if settings.is_development:
            tier = "dev"
            email = websocket.headers.get("x-user-email", "dev@valaris.dev")
        elif settings.IAP_AUDIENCE:
            tier = "iap"
            try:
                from app.core.auth import (
                    IAP_CERTS_URL,
                    _verify_iap_jwt,
                    extract_iap_jwt,
                )

                iap_jwt = extract_iap_jwt(websocket.headers.get)
                claims = await _verify_iap_jwt(
                    iap_jwt, audience=settings.IAP_AUDIENCE, certs_url=IAP_CERTS_URL
                )
                email = claims.get("email", "")
            except Exception:
                log_auth_rejected(
                    "invalid_iap_jwt", tier=tier, path="ws", client_ip=client_ip
                )
                return None, None
        elif settings.TRUSTED_PROXY_AUTH:
            tier = "trusted_proxy"
            if not proxy_secret_valid(websocket.headers.get):
                log_auth_rejected(
                    "invalid_proxy_secret", tier=tier, path="ws", client_ip=client_ip
                )
                return None, None
            from app.core.auth import extract_email_from_trusted_proxy_header

            email = extract_email_from_trusted_proxy_header(websocket.headers.get)
        else:
            # no verifier configured — never trust a bare header
            log_auth_rejected(
                "no_verifier", tier="none", path="ws", client_ip=client_ip
            )
            return None, None

        if not email:
            log_auth_rejected("no_email", tier=tier, path="ws", client_ip=client_ip)
            return None, None

        # Same canonical form as the HTTP tier (auth.py) — HTTP and WS must
        # agree on identity policy, allowlist included.
        email = normalize_email(email)

        if tier != "dev" and not email_domain_allowed(email):
            domain = email.rsplit("@", 1)[-1]
            log_auth_rejected(
                f"email_domain_not_allowed domain={domain}",
                tier=tier,
                path="ws",
                client_ip=client_ip,
            )
            return None, None

        from app.repositories.user import UserRepository

        repo = UserRepository(session)
        if settings.AUTH_AUTO_PROVISION:
            user = await repo.get_or_create(email)
        else:
            user = await repo.get_by_email(email)
            if not user:
                log_auth_rejected(
                    "user_not_provisioned", tier=tier, path="ws", client_ip=client_ip
                )
                return None, None
        await session.commit()
        return user, None


async def _resolve_workspace(slug: str, user, agent_id=None):
    """Resolve the workspace, verify membership, and hold an agent to its scope.

    Returns `(workspace, role)`. The role rides along because subscription
    authorization needs it on every frame, and re-reading the membership per
    frame would put a database round-trip in the hot path of a chatty socket.

    Returning None for a scoped-out agent rather than raising keeps the caller's
    single close path: this handler authenticates outside the HTTP dependency
    graph, so a ForbiddenError here would surface as an unhandled exception
    rather than a clean close frame.
    """
    async with async_session() as session:
        from app.repositories.workspace import (
            WorkspaceRepository,
            WorkspaceMemberRepository,
        )

        workspace = await WorkspaceRepository(session).get_by_slug(slug)
        if workspace is None:
            return None, None

        member = await WorkspaceMemberRepository(session).get_membership(
            workspace.id, user.id
        )
        if member is None:
            return None, None

        # Membership is the user's; an agent key resolves to its creating user,
        # so without this an agent streams every event of every workspace that
        # user belongs to — card moves, executions, approvals.
        try:
            await enforce_agent_scope(agent_id, slug, session)
        except ForbiddenError:
            # The wire deliberately conflates this with "not found" so the close
            # frame leaks nothing, which leaves a scoped-out runner reconnecting
            # forever and looking identical to a typo'd slug. Say so in the log.
            logger.warning(
                "WS refused: agent %s is not scoped to workspace %s", agent_id, slug
            )
            return None, None

        return workspace, member.role


async def _apply_subscribe_frame(
    websocket: WebSocket, conn, patterns: list[str], manager=None
) -> None:
    """Subscribe the allowed patterns; tell the client about any that were not.

    The allowed set is always applied, even when empty — `update_subscriptions`
    REPLACES the connection's set, so skipping the call on a fully-denied frame
    would leave an earlier subscription silently in place.
    """
    manager = manager or connection_manager
    allowed, denied = partition_subscriptions(conn, patterns)

    await manager.update_subscriptions(conn, allowed)

    if denied:
        logger.warning(
            "WS subscription denied: user=%s workspace=%s patterns=%s",
            conn.user_id,
            conn.workspace_id,
            denied,
        )
        await websocket.send_json(
            {
                "type": "subscription_denied",
                "error_code": "admin_required",
                "patterns": denied,
                "detail": (
                    "Observer-grade event subscriptions require the workspace "
                    "admin or owner role."
                ),
            }
        )


async def _handle_heartbeat_frame(conn, payload: dict) -> None:
    """Route an incoming WS heartbeat frame to AgentService.

    Drops the frame (with a warn) when the WS connection is not bound to
    an agent — the heartbeat channel is agent-only.
    """
    if conn.agent_id is None:
        logger.warning(
            "heartbeat frame on non-agent WS connection user=%s ws=%s",
            conn.user_id,
            conn.workspace_id,
        )
        return

    from app.services.agents.agent import AgentService

    async with async_session() as session:
        try:
            await AgentService(session).handle_ws_heartbeat(
                conn.agent_id, payload, workspace_id=conn.workspace_id
            )
            await session.commit()
        except Exception:
            await session.rollback()
            logger.exception("WS heartbeat handler failed agent=%s", conn.agent_id)


async def _run_connection(websocket: WebSocket, conn):
    """Receive loop with periodic heartbeat pings."""
    heartbeat_interval = settings.WS_HEARTBEAT_INTERVAL

    async def heartbeat():
        while True:
            await asyncio.sleep(heartbeat_interval)
            try:
                await websocket.send_json({"type": "ping"})
            except Exception:
                return

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "pong":
                continue

            if "subscribe" in msg:
                patterns = msg["subscribe"]
                if isinstance(patterns, list):
                    await _apply_subscribe_frame(websocket, conn, patterns)

            if "unsubscribe" in msg:
                to_remove = set(msg.get("unsubscribe", []))
                remaining = [p for p in conn.patterns if p not in to_remove]
                # Already-authorized patterns only shrink here, but route it
                # through the same gate so there is exactly one path to the bus.
                await _apply_subscribe_frame(websocket, conn, remaining)

            if msg.get("type") == "heartbeat":
                await _handle_heartbeat_frame(conn, msg.get("payload") or {})
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
