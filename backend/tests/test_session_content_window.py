# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import copy
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, insert, select, update

from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.workspace import WorkspaceMember, WorkspaceRole
from tests.rich_capture import (
    declaration,
    enroll_rich,
    ingest,
    rich_record,
    sessions_path,
)
from tests.test_agent_sessions import as_user

pytestmark = pytest.mark.usefixtures("content_storage")
START = datetime(2026, 10, 8, 14, 4, 20, 123456, tzinfo=timezone.utc)


@dataclass
class SeededContents:
    path: str
    session_id: uuid.UUID
    rows: list[dict]
    template: dict
    enrolled: dict


@pytest.fixture
async def seed_contents(client, device_client, db_session, test_workspace, test_board):
    async def seed(count=1):
        enrolled = await enroll_rich(
            client,
            device_client,
            db_session,
            test_workspace,
            test_board,
            root=f"/synthetic/window-{uuid.uuid4().hex}",
        )
        await ingest(
            device_client,
            enrolled,
            [
                rich_record(
                    enrolled["mapping_id"], [declaration(b"synthetic private preview")]
                )
            ],
        )
        original = await db_session.scalar(
            select(AgentSessionContent).where(
                AgentSessionContent.installation_id
                == uuid.UUID(enrolled["installation_id"])
            )
        )
        template = {
            column.name: copy.deepcopy(getattr(original, column.name))
            for column in AgentSessionContent.__table__.columns
        }
        session_id = original.session_id
        await db_session.execute(
            delete(AgentSessionContent).where(
                AgentSessionContent.session_id == session_id
            )
        )
        namespace = uuid.uuid4().int & ~((1 << 32) - 1)
        rows = [
            {
                **copy.deepcopy(template),
                "id": uuid.UUID(int=namespace + index + 1),
                "content_key": f"{index:064x}",
                "source_order": 10_000 + index // 3,
                "occurred_at": START + timedelta(seconds=index // 30),
                "call_key": f"call-{index // 2}",
            }
            for index in range(count)
        ]
        # One real ingest supplies valid ownership/generation fields. Bulk seed
        # only the read corpus, keeping the 10,001-row case out of ingest tests.
        if rows:
            await db_session.execute(insert(AgentSessionContent), rows)
        await db_session.execute(
            update(AgentSession)
            .where(AgentSession.id == session_id)
            .values(content_count=count, content_bytes=count * template["byte_count"])
        )
        await db_session.flush()
        return SeededContents(
            f"{sessions_path(test_workspace, session_id)}/contents",
            session_id,
            rows,
            template,
            enrolled,
        )

    return seed


async def add_content(db_session, seeded, **values):
    row = {
        **copy.deepcopy(seeded.template),
        "id": uuid.uuid4(),
        "content_key": uuid.uuid4().hex * 2,
        "occurred_at": START,
        "source_order": 20_000,
        **values,
    }
    await db_session.execute(insert(AgentSessionContent), [row])
    await db_session.flush()
    return row


def ids(rows):
    return [str(row["id"]) for row in rows]


def wire_order(item):
    return (
        datetime.fromisoformat(item["occurred_at"].replace("Z", "+00:00")),
        item["source"]["order"],
        uuid.UUID(item["id"]).int,
    )


async def window(client, seeded, *, mode="latest", **params):
    response = await client.get(
        f"{seeded.path}/window", params={"mode": mode, **params}
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    result = response.json()
    assert result["capability"] == "content-window-v1"
    assert result["mode"] == mode
    assert len(result["items"]) <= 100
    assert result["items"] == sorted(result["items"], key=wire_order)
    assert isinstance(result["window_cursor"], str)
    for name in ("earlier_cursor", "later_cursor", "window_cursor"):
        assert result[name] is None or len(result[name]) <= 512
    assert "anchor_id" in result
    return result


def encoded(value):
    return (
        base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )


def decoded(cursor):
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))


