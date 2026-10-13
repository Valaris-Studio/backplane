# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import may_manage_credentials
from app.core.harness import KNOWN_HARNESSES
from app.core.local_paths import scrub_local_paths
from app.core.time import as_utc
from app.core.repo_url import normalize_repo_url
from app.exceptions import (
    ConflictError,
    DeviceAuthenticationError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.companion import (
    CONTENT_LEVELS,
    CompanionInstallation,
    CompanionProjectMapping,
)
from app.repositories.agent_session import AgentSessionRepository
from app.repositories.companion import CompanionRepository
from app.schemas.companion import (
    AgentKeyCreated,
    AgentKeyRead,
    AutoMappingRequest,
    CapturePolicy,
    CapturePolicyUpdate,
    DeviceBoard,
    DeviceBoardList,
    DeviceIdentity,
    DeviceMappingCreate,
    DeviceMappingUpdate,
    DeviceOwner,
    DevicePolicy,
    DevicePolicyInstallation,
    DeviceSelf,
    DeviceSettingsUpdate,
    DeviceWorkspace,
    DeviceStatusReport,
    HeartbeatResult,
    InstallationCreate,
    InstallationEnrollment,
    InstallationRead,
    InstallationRename,
    MappingCreate,
    MappingRead,
    MappingUpdate,
    RepoCatalogEntry,
    SessionDeletionResult,
)
from app.services.activity import ActivityService
from app.services.rich_capture import (
    announced_capabilities,
    carried_level,
    effective_capture,
    new_mapping_level,
    require_level_available,
    rich_capture_enabled,
    rich_capture_offer,
    rich_since_for,
    set_level,
)
from app.services.api_key import ApiKeyService
from app.services.session_events import Invalidation, installation_updated
from app.services.session_history_cutoff import history_cutoffs
from app.services.storage.session_content import content_store

DEVICE_TOKEN_PREFIX = "bpc_"
_DEVICE_AUTHORIZATION = re.compile(
    r"^[Bb][Ee][Aa][Rr][Ee][Rr] (bpc_[A-Za-z0-9_-]{43})$"
)
# A liveness stamp, not a write per upload; fine-grained enough for the
# 30-minute disconnected threshold (app/services/agent_session.py).
LAST_SEEN_REFRESH_INTERVAL = timedelta(minutes=1)
BULK_DELETE_BATCH = 500
# Heartbeats are stored at most this often; faster ones are acknowledged only.
STATUS_REFRESH_INTERVAL = timedelta(minutes=1)
API_KEY_NAME_MAX = 255


def _mint_device_token() -> tuple[str, str]:
    token = DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)
    return token, _token_hash(token)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def policy_of(installation: CompanionInstallation) -> CapturePolicy:
    return CapturePolicy(
        paused=installation.paused,
        auto_match_repos=installation.auto_match_repos,
        enabled_agents=installation.enabled_agents,
        exclude_globs=installation.exclude_globs or [],
        retention_days=installation.retention_days,
    )


def installation_read(
    installation: CompanionInstallation, session_count: int
) -> InstallationRead:
    return InstallationRead(
        installation_id=installation.id,
        name=installation.name,
        platform=installation.platform,
        token_prefix=installation.token_prefix,
        created_at=installation.created_at,
        last_seen_at=installation.last_seen_at,
        revoked_at=installation.revoked_at,
        policy=policy_of(installation),
        status=DeviceStatusReport.model_validate(installation.last_status)
        if installation.last_status
        else None,
        status_reported_at=installation.last_status_at,
        session_count=session_count,
    )


def mapping_read(
    mapping: CompanionProjectMapping,
    installation: CompanionInstallation,
    *,
    to_device: bool = False,
) -> MappingRead:
    """A device is told the level it captures at: an older companion maps a
    level it does not know to metadata, so a rich mapping it cannot capture
    reaches it as full."""
    capture = effective_capture(mapping, installation)
    fields = {
        name: getattr(mapping, name)
        for name in MappingRead.model_fields
        if name != "capture"
    }
    if to_device:
        fields["content_level"] = capture.effective_content_level
    return MappingRead(**fields, capture=capture)


