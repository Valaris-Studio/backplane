# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repo-fact leak lint for loop templates (spec f52328b3 F12).

"Save as template" and export carry a kernel out of the workspace that authored
it. A kernel that names a repo URL, a commit SHA, an org/repo or a laptop path
is not reusable — it is that workspace's loop wearing a template's clothes. This
module spots those facts and says so.

It WARNS and never blocks (operator direction 2026-08-16): false positives are
acceptable, false negatives expected. Accordingly a `Finding` is deliberately
NOT `ValidationError` (`pipeline_config_validation.py`), which is the shape a
422 is built from — mixing them would eventually let a hint refuse a publish.

Only kernel PROMPT bodies are scanned for repo facts. Slot values are where such
facts are supposed to live, so scanning them would invert the lesson; values are
checked only for `<<SLOT>>` placeholders an author pasted in by mistake.
"""

import logging
import re
from typing import Any, Iterable

from app.services.loop_config_validation import SLOT_PATTERN
from app.services.loop_template_render import PROMPT_FIELDS, TemplateContent

logger = logging.getLogger(__name__)


class Finding(dict):
    """One lint warning: `code`, `match`, `line`, `hint`.

    A dict subclass with attribute access, matching the house style of
    `ValidationError` next door, so routers and the MCP twin can serialize it
    without a schema while tests can read `finding.code`.
    """

    def __init__(self, *, code: str, match: str, line: int, hint: str):
        super().__init__(code=code, match=match, line=line, hint=hint)

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


_HINTS = {
    "url": "move into a slot such as <<REPO_URL>>",
    "git_ref": "a commit is a run fact — move it into a slot such as <<BASE_SHA>>",
    "org_repo": "move into a slot such as <<REPO_SLUG>>",
    "abs_path": "move into a slot such as <<WORKDIR>>",
    "secret_like": "remove it — a template is shareable; secrets never are",
    "slot_leftover": "a slot VALUE should be the filled text, not a placeholder",
}

# A short hex run is only a commit when a nearby word says so; `deadbeef` and
# `facebee` are ordinary prose. Full 40-hex is unambiguous on its own.
_SHA_CONTEXT = r"sha|commit|merge|merged|anchor|rev|revision|head|hash"

_PROMPT_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("url", re.compile(r"https?://[^\s)]+")),
    (
        "org_repo",
        re.compile(r"\b[\w.-]+/[\w.-]+\.git\b|github\.com/[^\s/]+/[^\s/]+"),
    ),
    (
        "git_ref",
        # Alternation of single-group branches: `findall` yields the group, so
        # the context words themselves never end up in the reported match.
        # Python's `re` has no variable-width lookbehind, hence a real group.
        re.compile(
            rf"\b([0-9a-f]{{40}})\b"
            rf"|\b(?:{_SHA_CONTEXT})\s+([0-9a-f]{{7,40}})\b"
            rf"|\b([0-9a-f]{{7,40}})\s+(?:{_SHA_CONTEXT})\b",
            re.IGNORECASE,
        ),
    ),
    ("abs_path", re.compile(r"(?<![\w])(?:/Users/|/home/|~/|C:\\)[^\s]+")),
    (
        "secret_like",
        re.compile(
            r"\b(?:vlr_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}"
            r"|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})\b"
        ),
    ),
)


def _scan(text: str, rules, allow: Iterable[str]) -> list[Finding]:
    """Apply `rules` line by line, deduping by (code, match) across the body."""
    allowed = set(allow)
    seen: set[tuple[str, str]] = set()
    findings: list[Finding] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for code, pattern in rules:
            for raw in pattern.findall(line):
                # A multi-group alternation yields a tuple with one non-empty
                # branch; a group-free pattern yields the whole match.
                match = (
                    next((part for part in raw if part), "")
                    if isinstance(raw, tuple)
                    else raw
                )
                if not match or match in allowed or (code, match) in seen:
                    continue
                seen.add((code, match))
                findings.append(
                    Finding(
                        code=code, match=match, line=line_number, hint=_HINTS[code]
                    )
                )
    return findings


def lint_repo_facts(text: str, *, allow: Iterable[str] = frozenset()) -> list[Finding]:
    """Findings for repo-specific facts in one kernel prompt body.

    Secret-shaped matches are additionally logged at WARNING so an operator sees
    that one happened — WITHOUT the match text, which would defeat the point.
    """
    findings = _scan(text, _PROMPT_RULES, allow)
    secrets = sum(1 for finding in findings if finding["code"] == "secret_like")
    if secrets:
        logger.warning(
            "loop template lint: %d secret_like match(es) found; "
            "match text withheld from logs",
            secrets,
        )
    return findings


_SLOT_VALUE_RULES = (("slot_leftover", SLOT_PATTERN),)


def _slot_value_texts(slot: Any) -> list[str]:
    """The authored strings a slot ships with — default, example, enum values.

    Read defensively because a slot arrives either as a `SlotSpec` or as the raw
    dict half of a draft that has not been validated yet.
    """
    get = slot.get if isinstance(slot, dict) else lambda key, d=None: getattr(slot, key, d)
    texts = [get("default"), get("example")]
    texts.extend(get("enum_values") or [])
    return [text for text in texts if isinstance(text, str) and text]


def lint_template_content(
    content: TemplateContent | dict, *, allow: Iterable[str] = frozenset()
) -> list[Finding]:
    """Lint a whole template: repo facts in kernels, leftovers in slot values."""
    if isinstance(content, dict):
        content = TemplateContent.model_validate(content)

    findings: list[Finding] = []
    for field_name in PROMPT_FIELDS:
        findings.extend(lint_repo_facts(getattr(content, field_name) or "", allow=allow))

    seen = {(finding["code"], finding["match"]) for finding in findings}
    for slot in content.slots:
        for text in _slot_value_texts(slot):
            for finding in _scan(text, _SLOT_VALUE_RULES, allow):
                key = (finding["code"], finding["match"])
                if key not in seen:
                    seen.add(key)
                    findings.append(finding)
        findings.extend(lint_variant_rail_coverage(slot))
    return findings


def lint_variant_rail_coverage(slot: Any) -> list[Finding]:
    """Findings for a variant slot whose variants disagree about a rail.

    A variant that sets no value for a rail its SIBLING sets does not fall
    back to nothing — `render` resolves rails as
    ``{**rails_defaults, **variant_rails}``, so the silent variant inherits
    whatever `rails_defaults` happens to say. That is how Coding Loop v2 came
    to ship a self-merge prose variant under ``loop_landing="human"``: the
    prompt told the agent to land its own PR while the config described a
    board waiting on a person. Nothing errors, which is precisely why it needs
    a lint.

    Only rails SOME variant already sets are checked. A slot where no variant
    touches rails has nothing to disagree about, and flagging it would train
    authors to ignore the lint. That same rule covers the degenerate arities
    for free — with zero variants nothing is claimed, and with one the only
    variant is never silent about a rail it itself set — so no arity guard is
    needed here.
    """
    get = slot.get if isinstance(slot, dict) else lambda key, d=None: getattr(slot, key, d)
    variants = get("variants") or []

    def _rails(variant: Any) -> dict:
        rails = (
            variant.get("rails")
            if isinstance(variant, dict)
            else getattr(variant, "rails", None)
        )
        return rails if isinstance(rails, dict) else {}

    def _id(variant: Any) -> str:
        return str(
            variant.get("id") if isinstance(variant, dict) else getattr(variant, "id", "")
        )

    slot_name = get("name") or ""
    findings: list[Finding] = []
    claimed = sorted({rail for variant in variants for rail in _rails(variant)})
    for rail in claimed:
        silent = [_id(variant) for variant in variants if rail not in _rails(variant)]
        if not silent:
            continue
        findings.append(
            Finding(
                code="variant_rail_inherited",
                match=f"{slot_name}.{rail}",
                line=0,
                hint=(
                    f"variant(s) {', '.join(silent)} leave {rail} to "
                    "rails_defaults while a sibling sets it — give every "
                    "variant an explicit value so the prose and the rail "
                    "cannot disagree"
                ),
            )
        )
    return findings
