# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy.engine import make_url

from app.config import Settings


@pytest.mark.parametrize("password", ["Audit@2026/Strong:Pass", "a@/:#%$b", "a%40b", "a b"])
def test_database_password_is_literal_not_url_syntax(password):
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql+asyncpg://backplane@postgres:5432/backplane",
        DATABASE_PASSWORD=password,
    )
    url = make_url(settings.DATABASE_URL)
    assert url.password == password
    assert url.host == "postgres"
    assert url.database == "backplane"


def test_database_url_keeps_its_password_when_no_separate_password_is_set():
    url = "postgresql+asyncpg://user:encoded%40password@localhost:5433/example"
    assert Settings(_env_file=None, DATABASE_URL=url).DATABASE_URL == url


def test_separate_password_overrides_the_url_password():
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql+asyncpg://user:old@localhost/example",
        DATABASE_PASSWORD="new@password",
    )
    assert make_url(settings.DATABASE_URL).password == "new@password"


def test_invalid_database_url_reports_a_configuration_error():
    with pytest.raises(ValueError, match="DATABASE_URL must be a valid database URL"):
        Settings(_env_file=None, DATABASE_URL="not-a-url", DATABASE_PASSWORD="password")
