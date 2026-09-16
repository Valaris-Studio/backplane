# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fit, preview and bind must agree on the proposed execution contract."""

from copy import deepcopy
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.models.config_template import BoardLoopTemplateBinding, ConfigTemplate
from app.models.workspace_config import WorkspaceConfig
from app.services.loop_template_render import SlotSpec, SlotVariant, TemplateContent
from app.services.loop_templates._types import SystemTemplate
from tests.test_landing_completion_policy import policy, save_policy

pytestmark = pytest.mark.anyio


def content(**changes):
    values = {
        "system_prompt": "Execute the board's mandatory completion contract. Default branch: <<DEFAULT_BRANCH>>.",
        "loop_prompt": "Implement <<RUN_LABEL>>. Open the PR into <<INTEGRATION_BRANCH>>.",
        "slots": [
            SlotSpec(name="RUN_LABEL", kind="scalar", required=True),
            SlotSpec(name="DEFAULT_BRANCH", kind="scalar", default="main"),
            SlotSpec(name="INTEGRATION_BRANCH", kind="scalar", default="integration"),
        ],
        "tools": [
            "mcp__valaris__set_board_loop", "mcp__valaris__get_completion_policy",
            "mcp__valaris__get_completion_status", "mcp__valaris__submit_completion_candidate",
            "mcp__valaris__request_landing", "mcp__valaris__retry_completion",
        ],
        "rails_defaults": {"loop_landing": "merge_queue", "provider": "template-provider", "model": "template-model"},
        "derived_rails": {"completion_query": {"label": "<<RUN_LABEL>>"}},
    }
    values.update(changes)
    return TemplateContent(**values)


NEUTRAL = SystemTemplate(slug="test-policy-neutral", version=3, name="Policy neutral", content=content(), profile={})
DISTINCT = SystemTemplate(
    slug="test-distinct-branches", version=3, name="Distinct branches",
    content=content(setup_contract={"branch_constraints": [
        {"kind": "distinct", "slots": ["DEFAULT_BRANCH", "INTEGRATION_BRANCH"]},
    ]}), profile={},
)
SELF_MERGE = SystemTemplate(
    slug="test-self-merge-contract", version=3, name="Self merge",
    content=content(
        loop_prompt="Implement <<RUN_LABEL>>; run git merge --no-ff into <<INTEGRATION_BRANCH>>, push, then move Done.",
        rails_defaults={"loop_landing": "self_merge", "merge_gate": "none"},
    ), profile={},
)


@pytest.fixture(autouse=True)
def templates():
    from app.services import loop_templates as registry

    original = registry.get_system_template
    doubles = {t.slug: t for t in (NEUTRAL, DISTINCT, SELF_MERGE)}

    def lookup(slug):
        return doubles.get(slug) or original(slug)

    with (
        patch("app.services.loop_template.get_system_template", side_effect=lookup),
        patch("app.services.kanban.loop_binding.get_system_template", side_effect=lookup),
    ):
        yield


def board_url(board):
    return f"/api/workspaces/default/boards/{board.id}"


def rehearsal_url(board, template, view):
    ref = template.slug if isinstance(template, SystemTemplate) else template.id
    return f"{board_url(board)}/loop-templates/{ref}/{view}"


def bind_body(template=NEUTRAL, **extra):
    return {
        "enabled": False,
        "template": {"source": "system", "ref": template.slug, "version": template.version,
                     "slot_values": {"RUN_LABEL": "proposed-run"}},
        **extra,
    }


async def assert_unbound(db, board, saved):
    await db.refresh(board)
    assert board.loop_config == saved
    assert await db.scalar(select(BoardLoopTemplateBinding).where(
        BoardLoopTemplateBinding.board_id == board.id,
    )) is None


async def test_system_bind_refuses_unavailable_requested_version_without_writes(client, db_session, test_board):
    before = deepcopy(test_board.loop_config)
    body = bind_body()
    body["template"]["version"] = NEUTRAL.version - 1
    response = await client.put(f"{board_url(test_board)}/loop", json=body)
    assert response.status_code == 409, response.text
    assert "version" in response.text.lower()
    await assert_unbound(db_session, test_board, before)


@pytest.mark.parametrize("view", ["fit", "preview"])
async def test_system_rehearsal_refuses_unavailable_version_without_writes(client, db_session, test_board, view):
    before = deepcopy(test_board.loop_config)
    response = await client.post(rehearsal_url(test_board, NEUTRAL, view), json={
        "slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": NEUTRAL.version - 1,
    })
    assert response.status_code == 409, response.text
    await assert_unbound(db_session, test_board, before)


