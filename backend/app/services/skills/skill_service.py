# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skill registry + authority — no intelligence.

Backplane stores SKILL.md bundles verbatim and answers "which skills, which
version" for a board; it never executes, renders, or interprets a skill. The
SKILL.md format is an open standard: `name` and `description` in the
frontmatter are required (and mirrored to the skill row as the authoritative
source), every other key passes through untouched — Backplane defines exactly
ONE key of its own, `toolsets` (see manifest.py): the optional list of MCP
toolset ids the playbook plays in. Toolsets enforce, skills guide — the
declaration never restricts tools client-side; it lets the platform lint the
prose against the hand and flag a board whose loop grant cannot cover it.
"""

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import (
    ConflictError,
    ForbiddenError,
    PayloadTooLargeError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
from app.models.skills.skill import BoardSkill, Skill, SkillVersion, SkillVersionStatus
from app.repositories.approvals.approval import ApprovalRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.skills.skill import (
    BoardSkillRepository,
    SkillRepository,
    SkillAuditEventRepository,
    SkillVersionRepository,
)
from app.schemas.approvals.approval import ApprovalCreate
from app.schemas.skills.skill import (
    BoardSkillBindingPut,
    BoardSkillBindingRow,
    EffectiveSkillRead,
    SkillCreate,
    SkillListItem,
    SkillProposalCreate,
    SkillRead,
    SkillVersionDetailRead,
    SkillVersionRead,
)
from app.services.activity import ActivityService
from app.services.approvals.approval import ApprovalService
from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS
from app.services.skills.catalog import get_catalog_entry
from app.services.skills.manifest import (
    SkillManifest,
    lint_prose_against_toolsets,
    parse_frontmatter,
    parse_manifest,
)
from app.services.skills.toolsets import tools_for_known, validate_toolset_ids

__all__ = [
    "SkillManifest",
    "SkillService",
    "compute_content_hash",
    "lint_prose_against_toolsets",
    "parse_manifest",
    "skill_toolsets",
    "validate_files",
    "validate_manifest",
]

logger = logging.getLogger(__name__)

MAX_FILES = 32
MAX_FILE_BYTES = 64 * 1024
MAX_BUNDLE_BYTES = 512 * 1024
MANIFEST_PATH = "SKILL.md"
MCP_TOOL_PREFIX = "mcp__valaris__"


def compute_content_hash(files: list[dict]) -> str:
    """sha256 over the canonical bundle JSON: entries sorted by path,
    sort_keys, compact separators — so hash equality means byte equality of
    the bundle regardless of upload order."""
    canonical = json.dumps(
        sorted(files, key=lambda f: f["path"]),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


_parse_frontmatter = parse_frontmatter


# Characters that make a path lie about itself or break the consumers that
# materialize a bundle onto a filesystem: C0/C7 controls (NUL, newline, tab),
# the BOM, and the bidi overrides/isolates that let "\u202eexe.md" render as
# "dm.exe".
_BIDI_CHARS = frozenset("\ufeff\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def _has_hostile_chars(path: str) -> bool:
    return any(c < " " or c == "\x7f" or c in _BIDI_CHARS for c in path)


def _validate_path(path: str) -> None:
    if not path:
        raise ValidationError("File path cannot be empty")
    if _has_hostile_chars(path):
        raise ValidationError(
            f"File path contains control or bidi characters: {path!r}"
        )
    if path.startswith("/"):
        raise ValidationError(f"File path must be relative: {path}")
    if "\\" in path:
        raise ValidationError(f"File path must use forward slashes: {path}")
    segments = path.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise ValidationError(f"File path contains unsafe segments: {path}")


def validate_files(files: list[dict]) -> tuple[str, str]:
    """Enforce the bundle rails and return the manifest's (name, description).

    Kept as the two-tuple for existing callers; validate_manifest is the
    superset that also validates the `toolsets` declaration.
    """
    manifest = validate_manifest(files)
    return manifest.name, manifest.description


def validate_manifest(files: list[dict]) -> SkillManifest:
    """Enforce the bundle rails and return the validated manifest.

    Structure problems are 422s (including an unknown toolset id, whose
    message lists every valid id); size problems are 413s (utf-8 bytes, per
    file and per bundle).
    """
    if not files:
        raise ValidationError("A skill bundle needs at least a SKILL.md")
    if len(files) > MAX_FILES:
        raise ValidationError(f"A skill bundle is limited to {MAX_FILES} files")

    seen_paths: set[str] = set()
    total_bytes = 0
    for f in files:
        _validate_path(f["path"])
        if f["path"] in seen_paths:
            raise ValidationError(f"Duplicate file path: {f['path']}")
        seen_paths.add(f["path"])
        size = len(f["content"].encode("utf-8"))
        if size > MAX_FILE_BYTES:
            raise PayloadTooLargeError(
                f"File {f['path']} exceeds {MAX_FILE_BYTES} bytes"
            )
        total_bytes += size
    if total_bytes > MAX_BUNDLE_BYTES:
        raise PayloadTooLargeError(f"Bundle exceeds {MAX_BUNDLE_BYTES} bytes")

    manifests = [f for f in files if f["path"] == MANIFEST_PATH]
    if len(manifests) != 1:
        raise ValidationError("A skill bundle needs exactly one root SKILL.md")

    manifest = parse_manifest(manifests[0]["content"])
    if not manifest.name:
        raise ValidationError("SKILL.md frontmatter requires a non-empty name")
    if not manifest.description:
        raise ValidationError("SKILL.md frontmatter requires a non-empty description")
    return SkillManifest(
        name=manifest.name,
        description=manifest.description,
        toolsets=validate_toolset_ids(manifest.toolsets),
        raw=manifest.raw,
    )


# --- derived at read time (no migration: the manifest is in the files JSON) ---


def skill_toolsets(version: SkillVersion) -> list[str]:
    """The version's declared hand, de-duplicated, from its own SKILL.md."""
    for f in version.files:
        if f["path"] == MANIFEST_PATH:
            return list(dict.fromkeys(parse_manifest(f["content"]).toolsets))
    return []


