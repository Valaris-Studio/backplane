# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from starlette.convertors import PathConvertor, register_url_convertor


class NonEmptyPathConvertor(PathConvertor):
    # Starlette's `path` also matches "", so `…/download/` reached auth (401/403)
    # while an unknown route 404s — confirming the route exists. Requiring a
    # character makes a keyless URL an unknown route instead.
    regex = ".+"


register_url_convertor("nonempty_path", NonEmptyPathConvertor())
