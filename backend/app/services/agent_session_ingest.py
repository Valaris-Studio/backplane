# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from pathlib import PurePosixPath, PureWindowsPath

from pydantic import ValidationError as SchemaValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.call_correlation import captured_call_signature
from app.core.harness import harness_enabled
from app.core.local_paths import local_path_of, place_event, place_text
from app.core.time import as_utc
from app.core.working_directory import (
    folder_path,
    without_device_working_directories,
)
from app.exceptions import ValidationError
from app.models.agent_session import NON_ACTIVITY_ACTIONS, AgentSession
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.repositories.agent_session import AgentSessionRepository
from app.repositories.companion import CompanionRepository
from app.schemas.beacon import (
    BeaconEvent,
    PromotedEvent,
    canonical_json,
    promote,
    for_content_level,
    session_title,
)
from app.schemas.companion import (
    MAX_INGEST_EVENT_BYTES,
    HistoryDeleted,
    MAX_INGEST_RECORD_BYTES,
    MAX_INGEST_RECORDS,
    IngestDrop,
    IngestRejection,
    IngestRejectionReason as Reason,
)
from app.schemas.session_content import ContentAck, RichCaptureRecord, RichIngestResult
from app.services.companion import mark_seen
from app.services.rich_capture import effective_capture
from app.services.session_content_ingest import (
    DeclaredContents,
    InstallationQuota,
    SessionContentIngest,
)
from app.services.agent_usage import AgentUsageService
from app.services.session_events import Invalidation, session_updated
from app.services.session_history_cutoff import (
    MAX_CLOCK_SKEW,
    deleted_history_of,
)
from app.services.session_work_link import SessionWorkLinkService

_CAPTURE_ID = re.compile(r"^[0-9a-f]{32}$")
_WINDOWS_ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")
_PATH_SEPARATORS = re.compile(r"[\\/]")
_DRIVE_NAME = re.compile(r"^[A-Za-z]:$")
SESSION_END_ACTION = "session.ended"
PROMPT_ACTION = "prompt.submitted"


class _Rejected(Exception):
    def __init__(self, reason: str):
        self.reason = reason


class _Dropped(Exception):
    """Acknowledged without storing: the owner deleted this part of the
    session's history."""


# Rejections that mean part of a known session's timeline never arrived.
_GAP_REASONS = frozenset({Reason.INVALID, Reason.TOO_LARGE, Reason.CONFLICT})
DROPPED = "dropped"


@dataclass(frozen=True)
class _ValidRecord:
    record: RichCaptureRecord
    raw_events: list[dict]
    promoted: list[PromotedEvent]
    content_hash: str


def validate_batch_shape(body) -> list[dict]:
    """Whole-batch checks. Anything past these is judged per record, so one
    bad record never blocks the rest of an upload."""
    records = body.get("records") if isinstance(body, dict) else None
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_INGEST_RECORDS:
        raise ValidationError(
            f"records must be a list of 1 to {MAX_INGEST_RECORDS} capture records"
        )
    for raw in records:
        if not isinstance(raw, dict) or not _CAPTURE_ID.match(
            str(raw.get("capture_id", ""))
        ):
            raise ValidationError("Every record needs a 32-hex capture_id")
    return records


def _validate_record(raw: dict, now: datetime) -> _ValidRecord:
    encoded = canonical_json(raw)
    if len(encoded.encode()) > MAX_INGEST_RECORD_BYTES:
        raise _Rejected(Reason.TOO_LARGE)
    try:
        # Parsed as rich whatever the switch says: with rich capture off the
        # events are still stored and the contents recorded withheld.
        record = RichCaptureRecord.model_validate(raw)
    except SchemaValidationError:
        raise _Rejected(Reason.INVALID) from None
    latest_allowed = now + MAX_CLOCK_SKEW
    if record.captured_at > latest_allowed:
        raise _Rejected(Reason.INVALID)
    promoted = []
    for event in record.events:
        if len(canonical_json(event).encode()) > MAX_INGEST_EVENT_BYTES:
            raise _Rejected(Reason.TOO_LARGE)
        try:
            parsed = BeaconEvent.model_validate(event)
        except (SchemaValidationError, ValueError):
            raise _Rejected(Reason.INVALID) from None
        if (
            parsed.session is not None
            and parsed.session.id is not None
            and parsed.session.id != record.native_session_id
        ):
            raise _Rejected(Reason.INVALID)
        if parsed.timestamp > latest_allowed:
            raise _Rejected(Reason.INVALID)
        promoted.append(promote(event, parsed, record.collection_method))
    return _ValidRecord(
        record=record,
        raw_events=record.events,
        promoted=promoted,
        content_hash=hashlib.sha256(encoded.encode()).hexdigest(),
    )


