# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fix 5 — the card_dependencies schema-existence probe is memoized.

`attach_dependency_counts` runs on every board-detail request. It first probes
whether the `card_dependencies` table exists via an inspector has_table call.
That existence only ever transitions absent -> present (a migration creates the
table once), so a True result is cached process-wide and the probe stops
running. A False result is NOT cached — a migration can create the table mid
process, so we keep probing until it appears.
"""

import app.services.kanban.card as card_module
from app.services.kanban.card import (
    _card_dependencies_table_exists,
    _reset_card_dependencies_table_probe,
)


async def test_true_result_probes_at_most_once(db_session, monkeypatch):
    """Once the probe returns True it is cached: a second call must not re-run
    the underlying inspector probe."""
    _reset_card_dependencies_table_probe()

    calls = {"n": 0}
    real_probe = card_module._probe_card_dependencies_table

    async def _counting_probe(db):
        calls["n"] += 1
        return await real_probe(db)

    monkeypatch.setattr(card_module, "_probe_card_dependencies_table", _counting_probe)

    first = await _card_dependencies_table_exists(db_session)
    second = await _card_dependencies_table_exists(db_session)

    assert first is True
    assert second is True
    assert calls["n"] == 1, "the probe must run at most once after a True result"

    _reset_card_dependencies_table_probe()


async def test_false_result_keeps_probing(db_session, monkeypatch):
    """A False probe result must NOT be cached — a later migration can create
    the table, so subsequent calls must probe again (and can flip to True)."""
    _reset_card_dependencies_table_probe()

    results = iter([False, True])
    calls = {"n": 0}

    async def _fake_probe(db):
        calls["n"] += 1
        return next(results)

    monkeypatch.setattr(card_module, "_probe_card_dependencies_table", _fake_probe)

    assert await _card_dependencies_table_exists(db_session) is False
    # False was not cached: the second call probes again and observes True.
    assert await _card_dependencies_table_exists(db_session) is True
    assert calls["n"] == 2

    # And now the True result IS cached.
    assert await _card_dependencies_table_exists(db_session) is True
    assert calls["n"] == 2

    _reset_card_dependencies_table_probe()


async def test_reset_seam_reprobes(db_session, monkeypatch):
    """The reset seam clears a cached True so tests (and only tests) can force a
    fresh probe — process state must not leak between them."""
    _reset_card_dependencies_table_probe()

    calls = {"n": 0}

    async def _fake_probe(db):
        calls["n"] += 1
        return True

    monkeypatch.setattr(card_module, "_probe_card_dependencies_table", _fake_probe)

    await _card_dependencies_table_exists(db_session)
    assert calls["n"] == 1

    _reset_card_dependencies_table_probe()

    await _card_dependencies_table_exists(db_session)
    assert calls["n"] == 2, "reset must force a re-probe"

    _reset_card_dependencies_table_probe()
