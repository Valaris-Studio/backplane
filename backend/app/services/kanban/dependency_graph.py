# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DependencyGraphService — whole-board dependency-graph validation.

Companion to DependencyService's add-time recursive-CTE guard. That guard
prevents a *single new* edge from closing a cycle; this engine validates the
*entire existing* board graph in Python (one edge query + one card-meta
query), reporting three independent fault classes:

  - cycles   : strongly-connected components (Kahn's algorithm finds the
               nodes in/under a cycle; we then partition them into distinct
               SCCs by mutual reachability).
  - conflicts: a card in a done-typed column whose prerequisite does not
               satisfy its effective completion policy.
  - orphans  : dangling edges where an endpoint isn't a live card on this
               board (cross-board / survived-deletion references).

Validation runs in Python rather than SQL: the recursive-CTE guard answers a
single-edge question, whereas whole-board SCC partitioning + done-conflict
joins are clearer and cheaper as in-memory graph walks on the bounded
per-board edge set.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.kanban.dependencies import DependencyRepository
from app.services.kanban.completion_dependencies import CompletionDependencyService
from app.schemas.kanban.dependencies import (
    BoardDependencyValidation,
    ConflictInfo,
    CycleInfo,
    OrphanInfo,
)

DONE_COLUMN_TYPE = "done"