def _after_cutoff(valid: _ValidRecord, cutoff: datetime) -> _ValidRecord:
    """The record without what was observed at or before the deleted
    history's cutoff. A record captured by then is dropped whole: it was
    queued before the deletion, whatever its events claim."""
    if as_utc(valid.record.captured_at) <= cutoff:
        raise _Dropped()
    kept = [
        (raw_event, event)
        for raw_event, event in zip(valid.raw_events, valid.promoted)
        if as_utc(event.occurred_at) > cutoff
    ]
    if not kept and not any(
        as_utc(item.occurred_at) > cutoff for item in valid.record.contents
    ):
        raise _Dropped()
    return replace(
        valid,
        raw_events=[raw_event for raw_event, _ in kept],
        promoted=[event for _, event in kept],
    )


def _relative_to(path: str | None, root: str | None) -> str | None:
    """`path` relative to `root` (`.` for the root itself). An absolute path
    (after trimming and decoding file://) outside the root, or with no root to
    anchor it, is dropped: no local path of the device is ever stored."""
    if not path:
        return path
    local = local_path_of(path)
    if local is None:
        return path
    path = local
    if not root:
        return None
    flavor = PureWindowsPath if _WINDOWS_ABSOLUTE.match(root) else PurePosixPath
    try:
        return flavor(path).relative_to(flavor(root)).as_posix()
    except ValueError:
        return None


def _repository(value: str | None, mapping: CompanionProjectMapping) -> str | None:
    """A local checkout path is replaced by the mapping's repository URL."""
    if value and local_path_of(value) is not None:
        return mapping.repo_url_normalized
    return value


def _set_or_drop(container: dict, key: str, value: str | None) -> None:
    if value is None:
        container.pop(key, None)
    else:
        container[key] = value


def _place_event(event: dict, mapping: CompanionProjectMapping) -> dict:
    placed = dict(event)
    session = placed.get("session")
    if isinstance(session, dict) and isinstance(session.get("working_directory"), str):
        placed["session"] = dict(session)
        _set_or_drop(
            placed["session"],
            "working_directory",
            _relative_to(session["working_directory"], mapping.root_path),
        )
    if isinstance(placed.get("repository"), str):
        _set_or_drop(placed, "repository", _repository(placed["repository"], mapping))
    run = placed.get("run")
    if isinstance(run, dict) and isinstance(run.get("repository"), str):
        placed["run"] = dict(run)
        _set_or_drop(
            placed["run"], "repository", _repository(run["repository"], mapping)
        )
    # Every other string and member name, at every content level: file and
    # tool paths, transcript paths, commands, prompts.
    return place_event(placed, _mapping_roots(mapping))


def _mapping_roots(mapping: CompanionProjectMapping) -> list[str]:
    return [mapping.root_path] if mapping.root_path else []


def _placed(valid: _ValidRecord, mapping: CompanionProjectMapping) -> _ValidRecord:
    """The record with every working directory relative to the mapping root and
    every repository a URL, in both the stored events and their summaries."""
    return replace(
        valid,
        raw_events=[_place_event(event, mapping) for event in valid.raw_events],
        promoted=[
            replace(
                event,
                cwd=_relative_to(event.cwd, mapping.root_path),
                repository=_repository(event.repository, mapping),
                prompt_text=place_text(event.prompt_text, _mapping_roots(mapping))
                if event.prompt_text
                else None,
            )
            for event in valid.promoted
        ],
    )


