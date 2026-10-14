# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent structural inputs and observations at the actual DBAPI boundary."""

from contextlib import contextmanager

from sqlalchemy import Table, event
from sqlalchemy.sql import visitors

from app.models.notes.note import Note
from tests.routers.agents.context_budgets_support import compact_json
from tests.routers.agents.context_receipts_support import document


VISIBLE = "Visible café e\u0301 🧭"


def json_shape(value):
    """Count JSON values, not property names; depth counts only containers."""
    count = depth = 0
    pending = [(value, 0)]
    while pending:
        item, parent_depth = pending.pop()
        count += 1
        if isinstance(item, (list, dict)):
            container_depth = parent_depth + 1
            depth = max(depth, container_depth)
            children = item.values() if isinstance(item, dict) else item
            pending.extend((child, container_depth) for child in children)
    return depth, count


def depth_document(depth):
    value = document(VISIBLE)
    padding = "hidden"
    # The root object and attrs object account for two container levels.
    for _ in range(depth - 2):
        padding = [padding]
    value["attrs"] = {"padding": padding}
    assert json_shape(value)[0] == depth
    return value


def node_document(nodes):
    value = document(VISIBLE)
    value["attrs"] = {"padding": []}
    baseline = json_shape(value)[1]
    value["attrs"]["padding"] = [None] * (nodes - baseline)
    assert json_shape(value)[1] == nodes
    return value


def deep_stored_document(depth):
    # Construct text without requiring the test's encoder to recurse first.
    plain = compact_json(document(VISIBLE))
    return plain[:-1] + ',"attrs":{"padding":' + '[' * (depth - 2) + 'null' + ']' * (depth - 2) + '}}'


@contextmanager
def observe_note_queries(engine):
    calls = []

    def executing(connection, cursor, statement, parameters, context, executemany):
        compiled = context.compiled
        if compiled is None:
            return
        # Observe statements actually reaching the DBAPI, using their compiled
        # table comparison (including ORM annotations), not SQL spelling.
        if any(isinstance(element, Table) and element.compare(Note.__table__)
               for element in visitors.iterate(compiled.statement)):
            calls.append({"executemany": executemany})

    event.listen(engine.sync_engine, "before_cursor_execute", executing)
    try:
        yield calls
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", executing)
