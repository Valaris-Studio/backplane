// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { ResourceList } from "@/features/resources/components/ResourceList";

export function WorkspaceResourcesPage() {
  const { slug = "" } = useParams();
  return <ResourceList slug={slug} />;
}