def _folder_name(working_directory: str | None, root: str | None) -> str | None:
    """The last segment of a placed working directory; the root itself (`.`)
    is named after the mapping root. A filesystem or drive root names nothing."""
    if not working_directory:
        return None
    path = root if working_directory == "." else working_directory
    if not path:
        return None
    name = _PATH_SEPARATORS.split(path.rstrip("\\/"))[-1]
    if name in ("", ".", "..") or _DRIVE_NAME.match(name):
        return None
    return name


def _folder_paths(
    valid: _ValidRecord, uploaded: _ValidRecord, mapping: CompanionProjectMapping
) -> _ValidRecord:
    """Above the metadata level a working directory is the bound folder's name
    plus the path inside it, worked out from what was uploaded so a path the
    placement could not recognise (one with a space) never stays absolute.
    Runs after `_admit`, so exclude globs still judge the path inside the root."""
    raw_events = []
    for event, original in zip(valid.raw_events, uploaded.raw_events):
        event = without_device_working_directories(event)
        session = original.get("session")
        if isinstance(session, dict) and isinstance(
            session.get("working_directory"), str
        ):
            event = {**event, "session": dict(event.get("session") or {})}
            _set_or_drop(
                event["session"],
                "working_directory",
                folder_path(session["working_directory"], mapping.root_path),
            )
        raw_events.append(event)
    return replace(
        valid,
        raw_events=raw_events,
        promoted=[
            replace(event, cwd=folder_path(original.cwd, mapping.root_path))
            for event, original in zip(valid.promoted, uploaded.promoted)
        ],
    )


def _folder_name_only(
    valid: _ValidRecord, mapping: CompanionProjectMapping
) -> _ValidRecord:
    """At the metadata level a session keeps only its working folder's name.
    Runs after `_admit`, so exclude globs still judge the relative path an
    older companion sends."""
    raw_events = []
    for event in valid.raw_events:
        session = event.get("session")
        if isinstance(session, dict) and isinstance(
            session.get("working_directory"), str
        ):
            event = {**event, "session": dict(session)}
            _set_or_drop(
                event["session"],
                "working_directory",
                _folder_name(session["working_directory"], mapping.root_path),
            )
        raw_events.append(event)
    return replace(
        valid,
        raw_events=raw_events,
        promoted=[
            replace(event, cwd=_folder_name(event.cwd, mapping.root_path))
            for event in valid.promoted
        ],
    )


def _latest(events: list[PromotedEvent], field: str):
    values = [
        (event.occurred_at, getattr(event, field))
        for event in events
        if getattr(event, field)
    ]
    return max(values, key=lambda pair: pair[0]) if values else None


