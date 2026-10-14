# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Rich capture as a mapping level: the backend's defaults for new mappings,
capability negotiation on the policy read, and what each device is told it
may capture (contract §2, §7)."""

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, update

from app.config import Settings, settings
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.git.git_repo import GitProvider, GitRepo
from app.schemas.companion import DevicePolicy
from app.schemas.session_content import (
    CAPABILITIES_HEADER,
    MappingEffectiveCapture,
    RichCaptureOffer,
)
from tests.rich_capture import (
    ME,
    POLICY,
    ROOT,
    enroll_rich,
)

from tests.test_companion import enroll

pytestmark = pytest.mark.usefixtures("content_storage")

MAPPINGS = "/api/companion/mappings"


async def installation_with_board_repo(client, test_board, db_session):
    db_session.add(
        GitRepo(
            board_id=test_board.id,
            workspace_id=test_board.workspace_id,
            name="Widgets",
            slug="widgets",
            url="https://github.com/acme/widgets",
            provider=GitProvider.github,
            added_by=test_board.created_by,
        )
    )
    await db_session.flush()
    return (await enroll(client)).json()


def device(installation) -> dict:
    return {"Authorization": "Bearer " + installation["device_token"]}


def test_one_content_level_vocabulary_serves_mappings_and_contents():
    """n1: the mapping level and the rich-capture contract share one type."""
    from app.schemas import companion, session_content

    assert companion.ContentLevel is session_content.ContentLevel


def test_rich_capture_is_off_unless_an_operator_turns_it_on(monkeypatch):
    monkeypatch.delenv("RICH_CAPTURE_ENABLED", raising=False)
    assert Settings(_env_file=None).RICH_CAPTURE_ENABLED is False


# --- new mapping defaults ----------------------------------------------------------


async def test_a_web_mapping_without_a_level_is_rich_since_its_creation(
    client, test_workspace, test_board, db_session
):
    installation = (await enroll(client)).json()
    before = datetime.now(timezone.utc)
    created = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(test_workspace.id), "root_path": ROOT},
    )
    assert created.status_code == 201, created.text
    assert created.json()["content_level"] == "rich"
    mapping = await db_session.get(
        CompanionProjectMapping, uuid.UUID(created.json()["id"])
    )
    assert mapping.rich_since is not None
    assert mapping.rich_since.replace(tzinfo=timezone.utc) >= before.replace(
        microsecond=0
    )


async def test_without_the_flag_new_mappings_keep_the_standard_default(
    client, test_workspace, monkeypatch, db_session
):
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    installation = (await enroll(client)).json()
    created = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={"workspace_id": str(test_workspace.id), "root_path": ROOT},
    )
    assert created.json()["content_level"] == "standard"
    mapping = await db_session.get(
        CompanionProjectMapping, uuid.UUID(created.json()["id"])
    )
    assert mapping.rich_since is None


@pytest.mark.parametrize("level", ["metadata", "standard", "full"])
async def test_an_explicit_level_is_kept_exactly(
    client, device_client, test_workspace, test_board, level
):
    installation = (await enroll(client)).json()
    web = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={
            "workspace_id": str(test_workspace.id),
            "root_path": ROOT,
            "content_level": level,
        },
    )
    assert web.json()["content_level"] == level
    bound = await device_client.post(
        MAPPINGS,
        json={
            "workspace_id": str(test_workspace.id),
            "board_id": str(test_board.id),
            "root_path": "/synthetic/other",
            "content_level": level,
        },
        headers=device(installation),
    )
    assert bound.status_code == 201, bound.text
    assert bound.json()["content_level"] == level


async def test_explicit_rich_without_the_flag_is_refused_on_every_route(
    client, device_client, test_workspace, test_board, monkeypatch
):
    installation = (await enroll(client)).json()
    standard = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": ROOT,
                "content_level": "standard",
            },
        )
    ).json()
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    attempts = [
        client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": "/synthetic/other",
                "content_level": "rich",
            },
        ),
        client.patch(
            f"{ME}/{installation['installation_id']}/mappings/{standard['id']}",
            json={"content_level": "rich"},
        ),
        device_client.post(
            MAPPINGS,
            json={
                "workspace_id": str(test_workspace.id),
                "board_id": str(test_board.id),
                "root_path": "/synthetic/third",
                "content_level": "rich",
            },
            headers=device(installation),
        ),
        device_client.patch(
            f"{MAPPINGS}/{standard['id']}",
            json={"content_level": "rich"},
            headers=device(installation),
        ),
    ]
    for attempt in attempts:
        response = await attempt
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "rich_capture_unavailable"


async def test_rich_since_follows_every_change_into_and_out_of_rich(
    client, test_workspace, db_session
):
    installation = (await enroll(client)).json()
    mapping = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": ROOT,
                "content_level": "full",
            },
        )
    ).json()
    path = f"{ME}/{installation['installation_id']}/mappings/{mapping['id']}"

    async def rich_since():
        row = await db_session.scalar(
            select(CompanionProjectMapping)
            .where(CompanionProjectMapping.id == uuid.UUID(mapping["id"]))
            .execution_options(populate_existing=True)
        )
        return row.rich_since

    assert await rich_since() is None
    await client.patch(path, json={"content_level": "rich"})
    granted = await rich_since()
    assert granted is not None
    await client.patch(path, json={"enabled": False})
    assert await rich_since() == granted
    await client.patch(path, json={"content_level": "standard"})
    assert await rich_since() is None
    await client.patch(path, json={"content_level": "rich"})
    assert await rich_since() > granted


async def test_auto_match_defaults_to_rich_unless_a_standing_choice_carries_over(
    client, device_client, test_board, db_session
):
    first = await installation_with_board_repo(client, test_board, db_session)
    matched = await device_client.post(
        MAPPINGS,
        json={"repo_url": "git@github.com:acme/widgets.git"},
        headers=device(first),
    )
    assert matched.status_code == 201, matched.text
    row = await db_session.get(CompanionProjectMapping, uuid.UUID(matched.json()["id"]))
    assert row.content_level == "rich"
    assert row.rich_since is not None

    await client.patch(
        f"{ME}/{first['installation_id']}/mappings/{matched.json()['id']}",
        json={"content_level": "metadata"},
    )
    second = (await enroll(client, name="Second laptop")).json()
    carried = await device_client.post(
        MAPPINGS,
        json={"repo_url": "https://github.com/acme/widgets"},
        headers=device(second),
    )
    assert carried.json()["content_level"] == "metadata"


async def test_a_carried_over_rich_choice_is_granted_afresh(
    client, device_client, test_board, db_session
):
    first = await installation_with_board_repo(client, test_board, db_session)
    await device_client.post(
        MAPPINGS, json={"repo_url": "github.com/acme/widgets"}, headers=device(first)
    )
    second = (await enroll(client, name="Second laptop")).json()
    carried = await device_client.post(
        MAPPINGS, json={"repo_url": "github.com/acme/widgets"}, headers=device(second)
    )
    row = await db_session.get(CompanionProjectMapping, uuid.UUID(carried.json()["id"]))
    assert (row.content_level, row.rich_since is not None) == ("rich", True)


async def test_device_routes_grant_and_clear_rich_since(
    client, device_client, test_workspace, test_board, db_session
):
    installation = (await enroll(client)).json()
    bound = await device_client.post(
        MAPPINGS,
        json={
            "workspace_id": str(test_workspace.id),
            "board_id": str(test_board.id),
            "root_path": ROOT,
            "content_level": "rich",
        },
        headers=device(installation),
    )
    assert bound.status_code == 201, bound.text
    mapping_id = uuid.UUID(bound.json()["id"])

    async def rich_since():
        row = await db_session.scalar(
            select(CompanionProjectMapping)
            .where(CompanionProjectMapping.id == mapping_id)
            .execution_options(populate_existing=True)
        )
        return row.rich_since

    granted = await rich_since()
    assert granted is not None
    path = f"{MAPPINGS}/{mapping_id}"
    await device_client.patch(
        path, json={"content_level": "standard"}, headers=device(installation)
    )
    assert await rich_since() is None
    await device_client.patch(
        path, json={"content_level": "rich"}, headers=device(installation)
    )
    assert await rich_since() > granted


async def test_existing_mappings_keep_their_level_when_the_default_changes(
    client, test_workspace, db_session
):
    installation = (await enroll(client)).json()
    mapping = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "root_path": ROOT,
                "content_level": "standard",
            },
        )
    ).json()
    listed = await client.get(f"{ME}/{installation['installation_id']}/mappings")
    [item] = listed.json()
    assert item["id"] == mapping["id"]
    assert item["content_level"] == "standard"
    assert item["capture"] == {
        "content_level": "standard",
        "effective_content_level": "standard",
        "reason": None,
    }


# --- negotiation and the offer --------------------------------------------------------


async def test_policy_offers_rich_capture_for_granted_mappings(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    response = await device_client.get(
        POLICY, headers={**enrolled["headers"], CAPABILITIES_HEADER: "rich_capture_v1"}
    )
    policy = DevicePolicy.model_validate(response.json())
    offer = RichCaptureOffer.model_validate(response.json()["rich_capture"])
    assert policy.rich_capture == offer
    assert [str(grant.mapping_id) for grant in offer.rich_mappings] == [
        enrolled["mapping_id"]
    ]
    assert (
        offer.limits.chunk_bytes * offer.limits.max_chunks
        >= offer.limits.max_text_body_bytes
    )
    [mapping] = response.json()["mappings"]
    assert mapping["content_level"] == "rich"
    assert mapping["capture"] == {
        "content_level": "rich",
        "effective_content_level": "rich",
        "reason": None,
    }


async def test_policy_records_capabilities_on_every_read_and_clears_them(
    client, device_client, db_session, test_workspace, test_board
):
    """m12: the latest policy read is the device's capability, both ways."""
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    installation_id = uuid.UUID(enrolled["installation_id"])

    async def stored():
        row = await db_session.scalar(
            select(CompanionInstallation)
            .where(CompanionInstallation.id == installation_id)
            .execution_options(populate_existing=True)
        )
        return row.capture_capabilities, row.capture_capabilities_at

    capabilities, seen_at = await stored()
    assert capabilities == ["rich_capture_v1"] and seen_at is not None
    # An unchanged announcement is not a write on every poll.
    await device_client.get(
        POLICY, headers={**enrolled["headers"], CAPABILITIES_HEADER: "rich_capture_v1"}
    )
    assert await stored() == (capabilities, seen_at)

    without = await device_client.get(POLICY, headers=enrolled["headers"])
    assert "rich_capture" in without.json()
    assert without.json()["rich_capture"] is None
    assert await stored() == (None, None)
    [mapping] = without.json()["mappings"]
    # An old companion maps an unknown level to metadata: it is told full.
    assert mapping["content_level"] == "full"
    assert mapping["capture"]["reason"] == "device_unsupported"