def version_lint_warnings(version: SkillVersion) -> list[str]:
    return lint_prose_against_toolsets(version.files, skill_toolsets(version))


def resolving_version(skill: Skill) -> SkillVersion | None:
    """The version that speaks for the skill in listings and detail: latest
    PUBLISHED, else the newest, else nothing (same order the effective set
    resolves an unpinned binding)."""
    if not skill.versions:
        return None
    if skill.latest_published_version is not None:
        for version in skill.versions:
            if version.version == skill.latest_published_version:
                return version
    return max(skill.versions, key=lambda v: v.version)


def uncovered_toolsets(toolsets: list[str], loop_config: dict | None) -> list[str]:
    """Declared toolsets a board's loop grant cannot cover. The grant is
    `loop_config.tools` (prefixed); empty/absent = the whole surface, so
    nothing is uncovered. A toolset is uncovered when ANY of its tools is
    missing — and an id the taxonomy no longer knows can never be covered."""
    grant = (loop_config or {}).get("tools") or []
    if not grant:
        return []
    granted = {tool.removeprefix(MCP_TOOL_PREFIX) for tool in grant}
    return [
        toolset_id
        for toolset_id in toolsets
        if not (tools_for_known([toolset_id]) or {toolset_id}) <= granted
    ]


def _warn_prose_outside_toolsets(
    slug: str, version: int, files: list[dict], toolsets: list[str]
) -> list[str]:
    warnings = lint_prose_against_toolsets(files, toolsets)
    if warnings:
        logger.warning(
            "skill_prose_outside_toolsets slug=%s version=%s toolsets=%s tools=%s",
            slug,
            version,
            toolsets,
            warnings,
        )
    return warnings


# --- wire builders (the derived fields are not model attributes) -------------