class AgentSessionIngestService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.sessions = AgentSessionRepository(db)
        self.companion = CompanionRepository(db)
        self.links = SessionWorkLinkService(db)
        self.usage = AgentUsageService(db)
        self.contents = SessionContentIngest(db)

    async def ingest(
        self, installation: CompanionInstallation, raw_records: list[dict]
    ) -> tuple[RichIngestResult, list[Invalidation]]:
        """Store what can be stored; returns the per-record result and the
        invalidations to publish once the transaction has committed."""
        mappings = await self.companion.get_mappings(
            installation.id,
            {
                mapping_id
                for raw in raw_records
                if (mapping_id := _as_uuid(raw.get("mapping_id"))) is not None
            },
        )
        members_of = await self.companion.member_workspace_ids(
            installation.owner_id,
            {mapping.workspace_id for mapping in mappings.values()},
        )
        now = datetime.now(timezone.utc)
        # Rejection reason (or None when acknowledged) per position in the batch.
        outcomes: dict[int, str | None] = {}
        content_acks: dict[int, list[ContentAck]] = {}
        quota = InstallationQuota(stored=installation.content_bytes or 0)
        # (mapping, harness, native session) -> (cutoff, reason)
        deleted_history: dict[tuple[uuid.UUID, str, str], tuple[datetime, str]] = {}
        touched: dict[uuid.UUID, Invalidation] = {}
        valid_records: list[tuple[int, _ValidRecord]] = []
        for position, raw in enumerate(raw_records):
            try:
                valid_records.append((position, _validate_record(raw, now)))
            except _Rejected as rejection:
                outcomes[position] = rejection.reason
        # One lock order for the whole batch, so concurrent multi-record
        # uploads can never wait on each other in a cycle: every call-id lock
        # up front, then session rows in (workspace, harness, session) order.
        await self.links.serialize_call_matching(
            installation.owner_id,
            {
                event.native_tool_call_id
                for _, valid in valid_records
                for event in valid.promoted
                if event.native_tool_call_id
            },
            {valid.record.harness for _, valid in valid_records},
        )
        for position, valid in sorted(
            valid_records,
            key=lambda item: (
                _lock_workspace(mappings.get(item[1].record.mapping_id)),
                item[1].record.harness,
                item[1].record.native_session_id,
                item[0],
            ),
        ):
            try:
                # Savepoint per record: a failure inside one record's writes
                # rolls back only that record.
                async with self.db.begin_nested():
                    session, declared = await self._ingest_record(
                        installation,
                        valid,
                        mappings,
                        members_of,
                        deleted_history,
                        quota,
                    )
            except _Rejected as rejection:
                outcomes[position] = rejection.reason
            except _Dropped:
                outcomes[position] = DROPPED
                content_acks[position] = self.contents.dropped(valid.record)
            else:
                outcomes[position] = None
                content_acks[position] = declared.acks
                # Committed with the record's savepoint, so it counts now.
                quota.reserved += declared.reserved
                if session is not None:
                    touched[(session.id, "events")] = session_updated(session, "events")
                if declared.session is not None and declared.stored:
                    touched[(declared.session.id, "contents")] = session_updated(
                        declared.session, "contents"
                    )
        # Sessions first, then the device row: the lock order every content
        # counter keeps.
        await self.contents.repo.add_installation_bytes(installation.id, quota.reserved)
        acknowledged, rejected, dropped = [], [], []
        for position, raw in enumerate(raw_records):
            reason = outcomes[position]
            if reason in (None, DROPPED):
                acknowledged.append(raw["capture_id"])
                if reason == DROPPED:
                    dropped.append(
                        IngestDrop(
                            capture_id=raw["capture_id"], reason="session_deleted"
                        )
                    )
            else:
                rejected.append(
                    IngestRejection(capture_id=raw["capture_id"], reason=reason)
                )
                if reason in _GAP_REASONS:
                    await self._count_capture_gap(installation, raw, mappings)
        if acknowledged:
            mark_seen(installation, now)
            await self.db.flush()
        return (
            RichIngestResult(
                acknowledged=acknowledged,
                rejected=rejected,
                dropped=dropped,
                contents=[
                    ack
                    for position in range(len(raw_records))
                    for ack in content_acks.get(position, [])
                ],
                history_deleted=[
                    HistoryDeleted(
                        mapping_id=mapping_id,
                        harness=harness,
                        native_session_id=native_session_id,
                        deleted_through=cutoff,
                        reason=reason,
                    )
                    for (mapping_id, harness, native_session_id), (
                        cutoff,
                        reason,
                    ) in deleted_history.items()
                ],
            ),
            list(touched.values()),
        )

    async def _count_capture_gap(self, installation, raw: dict, mappings) -> None:
        mapping = mappings.get(_as_uuid(raw.get("mapping_id")))
        harness, native_session_id = raw.get("harness"), raw.get("native_session_id")
        if (
            mapping is None
            or not isinstance(harness, str)
            or not isinstance(native_session_id, str)
        ):
            return
        async with self.db.begin_nested():
            await self.sessions.count_capture_gap(
                dict(
                    workspace_id=mapping.workspace_id,
                    owner_id=installation.owner_id,
                    installation_id=installation.id,
                    harness=harness,
                    native_session_id=native_session_id,
                )
            )

    async def _ingest_record(
        self,
        installation: CompanionInstallation,
        valid: _ValidRecord,
        mappings: dict[uuid.UUID, CompanionProjectMapping],
        members_of: set[uuid.UUID],
        deleted_history: dict[tuple[uuid.UUID, str, str], tuple[datetime, str]],
        quota: InstallationQuota,
    ) -> tuple[AgentSession | None, DeclaredContents]:
        """Store one record; returns its session when new events were stored,
        and the answers to its content declarations. Notes in
        `deleted_history` the cutoff of a session the owner deleted."""
        record = valid.record
        mapping = mappings.get(record.mapping_id)
        receipt = await self._already_received(installation, valid)
        if receipt is not None:
            return None, await self._replayed_contents(
                installation, record, receipt.session_id, mapping, quota
            )
        cutoff = None
        if mapping is not None:
            identity = dict(
                workspace_id=mapping.workspace_id,
                owner_id=installation.owner_id,
                installation_id=installation.id,
                harness=record.harness,
                native_session_id=record.native_session_id,
            )
            deleted = await self._deleted_history(installation, record)
            if deleted is not None:
                cutoff = deleted[0]
                deleted_history[
                    (mapping.id, record.harness, record.native_session_id)
                ] = deleted
                valid = _after_cutoff(valid, cutoff)
        uploaded = valid
        if mapping is not None:
            valid = _placed(valid, mapping)
        self._admit(installation, record, mapping, members_of, valid.promoted)
        if mapping.content_level == "metadata":
            valid = _folder_name_only(valid, mapping)
        else:
            valid = _folder_paths(valid, uploaded, mapping)
        # Events of a rich mapping are exactly full events.
        level = effective_capture(mapping, installation).effective_content_level

        received_at = datetime.now(timezone.utc)
        occurred = [event.occurred_at for event in valid.promoted] or [
            as_utc(item.occurred_at)
            for item in record.contents
            if cutoff is None or as_utc(item.occurred_at) > cutoff
        ]
        session = await self.sessions.lock_or_create_session(
            identity=identity,
            defaults=dict(
                mapping_id=mapping.id,
                board_id=mapping.board_id,
                started_at=min(occurred),
                last_event_at=max(occurred),
            ),
        )
        # Checked again under the session lock: a delete that committed while
        # this upload waited on the row would otherwise be undone by a fresh
        # insert. Its cutoff includes the device's clock lead, so it reaches
        # past anything captured by now. Raising rolls the record's savepoint
        # back, new row included.
        deleted_now = await self._deleted_history(installation, record)
        if (deleted_now[0] if deleted_now else None) != cutoff:
            raise _Dropped()
        if not await self.sessions.insert_capture_receipt(
            installation_id=installation.id,
            capture_id=record.capture_id,
            session_id=session.id,
            content_hash=valid.content_hash,
            collection_method=record.collection_method,
            beacon_commit=record.beacon.commit,
            beacon_schema_version=record.beacon.schema_version,
            event_count=len(valid.promoted),
            # UTC, so correlation can bound it in SQL on every dialect.
            captured_at=record.captured_at.astimezone(timezone.utc),
            received_at=received_at,
            content_level=level,
        ):
            # A concurrent upload of the same capture committed first; it
            # stored these events, so an identical retry is simply received.
            if await self._already_received(installation, valid):
                return None, await self._replayed_contents(
                    installation, record, session.id, mapping, quota
                )
            raise _Rejected(Reason.CONFLICT)

        await self._resolve_parentage(session, record)
        declared = await self.contents.declare(
            installation=installation,
            mapping=mapping,
            session=session,
            record=record,
            cutoff=cutoff,
            quota=quota,
        )
        declared.session = session
        call_ids = {
            event.native_tool_call_id
            for event in valid.promoted
            if event.native_tool_call_id
        }
        known_calls = await self.sessions.known_tool_calls(session.id, call_ids)
        rows, promoted_by_id, raw_by_id, signature_by_id = [], {}, {}, {}
        for raw_event, event in zip(valid.raw_events, valid.promoted):
            if event.event_id in promoted_by_id:
                continue
            promoted_by_id[event.event_id] = event
            raw_by_id[event.event_id] = raw_event
            # From the uploaded event, before the content level drops `raw`.
            signature = (
                captured_call_signature(session.harness, raw_event)
                if event.native_tool_call_id
                else None
            )
            signature_by_id[event.event_id] = signature
            rows.append(
                {
                    "id": uuid.uuid4(),
                    "session_id": session.id,
                    "event_id": event.event_id,
                    "capture_id": record.capture_id,
                    "occurred_at": event.occurred_at,
                    "received_at": received_at,
                    "action": event.action,
                    "kind": event.kind,
                    "category": event.category,
                    "fidelity": event.fidelity,
                    "collection_method": event.collection_method,
                    "tool_name": event.tool_name,
                    "native_tool_call_id": event.native_tool_call_id,
                    "mcp_server": event.mcp_server,
                    "mcp_tool": event.mcp_tool,
                    "outcome": event.outcome,
                    "tool_call_signature": signature,
                    "event": for_content_level(raw_event, level),
                }
            )
        new_ids = await self.sessions.insert_new_events(rows)
        new_events = [promoted_by_id[event_id] for event_id in new_ids]
        upgraded = await self.usage.upgrade(
            session,
            [
                (raw_by_id[event_id], event)
                for event_id, event in promoted_by_id.items()
                if event_id not in new_ids
            ],
        )
        if not new_events:
            return (session if upgraded else None), declared
        new_calls = {
            event.native_tool_call_id
            for event in new_events
            if event.native_tool_call_id
        } - known_calls
        await self._summarize(
            session,
            record,
            new_events,
            new_calls,
            content_level=level,
        )
        # Read from the uploaded event, before the content level strips it:
        # token counts, model, tier and auth kind are metadata at every level.
        await self.usage.record(
            session, [(raw_by_id[event.event_id], event) for event in new_events]
        )
        await self.links.link_session_calls(
            session,
            {
                event.native_tool_call_id
                for event in new_events
                if event.native_tool_call_id
            },
        )
        await self.links.correlate_session_calls(
            session,
            {signature_by_id[event_id] for event_id in new_ids} - {None},
            record.captured_at,
        )
        return session, declared

    async def _replayed_contents(
        self,
        installation: CompanionInstallation,
        record: RichCaptureRecord,
        session_id: uuid.UUID,
        mapping: CompanionProjectMapping | None,
        quota: InstallationQuota,
    ) -> DeclaredContents:
        """A replayed record hears its declarations' stored answers again, so
        a device that lost the first response can resume."""
        if not record.contents:
            return DeclaredContents()
        session = await self.contents.repo.lock_session(session_id)
        if session is None:
            return DeclaredContents()
        if mapping is None:
            # The mapping that admitted it is gone: stored items still answer
            # as stored, so a device that lost the first response settles.
            declared = await self.contents.stored_only(session, record)
            declared.session = session
            return declared
        deleted = await self._deleted_history(installation, record)
        declared = await self.contents.declare(
            installation=installation,
            mapping=mapping,
            session=session,
            record=record,
            cutoff=deleted[0] if deleted else None,
            quota=quota,
        )
        declared.session = session
        return declared

    async def _deleted_history(
        self, installation: CompanionInstallation, record: RichCaptureRecord
    ) -> tuple[datetime, str] | None:
        """Deleted history of this device's native session in any workspace:
        the record's own mapping does not limit it."""
        return deleted_history_of(
            await self.sessions.tombstones_in_any_workspace(
                installation.owner_id,
                installation.id,
                record.harness,
                record.native_session_id,
            )
        )

    async def _already_received(
        self, installation: CompanionInstallation, valid: _ValidRecord
    ):
        """The receipt of an identical earlier upload of this record, if any."""
        receipt = await self.sessions.capture_receipt(
            installation.id, valid.record.capture_id
        )
        if receipt is not None and receipt.content_hash != valid.content_hash:
            raise _Rejected(Reason.CONFLICT)
        return receipt

    async def _resolve_parentage(
        self, session: AgentSession, record: RichCaptureRecord
    ) -> None:
        if record.parent_native_session_id and session.parent_native_session_id is None:
            session.parent_native_session_id = record.parent_native_session_id
        if session.parent_native_session_id and session.parent_session_id is None:
            await self.sessions.link_parent(session)
        await self.sessions.adopt_waiting_children(session)
        await self.db.flush()

    @staticmethod
    def _admit(installation, record, mapping, members_of, events) -> None:
        if installation.paused:
            raise _Rejected(Reason.PAUSED)
        if not harness_enabled(record.harness, installation.enabled_agents):
            raise _Rejected(Reason.AGENT_DISABLED)
        if mapping is None or mapping.workspace_id not in members_of:
            raise _Rejected(Reason.MAPPING_UNAVAILABLE)
        if not mapping.enabled:
            raise _Rejected(Reason.MAPPING_DISABLED)
        subjects = {event.cwd for event in events if event.cwd}
        if mapping.repo_url_normalized:
            subjects.add(mapping.repo_url_normalized)
        if any(
            fnmatchcase(subject, glob)
            for glob in installation.exclude_globs or []
            for subject in subjects
        ):
            raise _Rejected(Reason.EXCLUDED)

    async def _summarize(
        self,
        session: AgentSession,
        record: RichCaptureRecord,
        new_events: list[PromotedEvent],
        new_calls: set[str],
        *,
        content_level: str,
    ) -> None:
        # Before event_count grows: a session that already held events but no
        # recorded levels predates them, and keeps claiming none.
        session.capture_levels = _with_capture_level(
            session.capture_levels, content_level, had_events=session.event_count > 0
        )
        previous_last = as_utc(session.last_event_at)
        occurred = [event.occurred_at for event in new_events]
        session.started_at = min(as_utc(session.started_at), *occurred)
        session.last_event_at = max(previous_last, *occurred)
        for field in ("cwd", "repository", "branch", "model", "harness_version"):
            latest = _latest(new_events, field)
            if latest and (
                getattr(session, field) is None or latest[0] >= previous_last
            ):
                setattr(session, field, latest[1])
        if record.harness_version:
            session.harness_version = record.harness_version
        session.event_count += len(new_events)
        if session.activity_event_count is None:
            # Written by the previous release: count every stored event once,
            # the ones inserted for this record included.
            counts = await self.sessions.activity_event_counts({session.id})
            session.activity_event_count = counts.get(session.id, 0)
        else:
            session.activity_event_count += sum(
                event.action not in NON_ACTIVITY_ACTIONS for event in new_events
            )
        session.tool_call_count += len(new_calls)
        session.prompt_count += sum(
            event.action == PROMPT_ACTION for event in new_events
        )
        session.error_count += sum(event.outcome == "failed" for event in new_events)
        session.input_tokens += sum(event.input_tokens for event in new_events)
        session.output_tokens += sum(event.output_tokens for event in new_events)
        session.cache_read_tokens += sum(
            event.cache_read_tokens for event in new_events
        )
        session.cache_creation_tokens += sum(
            event.cache_creation_tokens for event in new_events
        )
        ended = [
            event.occurred_at
            for event in new_events
            if event.action == SESSION_END_ACTION
        ]
        if ended:
            previous_end = [as_utc(session.ended_at)] if session.ended_at else []
            session.ended_at = max([*previous_end, *ended])
        session.status = (
            "ended"
            if session.ended_at is not None
            and as_utc(session.ended_at) >= as_utc(session.last_event_at)
            else "active"
        )
        if content_level != "metadata" and session.title is None:
            prompts = sorted(
                (event for event in new_events if event.prompt_text),
                key=lambda event: event.occurred_at,
            )
            if prompts:
                session.title = session_title(prompts[0].prompt_text)
        await self.db.flush()


def _with_capture_level(
    levels: list[str] | None, level: str, *, had_events: bool
) -> list[str] | None:
    """`levels` with `level` moved to the end, so the last entry is the level
    of the latest capture. A fresh list: JSON columns track reassignment only."""
    if levels is None and had_events:
        return None
    return [*(known for known in levels or [] if known != level), level]


def _lock_workspace(mapping: CompanionProjectMapping | None) -> str:
    # Sessions are identified per workspace, so the row-lock order includes it.
    return str(mapping.workspace_id) if mapping else ""


def _as_uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None