class DependencyGraphService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = DependencyRepository(db)

    async def validate(
        self, *, board_id: uuid.UUID
    ) -> BoardDependencyValidation:
        # Board identity + workspace membership are enforced by the router's
        # resolve_board_id + get_workspace dependencies before we get here.
        edges = await self.repo.list_for_board(board_id)
        card_meta = await self.repo.list_card_meta_for_board(board_id)

        titles: dict[uuid.UUID, str] = {cid: title for cid, title, _ in card_meta}
        done_ids: set[uuid.UUID] = {
            cid for cid, _, col_type in card_meta if col_type == DONE_COLUMN_TYPE
        }
        on_board: set[uuid.UUID] = set(titles)

        orphans = self._find_orphans(edges, on_board, titles)
        # Cycle + conflict analysis only considers edges fully on this board;
        # an orphan edge's missing endpoint can't participate in a board cycle.
        internal_edges = [
            (c, d) for c, d in edges if c in on_board and d in on_board
        ]
        cycles = self._find_cycles(internal_edges, titles)
        satisfied = await CompletionDependencyService(self.db).satisfied_ids({target for _, target in internal_edges})
        conflicts = self._find_conflicts(
            internal_edges, done_ids, titles, satisfied_ids=satisfied
        )

        return BoardDependencyValidation(
            ok=not (cycles or conflicts or orphans),
            cycles=cycles,
            conflicts=conflicts,
            orphans=orphans,
        )

    @staticmethod
    def _find_orphans(
        edges: list[tuple[uuid.UUID, uuid.UUID]],
        on_board: set[uuid.UUID],
        titles: dict[uuid.UUID, str],
    ) -> list[OrphanInfo]:
        orphans: list[OrphanInfo] = []
        for card_id, depends_on_id in edges:
            card_ok = card_id in on_board
            dep_ok = depends_on_id in on_board
            if card_ok and dep_ok:
                continue
            missing = []
            if not card_ok:
                missing.append(f"dependent card {card_id}")
            if not dep_ok:
                missing.append(f"prerequisite card {depends_on_id}")
            orphans.append(
                OrphanInfo(
                    card_id=card_id,
                    depends_on_card_id=depends_on_id,
                    card_on_board=card_ok,
                    depends_on_on_board=dep_ok,
                    summary=(
                        "Dangling dependency edge — "
                        + " and ".join(missing)
                        + " is not on this board"
                    ),
                )
            )
        return orphans

    def _find_cycles(
        self,
        edges: list[tuple[uuid.UUID, uuid.UUID]],
        titles: dict[uuid.UUID, str],
    ) -> list[CycleInfo]:
        # Edge (card, depends_on): card depends on depends_on. For topological
        # order, depends_on must come first, so the DAG arrow is
        # depends_on -> card. in_degree counts a node's prerequisites.
        successors: dict[uuid.UUID, list[uuid.UUID]] = {}
        in_degree: dict[uuid.UUID, int] = {}
        nodes: set[uuid.UUID] = set()
        for card, depends_on in edges:
            nodes.add(card)
            nodes.add(depends_on)
            successors.setdefault(depends_on, []).append(card)
            in_degree[card] = in_degree.get(card, 0) + 1
            in_degree.setdefault(depends_on, in_degree.get(depends_on, 0))

        queue = [n for n in nodes if in_degree.get(n, 0) == 0]
        removed = 0
        while queue:
            node = queue.pop()
            removed += 1
            for succ in successors.get(node, ()):
                in_degree[succ] -= 1
                if in_degree[succ] == 0:
                    queue.append(succ)

        if removed == len(nodes):
            return []

        # Leftover nodes (in_degree never hit 0) are in/under a cycle.
        leftover = {n for n in nodes if in_degree.get(n, 0) > 0}
        components = self._partition_scc(leftover, successors)
        cycles: list[CycleInfo] = []
        for component in components:
            ordered = sorted(component, key=lambda c: titles.get(c, ""))
            component_titles = [titles.get(c, str(c)) for c in ordered]
            cycles.append(
                CycleInfo(
                    card_ids=ordered,
                    titles=component_titles,
                    summary=(
                        "Dependency cycle among "
                        + ", ".join(component_titles)
                    ),
                )
            )
        cycles.sort(key=lambda c: c.titles)
        return cycles

    @staticmethod
    def _partition_scc(
        leftover: set[uuid.UUID],
        successors: dict[uuid.UUID, list[uuid.UUID]],
    ) -> list[set[uuid.UUID]]:
        # Within the leftover set, two nodes share a cycle iff each is
        # reachable from the other. Compute forward reachability restricted to
        # `leftover`, then group by mutual reachability.
        reach: dict[uuid.UUID, set[uuid.UUID]] = {}
        for start in leftover:
            seen: set[uuid.UUID] = set()
            stack = [
                s for s in successors.get(start, ()) if s in leftover
            ]
            while stack:
                node = stack.pop()
                if node in seen:
                    continue
                seen.add(node)
                stack.extend(
                    s for s in successors.get(node, ()) if s in leftover
                )
            reach[start] = seen

        components: list[set[uuid.UUID]] = []
        assigned: set[uuid.UUID] = set()
        for node in leftover:
            if node in assigned:
                continue
            component = {
                other
                for other in leftover
                if other == node
                or (node in reach[other] and other in reach[node])
            }
            assigned |= component
            components.append(component)
        return components

    @staticmethod
    def _find_conflicts(
        edges: list[tuple[uuid.UUID, uuid.UUID]],
        done_ids: set[uuid.UUID],
        titles: dict[uuid.UUID, str],
        *, satisfied_ids: set[uuid.UUID] | None = None,
    ) -> list[ConflictInfo]:
        satisfied_ids = done_ids if satisfied_ids is None else satisfied_ids
        unsatisfied: dict[uuid.UUID, list[uuid.UUID]] = {}
        for card, depends_on in edges:
            if card in done_ids and depends_on not in satisfied_ids:
                unsatisfied.setdefault(card, []).append(depends_on)

        conflicts: list[ConflictInfo] = []
        for card_id in sorted(unsatisfied, key=lambda c: titles.get(c, "")):
            dep_ids = sorted(
                unsatisfied[card_id], key=lambda c: titles.get(c, "")
            )
            dep_titles = [titles.get(d, str(d)) for d in dep_ids]
            conflicts.append(
                ConflictInfo(
                    card_id=card_id,
                    title=titles.get(card_id, str(card_id)),
                    unsatisfied_dependency_ids=dep_ids,
                    unsatisfied_dependency_titles=dep_titles,
                    summary=(
                        f"'{titles.get(card_id, card_id)}' is done but depends "
                        f"on unfinished {', '.join(dep_titles)}"
                    ),
                )
            )
        return conflicts
