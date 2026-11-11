# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Additive test-first controls for the exact counter's consuming ancestor."""

import pytest

from tests.query_plans.test_plan_tuple_counts import (
    parallel_content_scan,
    recorded_plan,
    visits,
)


def ancestors(plan, target, path=()):
    if plan is target:
        return path
    for child in plan.get("Plans", []):
        found = ancestors(child, target, (*path, plan))
        if found is not None:
            return found
    return None


def insert_limit(parent, target):
    index = next(
        index for index, child in enumerate(parent["Plans"]) if child is target
    )
    parent["Plans"][index] = {
        "Node Type": "Limit",
        "Parent Relationship": target.get("Parent Relationship", "Outer"),
        "Actual Rows": 1,
        "Actual Loops": target["Actual Loops"],
        "Plans": [target],
    }


def test_limit_between_content_loop_and_consuming_aggregate_is_rejected():
    plan = recorded_plan("fenced_ordinary_grown.json")
    outer, nested_loop = parallel_content_scan(plan)
    path = ancestors(plan, nested_loop)
    insert_limit(path[-1], nested_loop)
    # A per-worker limit can stop after one tuple without consuming the bitmap.
    outer["Actual Rows"] = nested_loop["Actual Rows"] = 1
    inner = next(
        child
        for child in nested_loop["Plans"]
        if child["Parent Relationship"] == "Inner"
    )
    inner["Actual Loops"] = outer["Actual Loops"]
    for node in (outer, nested_loop, inner):
        node.pop("Workers", None)
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_content_loop_without_a_consuming_aggregate_is_rejected():
    plan = recorded_plan("fenced_ordinary_grown.json")
    outer, _ = parallel_content_scan(plan)
    for ancestor in ancestors(plan, outer):
        if ancestor["Node Type"] == "Aggregate":
            ancestor["Node Type"] = "Result"
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_streaming_sorted_aggregate_without_a_blocking_sort_is_rejected():
    plan = recorded_plan("fenced_ordinary_grown.json")
    outer, _ = parallel_content_scan(plan)
    for ancestor in reversed(ancestors(plan, outer)):
        if ancestor["Node Type"] == "Sort":
            ancestor["Node Type"] = "Result"
        if ancestor["Node Type"] == "Aggregate":
            ancestor["Strategy"] = "Sorted"
            break
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_limit_above_the_blocking_aggregate_preserves_exact_content_count():
    plan = recorded_plan("fenced_ordinary_grown.json")
    outer, _ = parallel_content_scan(plan)
    path = ancestors(plan, outer)
    aggregate = next(
        node for node in reversed(path) if node["Node Type"] == "Aggregate"
    )
    aggregate_parent = path[path.index(aggregate) - 1]
    insert_limit(aggregate_parent, aggregate)
    assert visits(plan) == 3072
