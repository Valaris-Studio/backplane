# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""File-only regression proposal; root executes after accepting the design."""

import copy
import json
from pathlib import Path

import pytest

from tests.query_plans.plan_tuple_counts import relation_visits


CONTENT = "agent_session_contents"
SOURCE = "session_search_sources"
RANGE_INDEX = "ix_agent_session_contents_search_session"


def recorded_plan(name):
    return json.loads((Path(__file__).parent / "plans" / name).read_text())["plan"]


def nodes(node, parent=None):
    yield node, parent
    for child in node.get("Plans", []):
        yield from nodes(child, node)


def visits(plan, relation=CONTENT):
    return relation_visits(plan, relation, exact_btree_indexes={RANGE_INDEX})


def parallel_content_scan(plan):
    return next(
        (node, parent)
        for node, parent in nodes(plan)
        if node.get("Relation Name") == CONTENT and node["Actual Loops"] > 1
    )


@pytest.mark.parametrize("population", ["ordinary", "before_prefix"])
@pytest.mark.parametrize("phase", ["cold", "grown"])
def test_saved_exact_content_access_is_counted_without_rounded_row_average(
    population, phase
):
    plan = recorded_plan(f"fenced_{population}_{phase}.json")
    assert visits(plan) == 3072
    assert visits(plan, SOURCE) == 3072
    assert visits(plan, "session_search_chunks") == 0


@pytest.mark.parametrize(
    "population,expected", [("ordinary", 3074), ("before_prefix", 3076)]
)
def test_real_foreign_content_visits_remain_over_the_unchanged_bound(
    population, expected
):
    plan = recorded_plan(f"foreign_{population}_cold.json")
    assert visits(plan) == expected
    assert visits(plan) > 3072


def test_exact_inner_counter_does_not_cap_real_work_to_the_expected_bound():
    plan = recorded_plan("fenced_ordinary_grown.json")
    _, parent = parallel_content_scan(plan)
    inner = next(
        child for child in parent["Plans"] if child["Parent Relationship"] == "Inner"
    )
    inner["Actual Loops"] = 3040
    assert visits(plan) == 3073
    assert visits(plan) > 3072


def test_exact_counter_also_corrects_an_underreported_rounded_average():
    plan = recorded_plan("fenced_ordinary_grown.json")
    _, parent = parallel_content_scan(plan)
    inner = next(
        child for child in parent["Plans"] if child["Parent Relationship"] == "Inner"
    )
    inner["Actual Loops"] = 3041
    assert visits(plan) == 3074


@pytest.mark.parametrize(
    "mutation",
    [
        "filter_even_when_displayed_removals_are_zero",
        "lossy_bitmap",
        "missing_lossy_proof",
        "index_recheck_removal",
        "different_recheck_condition",
        "unproved_bitmap_index",
        "memoized_inner",
        "materialized_inner",
        "non_nested_loop_parent",
        "missing_inner_loop_counter",
        "fractional_inner_loop_counter",
        "inconsistent_rounding_interval",
    ],
)
def test_unproved_parallel_content_counts_fail_closed(mutation):
    plan = recorded_plan("fenced_ordinary_grown.json")
    outer, parent = parallel_content_scan(plan)
    inner = next(
        child for child in parent["Plans"] if child["Parent Relationship"] == "Inner"
    )
    if mutation == "filter_even_when_displayed_removals_are_zero":
        outer["Filter"] = "(agent_session_contents_4.channel = 'tool_output'::text)"
        outer["Rows Removed by Filter"] = 0
    elif mutation == "lossy_bitmap":
        outer["Lossy Heap Blocks"] = 1
    elif mutation == "missing_lossy_proof":
        del outer["Lossy Heap Blocks"]
    elif mutation == "index_recheck_removal":
        outer["Rows Removed by Index Recheck"] = 1
    elif mutation == "different_recheck_condition":
        outer["Recheck Cond"] += " AND additional_predicate"
    elif mutation == "unproved_bitmap_index":
        outer["Plans"][0]["Index Name"] = "unproved_index"
    elif mutation in {"memoized_inner", "materialized_inner"}:
        wrapped = copy.deepcopy(inner)
        inner.clear()
        inner.update(
            {
                "Node Type": "Memoize"
                if mutation == "memoized_inner"
                else "Materialize",
                "Parent Relationship": "Inner",
                "Actual Rows": 1,
                "Actual Loops": 3039,
                "Plans": [wrapped],
            }
        )
    elif mutation == "non_nested_loop_parent":
        parent["Node Type"] = "Hash Join"
    elif mutation == "missing_inner_loop_counter":
        del inner["Actual Loops"]
    elif mutation == "fractional_inner_loop_counter":
        inner["Actual Loops"] = 3039.5
    elif mutation == "inconsistent_rounding_interval":
        inner["Actual Loops"] = 3000
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_bitmap_access_requires_catalog_proof_not_an_index_name_assumption():
    plan = recorded_plan("fenced_ordinary_grown.json")
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        relation_visits(plan, CONTENT, exact_btree_indexes=set())
