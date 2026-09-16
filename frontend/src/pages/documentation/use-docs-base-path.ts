// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";

// Docs render both workspace-scoped (/:slug/documentation) and standalone
// (/documentation — readable before any workspace exists). Every internal
// docs link must derive from this single base.
export function useDocsBasePath(): string {
  const { slug } = useParams();
  return slug ? `/${slug}/documentation` : "/documentation";
}