def build_version_read(version: SkillVersion) -> SkillVersionRead:
    return SkillVersionRead(
        id=version.id,
        version=version.version,
        status=version.status,
        content_hash=version.content_hash,
        created_at=version.created_at,
        lint_warnings=version_lint_warnings(version),
        created_by_user_id=version.created_by_user_id,
        created_by_agent_id=version.created_by_agent_id,
        approval_id=version.approval_id,
        base_version=version.base_version,
        reason=version.reason,
        provenance=version.provenance,
        source_board_id=version.source_board_id,
        source_card_id=version.source_card_id,
        source_execution_id=version.source_execution_id,
        delegation_id=version.delegation_id,
    )


def build_version_detail_read(version: SkillVersion) -> SkillVersionDetailRead:
    return SkillVersionDetailRead(
        **build_version_read(version).model_dump(),
        files=version.files,
        toolsets=skill_toolsets(version),
    )


def _skill_columns(skill: Skill) -> dict:
    return {
        "id": skill.id,
        "slug": skill.slug,
        "name": skill.name,
        "description": skill.description,
        "latest_published_version": skill.latest_published_version,
        "origin": skill.origin,
        "archived_at": skill.archived_at,
        "updated_at": skill.updated_at,
    }


def build_skill_list_item(skill: Skill) -> SkillListItem:
    version = resolving_version(skill)
    return SkillListItem(
        **_skill_columns(skill),
        toolsets=skill_toolsets(version) if version else [],
    )


def build_skill_read(skill: Skill) -> SkillRead:
    version = resolving_version(skill)
    return SkillRead(
        **_skill_columns(skill),
        created_at=skill.created_at,
        versions=[
            build_version_read(v)
            for v in sorted(skill.versions, key=lambda v: v.version)
        ],
        toolsets=skill_toolsets(version) if version else [],
        lint_warnings=version_lint_warnings(version) if version else [],
    )