def replace_scalar(value, predicate, replacement):
    if isinstance(value, dict):
        return {
            key: replace_scalar(item, predicate, replacement)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [replace_scalar(item, predicate, replacement) for item in value]
    return replacement if predicate(value) else value


@pytest.mark.parametrize("mode", ["latest", "beginning"])
async def test_window_seeks_directly_to_a_bounded_end_of_10001_records(
    client, seed_contents, mode
):
    seeded = await seed_contents(10_001)
    result = await window(client, seeded, mode=mode)
    expected = seeded.rows[-100:] if mode == "latest" else seeded.rows[:100]
    assert ids(result["items"]) == ids(expected)
    assert result["anchor_id"] is None
    assert bool(result["earlier_cursor"]) is (mode == "latest")
    assert bool(result["later_cursor"]) is (mode == "beginning")


async def test_window_defaults_to_latest_and_echoes_its_capability(
    client, seed_contents
):
    seeded = await seed_contents(103)
    response = await client.get(f"{seeded.path}/window")
    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "latest"
    assert response.json()["capability"] == "content-window-v1"
    assert ids(response.json()["items"]) == ids(seeded.rows[-100:])


@pytest.mark.parametrize(
    "direction,initial,cursor_name",
    [
        ("earlier", "latest", "earlier_cursor"),
        ("later", "beginning", "later_cursor"),
    ],
)
async def test_fixed_corpus_with_tied_tuples_traverses_once_in_both_directions(
    client, seed_contents, direction, initial, cursor_name
):
    seeded = await seed_contents(251)
    result = await window(client, seeded, mode=initial)
    visited = ids(result["items"])
    pages = 1
    while result[cursor_name] is not None:
        assert pages < 4, "A keyset cursor must make progress"
        result = await window(
            client, seeded, mode=direction, cursor=result[cursor_name]
        )
        page = ids(result["items"])
        assert not set(page).intersection(visited)
        visited = page + visited if direction == "earlier" else visited + page
        pages += 1
    assert pages == 3
    assert visited == ids(seeded.rows)


@pytest.mark.parametrize("position", [0, 110, 220])
async def test_anchor_returns_49_before_exact_record_and_50_after_with_edge_underfill(
    client, seed_contents, position
):
    seeded = await seed_contents(221)
    anchor_id = str(seeded.rows[position]["id"])
    result = await window(client, seeded, mode="anchor", anchor_id=anchor_id)
    assert result["anchor_id"] == anchor_id
    assert ids(result["items"]) == ids(
        seeded.rows[max(0, position - 49) : position + 51]
    )
    assert bool(result["earlier_cursor"]) is (position > 49)
    assert bool(result["later_cursor"]) is (position + 51 < len(seeded.rows))


async def test_missing_and_other_session_anchors_are_indistinguishable_content_errors(
    client, seed_contents
):
    seeded = await seed_contents()
    foreign = await seed_contents()
    await window(client, seeded)
    missing = await client.get(
        f"{seeded.path}/window",
        params={"mode": "anchor", "anchor_id": str(uuid.uuid4())},
    )
    crossed = await client.get(
        f"{seeded.path}/window",
        params={"mode": "anchor", "anchor_id": str(foreign.rows[0]["id"])},
    )
    assert crossed.status_code == missing.status_code == 404
    assert crossed.json() == missing.json()
    assert crossed.json()["error_code"] == "content_not_found"
    assert "synthetic private preview" not in crossed.text


@pytest.mark.parametrize(
    "params",
    [
        {"mode": "anchor"},
        {"mode": "earlier"},
        {"mode": "later"},
        {"mode": "refresh"},
        {"mode": "latest", "cursor": "unexpected"},
        {"mode": "beginning", "anchor_id": str(uuid.UUID(int=1))},
        {"mode": "anchor", "anchor_id": str(uuid.UUID(int=1)), "cursor": "unexpected"},
        {"mode": "around"},
        {"mode": "anchor", "anchor_id": "not-a-uuid"},
    ],
)
async def test_window_rejects_incompatible_navigation_inputs(
    client, seed_contents, params
):
    seeded = await seed_contents()
    response = await client.get(f"{seeded.path}/window", params=params)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "cursor", ["%", "a", encoded([]), encoded({"unexpected": 1}), "A" * 513]
)
async def test_window_rejects_malformed_and_oversized_cursors(
    client, seed_contents, cursor
):
    seeded = await seed_contents()
    response = await client.get(
        f"{seeded.path}/window", params={"mode": "refresh", "cursor": cursor}
    )
    assert response.status_code == 422, response.text