async def test_workspace_published_preview_and_bind_ignore_pending_draft(client, db_session, test_board, test_workspace, test_user):
    published = content().model_dump()
    draft = deepcopy(published)
    published["system_prompt"] = "PUBLISHED mandatory contract"
    draft["system_prompt"] = "UNPUBLISHED draft instructions"
    template = ConfigTemplate(
        workspace_id=test_workspace.id, kind="loop", slug="published-completion",
        name="Published completion", version=2, content=published, profile={},
        draft_content=draft, draft_profile={}, created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()
    preview = await client.post(rehearsal_url(test_board, template, "preview"), json={
        "slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": 2,
    })
    assert preview.status_code == 200, preview.text
    bound = await client.put(f"{board_url(test_board)}/loop", json={
        "enabled": False, "template": {"source": "workspace", "ref": str(template.id),
        "version": 2, "slot_values": {"RUN_LABEL": "proposed-run"}},
    })
    assert bound.status_code == 200, bound.text
    assert preview.json()["template"]["version"] == bound.json()["template"]["version"] == 2
    assert preview.json()["system_prompt"] == bound.json()["system_prompt"] == "PUBLISHED mandatory contract"


@pytest.mark.parametrize("view", ["fit", "preview"])
async def test_proposed_loop_config_validation_reports_findings_without_writes(client, db_session, test_board, view):
    before = deepcopy(test_board.loop_config)
    response = await client.post(rehearsal_url(test_board, NEUTRAL, view), json={
        "slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": 3,
        "loop_config": {"loop_landing": "invented-strategy"},
    })
    assert response.status_code == 200, response.text
    data = response.json()
    if view == "preview":
        assert any(f.get("code") == "invalid_loop_landing" for f in data["findings"]), data
    else:
        assert any(c["id"] == "loop_config" and c["status"] == "warn" for c in data["checks"]), data
        assert "loop_landing" in str(data["checks"])
    await assert_unbound(db_session, test_board, before)


async def test_invalid_proposed_loop_config_is_rejected_before_binding_mutation(client, db_session, test_board):
    before = deepcopy(test_board.loop_config)
    response = await client.put(f"{board_url(test_board)}/loop", json=bind_body(loop_landing="invented-strategy"))
    assert response.status_code == 422, response.text
    await assert_unbound(db_session, test_board, before)


async def test_explicit_policy_conflicting_with_rendered_landing_is_a_fit_warning(client, db_session, test_board, test_git_repo):
    await save_policy(client, test_board, policy(landing_actor="human", landing_methods=["external"], auto_complete=False))
    before = deepcopy(test_board.loop_config)
    response = await client.post(rehearsal_url(test_board, SELF_MERGE, "fit"), json={
        "slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": 3,
    })
    assert response.status_code == 200, response.text
    conflicts = [c for c in response.json()["checks"] if c["id"] == "completion_policy"]
    assert conflicts and conflicts[0]["status"] == "warn", response.text
    assert "human" in conflicts[0]["evidence"]
    assert "self_merge" in conflicts[0]["evidence"]
    await assert_unbound(db_session, test_board, before)


async def test_explicit_policy_cannot_bind_contradictory_source_completion_prose(client, db_session, test_board, test_git_repo):
    await save_policy(client, test_board, policy(landing_actor="human", landing_methods=["external"], auto_complete=False))
    before = deepcopy(test_board.loop_config)
    response = await client.put(f"{board_url(test_board)}/loop", json=bind_body(SELF_MERGE))
    assert response.status_code in (409, 422), response.text
    assert "completion" in response.text.lower()
    await assert_unbound(db_session, test_board, before)


@pytest.mark.parametrize("via_variant", [False, True])
async def test_branch_constraint_checks_resolved_values_before_binding(client, db_session, test_board, via_variant):
    selected = DISTINCT
    values = {"RUN_LABEL": "proposed-run", "INTEGRATION_BRANCH": "main"}
    if via_variant:
        selected = deepcopy(DISTINCT)
        selected.content.slots.append(SlotSpec(name="TARGET", kind="variant", default="same", variants=[
            SlotVariant(id="same", label="Same", fills={"INTEGRATION_BRANCH": "main"}),
        ]))
        values = {"RUN_LABEL": "proposed-run"}
    before = deepcopy(test_board.loop_config)
    with (
        patch("app.services.loop_template.get_system_template", return_value=selected),
        patch("app.services.kanban.loop_binding.get_system_template", return_value=selected),
    ):
        fit = await client.post(rehearsal_url(test_board, selected, "fit"), json={
            "slot_values": values, "draft": False, "version": selected.version,
        })
        assert fit.status_code == 200, fit.text
        assert any(c["id"] == "branch_constraints" and c["status"] == "warn" for c in fit.json()["checks"]), fit.text
        body = bind_body(selected)
        body["template"]["slot_values"] = values
        bound = await client.put(f"{board_url(test_board)}/loop", json=body)
    assert bound.status_code in (409, 422), bound.text
    assert "branch" in bound.text.lower()
    await assert_unbound(db_session, test_board, before)


async def test_no_implicit_ban_on_default_branch_for_policy_compatible_template(client, test_board, test_git_repo):
    await save_policy(client, test_board, policy())
    body = bind_body()
    body["template"]["slot_values"]["INTEGRATION_BRANCH"] = "main"
    response = await client.put(f"{board_url(test_board)}/loop", json=body)
    assert response.status_code == 200, response.text
    assert "PR into main" in response.json()["loop_prompt"]


async def test_preview_and_bind_preserve_arbitrary_role_provider_and_per_role_model(client, db_session, test_workspace, test_board, test_git_repo):
    role = "architecture_and_performance_assessor"
    config = await db_session.scalar(select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == test_workspace.id))
    if config is None:
        config = WorkspaceConfig(workspace_id=test_workspace.id)
        db_session.add(config)
    config.pipeline_config = {"stages": [{"role": role, "enabled": True,
        "llm": {"provider": "operator-review-provider", "model": "review-model-v42"}}]}
    await db_session.flush()
    expected = policy(landing_actor="platform", source_review="independent", review_role=role)
    await save_policy(client, test_board, expected)
    rails = {"provider": "operator-source-provider", "model": "source-model-v19"}
    response = await client.post(rehearsal_url(test_board, NEUTRAL, "preview"), json={
        "slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": 3, "loop_config": rails,
    })
    assert response.status_code == 200, response.text
    assert response.json()["rails"]["provider"] == rails["provider"]
    assert response.json()["rails"]["model"] == rails["model"]
    bound = await client.put(f"{board_url(test_board)}/loop", json=bind_body(**rails))
    assert bound.status_code == 200, bound.text
    assert bound.json()["provider"] == rails["provider"]
    assert bound.json()["model"] == rails["model"]
    resolved = await client.get(f"{board_url(test_board)}/completion/policy")
    assert resolved.json()["effective_policy"] == expected
    await db_session.refresh(config)
    assert config.pipeline_config["stages"][0]["llm"] == {"provider": "operator-review-provider", "model": "review-model-v42"}


