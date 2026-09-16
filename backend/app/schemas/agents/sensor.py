# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic import BaseModel


class SensorManifestEntry(BaseModel):
    """Manifest of a sensor reported by a Go agent via heartbeat.

    Mirrors harness.SensorManifestEntry on the agent side — the platform
    treats agents as the source of truth for which sensors are installed.
    """

    name: str
    kind: str
    default_config: dict = {}
    config_schema: dict | None = None
    description: str | None = None