async def test_cursors_are_scoped_to_session_and_navigation_purpose(
    client, seed_contents
):
    seeded = await seed_contents(201)
    other = await seed_contents()
    result = await window(
        client, seeded, mode="anchor", anchor_id=str(seeded.rows[100]["id"])
    )
    cases = [
        (other, "refresh", result["window_cursor"]),
        (seeded, "refresh", result["earlier_cursor"]),
        (seeded, "earlier", result["later_cursor"]),
        (seeded, "later", result["window_cursor"]),
    ]
    for target, mode, cursor in cases:
        response = await client.get(
            f"{target.path}/window", params={"mode": mode, "cursor": cursor}
        )
        assert response.status_code == 422, (mode, response.text)


@pytest.mark.parametrize("invalid_order", [True, 1.25, 2**63, -(2**63) - 1])
async def test_cursor_order_must_be_a_signed_64_bit_integer_not_boolean(
    client, seed_contents, invalid_order
):
    seeded = await seed_contents(101)
    result = await window(client, seeded)
    payload = decoded(result["window_cursor"])
    altered = replace_scalar(
        payload, lambda value: type(value) is int and value >= 10_000, invalid_order
    )
    assert altered != payload, "The replay cursor must carry complete tuple boundaries"
    response = await client.get(
        f"{seeded.path}/window", params={"mode": "refresh", "cursor": encoded(altered)}
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "invalid_time", ["2026-10-08T14:04:20.123456", "not-a-time", "2026-02-30T14:04:20Z"]
)
async def test_cursor_timestamps_require_valid_aware_instants(
    client, seed_contents, invalid_time
):
    seeded = await seed_contents(101)
    result = await window(client, seeded)
    payload = decoded(result["window_cursor"])
    altered = replace_scalar(
        payload,
        lambda value: isinstance(value, str) and value.startswith("2026-10-08T"),
        invalid_time,
    )
    assert altered != payload
    response = await client.get(
        f"{seeded.path}/window", params={"mode": "refresh", "cursor": encoded(altered)}
    )
    assert response.status_code == 422, response.text


async def test_refresh_retains_original_bounds_after_edge_deletion_and_recomputes_external_navigation(
    client, seed_contents, db_session
):
    seeded = await seed_contents(110)
    original = await window(client, seeded, mode="beginning")
    assert original["earlier_cursor"] is None
    removed = [seeded.rows[0]["id"], seeded.rows[99]["id"]]
    await db_session.execute(
        delete(AgentSessionContent).where(AgentSessionContent.id.in_(removed))
    )
    before = await add_content(
        db_session, seeded, occurred_at=START - timedelta(seconds=1)
    )
    refreshed = await window(
        client, seeded, mode="refresh", cursor=original["window_cursor"]
    )
    assert ids(refreshed["items"]) == ids(seeded.rows[1:99])
    assert refreshed["earlier_cursor"]
    assert refreshed["later_cursor"]
    earlier = await window(
        client, seeded, mode="earlier", cursor=refreshed["earlier_cursor"]
    )
    later = await window(client, seeded, mode="later", cursor=refreshed["later_cursor"])
    assert ids(earlier["items"]) == [str(before["id"])]
    assert ids(later["items"]) == ids(seeded.rows[100:])
    # Restoring the original endpoints remains inside the replay envelope.
    await db_session.execute(
        insert(AgentSessionContent), [seeded.rows[0], seeded.rows[99]]
    )
    again = await window(
        client, seeded, mode="refresh", cursor=refreshed["window_cursor"]
    )
    assert ids(again["items"]) == ids(seeded.rows[:100])


