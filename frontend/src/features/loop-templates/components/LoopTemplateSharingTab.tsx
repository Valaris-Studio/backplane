// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExportButton } from "@/components/export/export-button";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { isApiError } from "@/lib/api-error";
import { loopTemplateKeys } from "@/lib/query-keys";
import {
  fetchLoopTemplate,
  importLoopTemplate,
  lintLoopTemplate,
  type LoopTemplateImportResult,
} from "../api/loop-templates";
import { findingsFrom } from "../lib/publish-findings";

/**
 * Share a loop template as a bundle file, and take one back in.
 *
 * Export is a member capability and always visible; import is admin-only
 * (`get_workspace_admin` + `forbid_agent_callers` on the route), so the
 * controls are hidden rather than disabled for everyone else — a non-admin
 * has no path to a successful POST and a disabled button would only invite
 * the attempt.
 */
export function LoopTemplateSharingTab({
  slug,
  templateRef,
}: {
  slug: string;
  templateRef: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useWorkspaceAdmin(slug);
  const fileInput = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<LoopTemplateImportResult | null>(null);
  const [bundle, setBundle] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: loopTemplateKeys.detail(slug, templateRef),
    queryFn: () => fetchLoopTemplate(slug, templateRef),
  });

  const lint = useQuery({
    queryKey: [...loopTemplateKeys.detail(slug, templateRef), "lint"],
    queryFn: () => lintLoopTemplate(slug, templateRef),
  });

  const runImport = useMutation({
    mutationFn: ({ payload, dryRun }: { payload: unknown; dryRun: boolean }) =>
      importLoopTemplate(slug, payload, { dryRun }),
    onSuccess: (result) => {
      setError(null);
      if (result.dry_run) {
        setPreview(result);
        return;
      }
      // A committed import lands a DRAFT; the profile tab is where the
      // operator names and reviews it before any publish.
      if (result.template_id) {
        navigate(`/${slug}/runner/loops/${result.template_id}/profile`);
      }
    },
    onError: (err) => {
      setPreview(null);
      setError(
        describeImportError(err, t("loopTemplates.sharing.importFailed")),
      );
    },
  });

  async function handleFile(file: File | undefined) {
    setPreview(null);
    setError(null);
    if (!file) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      // Never spend a round-trip on a file that is not even JSON.
      setError(t("loopTemplates.sharing.unparseable"));
      return;
    }
    setBundle(parsed);
    runImport.mutate({ payload: parsed, dryRun: true });
  }

  if (detail.isLoading) {
    return (
      <Skeleton
        className="h-64 w-full"
        data-testid="loop-template-sharing-loading"
      />
    );
  }

  const leakFindings = lint.data ?? [];

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="loop-template-sharing-tab"
    >
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {t("loopTemplates.sharing.exportTitle")}
        </h3>

        <p
          data-testid="loop-template-sharing-warning"
          className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("loopTemplates.sharing.repoFactsWarning")}
        </p>

        {leakFindings.length > 0 && (
          <ul
            className="space-y-1"
            data-testid="loop-template-sharing-findings"
          >
            {leakFindings.map((finding, index) => (
              <li
                key={`${finding.code}-${finding.match}-${finding.line}`}
                data-testid={`sharing-leak-finding-${index}`}
                className="rounded-md border border-border/70 p-2 text-xs"
              >
                <code className="font-mono">{finding.match}</code>
                <span className="text-muted-foreground ml-2">
                  {t("loopTemplates.sharing.findingLine", {
                    line: finding.line,
                  })}
                </span>
                {/* Server copy, relayed verbatim: the lint codes are backend
                    vocabulary and translating them here would drift. */}
                <p className="text-muted-foreground">{finding.hint}</p>
              </li>
            ))}
          </ul>
        )}

        <div>
          <ExportButton
            data-testid="loop-template-sharing-export"
            data-export-endpoint={exportEndpoint(slug, templateRef)}
            data-export-filename={exportFilename(detail.data?.slug)}
            endpoint={exportEndpoint(slug, templateRef)}
            defaultFilename={exportFilename(detail.data?.slug)}
            entityLabel={t("export.entity.loopTemplate")}
          />
        </div>
      </section>

      {isAdmin && (
        <section
          className="flex flex-col gap-3 border-t border-border/60 pt-4"
          data-testid="loop-template-sharing-import"
        >
          <h3 className="text-sm font-medium">
            {t("loopTemplates.sharing.importTitle")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("loopTemplates.sharing.importHint")}
          </p>

          {/* Real button affordance (devops UX round 2 #6) driving a hidden
              file input — same pattern as FileUploadButton. */}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="loop-template-sharing-choose-file"
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t("loopTemplates.sharing.chooseFile")}
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            data-testid="loop-template-sharing-file"
            aria-label={t("loopTemplates.sharing.fileLabel")}
            className="hidden"
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              // Reset so re-choosing the same file re-fires change.
              event.target.value = "";
            }}
          />

          {preview && (
            <div
              className="space-y-2 rounded-md border border-border/70 p-3 text-xs"
              data-testid="loop-template-sharing-preview"
            >
              <p data-testid="loop-template-sharing-preview-action">
                {t(`loopTemplates.sharing.action.${preview.action}`, {
                  slug: preview.slug,
                })}
              </p>

              {preview.diff_summary.length > 0 && (
                <p
                  className="text-muted-foreground"
                  data-testid="loop-template-sharing-preview-diff"
                >
                  {t("loopTemplates.sharing.diffSummary", {
                    fields: preview.diff_summary.join(", "),
                  })}
                </p>
              )}

              {preview.leak_findings.length > 0 && (
                <ul className="space-y-1">
                  {preview.leak_findings.map((finding, index) => (
                    <li
                      key={`${finding.code}-${finding.match}-${finding.line}`}
                      data-testid={`sharing-preview-leak-${index}`}
                      className="text-muted-foreground"
                    >
                      <code className="font-mono">{finding.match}</code>{" "}
                      {finding.hint}
                    </li>
                  ))}
                </ul>
              )}

              {preview.findings.length > 0 && (
                <ul
                  className="space-y-1 text-destructive"
                  data-testid="loop-template-sharing-preview-blocking"
                >
                  {preview.findings.map((finding) => (
                    <li key={`${finding.code}-${finding.field}`}>
                      <code className="font-mono">{finding.field}</code>{" "}
                      {finding.message}
                    </li>
                  ))}
                </ul>
              )}

              <Button
                type="button"
                size="sm"
                data-testid="loop-template-sharing-confirm"
                disabled={runImport.isPending || preview.findings.length > 0}
                onClick={() =>
                  runImport.mutate({ payload: bundle, dryRun: false })
                }
              >
                {t("loopTemplates.sharing.confirm")}
              </Button>
            </div>
          )}

          {error && (
            <p
              className="text-destructive text-xs"
              data-testid="loop-template-sharing-error"
            >
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function exportEndpoint(slug: string, templateRef: string) {
  return `/workspaces/${slug}/loop-templates/${encodeURIComponent(templateRef)}/export`;
}

/** Mirrors the backend's Content-Disposition attachment name exactly. */
function exportFilename(templateSlug: string | undefined) {
  return `${templateSlug ?? "loop-template"}.loop-template.json`;
}

/**
 * The server's own words where it has them.
 *
 * A 400 envelope guard and a 403 both carry a plain string `detail`; a 422
 * carries the validator findings array, which reads best as its dotted
 * fields. Anything else falls back to the generic message.
 */
function describeImportError(err: unknown, fallback: string): string {
  if (!isApiError(err)) return fallback;

  const findings = findingsFrom(err.detail);
  if (findings.length > 0) {
    return findings.map((f) => `${f.field}: ${f.message}`).join("; ");
  }
  return typeof err.detail === "string" ? err.detail : fallback;
}
