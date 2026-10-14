# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A session's working directory is the bound folder's name plus the path
inside it, never a path of the device (card d360089d)."""

import copy
import json

import pytest
from sqlalchemy import select, update

from app.models.agent_session import AgentSession, AgentSessionEvent
from tests.test_agent_sessions import SESSIONS
from tests.test_companion_ingest import (
    FIXTURE_EVENTS,
    ME,
    _set_root_path,
    _store_cwd_at_level,
    device_client as device_client_fixture,
    enrolled as enrolled_fixture,
    ingest,
    only_session,
    record,
)

device_client = device_client_fixture
enrolled = enrolled_fixture
ABOVE_METADATA = pytest.mark.parametrize("level", ["standard", "full"])
# Assembled so the source never spells a real home path.
HOME = "/" + "Users/me"


@ABOVE_METADATA
@pytest.mark.parametrize(
    "root_path,working_directory,expected",
    [
        (
            "/synthetic/project",
            "/synthetic/project/packages/api",
            "project/packages/api",
        ),
        ("/synthetic/project", "/synthetic/project/", "project"),
        ("/synthetic/project", ".", "project"),
        # A companion that already placed the path sends it relative to the root.
        ("/synthetic/project", "packages/api", "project/packages/api"),
        ("/synthetic/project", "file:///synthetic/project/src", "project/src"),
        (
            "C:\\code\\storefront-api",
            "C:\\code\\storefront-api\\src\\billing",
            "storefront-api/src/billing",
        ),
        ("C:\\code\\storefront-api", "src\\billing", "storefront-api/src/billing"),
        ("\\\\server\\share\\proj", "\\\\server\\share\\proj\\api", "proj/api"),
        ("\\\\server\\share\\proj", "\\\\?\\UNC\\server\\share\\proj\\api", "proj/api"),
        # Spaces kept such a path from being recognised as one.
        (
            HOME + "/My Projects/app",
            HOME + "/My Projects/app/src",
            "app/src",
        ),
    ],
)
async def test_working_directory_is_the_folder_name_and_path_inside_it(
    client,
    device_client,
    enrolled,
    db_session,
    level,
    root_path,
    working_directory,
    expected,
):
    await _set_root_path(db_session, enrolled, root_path)
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, level, working_directory
    )
    assert (stored, session_cwd) == (expected, expected)


@ABOVE_METADATA
@pytest.mark.parametrize(
    "working_directory,expected",
    [
        ("/synthetic/elsewhere/tool", "tool"),
        (HOME + "/Other Things/scratch", "scratch"),
        ("D:\\other\\repo", "repo"),
        ("\\\\nas\\team\\shared", "shared"),
        ("../sibling", "sibling"),
    ],
)
async def test_a_folder_outside_the_mapping_keeps_only_its_name(
    client, device_client, enrolled, db_session, level, working_directory, expected
):
    stored, session_cwd = await _store_cwd_at_level(
        client, device_client, enrolled, db_session, level, working_directory
    )
    assert (stored, session_cwd) == (expected, expected)
    rows = [row.event for row in await db_session.scalars(select(AgentSessionEvent))]
    assert "synthetic/elsewhere" not in json.dumps(rows)
    assert "Other Things" not in json.dumps(rows)


async def test_exclusions_still_judge_the_path_inside_the_mapping(
    client, device_client, enrolled
):
    installation_id = enrolled["installation"]["installation_id"]
    await client.patch(
        f"{ME}/{installation_id}/policy", json={"exclude_globs": ["packages/*"]}
    )
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    event["session"]["working_directory"] = "/synthetic/project/packages/api"
    response = await ingest(
        device_client, enrolled, [record([event], enrolled["mapping"]["id"])]
    )
    assert response.json()["rejected"][0]["reason"] == "excluded"


@pytest.mark.parametrize(
    "legacy,expected",
    [
        (HOME + "/code/app/src", "src"),
        ("C:\\Users\\me\\code\\app", "app"),
        ("\\\\server\\share\\app", "app"),
        ("file:///home/me/app", "app"),
        # Relative values were already placed; they stay.
        ("packages/api", "packages/api"),
    ],
)
async def test_absolute_paths_stored_before_are_reduced_on_read(
    client, device_client, enrolled, db_session, legacy, expected
):
    event = copy.deepcopy(FIXTURE_EVENTS[0])
    await ingest(device_client, enrolled, [record([event], enrolled["mapping"]["id"])])
    await db_session.execute(update(AgentSession).values(cwd=legacy))
    stored = await db_session.scalar(select(AgentSessionEvent))
    data = copy.deepcopy(stored.event)
    data["session"]["working_directory"] = legacy
    await db_session.execute(
        update(AgentSessionEvent)
        .where(AgentSessionEvent.id == stored.id)
        .values(event=data)
    )
    await db_session.flush()

    [listed] = (await client.get(SESSIONS)).json()["items"]
    detail = (await client.get(f"{SESSIONS}/{listed['id']}")).json()
    [event_read] = (await client.get(f"{SESSIONS}/{listed['id']}/events")).json()[
        "items"
    ]
    assert listed["cwd"] == detail["cwd"] == expected
    assert event_read["data"]["session"]["working_directory"] == expected
    assert (await only_session(db_session)).cwd == legacy