def configured_origin(configured_url: str) -> str | None:
    """`scheme://host[:port]` of a configured URL setting, or None when it is
    unset or not an http(s) URL. Any path or credentials are dropped."""
    try:
        parts = urlsplit(configured_url.strip())
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"{parts.scheme.lower()}://{host}" + (f":{port}" if port else "")


def advertised_api_base(api_url: str) -> str | None:
    """The API origin devices hand their agents: https only, so an internal
    http name (e.g. a compose service) never leaves the server."""
    origin = configured_origin(api_url)
    return origin if origin and origin.startswith("https://") else None


def mark_seen(installation: CompanionInstallation, now: datetime) -> None:
    """Stamp liveness on a heartbeat or a successful upload, at most once a minute."""
    if (
        installation.last_seen_at is None
        or now - as_utc(installation.last_seen_at) >= LAST_SEEN_REFRESH_INTERVAL
    ):
        installation.last_seen_at = now


def carried_over_choice(
    prior: list[tuple[CompanionProjectMapping, datetime | None]],
) -> dict:
    """The owner's standing privacy choice for a repository, for a new device.

    Devices still enrolled say what the owner wants now. Of the revoked ones only
    the mapping the owner touched last counts, whichever device was revoked
    first, so neither the revocation order nor a long-gone device can override a
    newer choice. When these disagree, or two are equally recent, the more
    private choice wins; carrying a choice over never widens capture.

    Only mappings that know their repository can count: auto-matched ones and
    explicit ones created with a `repo_url`. An explicit mapping of a bare root
    cannot be linked to a later auto-match, because an auto-match request never
    carries a local root and captured events name the repository only by its
    local path."""
    current = [mapping for mapping, revoked_at in prior if revoked_at is None]
    revoked = [mapping for mapping, revoked_at in prior if revoked_at is not None]
    if revoked:
        last_touched = max(as_utc(mapping.updated_at) for mapping in revoked)
        current += [
            mapping for mapping in revoked if as_utc(mapping.updated_at) == last_touched
        ]
    if not current:
        return {}
    return {
        # CONTENT_LEVELS runs from most to least private.
        "content_level": min(
            (mapping.content_level for mapping in current), key=CONTENT_LEVELS.index
        ),
        "enabled": all(mapping.enabled for mapping in current),
    }


