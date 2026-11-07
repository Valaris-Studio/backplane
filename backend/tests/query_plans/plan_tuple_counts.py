# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Count scoped metadata work without rounding parallel Content row averages."""


def _is_exact_counter(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 0 <= value < 2**53
        and value == int(value)
    )


def _content_outer_visits(node, ancestors, exact_btree_indexes):
    parent = ancestors[-1] if ancestors else None

    def require(condition, reason):
        if not condition:
            raise ValueError(f"Cannot count Content visits exactly: {reason}")

    require(
        parent is not None and parent.get("Node Type") == "Nested Loop",
        "scan is not a direct nested-loop outer",
    )
    children = [
        child
        for child in parent.get("Plans", [])
        if child.get("Parent Relationship") in {"Outer", "Inner"}
    ]
    outers = [
        child for child in children if child.get("Parent Relationship") == "Outer"
    ]
    inners = [
        child for child in children if child.get("Parent Relationship") == "Inner"
    ]
    require(
        len(children) == 2 and len(outers) == len(inners) == 1 and outers[0] is node,
        "join children do not identify one direct outer and inner",
    )
    inner = inners[0]
    require(
        parent.get("Join Type") == "Left"
        and inner.get("Node Type") == "Index Scan"
        and inner.get("Relation Name") == "session_search_sources"
        and inner.get("Index Name") == "uq_session_search_source_content"
        and not inner.get("Plans"),
        "inner is not the direct Source content-index scan",
    )
    if node.get("Node Type") == "Index Scan":
        require(
            node.get("Index Name") in exact_btree_indexes
            and bool(node.get("Index Cond"))
            and not node.get("Plans")
            and "Filter" not in node
            and node.get("Rows Removed by Filter", 0) == 0
            and node.get("Rows Removed by Index Recheck") == 0,
            "Content index access is filtered, rechecked, or not catalog-proved",
        )
    else:
        require(
            node.get("Node Type") == "Bitmap Heap Scan"
            and "Filter" not in node
            and node.get("Rows Removed by Filter", 0) == 0
            and node.get("Lossy Heap Blocks") == 0
            and node.get("Rows Removed by Index Recheck") == 0,
            "Content bitmap access is filtered, lossy, or unproved",
        )
        bitmap_children = node.get("Plans", [])
        require(
            len(bitmap_children) == 1, "Content bitmap has multiple or no producers"
        )
        bitmap = bitmap_children[0]
        require(
            bitmap.get("Node Type") == "Bitmap Index Scan"
            and bitmap.get("Index Name") in exact_btree_indexes
            and not bitmap.get("Plans")
            and bool(bitmap.get("Index Cond"))
            and bitmap.get("Index Cond") == node.get("Recheck Cond"),
            "bitmap is not one catalog-proved exact B-tree condition",
        )
    loops = node.get("Actual Loops")
    rows = node.get("Actual Rows")
    inner_loops = inner.get("Actual Loops")
    require(
        _is_exact_counter(loops)
        and loops > 1
        and _is_exact_counter(rows)
        and _is_exact_counter(parent.get("Actual Loops"))
        and parent["Actual Loops"] == loops
        and _is_exact_counter(inner_loops),
        "missing, fractional, or inconsistent loop counters",
    )
    require(
        2 * abs(inner_loops - rows * loops) <= loops,
        "inner loops lie outside the displayed outer-row rounding interval",
    )
    blocking_sort = False
    for ancestor in reversed(ancestors):
        require(
            ancestor.get("Node Type") != "Limit", "LIMIT can truncate the Content loop"
        )
        if ancestor.get("Node Type") == "Sort":
            require(
                _is_exact_counter(ancestor.get("Actual Loops"))
                and ancestor["Actual Loops"] > 0,
                "blocking sort was not executed",
            )
            blocking_sort = True
        if ancestor.get("Node Type") == "Aggregate":
            require(
                _is_exact_counter(ancestor.get("Actual Loops"))
                and ancestor["Actual Loops"] > 0,
                "consuming aggregate was not executed",
            )
            require(
                blocking_sort or ancestor.get("Strategy") in {"Plain", "Hashed"},
                "sorted aggregate can stream without consuming the Content loop",
            )
            break
    else:
        require(False, "no consuming aggregate for the Content loop")
    # ExecNestLoop rescans this direct inner once per outer tuple. PostgreSQL
    # sums worker loop counters, while EXPLAIN rounds each scan's row average.
    return int(inner_loops)


def relation_scans(plan, relation):
    """Every scan of `relation` in a plan: access path and the rows it had to look at."""

    def nodes(node):
        yield node
        for child in node.get("Plans", []):
            yield from nodes(child)

    scans = []
    for node in nodes(plan):
        if node.get("Relation Name") != relation:
            continue
        # A bitmap heap scan names its indexes on child (possibly And/Or) nodes.
        indexes = [node["Index Name"]] if "Index Name" in node else [
            child["Index Name"]
            for child in nodes(node)
            if child is not node and "Index Name" in child
        ]
        loops = node.get("Actual Loops", 1)
        removed = node.get("Rows Removed by Filter", 0)
        scans.append({
            "node": node["Node Type"],
            "index": ", ".join(indexes) if indexes else None,
            "index_condition": any("Index Cond" in inner for inner in nodes(node)),
            "rows": node["Actual Rows"], "loops": loops, "removed_by_filter": removed,
            "heap_fetches": node.get("Heap Fetches"),
            "visited": (node["Actual Rows"] + removed) * loops,
        })
    return scans


def relation_visits(plan, relation, *, exact_btree_indexes):
    def nodes(node, ancestors=()):
        yield node, ancestors
        for child in node.get("Plans", []):
            yield from nodes(child, (*ancestors, node))

    visits = 0
    for node, ancestors in nodes(plan):
        if node.get("Relation Name") != relation:
            continue
        if relation == "agent_session_contents" and node["Actual Loops"] > 1:
            visits += _content_outer_visits(node, ancestors, exact_btree_indexes)
        else:
            visits += (
                node["Actual Rows"] + node.get("Rows Removed by Filter", 0)
            ) * node["Actual Loops"]
    return visits
