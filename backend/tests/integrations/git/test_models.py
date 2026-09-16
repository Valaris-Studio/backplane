# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.integrations.git.models import PullRequest, Repository, User


def _now() -> datetime:
    return datetime(2026, 4, 26, tzinfo=timezone.utc)


def test_repository_provider_data_defaults_empty_dict():
    repo = Repository(
        provider="github",
        id="acme/widgets",
        full_name="acme/widgets",
        default_branch="main",
        private=False,
        clone_url_https="https://github.com/acme/widgets.git",
        updated_at=_now(),
    )

    assert repo.provider_data == {}


@pytest.mark.parametrize("state", ["open", "merged", "closed"])
def test_pull_request_state_accepts_open_merged_closed(state: str):
    author = User(provider="github", id="u1", username="octocat")
    pr = PullRequest(
        provider="github",
        id="42",
        number=42,
        title="hi",
        body=None,
        state=state,
        source_branch="feat/x",
        target_branch="main",
        author=author,
        created_at=_now(),
        updated_at=_now(),
        url="https://github.com/acme/widgets/pull/42",
    )

    assert pr.state == state


def test_pull_request_requires_author():
    with pytest.raises(ValidationError):
        PullRequest(
            provider="github",
            id="42",
            number=42,
            title="hi",
            state="open",
            source_branch="feat/x",
            target_branch="main",
            created_at=_now(),
            updated_at=_now(),
            url="https://github.com/acme/widgets/pull/42",
        )
