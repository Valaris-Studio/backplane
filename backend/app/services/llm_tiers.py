# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tier-to-(provider, model) resolver.

DEFAULT_PIPELINE_CONFIG emits abstract tier identifiers (premium/mid/low) so
the pipeline isn't coupled to a specific provider's model names. This module
resolves a tier to a concrete (provider, model) tuple right before the
/next-assignment payload is built.

The resolver is intentionally a module-level callable (`_TIER_RESOLVER`) so
that future per-workspace overrides — and tests — can monkeypatch it without
rewriting every caller.
"""

from __future__ import annotations

import logging
import re
from typing import Callable
from uuid import UUID

logger = logging.getLogger(__name__)


_DEFAULT_TIER_MAP: dict[str, tuple[str, str]] = {
    "premium": ("claude-cli", "opus"),
    "mid": ("claude-cli", "sonnet"),
    "low": ("claude-cli", "haiku"),
}

# Literal model names that pre-tier configs and operators still write into
# `stages[].llm.model`. Each maps to its canonical provider+model tuple plus a
# deprecation log line so we can sunset the literal-passthrough path later.
_LITERAL_PASSTHROUGH: dict[str, tuple[str, str]] = {
    "opus": ("claude-cli", "opus"),
    "sonnet": ("claude-cli", "sonnet"),
    "haiku": ("claude-cli", "haiku"),
}


def _default_resolver(tier: str, workspace_id: UUID | None = None) -> tuple[str, str]:
    if tier in _DEFAULT_TIER_MAP:
        return _DEFAULT_TIER_MAP[tier]
    if tier in _LITERAL_PASSTHROUGH:
        logger.warning(
            "llm_tiers: literal model name %r used as tier — deprecated, "
            "use one of %s; literal passthrough will be removed after Q3 2026",
            tier, sorted(_DEFAULT_TIER_MAP),
        )
        return _LITERAL_PASSTHROUGH[tier]
    raise ValueError(
        f"unknown llm tier {tier!r} "
        f"(expected one of {sorted(_DEFAULT_TIER_MAP)})"
    )


_TIER_RESOLVER: Callable[..., tuple[str, str]] = _default_resolver


def resolve_tier(tier: str, workspace_id: UUID | None = None) -> tuple[str, str]:
    return _TIER_RESOLVER(tier, workspace_id)


def is_tier(value: str) -> bool:
    """Whether `value` names an abstract tier (premium/mid/low) rather than a
    concrete model or a deprecated literal. The runner mirrors this set in
    isTierAlias — only true tiers are forwarded on AssignmentLLM.tier for the
    runner to remap to a locally-available coding agent."""
    return value in _DEFAULT_TIER_MAP


# A bare alphabetic token ("high", "best") is a tier-vocabulary typo, not a
# provider model id — concrete ids carry digits/separators (claude-opus-4,
# gpt-4o, llama3:70b).
_BARE_WORD = re.compile(r"[A-Za-z]+\Z")


def model_value_error(value: str) -> str | None:
    """Save-time guard for `stages[].llm.model` / lifecycle llm-step
    `params.model`. Returns an error message for values `resolve_tier` would
    reject at dispatch (the frontend once offered tier "high" — card e019244b),
    or None when the value is acceptable.

    Accepted: empty (falls back to the flat default), known tiers, deprecated
    literal model names, and concrete provider model ids (which dispatch
    forwards verbatim — the documented escape hatch for pinned models).
    """
    candidate = value.strip()
    if (
        not candidate
        or candidate in _DEFAULT_TIER_MAP
        or candidate in _LITERAL_PASSTHROUGH
    ):
        return None
    if _BARE_WORD.fullmatch(candidate):
        return (
            f"unknown llm model tier {value!r} — expected one of "
            f"{sorted(_DEFAULT_TIER_MAP)} (or a concrete provider model id)"
        )
    return None
