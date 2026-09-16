// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";
import { RUNNER_RELEASE, runnerArtifactUrl, runnerChecksumsUrl } from "@/lib/runner-release";

// Hosted-instance operators reach the launch commands without ever being told
// where the binary comes from. This is the missing step zero: direct downloads
// for the pinned release, the checksum file, and the guided walkthrough. Shared
// by the creation wizard's launch step and the existing-runner launch panel.
export function GetRunnerBlock() {
  const { t } = useTranslation();
  const docsBasePath = useDocsBasePath();

  return (
    <div
      className="rounded-lg border border-border/60 bg-muted/20 p-4"
      data-testid="get-runner-block"
    >
      <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Download className="h-3.5 w-3.5" />
        {t("runner.getRunner.title", { version: RUNNER_RELEASE.version })}
      </p>
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-3">
        {RUNNER_RELEASE.artifacts.map((artifact) => (
          <li key={artifact.filename}>
            <a
              href={runnerArtifactUrl(artifact)}
              className="text-xs font-medium text-primary hover:underline"
              data-testid={`get-runner-link-${artifact.filename}`}
            >
              {artifact.os} {artifact.arch}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        <a
          href={runnerChecksumsUrl()}
          className="font-medium text-primary hover:underline"
          data-testid="get-runner-checksums"
        >
          SHA256SUMS
        </a>{" "}
        — {t("runner.getRunner.checksumHint")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t("runner.getRunner.windowsCaveat")}</p>
      <p className="mt-1 text-xs">
        <Link
          to={`${docsBasePath}/your-first-pipeline-run`}
          className="font-medium text-primary hover:underline"
          data-testid="get-runner-docs-link"
        >
          {t("runner.getRunner.docsLink")}
        </Link>
      </p>
    </div>
  );
}