class SkillService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = SkillRepository(db)
        self.versions = SkillVersionRepository(db)
        self.bindings = BoardSkillRepository(db)
        self.activity = ActivityService(db)
        self.audit = SkillAuditEventRepository(db)

    # --- workspace registry --------------------------------------------------

    async def list_skills(
        self, workspace_id: uuid.UUID, include_archived: bool = False
    ) -> list[Skill]:
        return await self.repo.list_by_workspace(
            workspace_id, include_archived=include_archived
        )

    async def get_skill_detail(self, workspace_id: uuid.UUID, slug: str) -> Skill:
        skill = await self.repo.get_detail_by_slug(workspace_id, slug)
        if skill is None:
            raise ResourceNotFoundError("Skill not found")
        return skill

    async def get_or_create_skill(
        self, workspace_id: uuid.UUID, data: SkillCreate, user_id: uuid.UUID
    ) -> tuple[Skill, bool]:
        """Idempotent create-by-slug: an existing slug returns the existing
        skill untouched — agents retry, and a retry must not stack versions."""
        existing = await self.repo.get_detail_by_slug(workspace_id, data.slug)
        if existing is not None:
            return existing, False

        if data.base_version is not None:
            raise ValidationError("A new skill cannot name an existing base version")
        files = [f.model_dump() for f in data.files]
        manifest = validate_manifest(files)
        _warn_prose_outside_toolsets(data.slug, 1, files, manifest.toolsets)
        skill = await self.repo.create(
            workspace_id=workspace_id,
            slug=data.slug,
            name=manifest.name,
            description=manifest.description,
            created_by=user_id,
        )
        version = await self.versions.create(
            skill_id=skill.id,
            version=1,
            files=files,
            status=SkillVersionStatus.draft.value,
            created_by_user_id=user_id,
            content_hash=compute_content_hash(files),
            reason=data.reason,
            provenance=await self._actor_snapshot(user_id),
        )
        await self._record_event(
            skill, "authored", user_id, version=version, reason=data.reason
        )
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.skill,
            entity_id=skill.id,
            # No message_key: v1 skill events render the summary fallback (the
            # localization pass rides with the W2 proposals slice).
            message_key=None,
            message_params=None,
            action=ActivityAction.created,
            summary=f"skill {skill.slug} created",
        )
        return await self.get_skill_detail(workspace_id, data.slug), True

    async def create_skill(
        self, workspace_id: uuid.UUID, data: SkillCreate, user_id: uuid.UUID
    ) -> Skill:
        skill, _ = await self.get_or_create_skill(workspace_id, data, user_id)
        return skill

    async def archive_skill(
        self, workspace_id: uuid.UUID, slug: str, user_id: uuid.UUID
    ) -> Skill:
        """Idempotent soft-archive: re-archiving preserves the original
        `archived_at`/`archived_by` untouched."""
        skill = await self._get_skill(workspace_id, slug)
        if skill.archived_at is None:
            await self.repo.update(
                skill,
                archived_at=datetime.now(timezone.utc),
                archived_by=user_id,
            )
            await self._record_event(skill, "archived", user_id)
            await self.activity.record(
                workspace_id=workspace_id,
                actor_id=user_id,
                entity_type=ActivityEntityType.skill,
                entity_id=skill.id,
                # No message_key: v1 skill events render the summary fallback.
                message_key=None,
                message_params=None,
                action=ActivityAction.archived,
                summary=f"skill {skill.slug} archived",
            )
        return await self.get_skill_detail(workspace_id, slug)

    async def unarchive_skill(
        self, workspace_id: uuid.UUID, slug: str, user_id: uuid.UUID
    ) -> Skill:
        skill = await self._get_skill(workspace_id, slug)
        if skill.archived_at is not None:
            await self.repo.update(skill, archived_at=None, archived_by=None)
            await self._record_event(skill, "unarchived", user_id)
            await self.activity.record(
                workspace_id=workspace_id,
                actor_id=user_id,
                entity_type=ActivityEntityType.skill,
                entity_id=skill.id,
                # No message_key: v1 skill events render the summary fallback.
                message_key=None,
                message_params=None,
                action=ActivityAction.unarchived,
                summary=f"skill {skill.slug} unarchived",
            )
        return await self.get_skill_detail(workspace_id, slug)

    # --- versions ------------------------------------------------------------

    async def get_version(
        self, workspace_id: uuid.UUID, slug: str, version: int
    ) -> SkillVersion:
        skill = await self._get_skill(workspace_id, slug)
        row = await self.versions.get_by_number(skill.id, version)
        if row is None:
            raise ResourceNotFoundError("Skill version not found")
        return row

    async def create_version(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        files: list[dict],
        user_id: uuid.UUID,
        reason: str | None = None,
        base_version: int | None = None,
    ) -> SkillVersion:
        skill = await self._get_skill(workspace_id, slug)
        await self._validate_base_version(skill, base_version)
        manifest = validate_manifest(files)
        name, description = manifest.name, manifest.description
        next_version = await self.versions.max_version(skill.id) + 1
        _warn_prose_outside_toolsets(slug, next_version, files, manifest.toolsets)
        row = await self.versions.create(
            skill_id=skill.id,
            version=next_version,
            files=files,
            status=SkillVersionStatus.draft.value,
            created_by_user_id=user_id,
            content_hash=compute_content_hash(files),
            base_version=base_version,
            reason=reason,
            provenance=await self._actor_snapshot(user_id),
        )
        await self._record_event(skill, "authored", user_id, version=row, reason=reason)
        # The manifest frontmatter is authoritative for the skill's identity
        # fields, so a new version carries any rename with it.
        await self.repo.update(skill, name=name, description=description)
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.skill,
            entity_id=skill.id,
            # No message_key: v1 skill events render the summary fallback (the
            # localization pass rides with the W2 proposals slice).
            message_key=None,
            message_params=None,
            action=ActivityAction.updated,
            summary=f"skill {skill.slug} version {next_version} drafted",
        )
        return row

    async def publish_version(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        version: int,
        user_id: uuid.UUID,
        *,
        approval_id: uuid.UUID | None = None,
        reason: str | None = None,
    ) -> SkillVersion:
        skill = await self._get_skill(workspace_id, slug)
        row = await self.versions.get_by_number(skill.id, version)
        if row is None:
            raise ResourceNotFoundError("Skill version not found")
        if row.status == SkillVersionStatus.published.value:
            return row
        if row.status == SkillVersionStatus.rejected.value:
            raise ConflictError("A rejected skill version cannot be published")

        # Warn on publish, never reject: the operator chose this version.
        _warn_prose_outside_toolsets(slug, version, row.files, skill_toolsets(row))
        row = await self.versions.update(row, status=SkillVersionStatus.published.value)
        await self.repo.update(
            skill,
            latest_published_version=max(skill.latest_published_version or 0, version),
        )
        # Refreshing the parent can expire an eagerly loaded version collection.
        await self.db.refresh(row)
        await self._record_event(
            skill,
            "published",
            user_id,
            version=row,
            reason=reason,
            details={"approval_id": str(approval_id) if approval_id else None},
        )
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.skill,
            entity_id=skill.id,
            # No message_key: v1 skill events render the summary fallback (the
            # localization pass rides with the W2 proposals slice).
            message_key=None,
            message_params=None,
            action=ActivityAction.published,
            summary=f"skill {skill.slug} version {version} published",
        )
        return row

    # --- proposals (W2, card cdcf94b7) ---------------------------------------

    async def propose_skill(
        self, workspace_id: uuid.UUID, data: SkillProposalCreate, user_id: uuid.UUID
    ) -> tuple[dict, bool]:
        """Agent proposal path: a new 'proposed' version plus its pending
        ApprovalRequest — a human decides, and the approval hook publishes.

        Idempotent on (slug, content_hash) while the earlier proposal is still
        pending: agents retry, and a retry must not stack versions or
        approvals. Returns (wire payload, created).
        """
        # Lazy import as in kanban/board.py: core.auth and the service layer
        # load each other lazily.
        from app.core.auth import current_agent_id

        agent_id = current_agent_id.get()
        if agent_id is None:
            raise ForbiddenError(
                "Skill proposals are the agent path — humans author skills "
                "directly via draft + publish on the registry"
            )

        if data.board_id is not None:
            await self._ensure_board_allows_proposals(workspace_id, data.board_id)

        files = [f.model_dump() for f in data.files]
        manifest = validate_manifest(files)
        name, description = manifest.name, manifest.description
        content_hash = compute_content_hash(files)

        skill = await self.repo.get_by_slug(workspace_id, data.slug)
        if skill is not None:
            if skill.archived_at is not None:
                raise ValidationError(
                    f"Skill {data.slug} is archived — proposals cannot target "
                    "an archived skill"
                )
            pending = await self._find_pending_proposal(skill, content_hash)
            if pending is not None:
                return pending, False
        else:
            if data.base_version is not None:
                raise ValidationError(
                    "A new skill cannot name an existing base version"
                )
            skill = await self.repo.create(
                workspace_id=workspace_id,
                slug=data.slug,
                name=name,
                description=description,
                created_by=user_id,
                origin=f"proposal:agent:{agent_id}",
            )

        await self._validate_base_version(skill, data.base_version)
        next_version = await self.versions.max_version(skill.id) + 1
        _warn_prose_outside_toolsets(skill.slug, next_version, files, manifest.toolsets)
        row = await self.versions.create(
            skill_id=skill.id,
            version=next_version,
            files=files,
            status=SkillVersionStatus.proposed.value,
            created_by_agent_id=agent_id,
            created_by_user_id=user_id,
            content_hash=content_hash,
            base_version=data.base_version,
            reason=data.reason,
            provenance=await self._actor_snapshot(user_id),
            source_board_id=data.board_id,
        )
        # Through the approvals service so risk scoring runs — and the
        # skill_publication base score guarantees it lands pending, never
        # auto-approved.
        approval = await ApprovalService(self.db).create_approval(
            workspace_id,
            ApprovalCreate(
                agent_id=agent_id,
                board_id=data.board_id,
                category=ApprovalCategory.skill_publication,
                action_description=(
                    f"Publish skill {skill.slug} version {next_version}"
                ),
                action_payload={
                    "skill_id": str(skill.id),
                    "version": next_version,
                    "slug": skill.slug,
                },
            ),
        )
        await self.versions.update(row, approval_id=approval.id)
        await self._record_event(
            skill,
            "authored",
            user_id,
            version=row,
            reason=data.reason,
            details={
                "approval_id": str(approval.id),
                "source_board_id": str(data.board_id) if data.board_id else None,
            },
        )
        return {
            "approval_id": approval.id,
            "skill_slug": skill.slug,
            "version": next_version,
            "status": SkillVersionStatus.proposed.value,
        }, True

    async def _find_pending_proposal(
        self, skill: Skill, content_hash: str
    ) -> dict | None:
        # The approval's status is authoritative; the version's is the index —
        # a decided approval means no pending proposal even if the row still
        # reads 'proposed'.
        row = await self.versions.get_proposed_by_hash(skill.id, content_hash)
        if row is None or row.approval_id is None:
            return None
        approval = await ApprovalRepository(self.db).get_by_id(row.approval_id)
        if approval is None or approval.status != ApprovalStatus.pending:
            return None
        return {
            "approval_id": approval.id,
            "skill_slug": skill.slug,
            "version": row.version,
            "status": SkillVersionStatus.proposed.value,
        }

    async def _ensure_board_allows_proposals(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID
    ) -> None:
        """The per-board loop-config gate, checked BEFORE any write so a
        gated proposal leaves nothing behind. A missing key defaults open —
        only an explicit False closes the board."""
        board = await BoardRepository(self.db).get_by_id(board_id)
        if board is None or board.workspace_id != workspace_id:
            raise ResourceNotFoundError("Board not found")
        config = board.loop_config or {}
        if not config.get(
            "skills_proposal_enabled",
            LOOP_CONFIG_DEFAULTS["skills_proposal_enabled"],
        ):
            raise ForbiddenError("Skill proposals are disabled for this board")

    # --- board bindings ------------------------------------------------------

    async def get_board_effective_skills(
        self, board_id: uuid.UUID
    ) -> list[EffectiveSkillRead]:
        rows = await self.bindings.list_effective_for_board(board_id)
        loop_config = await self._board_loop_config(board_id)
        items = []
        for skill, binding, version in rows:
            toolsets = skill_toolsets(version)
            items.append(
                EffectiveSkillRead(
                    skill_id=skill.id,
                    slug=skill.slug,
                    name=skill.name,
                    description=skill.description,
                    version=version.version,
                    content_hash=version.content_hash,
                    enabled=binding.enabled,
                    pinned_version=binding.pinned_version,
                    role=binding.role,
                    toolsets=toolsets,
                    uncovered_toolsets=uncovered_toolsets(toolsets, loop_config),
                )
            )
        return items

    async def list_board_bindings(
        self, board_id: uuid.UUID
    ) -> list[BoardSkillBindingRow]:
        rows = await self.bindings.list_for_board(board_id)
        loop_config = await self._board_loop_config(board_id)
        items = []
        for skill, binding, resolved in rows:
            # A binding that resolves to nothing has no manifest to read;
            # a DISABLED one still resolves, so the operator sees the drift
            # before re-enabling.
            toolsets = skill_toolsets(resolved) if resolved is not None else []
            items.append(
                BoardSkillBindingRow(
                    skill_id=skill.id,
                    slug=skill.slug,
                    name=skill.name,
                    enabled=binding.enabled,
                    pinned_version=binding.pinned_version,
                    role=binding.role,
                    resolved_version=resolved.version if resolved is not None else None,
                    toolsets=toolsets,
                    uncovered_toolsets=uncovered_toolsets(toolsets, loop_config),
                )
            )
        return items

    async def _board_loop_config(self, board_id: uuid.UUID) -> dict | None:
        """Coverage is judged against the LOOP grant: the pipeline path grants
        per stage, not per board, so only loop-mode boards can drift."""
        board = await BoardRepository(self.db).get_by_id(board_id)
        return board.loop_config if board is not None else None

    async def set_binding(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        slug: str,
        payload: BoardSkillBindingPut,
        user_id: uuid.UUID,
    ) -> BoardSkill:
        skill = await self._get_skill(workspace_id, slug)
        binding = await self.bindings.get_binding(board_id, skill.id)
        # Archive closes NEW attachment points only — an existing binding
        # stays adjustable (toggle, pin, unbind) after the archive.
        if binding is None and skill.archived_at is not None:
            raise ValidationError(f"Skill {slug} is archived and cannot be bound")
        pin_provided = "pinned_version" in payload.model_fields_set
        # `enabled` is tri-state like the pin: absence means "no change", so a
        # pin-only PUT cannot silently re-enable a deliberately disabled skill.
        enabled_provided = "enabled" in payload.model_fields_set
        if payload.pinned_version is not None:
            pinned = await self.versions.get_by_number(skill.id, payload.pinned_version)
            if pinned is None:
                raise ValidationError(
                    f"Skill {slug} has no version {payload.pinned_version}"
                )

        if binding is None:
            binding = await self.bindings.create(
                board_id=board_id,
                skill_id=skill.id,
                enabled=payload.enabled,
                pinned_version=payload.pinned_version,
                bound_by=user_id,
            )
            await self.db.refresh(binding)
        else:
            updates: dict = {"bound_by": user_id}
            if enabled_provided:
                updates["enabled"] = payload.enabled
            if pin_provided:
                updates["pinned_version"] = payload.pinned_version
            binding = await self.bindings.update(binding, **updates)
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.board,
            entity_id=board_id,
            message_key=None,
            message_params=None,
            action=ActivityAction.updated,
            board_id=board_id,
            summary=f"skill {skill.slug} bound",
        )
        return binding

    async def remove_binding(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        slug: str,
        user_id: uuid.UUID,
    ) -> None:
        skill = await self._get_skill(workspace_id, slug)
        binding = await self.bindings.get_binding(board_id, skill.id)
        if binding is None:
            return
        await self.bindings.delete(binding)
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.board,
            entity_id=board_id,
            message_key=None,
            message_params=None,
            action=ActivityAction.updated,
            board_id=board_id,
            summary=f"skill {skill.slug} unbound",
        )

    # --- catalog -------------------------------------------------------------

    async def activate_catalog(
        self, workspace_id: uuid.UUID, catalog_id: str, user_id: uuid.UUID
    ) -> tuple[Skill, bool]:
        """Idempotent copy-in: the entry becomes an independent workspace
        skill with version 1 already published."""
        entry = get_catalog_entry(catalog_id)
        if entry is None:
            raise ResourceNotFoundError("Skill catalog entry not found")

        existing = await self.repo.get_detail_by_slug(workspace_id, catalog_id)
        if existing is not None:
            if existing.archived_at is not None:
                # Re-activation is the ONE implicit unarchive: the workspace
                # copy comes back live, with no new version stacked. Same
                # audit trail as the explicit endpoint — a skill reappearing
                # in the listing with no activity row is an audit hole.
                await self.repo.update(existing, archived_at=None, archived_by=None)
                await self._record_event(existing, "unarchived", user_id)
                await self.activity.record(
                    workspace_id=workspace_id,
                    actor_id=user_id,
                    entity_type=ActivityEntityType.skill,
                    entity_id=existing.id,
                    message_key=None,
                    message_params=None,
                    action=ActivityAction.unarchived,
                    summary=f"skill {existing.slug} unarchived via catalog activation",
                )
                return await self.get_skill_detail(workspace_id, catalog_id), False
            return existing, False

        files = [{"path": f.path, "content": f.content} for f in entry.files]
        manifest = validate_manifest(files)
        name, description = manifest.name, manifest.description
        _warn_prose_outside_toolsets(catalog_id, 1, files, manifest.toolsets)
        skill = await self.repo.create(
            workspace_id=workspace_id,
            slug=catalog_id,
            name=name,
            description=description,
            latest_published_version=1,
            origin=f"catalog:{catalog_id}@{entry.catalog_version}",
            created_by=user_id,
        )
        version = await self.versions.create(
            skill_id=skill.id,
            version=1,
            files=files,
            status=SkillVersionStatus.published.value,
            created_by_user_id=user_id,
            content_hash=compute_content_hash(files),
            provenance=await self._actor_snapshot(user_id),
        )
        await self._record_event(
            skill,
            "authored",
            user_id,
            version=version,
            details={"origin": skill.origin},
        )
        await self._record_event(
            skill,
            "published",
            user_id,
            version=version,
            details={"origin": skill.origin},
        )
        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.skill,
            entity_id=skill.id,
            # No message_key: v1 skill events render the summary fallback (the
            # localization pass rides with the W2 proposals slice).
            message_key=None,
            message_params=None,
            action=ActivityAction.created,
            summary=f"skill {skill.slug} activated from catalog",
        )
        return await self.get_skill_detail(workspace_id, catalog_id), True

    async def activate_catalog_skill(
        self, workspace_id: uuid.UUID, catalog_id: str, user_id: uuid.UUID
    ) -> Skill:
        skill, _ = await self.activate_catalog(workspace_id, catalog_id, user_id)
        return skill

    # --- internal ------------------------------------------------------------

    async def _get_skill(self, workspace_id: uuid.UUID, slug: str) -> Skill:
        skill = await self.repo.get_by_slug(workspace_id, slug)
        if skill is None:
            raise ResourceNotFoundError("Skill not found")
        return skill

    async def _actor_snapshot(self, user_id: uuid.UUID) -> dict:
        from app.core.auth import (
            current_agent_id,
            current_api_key_id,
            current_authentication_method,
        )
        from app.repositories.agents.agent import AgentRepository
        from app.repositories.user import UserRepository

        user = await UserRepository(self.db).get_by_id(user_id)
        agent_id = current_agent_id.get()
        agent = await AgentRepository(self.db).get_by_id(agent_id) if agent_id else None
        credential_id = current_api_key_id.get()
        return {
            "user_id": str(user_id),
            "user_name": user.name if user else None,
            "agent_id": str(agent_id) if agent_id else None,
            "agent_name": agent.name if agent else None,
            "credential_id": str(credential_id) if credential_id else None,
            "authentication_method": current_authentication_method.get(),
        }

    async def _record_event(
        self,
        skill: Skill,
        event_type: str,
        user_id: uuid.UUID,
        *,
        version: SkillVersion | None = None,
        reason: str | None = None,
        details: dict | None = None,
    ) -> None:
        await self.audit.create(
            skill_id=skill.id,
            version=version.version if version else None,
            event_type=event_type,
            actor=await self._actor_snapshot(user_id),
            reason=reason,
            details=details,
        )

    async def reject_version(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        version: int,
        user_id: uuid.UUID,
        *,
        approval_id: uuid.UUID,
        reason: str | None = None,
    ) -> SkillVersion:
        skill = await self._get_skill(workspace_id, slug)
        row = await self.get_version(workspace_id, slug, version)
        if row.status == SkillVersionStatus.rejected.value:
            return row
        row = await self.versions.update(row, status=SkillVersionStatus.rejected.value)
        await self._record_event(
            skill,
            "rejected",
            user_id,
            version=row,
            reason=reason,
            details={"approval_id": str(approval_id)},
        )
        return row

    async def _validate_base_version(
        self, skill: Skill, base_version: int | None
    ) -> None:
        if (
            base_version is not None
            and await self.versions.get_by_number(skill.id, base_version) is None
        ):
            raise ValidationError("Base skill version not found")

    async def record_approval(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        version: int,
        user_id: uuid.UUID,
        *,
        approval_id: uuid.UUID,
        reason: str | None = None,
    ) -> None:
        skill = await self._get_skill(workspace_id, slug)
        row = await self.get_version(workspace_id, slug, version)
        await self._record_event(
            skill,
            "approved",
            user_id,
            version=row,
            reason=reason,
            details={"approval_id": str(approval_id)},
        )
