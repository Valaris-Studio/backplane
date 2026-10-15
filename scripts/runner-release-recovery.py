#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover runner 0.8.8 with audited packaging tooling and unchanged source."""


class RecoveryError(RuntimeError):
    pass


def prepare(tooling, source, *, repository, ref, tooling_sha, source_tag, source_sha, tooling_tag):
    raise RecoveryError("recovery is not prepared")
