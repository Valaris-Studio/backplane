# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import CONFIG_CHANGED
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.agents.prompt_config import AgentPromptConfig
from app.repositories.agents.prompt_config import PromptConfigRepository
from app.schemas.agents.prompt_config import PromptConfigCreate, PromptConfigUpdate
from app.services.agents.prompt_defaults import _post_process_imperative

logger = logging.getLogger(__name__)


# Enough of each imperative to uniquely identify it when checking whether
# the operator's `content` already includes it (double-append guard).
# Matches the first sentence of each _POST_PROCESS_IMPERATIVES entry in
# prompt_defaults.py; robust to trailing whitespace/paraphrasing after.
_IMPERATIVE_CANONICAL_PREFIXES = (
    # produces_note: tells LLM to use the JSON `findings` field, not call create_note.
    "You MUST emit your full output in the `findings` field",
    # mutates_backlog: tells LLM the lifecycle captures output, forbids create_card/create_note.
    "Your output is captured by the lifecycle",
    # produces_decision: structured output channel.
    "You MUST deliver your verdict via the StructuredOutput tool",
)


def _already_contains_imperative(content: str, imperative: str) -> bool:
    """Substring-match the imperative's canonical prefix to avoid double-append.

    We match on a canonical prefix (one of `_IMPERATIVE_CANONICAL_PREFIXES`)
    rather than the full imperative so paraphrased copies — e.g., operator
    pasted and tweaked wording — still dedupe. The prefixes are discriminating
    enough that false positives are implausible in authored prompt text.
    """
    for prefix in _IMPERATIVE_CANONICAL_PREFIXES:
        if prefix in imperative and prefix in content:
            return True
    return False


def _build_post_process_index(
    pipeline_config: dict | None,
) -> dict[tuple[str, str], str]:
    """Map (team_role, llm.stage) → post_process_kind from the pipeline config.

    Disabled stages and stages without an llm.stage token are skipped — they
    aren't queried by the runner anyway.
    """
    if not pipeline_config:
        return {}
    index: dict[tuple[str, str], str] = {}
    for stage_cfg in pipeline_config.get("stages") or []:
        if not isinstance(stage_cfg, dict):
            continue
        llm = stage_cfg.get("llm") or {}
        if llm.get("enabled") is False:
            continue
        role = stage_cfg.get("role")
        llm_stage = llm.get("stage")
        kind = llm.get("post_process_kind") or ""
        if not role or not llm_stage or not kind:
            continue
        index[(role, llm_stage)] = kind
    return index


def _resolve_content(
    config: AgentPromptConfig,
    post_process_index: dict[tuple[str, str], str],
) -> str:
    """Return `content` plus the matching post_process imperative.

    Returns `content` unchanged when: no pipeline match, kind has no imperative,
    or the operator's content already contains the imperative (paste scenario).
    """
    if not config.team_role or not config.stage:
        return config.content
    kind = post_process_index.get((config.team_role, config.stage))
    if not kind:
        return config.content
    imperative = _post_process_imperative(kind)
    if not imperative:
        return config.content
    if _already_contains_imperative(config.content, imperative):
        return config.content
    return f"{config.content}\n\n{imperative.lstrip()}"


