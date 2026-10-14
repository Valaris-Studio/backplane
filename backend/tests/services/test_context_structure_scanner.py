# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: the pre-decode scanner counts exactly what the frozen
reference counter counts, at the boundary, without decoding."""

import json
import random

import pytest

from app.services.agents.context_structure import structure_excess
from tests.routers.agents.context_structure_support import json_shape


def _random_value(rng, depth=0):
    roll = rng.random()
    if depth > 6 or roll < 0.3:
        return rng.choice([0, -2.5e3, 'a"b\\', None, True, "[{}]", "", "é🧭́"])
    if roll < 0.65:
        return [_random_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return {f'k{i}"[:,': _random_value(rng, depth + 1) for i in range(rng.randint(0, 4))}


@pytest.mark.parametrize("seed", range(5))
def test_scanner_matches_reference_depth_and_node_counts_at_the_boundary(seed):
    rng = random.Random(seed)
    for _ in range(400):
        value = _random_value(rng)
        if not isinstance(value, (list, dict)):
            continue
        depth, nodes = json_shape(value)
        for text in (json.dumps(value), json.dumps(value, indent=2, ensure_ascii=True)):
            assert structure_excess(text, max_depth=depth, max_nodes=nodes) is None
            assert structure_excess(text, max_depth=depth, max_nodes=nodes - 1) == "structure_node_limit"
            if depth > 1:
                assert structure_excess(
                    text, max_depth=depth - 1, max_nodes=nodes,
                ) == "structure_depth_limit"


@pytest.mark.parametrize("text", ["plain text", "<p>html</p>", '"[[[["', "  42", ""])
def test_non_json_looking_bodies_are_left_to_the_legacy_fallback(text):
    assert structure_excess(text, max_depth=1, max_nodes=1) is None


def test_unterminated_malformed_input_stops_at_the_first_crossed_limit():
    assert structure_excess('[' * 10 + '"never closed', max_depth=9, max_nodes=10**6) == (
        "structure_depth_limit"
    )
    assert structure_excess('{"a": "unterminated [[[[', max_depth=1, max_nodes=10**6) is None
