# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import uuid

from pydantic import ValidationError as SchemaValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import CONFIG_CHANGED
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.workspace import WorkspaceRole
from app.repositories.completion import CompletionRepository
from app.repositories.git.git_repo import GitRepoRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository
from app.schemas.completion import CompletionPolicyV1
from app.services.activity import ActivityService

_UNSET = object()


def policy_hash(policy: dict | None) -> str | None:
    if policy is None:
        return None
    return hashlib.sha256(
        json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def parse_policy(policy: dict | CompletionPolicyV1 | None) -> CompletionPolicyV1 | None:
    if policy is None:
        return None
    try:
        return CompletionPolicyV1.model_validate(policy)
    except SchemaValidationError as exc:
        raise ValidationError(
            "Unsupported completion policy: " + str(exc),
            error_code="completion_policy_invalid",
        ) from exc


class CompletionPolicyService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = CompletionRepository(db)

    async def authorize(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None,
        *,
        operator=False,
        member=False,
    ):
        from app.core.auth import current_agent_id
        from app.core.workspace import enforce_agent_scope

        if actor_id is None or (operator and current_agent_id.get() is not None):
            raise ForbiddenError(
                "Only a human workspace admin may select completion policy or mode",
                error_code="admin_required",
            )
        membership = await WorkspaceMemberRepository(self.db).get_membership(
            workspace_id, actor_id
        )
        if (
            not membership
            or (
                operator
                and membership.role not in (WorkspaceRole.admin, WorkspaceRole.owner)
            )
            or (member and membership.role == WorkspaceRole.viewer)
        ):
            raise ForbiddenError(
                "Insufficient workspace permissions",
                error_code="admin_required" if operator else "forbidden",
            )
        workspace = await WorkspaceRepository(self.db).get_by_id(workspace_id)
        if workspace is None:
            raise ResourceNotFoundError("Workspace not found")
        await enforce_agent_scope(current_agent_id.get(), workspace.slug, self.db)

    async def get_board(
        self,
        board_id,
        workspace_id,
        actor_id,
        *,
        operator=False,
        lock=False,
        member=False,
    ):
        await self.authorize(workspace_id, actor_id, operator=operator, member=member)
        # All completion mutations lock workspace before board to serialize inherited policy changes.
        if lock:
            await self.repo.lock_workspace(workspace_id)
            await self.repo.workspace_config(workspace_id, lock=True)
        board = await self.repo.board(board_id, workspace_id, lock=lock)
        if board is None:
            raise ResourceNotFoundError("Board not found", error_code="board_not_found")
        return board

    async def effective_policy(self, board: Board, *, override=_UNSET) -> CompletionPolicyV1 | None:
        config = await self.repo.workspace_config(board.workspace_id)
        selected = board.completion_policy if override is _UNSET else override
        return parse_policy(
            selected
            if selected is not None
            else (config.completion_policy if config else None)
        )

    async def resolve(self, board: Board, *, override=_UNSET, loop_config=None, proposed_template=None):
        config = await self.repo.workspace_config(board.workspace_id)
        workspace_policy = config.completion_policy if config else None
        selected = board.completion_policy if override is _UNSET else override
        if isinstance(selected, CompletionPolicyV1):
            selected = selected.model_dump()
        raw = selected if selected is not None else workspace_policy
        policy = parse_policy(raw)
        effective = policy.model_dump() if policy else None
        from app.services.completion_context import assemble_mandatory_completion_context
        context_size = (await assemble_mandatory_completion_context(self.db, board, policy))[1] if policy else None
        incompatibilities = await self.incompatibilities(board, policy, loop_config=loop_config, proposed_template=proposed_template, context_size=context_size)
        return {
            "context_size": context_size,
            "override": selected,
            "workspace_policy": workspace_policy,
            "effective_policy": effective,
            "origin": "board"
            if selected is not None
            else "workspace"
            if workspace_policy is not None
            else "legacy",
            "policy_hash": policy_hash(effective),
            "capabilities": {
                "policy_versions": [1],
                "source_forges": ["github"],
                "landing_methods": ["merge_queue", "external"],
                "exact_revision_validation": True,
                "evidence_only": True,
            },
            "incompatibilities": incompatibilities,
        }

    async def incompatibilities(self, board: Board, policy: CompletionPolicyV1 | None, *, loop_config=None, proposed_template=None, context_size=None):
        if policy is None:
            return []
        findings = []
        from app.services.completion_context import assemble_mandatory_completion_context
        report = context_size if context_size is not None else (await assemble_mandatory_completion_context(self.db, board, policy))[1]
        if not report["within_limit"]:
            findings.append({"code": "completion_context_too_large",
                "message": f"Mandatory completion context uses {report['bytes']} UTF-8 bytes; the limit is {report['limit_bytes']} bytes. Reduce pinned notes or the board definition before saving this policy.",
                "context_size": report})
        from app.services.loop_template_completion import template_policy_incompatibilities

        findings.extend(await template_policy_incompatibilities(
            self.db, board, policy, loop_config=loop_config, proposed_template=proposed_template,
        ))
        repos = await GitRepoRepository(self.db).list_by_board(board.id)
        if not repos and not policy.evidence_only.enabled:
            findings.append(
                {
                    "code": "completion_repo_required",
                    "message": "Link a supported repository or explicitly enable evidence-only completion.",
                }
            )
        for repo in repos:
            provider = repo.provider.value if repo.provider else "unknown"
            if provider != "github":
                findings.append(
                    {
                        "code": "completion_forge_unsupported",
                        "message": f"{provider} does not support authoritative completion verification. Use a supported GitHub repository or retain legacy policy.",
                        "repo_id": str(repo.id),
                        "provider": provider,
                    }
                )
        config = await self.repo.workspace_config(board.workspace_id)
        from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

        pipeline = (
            config.pipeline_config
            if config and config.pipeline_config is not None
            else DEFAULT_PIPELINE_CONFIG
        )
        roles = {stage.get("role"): stage for stage in pipeline.get("stages", [])}
        required = []
        if policy.source_review == "independent":
            required.append((policy.review_role, False))
        if policy.postmerge_validation:
            required.append((policy.postmerge_validation.role, True))
        if (
            policy.evidence_only.enabled
            and policy.evidence_only.approval == "independent"
        ):
            required.append((policy.evidence_only.review_role, False))
        from app.services.completion_roles import completion_role_issue

        for role, direct_checks in sorted(set(required)):
            issue = completion_role_issue(roles.get(role) or {}, role, direct_checks=direct_checks)
            if issue:
                findings.append(issue)
        from app.services.llm_tiers import is_tier
        source = loop_config if loop_config is not None else (board.loop_config or {})
        if source.get("provider") and (not source.get("model") or is_tier(source["model"])):
            findings.append({
                "code": "completion_source_model_required",
                "message": "Configure a concrete model for the selected source provider before enabling this loop.",
            })
        return findings

    async def read_policy(self, board_id, workspace_id, actor_id):
        return await self.resolve(
            await self.get_board(board_id, workspace_id, actor_id)
        )

    async def preview_policy(self, board_id, workspace_id, actor_id, policy, *, loop_config=None, template=None):
        board = await self.get_board(board_id, workspace_id, actor_id)
        previous = await self.resolve(board)
        config = None
        template_preview = None
        if template is not None:
            from app.services.loop_template_preview import preview_binding

            template_preview, config = await preview_binding(
                self.db, board, template, loop_config or {},
                await self.effective_policy(board, override=policy),
            )
        elif loop_config is not None:
            from app.services.loop_config_validation import canonicalize_loop_config, validate_loop_config
            config = canonicalize_loop_config(loop_config, stored=board.loop_config)
            findings = validate_loop_config(config)
            if findings:
                raise ValidationError(findings)
        proposed = await self.resolve(board, override=policy, loop_config=config, proposed_template=template)
        if template_preview is not None:
            proposed["template_preview"] = template_preview
            proposed["loop_config"] = config
            proposed["incompatibilities"].extend(
                {"code": finding["code"], "message": finding["message"], "field": finding.get("field")}
                for finding in template_preview["findings"]
                if finding.get("severity", "error") == "error"
            )
        before, after = (
            previous["effective_policy"] or {},
            proposed["effective_policy"] or {},
        )
        proposed["changes"] = [
            {"field": key, "before": before.get(key), "after": after.get(key)}
            for key in sorted(before.keys() | after.keys())
            if before.get(key) != after.get(key)
        ]
        if previous["origin"] != proposed["origin"]:
            proposed["changes"].append(
                {
                    "field": "origin",
                    "before": previous["origin"],
                    "after": proposed["origin"],
                }
            )
        return proposed

    async def set_policy(self, board_id, workspace_id, actor_id, policy, *, validate=True):
        board = await self.get_board(
            board_id, workspace_id, actor_id, operator=True, lock=True
        )
        proposed = await self.resolve(board, override=policy)
        if proposed["incompatibilities"] and (validate or any(
            item["code"] == "completion_context_too_large" for item in proposed["incompatibilities"]
        )):
            raise ValidationError(
                proposed["incompatibilities"],
                error_code="completion_policy_incompatible",
            )
        if board.completion_policy != proposed["override"]:
            from app.services.completion import CompletionService

            await CompletionService(self.db).invalidate_board(board)
            await self.repo.update_policy(board, proposed["override"])
            await self._record(board, actor_id, "completion_policy")
        return await self.resolve(board)

    async def validate_workspace_policy(self, workspace_id, actor_id, policy):
        await self.authorize(workspace_id, actor_id, operator=True)
        await self.repo.lock_workspace(workspace_id)
        await self.repo.workspace_config(workspace_id, lock=True)
        policy = parse_policy(policy)
        findings = []
        for board in await self.repo.inheriting_boards(workspace_id):
            findings.extend(
                dict(finding, board_id=str(board.id))
                for finding in await self.incompatibilities(board, policy)
            )
        if findings:
            raise ValidationError(findings, error_code="completion_policy_incompatible")

    async def assert_mode_selection(self, board: Board, actor_id, mode):
        await self.authorize(board.workspace_id, actor_id, operator=True)
        if mode == "evidence_only":
            policy = await self.effective_policy(board)
            if policy is None or not policy.evidence_only.enabled:
                raise ValidationError(
                    "Enable evidence-only completion in the effective policy before selecting this mode",
                    error_code="completion_mode_disabled",
                )

    async def set_mode(self, board_id, workspace_id, actor_id, card_id, mode):
        board = await self.get_board(
            board_id, workspace_id, actor_id, operator=True, lock=True
        )
        card = await self.repo.card(card_id, board_id, lock=True)
        if card is None:
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        await self.assert_mode_selection(board, actor_id, mode)
        if card.completion_mode != mode:
            from app.services.completion import CompletionService

            await CompletionService(self.db).invalidate_card(
                board, card, "Completion mode changed"
            )
            await self.repo.update_mode(card, mode)
            await self._record(board, actor_id, "completion_mode", card=card)
        return {"card_id": str(card.id), "completion_mode": card.completion_mode}

    async def assert_card_complete(
        self, board: Board, card: Card | None, *, actor=None
    ):
        policy = await self.effective_policy(board)
        if policy is None:
            return
        from app.services.completion import CompletionService

        if card is None or not await CompletionService(self.db).is_accepted(
            board, card
        ):
            raise ConflictError(
                "Completion acceptance is required before Done",
                error_code="completion_acceptance_required",
            )
        from app.core.auth import current_agent_id

        if not policy.auto_complete and current_agent_id.get() is not None:
            raise ForbiddenError(
                "This completion policy requires a human to move accepted work to Done",
                error_code="completion_human_required",
            )

    async def lock_board_for_completion(self, board_id, workspace_id=None):
        board = await self.repo.board(board_id, workspace_id)
        if board is None:
            raise ResourceNotFoundError("Board not found", error_code="board_not_found")
        await self.repo.lock_workspace(board.workspace_id)
        await self.repo.workspace_config(board.workspace_id, lock=True)
        return await self.repo.board(board_id, board.workspace_id, lock=True)

    async def _record(self, board, actor_id, field, *, card=None):
        activity = ActivityService(self.db)
        common = dict(workspace_id=board.workspace_id, actor_id=actor_id,
                      board_id=board.id, action=ActivityAction.updated,
                      changes={"fields": [field]})
        if card is not None:
            await activity.record(
                **common, entity_type=ActivityEntityType.card, entity_id=card.id,
                summary=f"updated card '{card.title}': changed {field}",
                message_key="activity.card.updated",
                message_params={"card_title": card.title, "fields": [field]},
            )
        else:
            await activity.record(
                **common, entity_type=ActivityEntityType.board, entity_id=board.id,
                summary=f"updated board '{board.name}': changed {field}",
                message_key="activity.board.updated",
                message_params={"board_name": board.name, "fields": [field]},
            )
        await event_bus.publish(
            CONFIG_CHANGED,
            {"entity": "completion", "action": "updated", "entity_id": str(board.id)},
            workspace_id=board.workspace_id,
        )