class PromptConfigService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = PromptConfigRepository(db)

    async def authorize_mutation(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID | None
    ):
        from app.services.completion_policy import CompletionPolicyService

        completion = CompletionPolicyService(self.db)
        # Serialize with policy changes and claim/result before inspecting authority.
        await completion.repo.lock_workspace(workspace_id)
        await completion.repo.workspace_config(workspace_id, lock=True)
        policies = await self.repo.completion_policy_values(workspace_id)
        if any(policy is not None for policy in policies):
            try:
                await completion.authorize(workspace_id, actor_id, operator=True)
            except ForbiddenError as exc:
                raise ForbiddenError(
                    "Only a human workspace admin may change prompts while explicit completion policy is configured",
                    error_code="admin_required",
                ) from exc

    async def _authorize_shared_mutation(self):
        policies = await self.repo.completion_policy_values(None)
        if any(policy is not None for policy in policies):
            raise ForbiddenError(
                "Shared system prompts are read-only while explicit completion policy is configured; create a workspace prompt override",
                error_code="completion_shared_prompt_read_only",
            )

    async def load_prompt_contents(
        self, workspace_id: uuid.UUID | None
    ) -> dict[tuple[str, str], str]:
        """Map (team_role, stage) -> authored prompt content for a workspace.

        Used by the context-source wiring lint, which cross-checks a stage's
        declared context_sources against the prompt that consumes them. Only
        rows with both a team_role and stage are keyable to a pipeline stage;
        workspace-owned rows shadow system-level ones for the same key.
        """
        configs = await self.repo.list_by_workspace(workspace_id)
        contents: dict[tuple[str, str], str] = {}
        for c in configs:
            if not c.team_role or not c.stage:
                continue
            key = (c.team_role, c.stage)
            # Workspace-scoped rows win over system-level (workspace_id=NULL).
            if key in contents and c.workspace_id is None:
                continue
            contents[key] = c.content
        return contents

    async def _load_pipeline_config(self, workspace_id: uuid.UUID | None) -> dict | None:
        if workspace_id is None:
            return None
        from app.services.workspace_config import WorkspaceConfigService

        workspace_config = await WorkspaceConfigService(self.db).get_config(
            workspace_id
        )
        return workspace_config.get("pipeline_config")

    def _attach_resolved_content(
        self,
        configs: list[AgentPromptConfig],
        post_process_index: dict[tuple[str, str], str],
    ) -> list[AgentPromptConfig]:
        for c in configs:
            # Transient attribute — SQLAlchemy tolerates it; Pydantic
            # `from_attributes=True` picks it up for PromptConfigRead.
            c.resolved_content = _resolve_content(c, post_process_index)
        return configs

    async def _wiring_warnings_by_stage(
        self, workspace_id: uuid.UUID | None, pipeline_config: dict | None
    ) -> dict[tuple[str, str], list[dict]]:
        """Bucket context-source wiring warnings by (role, stage).

        Runs the lint once over the given pipeline_config + all authored
        prompts, then groups findings so each prompt config can carry the
        warnings for the stage it drives. `pipeline_config` is passed in by the
        caller (already loaded for resolved_content) to keep one config fetch
        per request.
        """
        if workspace_id is None or not pipeline_config:
            return {}
        from app.services.agents.context_source_lint import (
            lint_context_source_wiring,
        )

        prompt_contents = await self.load_prompt_contents(workspace_id)
        findings = lint_context_source_wiring(pipeline_config, prompt_contents)

        # Re-key each finding to its (role, stage) by matching the declaring
        # stage. The lint encodes "(role.stage)" in the field; reconstruct the
        # mapping from the config so we don't parse the human-readable field.
        bucket: dict[tuple[str, str], list[dict]] = {}
        stages = pipeline_config.get("stages") or []
        idx_to_key: dict[int, tuple[str, str]] = {}
        for i, stage in enumerate(stages):
            if not isinstance(stage, dict):
                continue
            role = stage.get("role")
            stage_name = (stage.get("llm") or {}).get("stage")
            if role and stage_name:
                idx_to_key[i] = (role, stage_name)
        for f in findings:
            field = f.get("field", "")
            for i, key in idx_to_key.items():
                if field.startswith(f"stages[{i}]."):
                    bucket.setdefault(key, []).append(dict(f))
                    break
        return bucket

    def _attach_wiring_warnings(
        self,
        configs: list[AgentPromptConfig],
        warnings_by_stage: dict[tuple[str, str], list[dict]],
    ) -> None:
        for c in configs:
            key = (c.team_role, c.stage) if c.team_role and c.stage else None
            c.context_source_warnings = warnings_by_stage.get(key, []) if key else []

    async def _finalize(
        self, configs: list[AgentPromptConfig], workspace_id: uuid.UUID | None
    ) -> None:
        """Attach resolved_content + context_source_warnings using a single
        pipeline_config fetch (the perf invariant the list endpoint asserts)."""
        pipeline_config = await self._load_pipeline_config(workspace_id)
        self._attach_resolved_content(
            configs, _build_post_process_index(pipeline_config)
        )
        self._attach_wiring_warnings(
            configs,
            await self._wiring_warnings_by_stage(workspace_id, pipeline_config),
        )

    async def list_configs(
        self,
        workspace_id: uuid.UUID | None = None,
        team_role: str | None = None,
    ) -> list[AgentPromptConfig]:
        configs = await self.repo.list_by_workspace(workspace_id, team_role)
        await self._finalize(configs, workspace_id)
        return configs

    async def get_config(
        self,
        config_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
    ) -> AgentPromptConfig:
        config = await self.repo.get_by_id(config_id)
        if not config:
            raise ResourceNotFoundError("Prompt config not found")
        if (
            workspace_id is not None
            and config.workspace_id is not None
            and config.workspace_id != workspace_id
        ):
            raise ResourceNotFoundError("Prompt config not found")
        await self._finalize([config], config.workspace_id)
        return config

    async def resolve_ident(
        self, ident: str, workspace_id: uuid.UUID
    ) -> uuid.UUID:
        """Resolve a `{config_ident}` path param (UUID or slug) to a UUID.

        Slug lookup is workspace-scoped and prefers workspace-owned rows
        over system-scoped fallbacks. Cross-workspace reads are rejected
        by the downstream `get_config` workspace_id guard.
        """
        try:
            return uuid.UUID(ident)
        except ValueError:
            pass
        config = await self.repo.get_by_slug(workspace_id, ident)
        if config is None:
            raise ResourceNotFoundError("Prompt config not found")
        return config.id

    async def create_config(
        self,
        workspace_id: uuid.UUID,
        data: PromptConfigCreate,
        created_by_id: uuid.UUID,
    ) -> AgentPromptConfig:
        await self.authorize_mutation(workspace_id, created_by_id)
        existing = await self.repo.get_by_scope_slug(
            workspace_id=workspace_id,
            team_id=data.team_id,
            team_role=data.team_role,
            stage=data.stage,
            slug=data.slug,
        )
        if existing is not None:
            await self._finalize([existing], workspace_id)
            return existing
        config = await self.repo.create(
            name=data.name,
            slug=data.slug,
            agent_type=data.agent_type,
            team_role=data.team_role,
            stage=data.stage,
            content=data.content,
            team_id=data.team_id,
            workspace_id=workspace_id,
            created_by_id=created_by_id,
        )
        await self._finalize([config], workspace_id)
        try:
            await event_bus.publish(
                event_type=CONFIG_CHANGED,
                payload={"entity": "prompt_config", "action": "created", "entity_id": str(config.id)},
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish config.changed event")
        return config

    async def update_config(
        self,
        config_id: uuid.UUID,
        data: PromptConfigUpdate,
        workspace_id: uuid.UUID | None = None,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> AgentPromptConfig:
        if workspace_id is not None:
            await self.authorize_mutation(workspace_id, actor_id)
        config = await self.repo.get_by_id(config_id)
        if not config:
            raise ResourceNotFoundError("Prompt config not found")
        if (
            workspace_id is not None
            and config.workspace_id is not None
            and config.workspace_id != workspace_id
        ):
            raise ResourceNotFoundError("Prompt config not found")
        if config.workspace_id is None:
            await self._authorize_shared_mutation()
        elif workspace_id is None:
            await self.authorize_mutation(config.workspace_id, actor_id)

        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            await self._finalize([config], config.workspace_id)
            return config
        # Bump version on content change
        if "content" in update_data:
            update_data["version"] = config.version + 1
        updated = await self.repo.update(config, **update_data)
        await self._finalize([updated], updated.workspace_id)
        if updated.workspace_id:
            try:
                await event_bus.publish(
                    event_type=CONFIG_CHANGED,
                    payload={"entity": "prompt_config", "action": "updated", "entity_id": str(config_id)},
                    workspace_id=updated.workspace_id,
                )
            except Exception:
                logger.exception("Failed to publish config.changed event")
        return updated

    async def seed_defaults(
        self, workspace_id: uuid.UUID, created_by_id: uuid.UUID
    ) -> list[AgentPromptConfig]:
        """Seed system prompt defaults if none exist for this workspace. Idempotent."""
        existing = await self.repo.list_by_workspace(workspace_id)
        if any(c.is_system for c in existing):
            return existing

        from app.services.agents.prompt_defaults import get_prompt_defaults

        for d in get_prompt_defaults():
            await self.repo.create(
                name=d.slug,
                slug=d.slug,
                agent_type=None,
                team_role=d.role,
                stage=d.stage,
                content=d.default_content,
                team_id=None,
                workspace_id=workspace_id,
                created_by_id=created_by_id,
                is_system=True,
            )

        return await self.repo.list_by_workspace(workspace_id)

    async def export_config(
        self,
        config_id: uuid.UUID,
        workspace_id: uuid.UUID,
        workspace_slug: str,
    ) -> dict:
        from sqlalchemy import select

        from app.models.agents.team import AgentTeam
        from app.services.export.envelope import build_envelope

        config = await self.get_config(config_id, workspace_id=workspace_id)

        team_slug: str | None = None
        if config.team_id is not None:
            team_slug = await self.db.scalar(
                select(AgentTeam.slug).where(AgentTeam.id == config.team_id)
            )

        return build_envelope(
            entity_type="prompt_config",
            source_workspace_slug=workspace_slug,
            data={
                "slug": config.slug,
                "name": config.name,
                "agent_type": config.agent_type,
                "team_role": config.team_role,
                "stage": config.stage,
                "content": config.content,
                "team_slug": team_slug,
                "is_system": config.is_system,
                "version": config.version,
            },
        )

    async def delete_config(
        self,
        config_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        *,
        actor_id: uuid.UUID | None = None,
    ) -> None:
        if workspace_id is not None:
            await self.authorize_mutation(workspace_id, actor_id)
        config = await self.repo.get_by_id(config_id)
        if not config:
            raise ResourceNotFoundError("Prompt config not found")
        if (
            workspace_id is not None
            and config.workspace_id is not None
            and config.workspace_id != workspace_id
        ):
            raise ResourceNotFoundError("Prompt config not found")
        if config.workspace_id is None:
            await self._authorize_shared_mutation()
        elif workspace_id is None:
            await self.authorize_mutation(config.workspace_id, actor_id)

        owning_workspace_id = config.workspace_id
        await self.repo.delete(config)
        if owning_workspace_id:
            try:
                await event_bus.publish(
                    event_type=CONFIG_CHANGED,
                    payload={"entity": "prompt_config", "action": "deleted", "entity_id": str(config_id)},
                    workspace_id=owning_workspace_id,
                )
            except Exception:
                logger.exception("Failed to publish config.changed event")
