# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.exceptions import ValidationError
from app.services.session_content import AgentSessionContentService
from app.services.session_content_cursor import ContentWindowCursor


def test_cursor_roundtrips_the_instant_of_an_aware_non_utc_timestamp():
    session_id = uuid.uuid4()
    position = (
        datetime(2026, 10, 17, 15, 30, 12, 345678, tzinfo=timezone(timedelta(hours=-4))),
        42,
        uuid.uuid4(),
    )
    cursor = ContentWindowCursor(session_id, "earlier", boundary=position)
    restored = ContentWindowCursor.decode(cursor.encode(), session_id, "earlier")
    assert restored.boundary == position
    assert restored.boundary[0].utcoffset() == timedelta(0)


@pytest.mark.parametrize("mode", ["earlier", "later", "refresh"])
async def test_direct_service_empty_cursor_is_validation_failure_after_authorization(mode):
    service = AgentSessionContentService(None)
    service._owned_session = AsyncMock()
    workspace_id, owner_id, session_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with pytest.raises(ValidationError):
        await service.content_window(
            workspace_id, owner_id, session_id, mode=mode, cursor="", anchor_id=None
        )
    service._owned_session.assert_awaited_once_with(workspace_id, owner_id, session_id)