async def test_maintained_coding_template_renders_explicit_policy_without_legacy_merge_instructions(client, test_board, test_git_repo):
    await save_policy(client, test_board, policy(landing_actor="human", landing_methods=["external"], auto_complete=False))
    response = await client.post(f"{board_url(test_board)}/loop-templates/coding-loop-easy/preview", json={
        "slot_values": {"RUN_LABEL": "current", "INTEGRATION_BRANCH": "feature-integration"}, "draft": False,
    })
    assert response.status_code == 200, response.text
    rendered = response.json()
    text = rendered["system_prompt"] + rendered["loop_prompt"]
    assert "submit_completion_candidate" in text
    assert "get_completion_status" in text
    assert "merge it yourself" not in text
    assert "self_merge" != rendered["rails"]["loop_landing"]
    assert "mcp__valaris__submit_completion_candidate" in rendered["tools"]


async def test_existing_legacy_binding_requires_policy_rerender_but_proposed_policy_prompts_are_valid(client, db_session, test_board):
    from app.schemas.completion import CompletionPolicyV1
    from app.services import loop_template_completion as completion_templates
    from app.services.loop_template_render import render
    from app.services.loop_templates import get_system_template

    template = get_system_template("coding-loop-easy")
    values = {"RUN_LABEL": "current", "INTEGRATION_BRANCH": "integration"}
    response = await client.put(f"{board_url(test_board)}/loop", json={
        "enabled": False, "template": {"source": "system", "ref": template.slug,
        "version": template.version, "slot_values": values},
    })
    assert response.status_code == 200, response.text
    await db_session.refresh(test_board)
    selected = CompletionPolicyV1(**policy())
    findings = await completion_templates.template_policy_incompatibilities(db_session, test_board, selected)
    assert findings[0]["code"] == "completion_template_rebind_required"
    candidate = render(completion_templates.content_for_policy(template.content, selected), values)
    proposed = {"system_prompt": candidate.system_prompt, "loop_prompt": candidate.loop_prompt}
    assert await completion_templates.template_policy_incompatibilities(db_session, test_board, selected, loop_config=proposed) == []
    assert await completion_templates.template_policy_incompatibilities(db_session, test_board, None) == []


async def test_policy_rerender_replaces_legacy_landing_default_without_overwriting_explicit_rails(client, db_session, test_board, test_git_repo):
    from app.services.loop_templates import get_system_template

    template = get_system_template("coding-loop-easy")
    body = {"enabled": False, "budget_usd": 42, "template": {"source": "system", "ref": template.slug,
        "version": template.version, "slot_values": {"RUN_LABEL": "current", "INTEGRATION_BRANCH": "integration"}}}
    assert (await client.put(f"{board_url(test_board)}/loop", json=body)).status_code == 200
    response = await client.put(f"{board_url(test_board)}/loop", json={**body, "completion_policy": policy()})
    assert response.status_code == 200, response.text
    assert response.json()["loop_landing"] == "merge_queue"
    assert response.json()["budget_usd"] == 42
