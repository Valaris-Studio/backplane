# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from app.models.user import User
from app.repositories.product_documentation import ProductDocumentationRepository


class ProductDocumentationService:
    def _catalog(self, user: User, locale: str, version: str | None = None):
        # All authenticated identities may read product docs. No workspace data
        # is queried or interpolated, including for workspace-bound agent keys.
        if user is None:
            raise ForbiddenError()
        try:
            catalog = ProductDocumentationRepository.read_catalog()
        except (OSError, ValueError) as exc:
            raise ServiceUnavailableError(
                "Platform documentation artifact is unavailable"
            ) from exc
        if locale not in catalog["locales"]:
            raise ValidationError("Unsupported documentation locale")
        if version is not None and version != catalog["version"]:
            raise ConflictError(
                "Documentation version changed; list documentation again",
                context={"version": catalog["version"]},
            )
        return catalog

    def list_sections(self, user: User, locale: str, offset: int, limit: int):
        catalog = self._catalog(user, locale)
        sections = catalog["locales"][locale]
        return {
            "version": catalog["version"],
            "schema_version": catalog["schema_version"],
            "locale": locale,
            "available_locales": list(catalog["locales"]),
            "total": len(sections),
            "next_offset": offset + limit if offset + limit < len(sections) else None,
            "sections": [
                {key: value for key, value in section.items() if key != "markdown"}
                for section in sections[offset : offset + limit]
            ],
        }

    def read_section(
        self,
        user: User,
        slug: str,
        locale: str,
        version: str | None,
        offset: int,
        limit: int,
    ):
        catalog = self._catalog(user, locale, version)
        section = next(
            (s for s in catalog["locales"][locale] if s["slug"] == slug), None
        )
        if section is None:
            raise ResourceNotFoundError("Documentation section not found")
        content = section["markdown"]
        return {
            **section,
            "version": catalog["version"],
            "schema_version": catalog["schema_version"],
            "locale": locale,
            "offset": offset,
            "total_characters": len(content),
            "markdown": content[offset : offset + limit],
            "next_offset": offset + limit if offset + limit < len(content) else None,
        }