async def test_refresh_discovers_later_records_without_sliding_the_loaded_window(
    client, seed_contents, db_session
):
    seeded = await seed_contents(100)
    original = await window(client, seeded)
    assert original["later_cursor"] is None
    late = await add_content(db_session, seeded, occurred_at=START + timedelta(days=1))
    refreshed = await window(
        client, seeded, mode="refresh", cursor=original["window_cursor"]
    )
    assert ids(refreshed["items"]) == ids(seeded.rows)
    assert refreshed["later_cursor"]
    later = await window(client, seeded, mode="later", cursor=refreshed["later_cursor"])
    assert ids(later["items"]) == [str(late["id"])]


async def test_a_fully_deleted_populated_window_stays_empty_but_can_navigate_outside(
    client, seed_contents, db_session
):
    seeded = await seed_contents(110)
    original = await window(client, seeded, mode="beginning")
    await db_session.execute(
        delete(AgentSessionContent).where(
            AgentSessionContent.id.in_([row["id"] for row in seeded.rows[:100]])
        )
    )
    refreshed = await window(
        client, seeded, mode="refresh", cursor=original["window_cursor"]
    )
    assert refreshed["items"] == []
    assert refreshed["later_cursor"]
    assert refreshed["earlier_cursor"] is None
    again = await window(
        client, seeded, mode="refresh", cursor=refreshed["window_cursor"]
    )
    assert again["items"] == []
    later = await window(client, seeded, mode="later", cursor=again["later_cursor"])
    assert ids(later["items"]) == ids(seeded.rows[100:])


@pytest.mark.parametrize("mode", ["latest", "beginning"])
async def test_never_populated_window_refresh_resolves_its_original_end_then_pins(
    client, seed_contents, db_session, mode
):
    seeded = await seed_contents(0)
    original = await window(client, seeded, mode=mode)
    assert original["items"] == []
    new_rows = [
        await add_content(db_session, seeded, source_order=20_000 + index)
        for index in range(103)
    ]
    first = await window(
        client, seeded, mode="refresh", cursor=original["window_cursor"]
    )
    expected = new_rows[-100:] if mode == "latest" else new_rows[:100]
    assert ids(first["items"]) == ids(expected)
    await add_content(db_session, seeded, occurred_at=START + timedelta(days=1))
    pinned = await window(client, seeded, mode="refresh", cursor=first["window_cursor"])
    assert ids(pinned["items"]) == ids(expected)


