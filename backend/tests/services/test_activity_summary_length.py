# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Activity summaries composed from user-controlled card titles must fit
`Activity.summary`'s `String(500)` cap.

These assert the LENGTH-BOUNDED property on the pure composition helpers rather
than round-tripping through the test database: the suite runs on aiosqlite,
which does not enforce `String(N)`, so a 669-char summary stores and reads back
cleanly here while Postgres raises `StringDataRightTruncation` in prod. A
round-trip test would be structurally incapable of failing.
"""

from app.models.activity import Activity
from app.services.scheduling.assignment_service import (
    _NO_PROGRESS_PARK_SUMMARY_MARKER,
    _no_progress_park_summary,
    _repo_slug_park_summary,
    _reserved_card_summary,
    _truncate_title,
)

# The declared width of Activity.summary, read off the model so this test
# follows a future widening instead of pinning a stale literal.
SUMMARY_CAP = Activity.__table__.c.summary.type.length

# Card.title is String(500) — the longest title the platform will ever store,
# and therefore the worst case every summary helper must survive.
MAX_TITLE = "T" * 500


def test_summary_cap_is_what_the_helpers_target():
    assert SUMMARY_CAP == 500


class TestNoProgressParkSummary:
    def test_fits_the_cap_with_a_max_length_title(self):
        summary = _no_progress_park_summary(
            title=MAX_TITLE, attempts=3, execution_action="implement"
        )
        assert len(summary) <= SUMMARY_CAP

    def test_marker_survives_a_max_length_title(self):
        """The FCH-2 reset boundary is found by a SQL `LIKE` on this marker.
        If a long title could push it out, an unparked card would silently lose
        its spent-execution set and re-park on the next poll."""
        summary = _no_progress_park_summary(
            title=MAX_TITLE, attempts=3, execution_action="implement"
        )
        assert _NO_PROGRESS_PARK_SUMMARY_MARKER in summary

    def test_marker_precedes_the_title_so_truncation_can_never_clip_it(self):
        summary = _no_progress_park_summary(
            title=MAX_TITLE, attempts=3, execution_action="implement"
        )
        assert summary.index(_NO_PROGRESS_PARK_SUMMARY_MARKER) < summary.index("T")

    def test_short_title_is_preserved_verbatim(self):
        summary = _no_progress_park_summary(
            title="Fix the widget", attempts=3, execution_action="implement"
        )
        assert "Fix the widget" in summary
        assert "…" not in summary

    def test_operator_facing_details_survive_a_max_length_title(self):
        """Truncation must eat the title, not the attempt count or the label the
        operator has to remove to unpark."""
        summary = _no_progress_park_summary(
            title=MAX_TITLE, attempts=7, execution_action="implement"
        )
        assert "7" in summary
        assert "implement" in summary
        assert "blocked" in summary


class TestRepoSlugParkSummary:
    def test_fits_the_cap_with_a_max_length_title(self):
        summary = _repo_slug_park_summary(title=MAX_TITLE, git_repo_slug="no-such-repo")
        assert len(summary) <= SUMMARY_CAP

    def test_the_unresolved_slug_survives_a_max_length_title(self):
        """The slug is the whole diagnostic — the operator cannot fix the card
        without knowing which slug failed to resolve."""
        summary = _repo_slug_park_summary(title=MAX_TITLE, git_repo_slug="no-such-repo")
        assert "no-such-repo" in summary

    def test_short_title_is_preserved_verbatim(self):
        summary = _repo_slug_park_summary(title="Fix the widget", git_repo_slug="app")
        assert "Fix the widget" in summary


class TestReservedCardSummary:
    def test_fits_the_cap_with_a_max_length_title(self):
        """This one runs on EVERY successful next_assignment, not just on a
        rare park — the highest-traffic overflow of the three."""
        summary = _reserved_card_summary(title=MAX_TITLE, role="implementer")
        assert len(summary) <= SUMMARY_CAP

    def test_role_survives_a_max_length_title(self):
        summary = _reserved_card_summary(title=MAX_TITLE, role="implementer")
        assert "implementer" in summary

    def test_short_title_is_preserved_verbatim(self):
        summary = _reserved_card_summary(title="Fix the widget", role="implementer")
        assert "Fix the widget" in summary


class TestTruncateTitle:
    def test_leaves_a_short_title_untouched(self):
        assert _truncate_title("Fix the widget", limit=100) == "Fix the widget"

    def test_a_title_exactly_at_the_limit_is_untouched(self):
        title = "T" * 40
        assert _truncate_title(title, limit=40) == title

    def test_an_over_long_title_is_cut_to_the_limit_including_the_ellipsis(self):
        result = _truncate_title("T" * 200, limit=40)
        assert len(result) == 40
        assert result.endswith("…")


class TestDependencySummary:
    """`DependencyService.add()`/`remove()` embed the prerequisite's title in
    their summaries. A pure module-level builder, `_dependency_summary(verb,
    title)`, is the seam that keeps the composition length-bounded."""

    @staticmethod
    def _builder():
        # Imported lazily so a missing builder fails ONLY this class, not the
        # whole module's collection.
        from app.services.kanban import dependencies

        builder = getattr(dependencies, "_dependency_summary", None)
        assert callable(builder), (
            "app.services.kanban.dependencies must expose a pure "
            "_dependency_summary(verb, title) -> str"
        )
        return builder

    def test_added_fits_the_cap_with_a_max_length_title(self):
        summary = self._builder()("added", MAX_TITLE)
        assert len(summary) <= SUMMARY_CAP

    def test_removed_fits_the_cap_with_a_max_length_title(self):
        summary = self._builder()("removed", MAX_TITLE)
        assert len(summary) <= SUMMARY_CAP

    def test_verb_survives_a_max_length_title(self):
        assert "added" in self._builder()("added", MAX_TITLE)
        assert "removed" in self._builder()("removed", MAX_TITLE)

    def test_truncated_title_prefix_survives_a_max_length_title(self):
        summary = self._builder()("added", MAX_TITLE)
        assert "T" * 50 in summary
        assert "…" in summary

    def test_short_title_is_preserved_verbatim(self):
        summary = self._builder()("added", "Fix the widget")
        assert "Fix the widget" in summary
        assert "…" not in summary