async def test_without_the_flag_no_offer_and_rich_mappings_capture_full(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    response = await device_client.get(
        POLICY, headers={**enrolled["headers"], CAPABILITIES_HEADER: "rich_capture_v1"}
    )
    assert response.json()["rich_capture"] is None
    [mapping] = response.json()["mappings"]
    assert mapping["content_level"] == "full"
    listed = await client.get(f"{ME}/{enrolled['installation_id']}/mappings")
    [item] = listed.json()
    assert item["content_level"] == "rich"
    assert MappingEffectiveCapture.model_validate(item["capture"]).reason == (
        "server_disabled"
    )


@pytest.mark.parametrize("change", [{"rich_since": None}, {"enabled": False}])
async def test_a_disabled_or_ungranted_rich_mapping_is_not_offered(
    client, device_client, db_session, test_workspace, test_board, change
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(enrolled["mapping_id"]))
        .values(**change)
    )
    await db_session.flush()
    response = await device_client.get(
        POLICY, headers={**enrolled["headers"], CAPABILITIES_HEADER: "rich_capture_v1"}
    )
    assert response.json()["rich_capture"]["rich_mappings"] == []


async def test_heartbeat_accepts_rich_capture_status_and_old_reports(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    report = {
        "companion_version": "0.9.1",
        "queue": {"pending": 0, "dropped_total": 0},
        "rich_capture": {
            "sources": [
                {
                    "harness": "claude_code",
                    "state": "stalled",
                    "detail": "waiting on /var/lib/agent/x.jsonl",
                }
            ],
            "spool": {"pending_bodies": 2, "pending_bytes": 1024, "failed_total": 0},
        },
    }
    response = await device_client.post(
        "/api/companion/status", json=report, headers=enrolled["headers"]
    )
    assert response.status_code == 200, response.text
    read = await client.get(f"{ME}/{enrolled['installation_id']}")
    stored = read.json()["status"]["rich_capture"]
    assert stored["sources"][0]["detail"] == "waiting on [path]"
    old = await device_client.post(
        "/api/companion/status",
        json={
            "companion_version": "0.8.0",
            "queue": {"pending": 0, "dropped_total": 0},
        },
        headers=enrolled["headers"],
    )
    assert old.status_code == 200, old.text


async def test_a_heartbeat_without_rich_capture_stores_no_such_member(
    client, device_client, db_session, test_workspace, test_board
):
    """The previous release rejects unknown members in a stored heartbeat, so
    a rollback must find none from a companion that sent no rich capture."""
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    response = await device_client.post(
        "/api/companion/status",
        json={
            "companion_version": "0.8.0",
            "queue": {"pending": 0, "dropped_total": 0},
        },
        headers=enrolled["headers"],
    )
    assert response.status_code == 200, response.text
    installation = await db_session.scalar(
        select(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .execution_options(populate_existing=True)
    )
    assert "rich_capture" not in installation.last_status


async def test_with_rich_capture_off_a_heartbeat_keeps_no_rich_capture_member(
    client, device_client, db_session, test_workspace, test_board, monkeypatch
):
    """A companion still holding its last offer reports rich capture after the
    switch went off; storing that would undo a rollback's cleanup."""
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    monkeypatch.setattr(settings, "RICH_CAPTURE_ENABLED", False)
    response = await device_client.post(
        "/api/companion/status",
        json={
            "companion_version": "0.9.1",
            "queue": {"pending": 0, "dropped_total": 0},
            "rich_capture": {
                "sources": [],
                "spool": {"pending_bodies": 0, "pending_bytes": 0, "failed_total": 0},
            },
        },
        headers=enrolled["headers"],
    )
    assert response.status_code == 200, response.text
    installation = await db_session.scalar(
        select(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .execution_options(populate_existing=True)
    )
    assert "rich_capture" not in installation.last_status
