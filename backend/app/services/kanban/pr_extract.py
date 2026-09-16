# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re

from app.services.notes.content_serializer import project_pm_to_text

_PR_LINE = re.compile(r"^PR:\s*(\S+)\s*$")
_BRANCH_LINE = re.compile(r"^Branch:\s*(\S+)\s*$")
_GITHUB_PR = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+")


def extract_pr_url(description: str | None) -> str:
    if not description or not description.strip():
        return ""
    description = project_pm_to_text(description)
    for line in description.splitlines():
        m = _PR_LINE.match(line.strip())
        if m:
            return m.group(1)
    inline = _GITHUB_PR.search(description)
    return inline.group(0) if inline else ""


def extract_pr_branch(description: str | None) -> str:
    if not description or not description.strip():
        return ""
    description = project_pm_to_text(description)
    for line in description.splitlines():
        m = _BRANCH_LINE.match(line.strip())
        if m:
            return m.group(1)
    return ""
