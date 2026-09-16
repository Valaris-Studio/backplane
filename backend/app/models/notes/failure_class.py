# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reviewer verdict failure classification.

When a reviewer issues a non-approving verdict it MUST attach a `failure_class`
so a downstream advisor role can route by failure type and we can collect
training signal on what fails and why. Approving verdicts leave the field NULL.

The five classes are deliberately coarse — they are the routing primitives,
not the explanation. The verdict note's body carries the prose; this enum
carries the category.
"""

from enum import Enum


class ReviewFailureClass(str, Enum):
    # External world broke: missing/wrong dep version at runtime, flaky network,
    # CI infra hiccup, sandbox-permission denial. Not a code defect.
    ENVIRONMENT = "ENVIRONMENT"

    # Code is wrong: bug, incorrect algorithm, broken invariant, failing test
    # caused by the change itself.
    LOGIC = "LOGIC"

    # Wrong/missing/incompatible library or package: import error, version
    # conflict, abandoned upstream, license clash. Distinct from ENVIRONMENT
    # in that the fix lives in the project's manifests, not the runner.
    DEPENDENCY = "DEPENDENCY"

    # The implementation works but solves the wrong problem or takes the wrong
    # shape: architectural mismatch, ignored card directive, layer violation.
    # The code passes its own tests; the reviewer says "not this way".
    APPROACH = "APPROACH"

    # Intermittent failure with no clear cause: re-running might pass. Used
    # sparingly — most "transient" failures are really ENVIRONMENT or LOGIC.
    TRANSIENT = "TRANSIENT"


REVIEW_FAILURE_CLASS_VALUES: frozenset[str] = frozenset(c.value for c in ReviewFailureClass)
