# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exact Index Scan counting must preserve real foreign work and proof failures."""

import copy
import json
from pathlib import Path

import pytest

from tests.query_plans.plan_tuple_counts import relation_visits
from tests.query_plans.test_plan_tuple_consumption import ancestors, insert_limit
from tests.query_plans.test_plan_tuple_counts import (
    CONTENT,
    RANGE_INDEX,
    SOURCE,
    nodes,
    parallel_content_scan,
    visits,
)


def candidate_plan(name):
    receipt = json.loads((Path(__file__).parent / "plans" / name).read_text())
    assert receipt["content_index_catalog"] == {
        "relname": RANGE_INDEX,
        "amname": "btree",
        "indisvalid": True,
        "indisready": True,
        "definition": "CREATE INDEX ix_agent_session_contents_search_session "
        "ON public.agent_session_contents USING btree (session_id, id)",
    }
    assert receipt["exact_btree_indexes"] == [RANGE_INDEX]
    return receipt["plan"]


def ordinary_grown():
    return candidate_plan("candidate11_ordinary_grown.json")


def direct_inner(parent):
    return next(
        child for child in parent["Plans"] if child["Parent Relationship"] == "Inner"
    )


def test_recorded_unfiltered_btree_index_scan_counts_exact_consumed_content():
    plan = ordinary_grown()
    outer, parent = parallel_content_scan(plan)
    assert outer["Node Type"] == "Index Scan"
    assert outer["Index Name"] == RANGE_INDEX
    assert outer["Actual Rows"] == 1520 and outer["Actual Loops"] == 2
    assert direct_inner(parent)["Actual Loops"] == 3039
    assert visits(plan) == 3072
    assert visits(plan, SOURCE) == 3072
    assert visits(plan, "session_search_chunks") == 0


@pytest.mark.parametrize("inner_loops,expected", [(3040, 3073), (3041, 3074)])
def test_index_scan_exact_counter_does_not_clamp_real_work(inner_loops, expected):
    plan = ordinary_grown()
    _, parent = parallel_content_scan(plan)
    direct_inner(parent)["Actual Loops"] = inner_loops
    assert visits(plan) == expected
    assert visits(plan) > 3072


def test_candidate11_ordinary_cold_foreign_visits_still_exceed_the_bound():
    plan = candidate_plan("candidate11_ordinary_cold.json")
    assert visits(plan) == 3074
    assert visits(plan) > 3072


def test_candidate11_before_prefix_cold_filtered_bitmap_still_fails_closed():
    plan = candidate_plan("candidate11_before_prefix_cold.json")
    outer, parent = parallel_content_scan(plan)
    assert outer["Node Type"] == "Bitmap Heap Scan"
    assert outer["Filter"] == "(session_id = $23)"
    assert outer["Plans"][0]["Index Name"] == "agent_session_contents_pkey"
    assert outer["Plans"][0]["Actual Rows"] == 244617
    assert direct_inner(parent)["Actual Loops"] == 3039
    prefix_visits = sum(
        (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
        * node["Actual Loops"]
        for node, _ in nodes(plan)
        if node.get("Relation Name") == CONTENT and node["Actual Loops"] <= 1
    )
    assert prefix_visits == 35
    assert prefix_visits + direct_inner(parent)["Actual Loops"] > 3072
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_index_scan_requires_catalog_proof_not_an_index_name_assumption():
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        relation_visits(ordinary_grown(), CONTENT, exact_btree_indexes=set())


@pytest.mark.parametrize(
    "mutation",
    [
        "filter_even_when_displayed_removals_are_zero",
        "removed_rows_without_filter_text",
        "index_recheck_removal",
        "missing_recheck_proof",
        "unproved_index",
        "missing_index_condition",
        "unexpected_child_plan",
        "unsupported_index_only_scan",
        "memoized_inner",
        "missing_inner_loop_counter",
        "fractional_inner_loop_counter",
        "boolean_inner_loop_counter",
        "fractional_outer_loop_counter",
        "inconsistent_rounding_interval",
        "intervening_limit",
        "missing_consuming_aggregate",
        "streaming_aggregate_without_sort",
        "unexecuted_blocking_sort",
    ],
)
def test_unproved_index_scan_counts_fail_closed(mutation):
    plan = ordinary_grown()
    outer, parent = parallel_content_scan(plan)
    inner = direct_inner(parent)
    if mutation == "filter_even_when_displayed_removals_are_zero":
        outer["Filter"] = "(session_id = $23)"
        outer["Rows Removed by Filter"] = 0
    elif mutation == "removed_rows_without_filter_text":
        outer["Rows Removed by Filter"] = 1
    elif mutation == "index_recheck_removal":
        outer["Rows Removed by Index Recheck"] = 1
    elif mutation == "missing_recheck_proof":
        del outer["Rows Removed by Index Recheck"]
    elif mutation == "unproved_index":
        outer["Index Name"] = "unproved_content_index"
    elif mutation == "missing_index_condition":
        del outer["Index Cond"]
    elif mutation == "unexpected_child_plan":
        outer["Plans"] = [{"Node Type": "Result", "Actual Rows": 1, "Actual Loops": 2}]
    elif mutation == "unsupported_index_only_scan":
        outer["Node Type"] = "Index Only Scan"
    elif mutation == "memoized_inner":
        wrapped = copy.deepcopy(inner)
        inner.clear()
        inner.update(
            {
                "Node Type": "Memoize",
                "Parent Relationship": "Inner",
                "Actual Rows": 1,
                "Actual Loops": 3039,
                "Plans": [wrapped],
            }
        )
    elif mutation == "missing_inner_loop_counter":
        del inner["Actual Loops"]
    elif mutation == "fractional_inner_loop_counter":
        inner["Actual Loops"] = 3039.5
    elif mutation == "boolean_inner_loop_counter":
        inner["Actual Loops"] = True
    elif mutation == "fractional_outer_loop_counter":
        outer["Actual Loops"] = 2.5
    elif mutation == "inconsistent_rounding_interval":
        inner["Actual Loops"] = 3000
    elif mutation == "intervening_limit":
        path = ancestors(plan, parent)
        insert_limit(path[-1], parent)
        outer["Actual Rows"] = parent["Actual Rows"] = 1
        inner["Actual Loops"] = outer["Actual Loops"]
    elif mutation == "missing_consuming_aggregate":
        for ancestor in ancestors(plan, outer):
            if ancestor["Node Type"] == "Aggregate":
                ancestor["Node Type"] = "Result"
    elif mutation == "streaming_aggregate_without_sort":
        for ancestor in reversed(ancestors(plan, outer)):
            if ancestor["Node Type"] == "Sort":
                ancestor["Node Type"] = "Result"
            if ancestor["Node Type"] == "Aggregate":
                ancestor["Strategy"] = "Sorted"
                break
    elif mutation == "unexecuted_blocking_sort":
        nearest_sort = next(
            ancestor
            for ancestor in reversed(ancestors(plan, outer))
            if ancestor["Node Type"] == "Sort"
        )
        nearest_sort["Actual Loops"] = 0
    with pytest.raises(ValueError, match="Cannot count Content visits exactly"):
        visits(plan)


def test_limit_above_consuming_aggregate_keeps_index_scan_exact_count():
    plan = ordinary_grown()
    outer, _ = parallel_content_scan(plan)
    path = ancestors(plan, outer)
    aggregate = next(
        node for node in reversed(path) if node["Node Type"] == "Aggregate"
    )
    insert_limit(path[path.index(aggregate) - 1], aggregate)
    assert visits(plan) == 3072