class CompanionService:
    """Installations, capture policy and project mappings.

    Humans manage all of it through their own credentials. A device token
    manages its own installation only: its mappings, its capture settings
    (retention and pausing excepted) and reading the boards its owner can reach.
    Agent keys never reach any of it: capture is private to a person.
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = CompanionRepository(db)

    @staticmethod
    def _require_human() -> None:
        if not may_manage_credentials():
            raise ForbiddenError("Agent keys cannot manage companion installations")

    async def _owned(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> CompanionInstallation:
        self._require_human()
        installation = await self.repo.get_installation(installation_id)
        if installation is None or installation.owner_id != owner_id:
            raise ResourceNotFoundError("Installation not found")
        return installation

    # --- installation lifecycle (human) ---------------------------------

    async def enroll(
        self, owner_id: uuid.UUID, data: InstallationCreate
    ) -> tuple[InstallationEnrollment, bool]:
        """Create the installation and mint its token, or return the existing
        one without a token. Returns (enrollment, created)."""
        self._require_human()
        installation, token = await self.create_installation(
            owner_id, data.installation_id, data.name, data.platform
        )
        return (
            InstallationEnrollment(
                installation_id=installation.id,
                device_token=token,
                token_prefix=installation.token_prefix,
            ),
            token is not None,
        )

    async def create_installation(
        self,
        owner_id: uuid.UUID,
        installation_id: uuid.UUID,
        name: str,
        platform: str,
    ) -> tuple[CompanionInstallation, str | None]:
        """Insert the installation with a fresh device token, or find the
        existing one. The token is returned only when this call created it."""
        token, token_hash = _mint_device_token()
        created = await self.repo.insert_installation(
            id=installation_id,
            owner_id=owner_id,
            name=name,
            platform=platform,
            token_hash=token_hash,
            token_prefix=token[:8],
            enabled_agents=list(KNOWN_HARNESSES),
            exclude_globs=[],
        )
        installation = await self.repo.get_installation(installation_id)
        if installation.owner_id != owner_id:
            raise ConflictError("Installation id is already in use")
        return installation, token if created else None

    async def list_installations(self, owner_id: uuid.UUID) -> list[InstallationRead]:
        self._require_human()
        installations = await self.repo.list_installations(owner_id)
        counts = await AgentSessionRepository(self.db).session_counts_by_installation(
            [item.id for item in installations]
        )
        return [
            installation_read(item, counts.get(item.id, 0)) for item in installations
        ]

    async def get_installation(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> InstallationRead:
        return await self._read(await self._owned(owner_id, installation_id))

    async def rotate_token(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> InstallationEnrollment:
        installation = await self._owned(owner_id, installation_id)
        if installation.revoked_at is not None:
            raise ConflictError("Installation is revoked")
        token = await self.issue_device_token(installation)
        return InstallationEnrollment(
            installation_id=installation.id,
            device_token=token,
            token_prefix=installation.token_prefix,
        )

    async def issue_device_token(self, installation: CompanionInstallation) -> str:
        """Replace the device token; the previous one stops working at once."""
        token, installation.token_hash = _mint_device_token()
        installation.token_prefix = token[:8]
        await self.db.flush()
        return token

    async def revoke(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> InstallationRead:
        installation = await self._owned(owner_id, installation_id)
        await self._revoke(installation)
        return await self._read(installation)

    async def _revoke(self, installation: CompanionInstallation) -> None:
        """Soft revoke, so the FK CASCADE never fires: the agent key has to be
        deleted here, in the same transaction, or it would outlive the device."""
        if installation.revoked_at is None:
            installation.revoked_at = datetime.now(timezone.utc)
        await ApiKeyService(self.db).delete_installation_keys(installation.id)
        await self.db.flush()

    async def _read(self, installation: CompanionInstallation) -> InstallationRead:
        counts = await AgentSessionRepository(self.db).session_counts_by_installation(
            [installation.id]
        )
        return installation_read(installation, counts.get(installation.id, 0))

    async def _updated(
        self, installation: CompanionInstallation, reason: str
    ) -> list[Invalidation]:
        workspace_ids = await self.repo.member_workspace_ids_of(installation.owner_id)
        return installation_updated(installation, workspace_ids, reason)

    async def delete_sessions(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> tuple[SessionDeletionResult, list[Invalidation]]:
        """Delete every session this device captured, with tombstones."""
        installation = await self._owned(owner_id, installation_id)
        sessions_repo = AgentSessionRepository(self.db)
        sessions = await sessions_repo.sessions_of_installation(installation.id)
        deleted_at = datetime.now(timezone.utc)
        cutoffs = await history_cutoffs(sessions_repo, sessions, deleted_at)
        for start in range(0, len(sessions), BULK_DELETE_BATCH):
            await sessions_repo.tombstone_and_delete(
                sessions[start : start + BULK_DELETE_BATCH],
                "owner",
                deleted_at,
                cutoffs,
                content_store().backend,
            )
        # One device-level invalidation instead of one per session.
        return SessionDeletionResult(deleted=len(sessions)), await self._updated(
            installation, "sessions_deleted"
        )

    async def get_policy(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> CapturePolicy:
        return policy_of(await self._owned(owner_id, installation_id))

    async def update_policy(
        self,
        owner_id: uuid.UUID,
        installation_id: uuid.UUID,
        data: CapturePolicyUpdate,
    ) -> CapturePolicy:
        installation = await self._owned(owner_id, installation_id)
        await self._apply_policy(installation, data)
        return policy_of(installation)

    async def _apply_policy(
        self,
        installation: CompanionInstallation,
        data: CapturePolicyUpdate | DeviceSettingsUpdate,
    ) -> list[str]:
        """Set the fields `data` carries; returns the names of those that changed."""
        changed = []
        for field in sorted(data.model_fields_set):
            value = getattr(data, field)
            # null retention means "keep forever"; every other field needs a value.
            if value is None and field != "retention_days":
                raise ValidationError(f"{field} cannot be null")
            if getattr(installation, field) != value:
                setattr(installation, field, value)
                changed.append(field)
        await self.db.flush()
        return changed

    # --- mappings (human) -------------------------------------------------

    async def _check_destination(
        self,
        owner_id: uuid.UUID,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
    ) -> None:
        # Not-found either way: a workspace or board the caller cannot see is
        # indistinguishable from one that does not exist.
        if await self.repo.membership(workspace_id, owner_id) is None:
            raise ResourceNotFoundError("Workspace not found")
        await self._require_board_in(workspace_id, board_id)

    async def _require_board_in(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID | None
    ) -> None:
        if board_id is not None and not await self.repo.board_in_workspace(
            workspace_id, board_id
        ):
            raise ResourceNotFoundError("Board not found")

    async def list_mappings(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID
    ) -> list[MappingRead]:
        installation = await self._owned(owner_id, installation_id)
        return [
            mapping_read(mapping, installation)
            for mapping in await self.repo.list_mappings(installation_id)
        ]

    async def create_mapping(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID, data: MappingCreate
    ) -> tuple[MappingRead, bool]:
        installation = await self._owned(owner_id, installation_id)
        await self._check_destination(owner_id, data.workspace_id, data.board_id)
        return await self._insert_explicit_mapping(installation, data)

    async def _insert_explicit_mapping(
        self,
        installation: CompanionInstallation,
        data: MappingCreate,
        *,
        to_device: bool = False,
    ) -> tuple[MappingRead, bool]:
        repo_url = normalize_repo_url(data.repo_url) if data.repo_url else None
        if data.repo_url and repo_url is None:
            raise ValidationError("repo_url is not a recognizable git remote")
        level = new_mapping_level(data.content_level)
        created = await self.repo.insert_mapping(
            id=uuid.uuid4(),
            installation_id=installation.id,
            workspace_id=data.workspace_id,
            board_id=data.board_id,
            root_path=data.root_path,
            repo_url_normalized=repo_url,
            origin="explicit",
            enabled=data.enabled,
            content_level=level,
            rich_since=rich_since_for(level, None, None),
        )
        mapping = await self.repo.mapping_by_root(installation.id, data.root_path)
        if not created and (
            mapping.workspace_id != data.workspace_id
            or mapping.board_id != data.board_id
        ):
            raise ConflictError("root_path is already mapped elsewhere")
        return mapping_read(mapping, installation, to_device=to_device), created

    async def _owned_mapping(
        self, owner_id, installation_id, mapping_id
    ) -> tuple[CompanionInstallation, CompanionProjectMapping]:
        installation = await self._owned(owner_id, installation_id)
        mapping = await self.repo.get_mapping(installation_id, mapping_id)
        if mapping is None:
            raise ResourceNotFoundError("Mapping not found")
        return installation, mapping

    async def update_mapping(
        self,
        owner_id: uuid.UUID,
        installation_id: uuid.UUID,
        mapping_id: uuid.UUID,
        data: MappingUpdate,
    ) -> MappingRead:
        installation, mapping = await self._owned_mapping(
            owner_id, installation_id, mapping_id
        )
        if "board_id" in data.model_fields_set:
            await self._check_destination(owner_id, mapping.workspace_id, data.board_id)
            mapping.board_id = data.board_id
        _apply_mapping_fields(mapping, data)
        await self.db.flush()
        await self.db.refresh(mapping)
        return mapping_read(mapping, installation)

    async def delete_mapping(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID, mapping_id: uuid.UUID
    ) -> None:
        _, mapping = await self._owned_mapping(owner_id, installation_id, mapping_id)
        await self.db.delete(mapping)
        await self.db.flush()

    # --- device -----------------------------------------------------------

    async def authenticate_device(self, authorization: str) -> CompanionInstallation:
        match = _DEVICE_AUTHORIZATION.match(authorization or "")
        if match is None:
            raise DeviceAuthenticationError()
        installation = await self.repo.installation_by_token_hash(_token_hash(match[1]))
        if installation is None or installation.revoked_at is not None:
            raise DeviceAuthenticationError()
        # Authenticating is not being seen: last_seen_at moves only on a
        # heartbeat or an ingest that stored something.
        return installation

    async def revoke_device(
        self, installation: CompanionInstallation
    ) -> InstallationRead:
        """A device disconnecting itself; its token stops working at once."""
        await self._revoke(installation)
        return await self._read(installation)

    # --- the API key a device mints for the agents it launches ------------

    async def create_agent_key(
        self, installation: CompanionInstallation
    ) -> AgentKeyCreated:
        """Rotation, not an idempotent create: the raw key is never stored, so
        a device that lost it can only get a new one, replacing the old."""
        name = f"Companion · {installation.name} · agents"[:API_KEY_NAME_MAX]
        api_key, raw_key = await ApiKeyService(self.db).rotate_installation_key(
            installation.owner_id, installation.id, name
        )
        return AgentKeyCreated(
            id=api_key.id,
            name=api_key.name,
            key_prefix=api_key.key_prefix,
            key=raw_key,
            created_at=api_key.created_at,
        )

    async def get_agent_key(self, installation: CompanionInstallation) -> AgentKeyRead:
        api_key = await ApiKeyService(self.db).get_installation_key(installation.id)
        if api_key is None:
            raise ResourceNotFoundError(
                "This device has no agent key", error_code="agent_key_missing"
            )
        return AgentKeyRead.model_validate(api_key)

    async def delete_agent_key(self, installation: CompanionInstallation) -> None:
        await ApiKeyService(self.db).delete_installation_keys(installation.id)
        await self.db.flush()

    async def rename_installation(
        self, owner_id: uuid.UUID, installation_id: uuid.UUID, data: InstallationRename
    ) -> tuple[InstallationRead, list[Invalidation]]:
        """The owner renaming a device from the web. A signed-out device keeps
        the name it was signed out under."""
        installation = await self._owned(owner_id, installation_id)
        if installation.revoked_at is not None:
            raise ConflictError("Installation is revoked")
        return await self.rename_device(installation, data)

    async def rename_device(
        self, installation: CompanionInstallation, data: InstallationRename
    ) -> tuple[InstallationRead, list[Invalidation]]:
        """A device relabelling itself, e.g. to replace a hostname default."""
        if installation.name == data.name:
            return await self._read(installation), []
        installation.name = data.name
        await self.db.flush()
        return await self._read(installation), await self._updated(
            installation, "renamed"
        )

    async def record_status(
        self, installation: CompanionInstallation, report: DeviceStatusReport
    ) -> tuple[HeartbeatResult, list[Invalidation]]:
        now = datetime.now(timezone.utc)
        mark_seen(installation, now)
        if (
            installation.last_status_at is not None
            and now - as_utc(installation.last_status_at) < STATUS_REFRESH_INTERVAL
        ):
            await self.db.flush()
            return HeartbeatResult(recorded=False), []
        # Kept only while this server takes rich capture, never stored as null:
        # the previous release rejects any member it does not know, and a
        # companion may report rich capture until it next fetches its policy.
        keeps_rich = report.rich_capture is not None and rich_capture_enabled()
        status = report.model_dump(
            mode="json", exclude=None if keeps_rich else {"rich_capture"}
        )
        sources = (status.get("rich_capture") or {}).get("sources", [])
        for agent in [*status["agents"], *sources]:
            if agent["detail"] is not None:
                agent["detail"] = scrub_local_paths(agent["detail"])
        installation.last_status = status
        installation.last_status_at = now
        await self.db.flush()
        return HeartbeatResult(recorded=True), await self._updated(
            installation, "status"
        )

    async def device_policy(
        self, installation: CompanionInstallation, capabilities_header: str | None
    ) -> DevicePolicy:
        """Also records what the device announced: each policy read replaces
        the capabilities its rich capture is judged by, and `_at` says since
        when it has announced them. An unchanged announcement writes nothing."""
        announced = announced_capabilities(capabilities_header)
        if announced != installation.capture_capabilities:
            installation.capture_capabilities = announced
            installation.capture_capabilities_at = (
                datetime.now(timezone.utc) if announced is not None else None
            )
            await self.db.flush()
        catalog = []
        for (
            slug,
            workspace_id,
            workspace_name,
            board_id,
            board_name,
            url,
        ) in await self.repo.repo_catalog(installation.owner_id):
            normalized = normalize_repo_url(url)
            if normalized:
                catalog.append(
                    RepoCatalogEntry(
                        workspace_slug=slug,
                        workspace_id=workspace_id,
                        workspace_name=workspace_name,
                        board_id=board_id,
                        board_name=board_name,
                        repo_url_normalized=normalized,
                    )
                )
        mappings = await self._device_mapping_rows(installation)
        return DevicePolicy(
            installation=DevicePolicyInstallation(
                id=installation.id, **policy_of(installation).model_dump()
            ),
            mappings=[
                mapping_read(mapping, installation, to_device=True)
                for mapping in mappings
            ],
            repo_catalog=catalog,
            api_base_url=advertised_api_base(settings.API_URL),
            rich_capture=rich_capture_offer(installation, mappings),
        )

    async def device_mappings(
        self, installation: CompanionInstallation
    ) -> list[MappingRead]:
        return [
            mapping_read(mapping, installation, to_device=True)
            for mapping in await self._device_mapping_rows(installation)
        ]

    async def _device_mapping_rows(
        self, installation: CompanionInstallation
    ) -> list[CompanionProjectMapping]:
        mappings = await self.repo.list_mappings(installation.id)
        # A mapping into a workspace the owner has left can never be admitted,
        # and its target is no longer theirs to see.
        member_of = await self.repo.member_workspace_ids(
            installation.owner_id, {mapping.workspace_id for mapping in mappings}
        )
        return [mapping for mapping in mappings if mapping.workspace_id in member_of]

    async def auto_map(
        self, installation: CompanionInstallation, data: AutoMappingRequest
    ) -> tuple[MappingRead, bool]:
        if not installation.auto_match_repos:
            raise ForbiddenError(
                "Repository auto-matching is disabled for this installation",
                error_code="auto_match_disabled",
            )
        repo_url = normalize_repo_url(data.repo_url)
        if repo_url is None:
            raise ValidationError("repo_url is not a recognizable git remote")
        existing = await self.repo.auto_mapping(installation.id, repo_url)
        if existing is not None:
            return mapping_read(existing, installation, to_device=True), False
        matches = [
            (workspace_id, board_id)
            for _, workspace_id, _, board_id, _, url in await self.repo.repo_catalog(
                installation.owner_id
            )
            if normalize_repo_url(url) == repo_url
        ]
        if not matches:
            raise ResourceNotFoundError("No accessible board uses this repository")
        workspaces = {workspace_id for workspace_id, _ in matches}
        if len(workspaces) > 1:
            raise ConflictError(
                "Repository is bound in several workspaces; map it explicitly",
                error_code="ambiguous_repo",
            )
        [workspace_id] = workspaces
        boards = {board_id for _, board_id in matches}
        # A reconnect is a new installation; without this the repository would
        # silently fall back to the default level and re-enable capture. Only
        # this workspace's choices count: a reconnect maps the repository back
        # into the same workspace.
        standing_choice = carried_over_choice(
            await self.repo.owner_repo_mappings(
                installation.owner_id, workspace_id, repo_url, installation.id
            )
        )
        level = (
            carried_level(standing_choice["content_level"])
            if standing_choice
            else new_mapping_level(None)
        )
        standing_choice["content_level"] = level
        created = await self.repo.insert_auto_mapping(
            id=uuid.uuid4(),
            installation_id=installation.id,
            workspace_id=workspace_id,
            # Several boards in one workspace: capture to the workspace and let
            # the owner pick the board.
            board_id=boards.pop() if len(boards) == 1 else None,
            repo_url_normalized=repo_url,
            rich_since=rich_since_for(level, None, None),
            **standing_choice,
        )
        mapping = await self.repo.auto_mapping(installation.id, repo_url)
        return mapping_read(mapping, installation, to_device=True), created

    # --- device self-service ------------------------------------------------
    # A device token manages its own installation only. Every write re-checks
    # the owner's membership: a device token outlives a removal from a workspace.

    async def _require_member(
        self, owner_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        # Forbidden, not not-found: the device named the workspace itself, and
        # an unknown id gets the same answer as one the owner left.
        if await self.repo.membership(workspace_id, owner_id) is None:
            raise ForbiddenError("Not a member of this workspace")

    async def _device_mapping(
        self, installation: CompanionInstallation, mapping_id: uuid.UUID
    ) -> CompanionProjectMapping:
        mapping = await self.repo.get_mapping(installation.id, mapping_id)
        if mapping is None:
            raise ResourceNotFoundError("Mapping not found")
        return mapping

    async def _record_device_change(
        self,
        installation: CompanionInstallation,
        workspace_id: uuid.UUID,
        action: ActivityAction,
        summary: str,
        changes: dict,
        board_id: uuid.UUID | None = None,
    ) -> None:
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=installation.owner_id,
            entity_type=ActivityEntityType.workspace,
            entity_id=workspace_id,
            action=action,
            board_id=board_id,
            summary=summary,
            message_key=(
                "activity.companion.settings_updated"
                if "mapping_id" not in changes
                else "activity.companion.mapping_created"
                if action == ActivityAction.created
                else "activity.companion.mapping_deleted"
                if action == ActivityAction.deleted
                else "activity.companion.mapping_updated"
            ),
            message_params={},
            changes={"installation_id": str(installation.id), **changes},
            via=f"companion: {installation.name}"[:255],
        )

    async def _record_mapping_change(
        self,
        installation: CompanionInstallation,
        mapping: CompanionProjectMapping,
        action: ActivityAction,
        summary: str,
        changed: list[str],
    ) -> None:
        # The local root stays on the device; the repository is already
        # visible to the workspace through its boards.
        await self._record_device_change(
            installation,
            mapping.workspace_id,
            action,
            summary,
            {
                "mapping_id": str(mapping.id),
                "repository": mapping.repo_url_normalized,
                "content_level": mapping.content_level,
                "enabled": mapping.enabled,
                "fields": changed,
            },
            board_id=mapping.board_id,
        )

    async def device_identity(
        self, installation: CompanionInstallation
    ) -> DeviceIdentity:
        owner = await self.repo.get_user(installation.owner_id)
        return DeviceIdentity(
            user=DeviceOwner(email=owner.email, display_name=owner.name or None),
            installation=DeviceSelf(id=installation.id, name=installation.name),
            web_origin=configured_origin(settings.FRONTEND_URL),
        )

    async def device_boards(
        self, installation: CompanionInstallation
    ) -> DeviceBoardList:
        repos_by_board: dict[uuid.UUID, set[str]] = {}
        for *_, board_id, _, url in await self.repo.repo_catalog(installation.owner_id):
            normalized = normalize_repo_url(url)
            if normalized:
                repos_by_board.setdefault(board_id, set()).add(normalized)
        workspaces: dict[uuid.UUID, DeviceWorkspace] = {}
        for workspace, board in await self.repo.reachable_boards(installation.owner_id):
            entry = workspaces.setdefault(
                workspace.id,
                DeviceWorkspace(
                    id=workspace.id, slug=workspace.slug, name=workspace.name, boards=[]
                ),
            )
            if board is not None:
                entry.boards.append(
                    DeviceBoard(
                        id=board.id,
                        name=board.name,
                        repos=sorted(repos_by_board.get(board.id, ())),
                    )
                )
        return DeviceBoardList(workspaces=list(workspaces.values()))

    async def device_create_mapping(
        self, installation: CompanionInstallation, data: DeviceMappingCreate
    ) -> tuple[MappingRead, bool, list[Invalidation]]:
        """Bind a local root or a repository to the board the owner chose.
        The same target again returns the existing mapping (created=False)."""
        await self._require_member(installation.owner_id, data.workspace_id)
        await self._require_board_in(data.workspace_id, data.board_id)
        if data.root_path is not None:
            read, created = await self._insert_explicit_mapping(
                installation,
                MappingCreate(
                    workspace_id=data.workspace_id,
                    board_id=data.board_id,
                    root_path=data.root_path,
                    repo_url=data.repo_url,
                    content_level=data.content_level,
                    enabled=data.enabled,
                ),
                to_device=True,
            )
        else:
            read, created = await self._insert_repository_mapping(installation, data)
        if not created:
            return read, False, []
        mapping = await self._device_mapping(installation, read.id)
        await self._record_mapping_change(
            installation,
            mapping,
            ActivityAction.created,
            "Bound a project to this board from a companion device",
            [],
        )
        return read, True, await self._updated(installation, "mapping_created")

    async def _insert_repository_mapping(
        self, installation: CompanionInstallation, data: DeviceMappingCreate
    ) -> tuple[MappingRead, bool]:
        repo_url = normalize_repo_url(data.repo_url)
        if repo_url is None:
            raise ValidationError("repo_url is not a recognizable git remote")
        level = new_mapping_level(data.content_level)
        # Rootless, so it shares the one-per-repository slot with auto-matches.
        created = await self.repo.insert_auto_mapping(
            id=uuid.uuid4(),
            installation_id=installation.id,
            workspace_id=data.workspace_id,
            board_id=data.board_id,
            repo_url_normalized=repo_url,
            content_level=level,
            rich_since=rich_since_for(level, None, None),
            enabled=data.enabled,
        )
        mapping = await self.repo.auto_mapping(installation.id, repo_url)
        if not created and (
            mapping.workspace_id != data.workspace_id
            or mapping.board_id != data.board_id
        ):
            raise ConflictError("Repository is already mapped elsewhere")
        return mapping_read(mapping, installation, to_device=True), created

    async def device_update_mapping(
        self,
        installation: CompanionInstallation,
        mapping_id: uuid.UUID,
        data: DeviceMappingUpdate,
    ) -> tuple[MappingRead, list[Invalidation]]:
        mapping = await self._device_mapping(installation, mapping_id)
        await self._require_member(installation.owner_id, mapping.workspace_id)
        changed = _apply_mapping_fields(mapping, data)
        if not changed:
            return mapping_read(mapping, installation, to_device=True), []
        await self.db.flush()
        await self.db.refresh(mapping)
        await self._record_mapping_change(
            installation,
            mapping,
            ActivityAction.updated,
            "Changed a companion project binding",
            changed,
        )
        return (
            mapping_read(mapping, installation, to_device=True),
            await self._updated(installation, "mapping_updated"),
        )

    async def device_delete_mapping(
        self, installation: CompanionInstallation, mapping_id: uuid.UUID
    ) -> list[Invalidation]:
        """Unbinding only narrows capture, so it is allowed even after the owner
        left the workspace; the workspace then gets no activity entry."""
        mapping = await self._device_mapping(installation, mapping_id)
        if await self.repo.membership(mapping.workspace_id, installation.owner_id):
            await self._record_mapping_change(
                installation,
                mapping,
                ActivityAction.deleted,
                "Removed a companion project binding",
                [],
            )
        await self.db.delete(mapping)
        await self.db.flush()
        return await self._updated(installation, "mapping_deleted")

    async def device_update_settings(
        self, installation: CompanionInstallation, data: DeviceSettingsUpdate
    ) -> tuple[CapturePolicy, list[Invalidation]]:
        changed = await self._apply_policy(installation, data)
        if not changed:
            return policy_of(installation), []
        # Settings shape capture into every workspace this device maps into;
        # the entry names the changed settings, not their values.
        mapped_workspaces = {
            mapping.workspace_id for mapping in await self.device_mappings(installation)
        }
        for workspace_id in sorted(mapped_workspaces):
            await self._record_device_change(
                installation,
                workspace_id,
                ActivityAction.updated,
                "Changed companion capture settings",
                {"fields": changed},
            )
        return policy_of(installation), await self._updated(
            installation, "settings_updated"
        )


def _apply_mapping_fields(
    mapping: CompanionProjectMapping, data: MappingUpdate | DeviceMappingUpdate
) -> list[str]:
    """Set the level and enabled state `data` carries; returns the names of
    those that changed."""
    changed = []
    for field in ("content_level", "enabled"):
        if field not in data.model_fields_set:
            continue
        value = getattr(data, field)
        if value is None:
            raise ValidationError(f"{field} cannot be null")
        if field == "content_level":
            require_level_available(value)
        if getattr(mapping, field) == value:
            continue
        if field == "content_level":
            set_level(mapping, value)
        else:
            mapping.enabled = value
        changed.append(field)
    return changed
