# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The markup scrub runs inside async request handlers, so it must be linear:
a quadratic scan on a crafted 60 KB approval pinned a worker for 30+ s
(reference-definition backtracking, and a backward label scan per `](`)."""

import time

import pytest

from app.services.media.unsafe_markup import neutralise_unsafe_markup_urls

WORST_CASE_SIZE = 100_000
TIME_BUDGET_SECONDS = 0.2


def _repeat_to(unit: str, size: int = WORST_CASE_SIZE) -> str:
    return unit * (size // len(unit))


WORST_CASE_INPUTS = [
    pytest.param(_repeat_to("["), id="reviewer-open-brackets"),
    pytest.param(_repeat_to("x]("), id="reviewer-many-destination-openers"),
    pytest.param(_repeat_to("]("), id="destination-openers-no-whitespace"),
    pytest.param(_repeat_to("](<"), id="angle-destination-openers"),
    pytest.param(_repeat_to("]( "), id="destination-openers-spaced"),
    pytest.param(_repeat_to("[x]:"), id="definition-shaped-run"),
    pytest.param(_repeat_to("[a\\]"), id="escaped-label-closers"),
    pytest.param(_repeat_to("\n[") , id="label-at-every-line-start"),
    pytest.param("[" + _repeat_to("a"), id="one-unclosed-label-line"),
    pytest.param(_repeat_to("> - [r]: "), id="container-prefixed-definitions"),
    pytest.param(_repeat_to("\\"), id="backslashes"),
    pytest.param(_repeat_to("!["), id="image-openers"),
    pytest.param(_repeat_to('<img a="'), id="unterminated-quoted-img-attributes"),
    pytest.param(_repeat_to("<img "), id="unterminated-img-tags"),
    pytest.param(_repeat_to("<a href=x "), id="unterminated-link-tags"),
    pytest.param(_repeat_to("<a:"), id="autolink-openers"),
    pytest.param(_repeat_to("[x](javascript:a) "), id="many-unsafe-links"),
    pytest.param(_repeat_to('<img src="javascript:a">'), id="many-unsafe-images"),
]


@pytest.mark.parametrize("text", WORST_CASE_INPUTS)
def test_scrub_stays_linear_on_worst_case_input(text: str) -> None:
    neutralise_unsafe_markup_urls(text[:1000])  # warm regex caches
    started = time.perf_counter()
    neutralise_unsafe_markup_urls(text)
    elapsed = time.perf_counter() - started
    assert elapsed < TIME_BUDGET_SECONDS, f"{elapsed:.3f}s for {len(text)} chars"


@pytest.mark.parametrize(
    ("markup", "neutralised"),
    [
        pytest.param("[x](javascript:a) and ![y](javascript:b)", "[x](<>) and ![y](<>)", id="inline"),
        pytest.param("[x][r]\n\n[r]: javascript:a\n", "[x][r]\n\n[r]: <>\n", id="definition"),
        pytest.param("> - [r]: javascript:a", "> - [r]: <>", id="definition-in-list-in-quote"),
        pytest.param("Step [1]: delete the cards", "Step [1]: delete the cards", id="prose-label-colon-kept"),
        pytest.param("\\![x](mailto:a@example.com)", "\\![x](mailto:a@example.com)", id="escaped-bang-is-a-link"),
        pytest.param("![a [b]](mailto:a@example.com)", "![a [b]](<>)", id="nested-brackets-image"),
        pytest.param('<img alt="<img src=javascript:a>" src="/ok.png">', '<img alt="<img src=javascript:a>" src="/ok.png">', id="tag-inside-attribute-is-text"),
    ],
)
def test_linear_scrub_keeps_the_same_decisions(markup: str, neutralised: str) -> None:
    assert neutralise_unsafe_markup_urls(markup) == neutralised