async def test_refresh_overflow_requires_deliberate_reload_instead_of_truncating(
    client, seed_contents, db_session
):
    seeded = await seed_contents(100)
    original = await window(client, seeded, mode="beginning")
    await add_content(db_session, seeded, occurred_at=START + timedelta(microseconds=1))
    response = await client.get(
        f"{seeded.path}/window",
        params={"mode": "refresh", "cursor": original["window_cursor"]},
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "content_window_changed"
    assert "items" not in response.json()
    assert len((await window(client, seeded, mode="latest"))["items"]) == 100


async def test_anchor_underfill_may_grow_inside_its_bounds_until_the_100_record_limit(
    client, seed_contents, db_session
):
    seeded = await seed_contents(100)
    original = await window(
        client, seeded, mode="anchor", anchor_id=str(seeded.rows[0]["id"])
    )
    assert len(original["items"]) == 51
    for index in range(49):
        await add_content(
            db_session, seeded, occurred_at=START + timedelta(microseconds=index + 1)
        )
    refreshed = await window(
        client, seeded, mode="refresh", cursor=original["window_cursor"]
    )
    assert len(refreshed["items"]) == 100
    await add_content(
        db_session, seeded, occurred_at=START + timedelta(microseconds=100)
    )
    response = await client.get(
        f"{seeded.path}/window",
        params={"mode": "refresh", "cursor": original["window_cursor"]},
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "content_window_changed"


async def test_selected_metadata_is_canonical_preview_free_and_does_not_disclose_foreign_rows(
    client, seed_contents, db_session
):
    seeded = await seed_contents(6)
    foreign = await seed_contents()
    missing_id = str(uuid.uuid4())
    removed_id = seeded.rows[1]["id"]
    await db_session.execute(
        delete(AgentSessionContent).where(AgentSessionContent.id == removed_id)
    )
    requested = [str(seeded.rows[index]["id"]) for index in (5, 2, 0, 1)] + [
        str(foreign.rows[0]["id"]),
        missing_id,
    ]
    response = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": requested}
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    result = response.json()
    assert ids(result["items"]) == ids([seeded.rows[index] for index in (0, 2, 5)])
    assert set(result["unavailable_ids"]) == {
        str(removed_id),
        str(foreign.rows[0]["id"]),
        missing_id,
    }
    assert all(item["preview"] is None for item in result["items"])
    assert "synthetic private preview" not in response.text
    assert all(item["session_id"] == str(seeded.session_id) for item in result["items"])


@pytest.mark.parametrize("count", [0, 257, 1024])
async def test_selected_metadata_accepts_the_explicit_bound_and_private_export_size(
    client, seed_contents, count
):
    seeded = await seed_contents(count)
    response = await client.post(
        f"{seeded.path}/metadata",
        json={"content_ids": list(reversed(ids(seeded.rows)))},
    )
    assert response.status_code == 200, response.text
    assert ids(response.json()["items"]) == ids(seeded.rows)
    assert response.json()["unavailable_ids"] == []
    assert all(item["preview"] is None for item in response.json()["items"])


@pytest.mark.parametrize(
    "content_ids",
    [
        [str(uuid.UUID(int=index + 1)) for index in range(1025)],
        [str(uuid.UUID(int=1)), str(uuid.UUID(int=1))],
        ["not-a-uuid"],
    ],
)
async def test_selected_metadata_rejects_oversized_duplicate_or_invalid_id_lists(
    client, seed_contents, content_ids
):
    seeded = await seed_contents()
    response = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": content_ids}
    )
    assert response.status_code == 422, response.text


async def test_selected_metadata_revalidation_returns_changed_coverage_provenance_and_digest(
    client, seed_contents, db_session
):
    seeded = await seed_contents()
    content_id = seeded.rows[0]["id"]
    before = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": [str(content_id)]}
    )
    assert before.status_code == 200, before.text
    await db_session.execute(
        update(AgentSessionContent)
        .where(AgentSessionContent.id == content_id)
        .values(
            redactions=3,
            original_byte_count=900,
            sha256="a" * 64,
            coverage="truncated",
            coverage_reason="source_limit",
        )
    )
    after = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": [str(content_id)]}
    )
    assert after.status_code == 200, after.text
    item = after.json()["items"][0]
    assert item["redaction"]["replacements"] == 3
    assert item["original_byte_count"] == 900
    assert item["sha256"] == "a" * 64
    assert item["coverage"] == "truncated"
    assert item["coverage_reason"] == "source_limit"
    assert item["preview"] is None


async def test_window_and_selected_metadata_never_open_the_body_store(
    client, seed_contents, monkeypatch, db_session
):
    seeded = await seed_contents(2)
    await db_session.execute(
        update(AgentSessionContent)
        .where(AgentSessionContent.session_id == seeded.session_id)
        .values(
            inline_text=None,
            storage_backend="local",
            storage_key="synthetic/unread/body",
            preview="bounded preview",
        )
    )

    def body_access(*_args, **_kwargs):
        pytest.fail("Metadata navigation must not access body storage")

    monkeypatch.setattr("app.services.session_content.store_for", body_access)
    result = await window(client, seeded)
    assert all(item["preview"]["text"] == "bounded preview" for item in result["items"])
    response = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
    )
    assert response.status_code == 200, response.text
    assert all(item["preview"] is None for item in response.json()["items"])


