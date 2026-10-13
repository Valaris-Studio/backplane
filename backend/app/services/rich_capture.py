# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Whether a mapping captures rich, as the server decides it: the operator's
switch, the owner's level, the device's announced capability, and the grant
time that bounds what content may claim to be."""

from datetime import datetime, timezone

from app.config import settings
from app.core.time import as_utc
from app.exceptions import ConflictError
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.schemas.session_content import (
    CHUNK_BYTES,
    MAX_ATTACHMENT_BYTES,
    MAX_CHUNKS,
    MAX_CONTENTS_PER_RECORD,
    MAX_INLINE_BODY_BYTES,
    MAX_INLINE_BYTES_PER_RECORD,
    MAX_INSTALLATION_BODY_BYTES,
    MAX_RICH_MAPPINGS,
    MAX_SESSION_BODY_BYTES,
    MAX_TEXT_BODY_BYTES,
    RICH_CAPTURE_CAPABILITY,
    STAGING_TTL,
    MappingEffectiveCapture,
    RichCaptureLimits,
    RichCaptureOffer,
    RichMappingGrant,
)

RICH = "rich"
# What a rich mapping captures where bodies cannot be accepted.
RICH_FALLBACK = "full"
LIMITS = RichCaptureLimits(
    max_contents_per_record=MAX_CONTENTS_PER_RECORD,
    max_inline_body_bytes=MAX_INLINE_BODY_BYTES,
    max_inline_bytes_per_record=MAX_INLINE_BYTES_PER_RECORD,
    max_text_body_bytes=MAX_TEXT_BODY_BYTES,
    max_attachment_bytes=MAX_ATTACHMENT_BYTES,
    chunk_bytes=CHUNK_BYTES,
    max_chunks=MAX_CHUNKS,
    staging_ttl_seconds=int(STAGING_TTL.total_seconds()),
    session_body_bytes=MAX_SESSION_BODY_BYTES,
    installation_body_bytes=MAX_INSTALLATION_BODY_BYTES,
)


def rich_capture_enabled() -> bool:
    return settings.RICH_CAPTURE_ENABLED


def announced_capabilities(header: str | None) -> list[str] | None:
    """The capability tokens of a `Backplane-Capture-Capabilities` header."""
    if header is None:
        return None
    return sorted({token.strip() for token in header.split(",") if token.strip()})


def device_captures_rich(installation: CompanionInstallation) -> bool:
    return RICH_CAPTURE_CAPABILITY in (installation.capture_capabilities or [])


def effective_capture(
    mapping: CompanionProjectMapping, installation: CompanionInstallation
) -> MappingEffectiveCapture:
    """A rich mapping captures full where this server or device takes no
    bodies, and says which of the two is why."""
    if mapping.content_level != RICH:
        return MappingEffectiveCapture(
            content_level=mapping.content_level,
            effective_content_level=mapping.content_level,
        )
    reason = None
    if not rich_capture_enabled() or mapping.rich_since is None:
        reason = "server_disabled"
    elif not device_captures_rich(installation):
        reason = "device_unsupported"
    return MappingEffectiveCapture(
        content_level=RICH,
        effective_content_level=RICH_FALLBACK if reason else RICH,
        reason=reason,
    )


def grants_bodies(
    mapping: CompanionProjectMapping, installation: CompanionInstallation
) -> bool:
    return effective_capture(mapping, installation).effective_content_level == RICH


def require_level_available(level: str | None) -> None:
    if level == RICH and not rich_capture_enabled():
        raise ConflictError(
            "Rich capture is not enabled on this Backplane",
            error_code="rich_capture_unavailable",
        )


def new_mapping_level(chosen: str | None) -> str:
    """A new mapping's level: the one chosen, else rich where available."""
    require_level_available(chosen)
    if chosen is not None:
        return chosen
    return RICH if rich_capture_enabled() else "standard"


def carried_level(level: str) -> str:
    """A level carried over from the owner's other devices; rich only where
    this server takes it."""
    return RICH_FALLBACK if level == RICH and not rich_capture_enabled() else level


def rich_since_for(level: str, previous: str | None, granted: datetime | None):
    """The grant time after a mapping's level becomes `level`: kept while it
    stays rich, renewed when it becomes rich, cleared when it leaves."""
    if level != RICH:
        return None
    if previous == RICH and granted is not None:
        return granted
    return datetime.now(timezone.utc) if rich_capture_enabled() else None


def set_level(mapping: CompanionProjectMapping, level: str) -> None:
    mapping.rich_since = rich_since_for(
        level, mapping.content_level, mapping.rich_since
    )
    mapping.content_level = level


def rich_capture_offer(
    installation: CompanionInstallation, mappings: list[CompanionProjectMapping]
) -> RichCaptureOffer | None:
    if not (rich_capture_enabled() and device_captures_rich(installation)):
        return None
    granted = [
        mapping
        for mapping in mappings
        if mapping.content_level == RICH
        and mapping.enabled
        and mapping.rich_since is not None
    ]
    grants = [
        RichMappingGrant(mapping_id=mapping.id, rich_since=as_utc(mapping.rich_since))
        for mapping in sorted(granted, key=lambda mapping: as_utc(mapping.rich_since))
    ]
    return RichCaptureOffer(
        version=1, limits=LIMITS, rich_mappings=grants[:MAX_RICH_MAPPINGS]
    )
