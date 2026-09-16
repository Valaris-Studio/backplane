// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";

export function GitHubTokenGuidance({ id }: { id?: string }) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-testid="pat-scope-guidance"
      className="space-y-2 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-4 py-3 text-sm"
    >
      <h3 id={titleId} className="font-semibold text-foreground">
        {t("integrations.pat.githubPermissions.title")}
      </h3>
      <p className="text-muted-foreground">
        {t("integrations.pat.githubPermissions.repositorySelection")}
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {(["contents", "pullRequests", "actions", "commitStatuses"] as const).map(
          (permission) => (
            <li key={permission}>
              {t(`integrations.pat.githubPermissions.${permission}`)}
            </li>
          ),
        )}
      </ul>
      <p className="text-muted-foreground">
        {t("integrations.pat.githubPermissions.verificationLimit")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("integrations.pat.scopeGuidance.githubClassic")}
      </p>
      <a
        href="https://github.com/settings/personal-access-tokens"
        target="_blank"
        rel="noreferrer"
        className="inline-block text-primary underline underline-offset-4"
      >
        {t("integrations.pat.githubPermissions.settingsLink")}
      </a>
    </section>
  );
}
