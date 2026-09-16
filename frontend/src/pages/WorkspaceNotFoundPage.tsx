// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { buttonVariants } from "@/components/ui/button";

// Rendered for BOTH 404 (no such workspace) and 403 (exists, caller is not a
// member). One surface with one wording on purpose: distinguishing them would
// let anyone confirm a private workspace's existence by typing its slug.
export function WorkspaceNotFoundPage() {
  const { t } = useTranslation();

  return (
    <div data-testid="workspace-not-found">
      <EmptyState
        icon={SearchX}
        title={t("workspace.notFound.title")}
        description={t("workspace.notFound.body")}
        action={
          <Link to="/" className={buttonVariants()}>
            {t("workspace.notFound.backToList")}
          </Link>
        }
      />
    </div>
  );
}
