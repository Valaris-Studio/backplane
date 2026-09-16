# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Git setup must never inherit an operator's repository or transport context."""

import os


def fixture_git_environment():
    env = {
        key: os.environ[key]
        for key in ("PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT")
        if key in os.environ
    }
    return {
        **env,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_ALLOW_PROTOCOL": "file",
    }
