# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Who may receive which workspace event, decided per delivered event.

Subscription admission only gives the client early, typed feedback; the
pattern a socket subscribed with is never authorization. Every delivered
event is classified by its actual type, and every delivery re-reads the
principal's current authority (membership/role, linked agent, API key).
"""

import asyncio
import logging
import uuid
import weakref
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app import database
from app.core.events import EXECUTION_CONTEXT_RECEIPT_CREATED
from app.models.workspace import WorkspaceRole
from app.repositories.agents.agent import AgentRepository
from app.repositories.api_key import ApiKeyRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository

logger = logging.getLogger(__name__)

# Close codes shared with the handshake. Their reasons are deliberately the
# same opaque strings, so a close never says which check failed.
CLOSE_CREDENTIAL = 4001
CLOSE_WORKSPACE = 4002
# Overload, never revocation: a timed-out read, slot wait, send or a full
# backlog. Clients reconnect and refetch.
CLOSE_TRY_AGAIN = 1013
CLOSE_REASONS = {
    CLOSE_CREDENTIAL: "Authentication failed",
    CLOSE_WORKSPACE: "Workspace not found",
    CLOSE_TRY_AGAIN: "Try again later",
}

# Runner internals with no member-facing view: executions, approvals and agent
# lifecycle. Board sync (card/column/activity) stays readable by every member.
OBSERVER_NAMESPACES = frozenset({"agent", "execution", "approval"})

# Kept for the admission predicate's historical, exact-match vocabulary.
PRIVILEGED_SUBSCRIPTION_PATTERNS = frozenset({"*", "agent.*", "execution.*", "approval.*"})

_OBSERVER_ROLES = frozenset({WorkspaceRole.owner, WorkspaceRole.admin})
_GLOB_METACHARACTERS = "*?["
_RECEIPT_KEYS = frozenset({"execution_id", "workspace_id", "receipt_id", "ordinal"})

# Authority reads run beside caller-owned request transactions, which already
# hold connections from a deliberately small pool (database.py: 3 + 2). However
# many sockets or publishers are active, WS revalidation holds at most this many.
_AUTHORITY_READ_CONCURRENCY = 1
# Waiting longer than this for a slot closes the socket as retryable overload
# (logged). It stays well under the pool's own 30 s checkout timeout, so a
# starved process sheds sockets instead of stacking up behind the pool.
AUTHORITY_SLOT_TIMEOUT_SECONDS = 10
# Deadline for the authority query itself. The engine has no statement timeout
# of its own, so without this a stalled query would hold the slot indefinitely.
AUTHORITY_READ_TIMEOUT_SECONDS = 3
# How long a caller additionally waits for the read's session to close before
# answering 1013 anyway. The close itself is never abandoned: it keeps the slot
# until it really finishes (see _owned_read).
AUTHORITY_CLEANUP_GRACE_SECONDS = 0.5
# A semaphore binds to the loop that first waits on it; keyed per loop so a
# process that runs more than one loop (tests, reloads) never shares one.
_authority_read_slots: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


# Reads that outlived their caller (a hung session close), per loop, so they
# stay referenced and findable until they actually finish.
_authority_read_owners: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, set[asyncio.Task]]" = (
    weakref.WeakKeyDictionary()
)


# Per loop: the failed session (and its owner) whose close could not be
# confirmed. While present, the sole permit stays held and no authority
# session is admitted; only a process restart clears it.
_authority_quarantine: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict]" = (
    weakref.WeakKeyDictionary()
)


def _read_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _authority_read_slots.get(loop)
    if slots is None:
        slots = _authority_read_slots[loop] = asyncio.Semaphore(_AUTHORITY_READ_CONCURRENCY)
    return slots


def is_observer_event(event_type: str) -> bool:
    # The exact receipt notification is the one execution.* event every
    # current reader may see; its payload is identifiers only.
    if event_type == EXECUTION_CONTEXT_RECEIPT_CREATED:
        return False
    return event_type.split(".", 1)[0] in OBSERVER_NAMESPACES


def pattern_requires_observer(pattern: str) -> bool:
    """Whether a subscription pattern could match an observer event.

    Without a glob metacharacter it is an exact name. With one, only a literal
    `namespace.` prefix bounds what it can match: `*.*`, `?*`, `[e]xecution.*`
    and `execution*` all reach the observer namespaces.
    """
    if pattern == EXECUTION_CONTEXT_RECEIPT_CREATED:
        return False
    first_glob = min(
        (i for i, char in enumerate(pattern) if char in _GLOB_METACHARACTERS),
        default=None,
    )
    if first_glob is None:
        return is_observer_event(pattern)
    literal_prefix = pattern[:first_glob]
    if "." not in literal_prefix:
        return True
    return literal_prefix.split(".", 1)[0] in OBSERVER_NAMESPACES


def may_observe(conn) -> bool:
    """Observer streams for current owner/admin humans and linked agents.

    Agents are exempt from the human role hierarchy by design: an agent key
    resolves to its creating user, whose role is incidental, while the runner
    subscribes to agent.*/execution.*/approval.* as its control channel. Its
    own state, scope and creator membership bound it instead (checked at
    delivery by current_delivery_authority).
    """
    if conn.agent_id is not None:
        return True
    return getattr(conn, "workspace_role", None) in _OBSERVER_ROLES


def partition_subscriptions(conn, patterns: list[str]) -> tuple[list[str], list[str]]:
    """Split requested patterns into (allowed, denied), preserving order.

    Denial is per-pattern rather than per-frame: the browser client sends every
    registered pattern as one merged `{"subscribe": [...]}` list, so rejecting
    the whole frame because it contains `*` would take board sync down with it.
    """
    if may_observe(conn):
        return list(patterns), []
    allowed: list[str] = []
    denied: list[str] = []
    for pattern in patterns:
        (denied if pattern_requires_observer(pattern) else allowed).append(pattern)
    return allowed, denied


def valid_receipt_payload(payload: object, workspace_id: uuid.UUID) -> bool:
    """Exactly the four identifiers, for this workspace, with a positive int ordinal."""
    if not isinstance(payload, dict) or set(payload) != _RECEIPT_KEYS:
        return False
    try:
        identifiers = {
            key: uuid.UUID(payload[key])
            for key in ("execution_id", "workspace_id", "receipt_id")
            if isinstance(payload[key], str)
        }
    except ValueError:
        return False
    ordinal = payload["ordinal"]
    return (
        len(identifiers) == 3
        and identifiers["workspace_id"] == workspace_id
        # bool is an int subclass; True must not pass as ordinal 1.
        and type(ordinal) is int
        and ordinal > 0
    )


@dataclass(frozen=True)
class DeliveryPrincipal:
    """Who a socket authenticated as. The API key is kept by id, never as the
    raw bearer; cookie/IAP/dev principals have no key at all."""

    workspace_id: uuid.UUID
    user_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    api_key_id: uuid.UUID | None = None


@dataclass(frozen=True)
class DeliveryAuthority:
    close_code: int | None = None
    role: WorkspaceRole | None = None
    observer: bool = False


_CREDENTIAL_REVOKED = DeliveryAuthority(close_code=CLOSE_CREDENTIAL)
_TRY_AGAIN = DeliveryAuthority(close_code=CLOSE_TRY_AGAIN)
_WORKSPACE_REVOKED = DeliveryAuthority(close_code=CLOSE_WORKSPACE)


async def current_delivery_authority(
    session: AsyncSession, principal: DeliveryPrincipal
) -> DeliveryAuthority:
    workspace = await WorkspaceRepository(session).get_by_id(principal.workspace_id)
    if workspace is None:
        return _WORKSPACE_REVOKED

    if principal.api_key_id is not None:
        keys = ApiKeyRepository(session)
        key = await keys.get_by_id(principal.api_key_id)
        if key is None or key.user_id != principal.user_id:
            return _CREDENTIAL_REVOKED
        if key.installation_id is not None and await keys.installation_revoked(
            key.installation_id
        ):
            return _CREDENTIAL_REVOKED

    members = WorkspaceMemberRepository(session)
    membership = await members.get_membership(workspace.id, principal.user_id)
    if membership is None:
        return _WORKSPACE_REVOKED

    if principal.agent_id is None:
        return DeliveryAuthority(
            role=membership.role, observer=membership.role in _OBSERVER_ROLES
        )

    agent = await AgentRepository(session).get_by_id(principal.agent_id)
    if (
        agent is None
        or not agent.is_active
        or principal.api_key_id is None
        or agent.api_key_id != principal.api_key_id
    ):
        return _CREDENTIAL_REVOKED
    if agent.allowed_workspaces and workspace.slug not in agent.allowed_workspaces:
        return _WORKSPACE_REVOKED
    if agent.created_by_id != principal.user_id and not await members.get_membership(
        workspace.id, agent.created_by_id
    ):
        return _WORKSPACE_REVOKED
    return DeliveryAuthority(role=membership.role, observer=True)


async def read_delivery_authority(principal: DeliveryPrincipal) -> DeliveryAuthority:
    """Current authority, read under the sole per-process slot.

    The read runs in an owner task that holds the slot until its session has
    REALLY closed (SQLAlchemy closes behind asyncio.shield, so a cancelled
    waiter would otherwise release the slot while the close still runs). This
    caller only waits, bounded: past the query deadline plus a short cleanup
    grace it answers retryable 1013 and leaves the owner, still holding the
    slot, to finish. Other readers then shed 1013 at their slot wait until it
    does. A hung close is logged, never forcibly terminated.

    Overload (slot wait, query deadline, pending close, quarantine) is 1013.
    Any other failure, including a session exit that did not complete cleanly,
    fails closed as an opaque credential close.
    """
    if asyncio.get_running_loop() in _authority_quarantine:
        return _TRY_AGAIN
    slots = _read_slots()
    try:
        async with asyncio.timeout(AUTHORITY_SLOT_TIMEOUT_SECONDS):
            await slots.acquire()
    except TimeoutError:
        logger.warning("WS authority slot wait timed out; closing the socket (retryable)")
        return _TRY_AGAIN
    # No await between acquiring the slot and handing it to the owner: from
    # here only the owner's done-callback releases it, even if the owner is
    # cancelled before it ever runs.
    phase = {"closing": False}
    owner = asyncio.get_running_loop().create_task(_owned_read(principal, phase))
    _adopt(owner, slots)
    try:
        done, _ = await asyncio.wait(
            {owner}, timeout=AUTHORITY_READ_TIMEOUT_SECONDS + AUTHORITY_CLEANUP_GRACE_SECONDS
        )
    except asyncio.CancelledError:
        # The caller went away. Stop a still-running query (the close, once
        # started, is never interrupted) and give the cleanup a short grace.
        if not phase["closing"]:
            owner.cancel()
        await asyncio.wait({owner}, timeout=AUTHORITY_CLEANUP_GRACE_SECONDS)
        raise
    if owner not in done:
        logger.warning(
            "WS authority session close still pending past its deadline; "
            "slot retained until it finishes, socket closed retryably"
        )
        return _TRY_AGAIN
    if owner.cancelled() or owner.exception() is not None:
        return _CREDENTIAL_REVOKED
    return owner.result()


def _adopt(owner: asyncio.Task, slots: asyncio.Semaphore) -> None:
    owners = _authority_read_owners.setdefault(asyncio.get_running_loop(), set())
    owners.add(owner)

    def finished(task: asyncio.Task) -> None:
        owners.discard(task)
        # A quarantined owner's permit is never released: the failed session's
        # connection was not confirmed reclaimed.
        if _authority_quarantine.get(asyncio.get_running_loop(), {}).get("owner") is not task:
            slots.release()
        if not task.cancelled() and task.exception() is not None:
            logger.error("WS authority read owner failed", exc_info=task.exception())

    owner.add_done_callback(finished)


async def _owned_read(principal: DeliveryPrincipal, phase: dict) -> DeliveryAuthority:
    session_scope = database.async_session()
    session = await session_scope.__aenter__()
    ended: BaseException | None = None
    try:
        async with asyncio.timeout(AUTHORITY_READ_TIMEOUT_SECONDS):
            result = await current_delivery_authority(session, principal)
    except TimeoutError as exc:
        logger.warning("WS authority read timed out; closing the socket (retryable)")
        ended, result = exc, _TRY_AGAIN
    except asyncio.CancelledError as exc:
        ended, result = exc, None
    except Exception as exc:
        logger.exception("WS delivery authority read failed; closing the socket")
        ended, result = exc, _CREDENTIAL_REVOKED
    phase["closing"] = True
    exited_cleanly = await _close_owned(session_scope, ended)
    if not exited_cleanly:
        _quarantine(session_scope)
        result = _CREDENTIAL_REVOKED
    if isinstance(ended, asyncio.CancelledError):
        raise ended
    return result


def _quarantine(session_scope) -> None:
    """Keep the permit (and the failed session) held for good on this loop.

    Pinned SQLAlchemy cannot prove the connection behind a failed or cancelled
    close was returned to the pool (after a cancel it may stay held until
    garbage collection), so admitting another authority session could exceed
    the one-live-authority-connection bound. Recovery is a process restart.
    """
    loop = asyncio.get_running_loop()
    if loop in _authority_quarantine:
        return
    _authority_quarantine[loop] = {
        "session": session_scope,
        "owner": asyncio.current_task(),
        "since": loop.time(),
    }
    logger.error(
        "WS authority permit quarantined: an authority session close did not "
        "complete cleanly, so its connection may still be held. WebSocket "
        "authority reads will shed 1013 until process restart."
    )


async def _close_owned(session_scope, ended: BaseException | None) -> bool:
    """Run the session's exit to completion, however often this task is
    cancelled meanwhile; re-raise one cancellation afterwards. True only if
    the exit itself completed without error and without being cancelled."""
    exit_args = (type(ended), ended, ended.__traceback__) if ended else (None, None, None)
    closing = asyncio.ensure_future(session_scope.__aexit__(*exit_args))
    cancelled = False
    while not closing.done():
        try:
            await asyncio.shield(closing)
        except asyncio.CancelledError:
            if closing.done():
                break
            cancelled = True
            logger.warning("WS authority session close still running; keeping the slot until it finishes")
        except Exception:
            break
    exited_cleanly = not closing.cancelled() and closing.exception() is None
    if closing.cancelled():
        logger.warning("WS authority session close was cancelled; its connection may be held until GC")
    elif closing.exception() is not None:
        logger.warning("WS authority session close failed", exc_info=closing.exception())
    if cancelled:
        if not exited_cleanly:
            _quarantine(session_scope)
        raise asyncio.CancelledError
    return exited_cleanly