async def test_other_workspace_member_cannot_read_window_or_selected_metadata(
    client, seed_contents, db_session, test_workspace, second_user
):
    seeded = await seed_contents()
    await window(client, seeded)
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    async with as_user(db_session, second_user) as other:
        seen = await other.get(f"{seeded.path}/window")
        unseen = await other.get(
            f"{seeded.path.replace(str(seeded.session_id), str(uuid.uuid4()))}/window"
        )
        assert seen.status_code == unseen.status_code == 404
        assert seen.json() == unseen.json()
        metadata = await other.post(
            f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
        )
        assert metadata.status_code == 404, metadata.text
        assert "unavailable_ids" not in metadata.json()


async def test_owner_keys_have_read_access_but_agent_launch_and_device_credentials_do_not(
    client,
    seed_contents,
    agent_client,
    installation_key_client,
    plain_key_client,
    device_client,
):
    seeded = await seed_contents()
    await window(client, seeded)
    await window(plain_key_client, seeded)
    owner_metadata = await plain_key_client.post(
        f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
    )
    assert owner_metadata.status_code == 200, owner_metadata.text
    for reader, headers in (
        (agent_client, {}),
        (installation_key_client, {}),
        (device_client, seeded.enrolled["headers"]),
    ):
        response = await reader.get(f"{seeded.path}/window", headers=headers)
        assert response.status_code == 403, response.text
        metadata = await reader.post(
            f"{seeded.path}/metadata",
            headers=headers,
            json={"content_ids": ids(seeded.rows)},
        )
        assert metadata.status_code == 403, metadata.text
        assert "synthetic private preview" not in response.text + metadata.text


async def test_membership_loss_revokes_window_refresh_and_selected_metadata(
    client, seed_contents, db_session, test_user
):
    seeded = await seed_contents()
    original = await window(client, seeded)
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    for mode, params in (
        ("latest", {}),
        ("refresh", {"cursor": original["window_cursor"]}),
    ):
        response = await client.get(
            f"{seeded.path}/window", params={"mode": mode, **params}
        )
        assert response.status_code == 403, response.text
    metadata = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
    )
    assert metadata.status_code == 403, metadata.text


async def test_deleted_session_cannot_be_read_through_replay_or_selected_ids(
    client, seed_contents, db_session
):
    seeded = await seed_contents()
    original = await window(client, seeded)
    await db_session.execute(
        delete(AgentSession).where(AgentSession.id == seeded.session_id)
    )
    response = await client.get(
        f"{seeded.path}/window",
        params={"mode": "refresh", "cursor": original["window_cursor"]},
    )
    assert response.status_code == 404, response.text
    metadata = await client.post(
        f"{seeded.path}/metadata", json={"content_ids": ids(seeded.rows)}
    )
    assert metadata.status_code == 404, metadata.text
    assert "unavailable_ids" not in metadata.json()


async def test_new_window_contract_preserves_legacy_forward_and_literal_call_queries(
    client, seed_contents
):
    seeded = await seed_contents(203)
    legacy = await client.get(seeded.path, params={"limit": 2, "call_id": "call-100"})
    assert legacy.status_code == 200, legacy.text
    assert set(legacy.json()) == {"items", "next_cursor"}
    assert ids(legacy.json()["items"]) == ids(seeded.rows[200:202])
    assert legacy.json()["next_cursor"] is None
    earliest = await client.get(seeded.path, params={"limit": 2})
    assert ids(earliest.json()["items"]) == ids(seeded.rows[:2])
    next_page = await client.get(
        seeded.path, params={"limit": 2, "cursor": earliest.json()["next_cursor"]}
    )
    assert ids(next_page.json()["items"]) == ids(seeded.rows[2:4])
    assert (
        await client.get(seeded.path, params={"cursor": "A" * 201})
    ).status_code == 422
    assert ids((await window(client, seeded))["items"]) == ids(seeded.rows[-100:])
