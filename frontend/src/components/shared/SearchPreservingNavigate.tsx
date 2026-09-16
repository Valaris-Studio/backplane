// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, useLocation } from "react-router-dom";

/**
 * Drop-in for `<Navigate replace>` on index routes. Plain `<Navigate to="tab">`
 * discards the current query string, which breaks deep links like
 * `/:slug/boards/:boardId?card=<id>` that rely on the redirect to the default
 * tab keeping their params.
 */
export function SearchPreservingNavigate({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}
