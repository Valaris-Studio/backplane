# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
import uuid
from datetime import datetime

from pydantic import field_validator
from app.core.json_response import UTCModel

from app.models.git.git_repo import GitProvider
from app.utils import SLUG_FORMAT
from app.schemas.bounded import Str255, Str1024

# git's `ext::`/`fd::` transports execute their argument as a shell command during
# clone, so an unvalidated repo URL is RCE on whatever host runs the clone. Only
# these schemes ever reach a real remote; everything else is rejected outright.
ALLOWED_GIT_URL_SCHEMES = ("https", "http", "ssh", "git")

# The authority is split out because git hands the host straight to the ssh
# binary: a `-`-leading host (`ssh://-oProxyCommand=id@h/r`) is parsed there as
# an option and runs the command — the ext:: bug one layer down.
_SCHEME_URL = re.compile(
    r"^(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*)://(?P<authority>[^/\s]+)(?P<path>/[^\s]*)?$"
)
# scp-style shorthand: user@host:path — the one accepted form without a scheme.
_SCP_URL = re.compile(r"^[A-Za-z0-9._~-]+@(?P<host>[A-Za-z0-9.-]+):(?P<path>[^\s]+)$")

# git refs reach the CLI as bare arguments; a leading `-` makes them an option
# (`--upload-pack=…` runs a command), and revision syntax (`~`, `^`, `..`) lets a
# branch name resolve somewhere the caller didn't name.
_BRANCH_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
_BRANCH_FORBIDDEN = ("..", "^", "~", ":", "?", "*", "[", "\\", "@{")


def _validate_slug(value: str | None) -> str | None:
    if value is None:
        return value
    if not SLUG_FORMAT.match(value):
        raise ValueError(
            "slug must match ^[a-z0-9][a-z0-9-]*$ (lowercase alphanum, hyphen-separated)"
        )
    return value


def _validate_git_url(value: str | None) -> str | None:
    if value is None:
        return value
    if match := _SCHEME_URL.match(value):
        scheme = match.group("scheme").lower()
        if scheme not in ALLOWED_GIT_URL_SCHEMES:
            raise ValueError(
                f"url scheme '{scheme}' is not allowed; use one of "
                f"{', '.join(ALLOWED_GIT_URL_SCHEMES)}"
            )
        # Credentials are legitimate here (the runner embeds a token), so the
        # host is whatever follows the userinfo — but neither half may lead with
        # `-`: git resolves the ssh hostname before the `@` split in some forms,
        # and a `-o…` host reaches the ssh binary as an option.
        authority = match.group("authority")
        host = authority.rpartition("@")[2]
        if not host or host.startswith("-") or authority.startswith("-"):
            raise ValueError("url host is missing or starts with '-'")
        return value
    if match := _SCP_URL.match(value):
        if match.group("path").startswith("-"):
            raise ValueError("url path must not start with '-'")
        return value
    raise ValueError(
        "url must be an https/http/ssh/git URL or scp-style user@host:path"
    )


def validate_branch_name(value: str | None) -> str | None:
    if value is None:
        return value
    if not _BRANCH_NAME.match(value) or any(token in value for token in _BRANCH_FORBIDDEN):
        raise ValueError(
            "branch must start with an alphanumeric and contain only [A-Za-z0-9._/-] "
            "(no git revision syntax)"
        )
    if value.endswith((".lock", "/", ".")):
        raise ValueError("branch must not end with '/', '.', or '.lock'")
    return value


class GitRepoCreate(UTCModel):
    name: Str255
    url: Str1024
    provider: GitProvider
    default_branch: Str255 = "main"
    integration_branch: Str255 | None = None
    description: str = ""
    slug: Str255 | None = None
    require_branch_protection: bool = True
    # Which workspace credential authenticates against this repo. NULL falls
    # back to CredentialResolver's later chain steps. Setting it is admin-only
    # (see the router) — it decides which token gets embedded in clone URLs.
    connection_id: uuid.UUID | None = None

    @field_validator("slug")
    @classmethod
    def _check_slug(cls, v: str | None) -> str | None:
        return _validate_slug(v)

    @field_validator("url")
    @classmethod
    def _check_url(cls, v: str) -> str:
        return _validate_git_url(v)

    @field_validator("default_branch", "integration_branch")
    @classmethod
    def _check_branch(cls, v: str | None) -> str | None:
        return validate_branch_name(v)


class GitRepoUpdate(UTCModel):
    name: Str255 | None = None
    url: Str1024 | None = None
    provider: GitProvider | None = None
    default_branch: Str255 | None = None
    integration_branch: Str255 | None = None
    description: str | None = None
    slug: Str255 | None = None
    require_branch_protection: bool | None = None
    # Read via exclude_unset, so omitted and explicit-null differ: omitting the
    # key leaves the binding alone, sending null UNBINDS the repo. A client that
    # round-trips a full GitRepoRead into this model therefore unbinds every
    # repo whose connection_id happens to be null — send a sparse patch.
    connection_id: uuid.UUID | None = None

    @field_validator("slug")
    @classmethod
    def _check_slug(cls, v: str | None) -> str | None:
        return _validate_slug(v)

    @field_validator("url")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        return _validate_git_url(v)

    @field_validator("default_branch", "integration_branch")
    @classmethod
    def _check_branch(cls, v: str | None) -> str | None:
        return validate_branch_name(v)


class GitRepoRead(UTCModel):
    id: uuid.UUID
    board_id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    slug: str | None
    url: str
    provider: GitProvider
    default_branch: str
    integration_branch: str | None
    description: str
    require_branch_protection: bool
    connection_id: uuid.UUID | None
    added_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
