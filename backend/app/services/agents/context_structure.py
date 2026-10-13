# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pre-decode structural admission for JSON-looking note bodies.

Runs before any json.loads, revision hashing or rendering, so an over-deep or
over-wide body is never handed to a recursive decoder or serializer. Depth
counts containers (root object/array = 1); nodes count every JSON value,
containers and scalars, but not object keys. The scan is quote/escape aware
and stops at the first limit crossed, so a malformed JSON-looking body that is
already over a limit is excluded without decoding it to learn it is invalid.
"""

import re
from typing import Literal

StructureExcess = Literal["structure_depth_limit", "structure_node_limit"]

# A string token runs to its closing quote (or the end, when unterminated);
# possessive so a long or unterminated string cannot backtrack.
_TOKEN = re.compile(r'"(?:[^"\\]|\\[\s\S])*+"?|[{}\[\],:]|[^\s{}\[\],:"]++')
_OPENERS = {"{": "object", "[": "array"}


def is_json_looking(text: str) -> bool:
    stripped = text.lstrip()
    return stripped[:1] in _OPENERS


def structure_excess(
    text: str, *, max_depth: int, max_nodes: int
) -> StructureExcess | None:
    if not is_json_looking(text):
        return None
    # One frame per open container: [kind, expecting_key].
    frames: list[list] = []
    nodes = 0
    for match in _TOKEN.finditer(text):
        token = match.group()
        first = token[0]
        if first in "}]":
            if frames:
                frames.pop()
            continue
        if first == ",":
            if frames and frames[-1][0] == "object":
                frames[-1][1] = True
            continue
        if first == ":":
            if frames and frames[-1][0] == "object":
                frames[-1][1] = False
            continue
        if first == '"' and frames and frames[-1][0] == "object" and frames[-1][1]:
            continue  # an object key is not a JSON value
        nodes += 1
        if nodes > max_nodes:
            return "structure_node_limit"
        if first in _OPENERS:
            frames.append([_OPENERS[first], first == "{"])
            if len(frames) > max_depth:
                return "structure_depth_limit"
    return None
