# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Resolve a stage's LLM dispatch (provider/model/prompt_slug/tool_policy/schema).

Two representations carry the same knobs and the precedence between them is the
whole point of this module: the frontend pipeline builder writes provider,
model, tool_policy and output_schema into the stage's lifecycle `llm` step
params, while `workspace_config.DEFAULT_PIPELINE_CONFIG` authors the flat
`stage.llm` block. Reading only one of them has broken production twice, so the
precedence lives in one place with the incidents that produced it.
"""

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.prompt_config import AgentPromptConfig
from app.schemas.agents.assignment import AssignmentLLM, AssignmentToolPolicy
from app.services.llm_tiers import is_tier, resolve_tier

logger = logging.getLogger(__name__)


class DispatchResolver:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def resolve(
        self,
        *,
        stage: dict,
        workspace_id: uuid.UUID,
        role: str,
    ) -> AssignmentLLM:
        """Build the assignment's `llm` block for the stage the runner claimed.

        The stage's llm.provider+model are backend-authoritative defaults from
        workspace_config.DEFAULT_PIPELINE_CONFIG; the prompt_slug falls back to
        the stage name when no operator-authored AgentPromptConfig matches
        (role + stage). The runner's yaml fallback is a one-deploy safety net.

        Authoritative source resolution (card b8024b15 split-brain): the pipeline
        builder writes provider/model/stage into the lifecycle llm-step params,
        not the flat stage.llm block, so reading flat alone emitted an empty model
        and the runner silently fell back to its yaml default. We read both
        representations field-by-field so neither wins by accident.
        """
        stage_llm = stage.get("llm") or {}
        lifecycle_llm_params = _lifecycle_llm_params(stage)

        stage_name = stage_llm.get("stage") or lifecycle_llm_params.get("stage") or ""
        prompt_slug = await self._resolve_prompt_slug(
            workspace_id=workspace_id,
            role=role,
            stage_name=stage_name,
        )

        # Tier-aware provider/model resolution: when the model names a tier
        # (premium/mid/low) we translate to a concrete (provider, model) tuple. A
        # literal model name (sonnet/opus/haiku) passes through with a deprecation
        # warning so older persisted configs keep working.
        # The frontend pipeline builder writes provider/model into the lifecycle
        # llm-step params; the flat stage.llm block carries the backend DEFAULT. When
        # both are present and DISAGREE (e.g. an operator bumps the lifecycle step to
        # 'premium' but the stale flat default still says 'mid'), the frontend-
        # authored lifecycle value is authoritative — reading flat-first silently
        # shadowed the edit and ran sonnet against a premium implementer (M1-05,
        # 2026-05-26). Prefer lifecycle, fall back to flat for configs that only have
        # the flat block (backend-default-only / pre-lifecycle).
        raw_provider = (
            lifecycle_llm_params.get("provider") or stage_llm.get("provider") or ""
        )
        raw_model = lifecycle_llm_params.get("model") or stage_llm.get("model") or ""
        # Forward the raw tier name (premium/mid/low) so a provider-agnostic runner
        # can remap it to a locally-available coding agent; empty for concrete or
        # literal models, which leave the runner nothing to remap.
        stage_tier = raw_model if is_tier(raw_model) else ""
        resolved_provider, resolved_model = raw_provider, raw_model
        if raw_model:
            try:
                resolved_provider, resolved_model = resolve_tier(
                    raw_model, workspace_id=workspace_id
                )
            except ValueError:
                logger.warning(
                    "next_assignment: stage llm.model %r is neither a known tier "
                    "nor a literal — passing through verbatim",
                    raw_model,
                )
        # Fail loud rather than silent: an enabled LLM stage with no model anywhere
        # is a config bug. Emitting an empty model lets the runner fall back to its
        # yaml default (the bug that ran sonnet against a premium-configured planner
        # on the client pilot 2026-05-25). The yaml fallback is a one-deploy safety net,
        # not a steady state — surface the misconfiguration in the backend logs.
        llm_enabled = bool(
            stage_llm.get("enabled")
            or lifecycle_llm_params.get("enabled", bool(lifecycle_llm_params))
        )
        if llm_enabled and not resolved_model:
            logger.error(
                "next_assignment: enabled LLM stage declares no model "
                "(workspace_id=%s role=%s stage=%s) — neither flat stage.llm.model "
                "nor lifecycle llm params carry one; runner will fall back to its "
                "yaml default. Fix the workspace pipeline_config.",
                workspace_id,
                role,
                stage_name or "?",
            )
        # Per-stage tool deny-list (security floor protecting the review gate).
        # Lifecycle-first to match provider/model resolution: the frontend builder
        # writes tool_policy into the lifecycle step, so it wins when present; flat
        # is the backend-default fallback. Opaque to the backend: we carry the
        # strings verbatim for the runner's --disallowedTools.
        flat_deny = (stage_llm.get("tool_policy") or {}).get("deny")
        lifecycle_deny = (lifecycle_llm_params.get("tool_policy") or {}).get("deny")
        tool_deny = lifecycle_deny if lifecycle_deny is not None else (flat_deny or [])
        # Per-stage output schema (same lifecycle-first resolution as tool_policy).
        # A produces_decision stage whose decision enum differs from the default
        # approve/request_changes envelope (e.g. board_reconciler's
        # supersede/no_action/repair/park) declares it; the runner uses it instead of
        # its built-in decisionOutputSchema. Empty for every other stage.
        flat_schema = stage_llm.get("output_schema")
        lifecycle_schema = lifecycle_llm_params.get("output_schema")
        output_schema = (
            lifecycle_schema if lifecycle_schema is not None else (flat_schema or "")
        )

        return AssignmentLLM(
            provider=resolved_provider,
            model=resolved_model,
            prompt_slug=prompt_slug,
            tier=stage_tier,
            tool_policy=AssignmentToolPolicy(deny=tool_deny),
            output_schema=output_schema,
        )

    async def _resolve_prompt_slug(
        self,
        *,
        workspace_id: uuid.UUID,
        role: str,
        stage_name: str,
    ) -> str:
        """Pick the slug the runner should render for (role, stage).

        Prefers a workspace-scoped AgentPromptConfig (team_role=role, stage=stage)
        over system defaults; falls back to the stage name when no row matches.
        The stage-name fallback mirrors the runner's historical convention of
        keying prompt cache by stage and keeps existing pipelines working without
        an explicit operator override.
        """
        if not stage_name:
            return ""

        stmt = (
            select(AgentPromptConfig.slug)
            .where(
                AgentPromptConfig.stage == stage_name,
                AgentPromptConfig.team_role == role,
                (AgentPromptConfig.workspace_id == workspace_id)
                | (AgentPromptConfig.workspace_id.is_(None)),
            )
            .order_by(
                AgentPromptConfig.workspace_id.is_(None).asc(),
                AgentPromptConfig.created_at.asc(),
            )
            .limit(1)
        )
        slug = await self.db.scalar(stmt)
        return slug or stage_name


def _lifecycle_llm_params(stage: dict) -> dict:
    """Return the params of the stage's first lifecycle `llm` step, or {}.

    The pipeline builder (frontend) writes provider/model/stage into this
    lifecycle step's params rather than the flat stage.llm block — a split-brain
    that left the flat block empty and broke per-stage model dispatch (card
    b8024b15). Reading both lets either representation supply the value.
    """
    lifecycle = stage.get("lifecycle")
    if not isinstance(lifecycle, list):
        return {}
    for step in lifecycle:
        if isinstance(step, dict) and step.get("kind") == "llm":
            params = step.get("params")
            return params if isinstance(params, dict) else {}
    return {}
