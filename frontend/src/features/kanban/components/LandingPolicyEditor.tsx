// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CompletionContextWarning } from "@/features/kanban/components/CompletionContextWarning";

import { isApiError } from "@/lib/api-error";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCompletionPolicy, useCompletionPolicyPreview } from "../api/use-completion";
import type { CompletionLoopConfig, CompletionPolicy, CompletionTemplateBinding } from "@/types/completion";

export const INITIAL_COMPLETION_POLICY: CompletionPolicy = {
  version: 1, landing_actor: "agent", landing_methods: ["merge_queue"],
  source_review: "none", review_role: null, require_forge_checks: false,
  postmerge_validation: null,
  evidence_only: { enabled: false, approval: "none", review_role: null },
  dependency_release: "done", auto_complete: true,
};

interface Props {
  slug: string;
  boardId: string;
  value: CompletionPolicy | null;
  loopConfig?: CompletionLoopConfig;
  template?: CompletionTemplateBinding;
  onChange: (value: CompletionPolicy | null) => void;
  onApply: () => void;
  onValidityChange?: (valid: boolean) => void;
  hideApply?: boolean;
  disabled?: boolean;
}

export function LandingPolicyEditor({ slug, boardId, value, onChange, onApply, onValidityChange, hideApply, disabled, loopConfig, template }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const current = useCompletionPolicy(slug, boardId);
  const preview = useCompletionPolicyPreview(slug, boardId, value, true, loopConfig, template);
  const resolution = preview.data ?? current.data;
  const valid = preview.isSuccess && !preview.isFetching && preview.data.incompatibilities.length === 0 && !preview.data.template_preview?.findings.length;
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const patch = (next: Partial<CompletionPolicy>) => onChange({ ...(value ?? resolution?.effective_policy ?? INITIAL_COMPLETION_POLICY), ...next });
  const errorDetail = isApiError(preview.error) ? preview.error.detail : undefined;
  const validationMessages = Array.isArray(errorDetail)
    ? errorDetail.flatMap((finding) => typeof finding?.message === "string" ? [finding.message] : typeof finding?.msg === "string" ? [finding.msg] : [])
    : typeof errorDetail === "string" ? [errorDetail] : [];
  const fieldKeys: Record<string, string> = { landing_actor: "landingActor", landing_methods: "landingMethods", source_review: "sourceReview", review_role: "reviewRole", require_forge_checks: "requireForgeChecks", postmerge_validation: "postmergeValidation", evidence_only: "evidenceOnly", dependency_release: "dependencyRelease", auto_complete: "autoComplete", origin: "policyOrigin", version: "version" };
  function changeValue(field: string, item: unknown): string {
    if (item == null) return t("completionPolicy.notConfigured");
    if (typeof item === "boolean") return t(item ? "completionPolicy.enabled" : "completionPolicy.disabled");
    const keys: Record<string, string> = { landing_actor: "actors", source_review: "approval", dependency_release: "release", origin: "origin" };
    if (keys[field] && typeof item === "string") return t(`completionPolicy.${keys[field]}.${item}`);
    if (field === "landing_methods" && Array.isArray(item)) return item.map((method) => t(`completionPolicy.methods.${method}`)).join(", ");
    if (field === "postmerge_validation" && typeof item === "object") {
      const validation = item as NonNullable<CompletionPolicy["postmerge_validation"]>;
      return `${validation.role}: ${validation.checks.map((check) => check.id).join(", ")}`;
    }
    if (field === "evidence_only" && typeof item === "object") {
      const evidence = item as CompletionPolicy["evidence_only"];
      return `${changeValue("", evidence.enabled)} · ${t(`completionPolicy.approval.${evidence.approval}`)}${evidence.review_role ? ` · ${evidence.review_role}` : ""}`;
    }
    return String(item);
  }
  const preset = (name: "agentManaged" | "reviewed" | "validated" | "human") => {
    const source = value ?? resolution?.effective_policy ?? INITIAL_COMPLETION_POLICY;
    onChange({
      ...source,
      landing_actor: name === "agentManaged" ? "agent" : name === "human" ? "human" : "platform",
      landing_methods: [name === "human" ? "external" : "merge_queue"],
      source_review: name === "agentManaged" ? "none" : name === "human" ? source.source_review : "independent",
      auto_complete: name !== "human",
      postmerge_validation: name === "validated" ? source.postmerge_validation ?? { role: "", checks: [] } : source.postmerge_validation,
    });
  };
  return (
    <section aria-label={t("completionPolicy.title")} className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("completionPolicy.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("completionPolicy.description")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange(null)}>{t("completionPolicy.inherit")}</Button>
        {(["agentManaged", "reviewed", "validated", "human"] as const).map((name) => (
          <Button key={name} type="button" size="sm" variant="outline" disabled={disabled} onClick={() => preset(name)}>{t(`completionPolicy.presets.${name}`)}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("completionPolicy.presetHint")}</p>
      <CompletionContextWarning slug={slug} sourceKind="configuration" sourceId={boardId} />
      <div role="status" aria-live="polite" className="space-y-1 text-sm">
        {resolution && <p>{t(`completionPolicy.origin.${resolution.origin}`)}</p>}
        {resolution?.effective_policy && <p className="break-words text-xs text-muted-foreground">
          {t("completionPolicy.summary", {
            actor: t(`completionPolicy.actors.${resolution.effective_policy.landing_actor}`),
            release: t(`completionPolicy.release.${resolution.effective_policy.dependency_release}`),
          })}
          {resolution.effective_policy.review_role && <> · <span>{resolution.effective_policy.review_role}</span></>}
          {resolution.effective_policy.postmerge_validation && <> · <span>{resolution.effective_policy.postmerge_validation.role}</span></>}
        </p>}
        {preview.isFetching && <p>{t("completionPolicy.previewPending")}</p>}
      </div>
      {resolution?.context_size && <div className="space-y-1 text-xs">
        <p>{t("completionContext.size", { bytes: resolution.context_size.bytes, limit: resolution.context_size.limit_bytes })}</p>
        <p className="text-muted-foreground">{t("completionContext.executionLimit")}</p>
        <ul>{resolution.context_size.contributors.filter((item) => item.bytes > 0).map((item, index) =>
          <li key={`${item.source}-${item.id ?? index}`}>{item.title ?? t(`completionContext.sources.${item.source}`)}: {t("completionContext.sourceSize", { bytes: item.bytes })}</li>
        )}</ul>
      </div>}
      {preview.isError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{t("completionPolicy.previewFailed")}</p>{validationMessages.map((message, index) => <p key={index}>{message}</p>)}<Button type="button" size="sm" variant="outline" onClick={() => void preview.refetch()}>{t("completionPolicy.reload")}</Button></div>}
      {!!preview.data?.incompatibilities.length && <ul role="alert" className="space-y-1 text-sm text-destructive">
        {preview.data.incompatibilities.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.message}</li>)}
      </ul>}
      {!!preview.data?.changes?.length && <div className="space-y-1 text-xs"><p className="font-medium">{t("completionPolicy.changes")}</p><ul>{preview.data.changes.map((change) => <li key={change.field}>{t(`completionPolicy.${fieldKeys[change.field] ?? "changes"}`)}: {changeValue(change.field, change.before)} → {changeValue(change.field, change.after)}</li>)}</ul></div>}
      {preview.data?.template_preview && (
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer font-medium">{t("completionPolicy.templatePreview")}</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3">{preview.data.template_preview.system_prompt}</pre>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3">{preview.data.template_preview.loop_prompt}</pre>
          {!!preview.data.template_preview.findings.length && <ul role="alert" className="text-destructive">{preview.data.template_preview.findings.map((finding, index) => <li key={index}>{finding.message}</li>)}</ul>}
        </details>
      )}
      {value && <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <PolicySelect label={t("completionPolicy.landingActor")} value={value.landing_actor} onChange={(landing_actor) => patch({ landing_actor })} options={(["agent", "platform", "human"] as const).map((v) => [v, t(`completionPolicy.actors.${v}`)])} />
        <fieldset className="space-y-2"><legend className="text-xs font-medium">{t("completionPolicy.landingMethods")}</legend>
          {(["merge_queue", "external"] as const).map((method) => <label className="flex items-center gap-2 text-sm" key={method}><input type="checkbox" checked={value.landing_methods.includes(method)} onChange={(event) => patch({ landing_methods: event.target.checked ? [...value.landing_methods, method] : value.landing_methods.filter((v) => v !== method) })} />{t(`completionPolicy.methods.${method}`)}</label>)}
        </fieldset>
        <PolicySelect label={t("completionPolicy.sourceReview")} value={value.source_review} onChange={(source_review) => patch({ source_review })} options={(["none", "independent"] as const).map((v) => [v, t(`completionPolicy.approval.${v}`)])} />
        <label className="space-y-1 text-xs font-medium">{t("completionPolicy.reviewRole")}<Input value={value.review_role ?? ""} onChange={(event) => patch({ review_role: event.target.value || null })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.require_forge_checks} onChange={(event) => patch({ require_forge_checks: event.target.checked })} />{t("completionPolicy.requireForgeChecks")}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.auto_complete} onChange={(event) => patch({ auto_complete: event.target.checked })} />{t("completionPolicy.autoComplete")}</label>
        <PolicySelect label={t("completionPolicy.dependencyRelease")} value={value.dependency_release} onChange={(dependency_release) => patch({ dependency_release })} options={(["done", "accepted"] as const).map((v) => [v, t(`completionPolicy.release.${v}`)])} />
        <div className="space-y-3 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.postmerge_validation} onChange={(event) => patch({ postmerge_validation: event.target.checked ? { role: "", checks: [] } : null })} />{t("completionPolicy.postmergeValidation")}</label>
          {value.postmerge_validation && <div className="space-y-3 border-l pl-3">
            <p className="text-xs text-muted-foreground">{t("completionPolicy.exactCommitHint")}</p>
            <label className="block space-y-1 text-xs font-medium">{t("completionPolicy.validationRole")}<Input value={value.postmerge_validation.role} onChange={(event) => patch({ postmerge_validation: { ...value.postmerge_validation!, role: event.target.value } })} /></label>
            {value.postmerge_validation.checks.map((check, index) => <div key={index} className="space-y-2 rounded-md border p-3">
              <label className="block space-y-1 text-xs font-medium">{t("completionPolicy.checkId")}<Input value={check.id} onChange={(event) => patch({ postmerge_validation: { ...value.postmerge_validation!, checks: value.postmerge_validation!.checks.map((row, i) => i === index ? { ...row, id: event.target.value } : row) } })} /></label>
              <label htmlFor={`${id}-argv-${index}`} className="block text-xs font-medium">{t("completionPolicy.checkArgv")}</label>
              <Textarea id={`${id}-argv-${index}`} rows={3} value={check.argv.join("\n")} onChange={(event) => patch({ postmerge_validation: { ...value.postmerge_validation!, checks: value.postmerge_validation!.checks.map((row, i) => i === index ? { ...row, argv: event.target.value.split("\n") } : row) } })} />
              <label className="block space-y-1 text-xs font-medium">{t("completionPolicy.checkTimeout")}<Input type="number" min={1} value={check.timeout_seconds} onChange={(event) => patch({ postmerge_validation: { ...value.postmerge_validation!, checks: value.postmerge_validation!.checks.map((row, i) => i === index ? { ...row, timeout_seconds: Number(event.target.value) } : row) } })} /></label>
              <Button type="button" size="sm" variant="ghost" onClick={() => patch({ postmerge_validation: { ...value.postmerge_validation!, checks: value.postmerge_validation!.checks.filter((_, i) => i !== index) } })}>{t("completionPolicy.removeCheck")}</Button>
            </div>)}
            <Button type="button" size="sm" variant="outline" onClick={() => patch({ postmerge_validation: { ...value.postmerge_validation!, checks: [...value.postmerge_validation!.checks, { id: "", argv: [], timeout_seconds: 300 }] } })}>{t("completionPolicy.addCheck")}</Button>
          </div>}
        </div>
        <div className="space-y-3 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.evidence_only.enabled} onChange={(event) => patch({ evidence_only: { ...value.evidence_only, enabled: event.target.checked } })} />{t("completionPolicy.evidenceOnly")}</label>
          <p className="text-xs text-muted-foreground">{t("completionPolicy.evidenceHint")}</p>
          {value.evidence_only.enabled && <div className="grid gap-3 sm:grid-cols-2">
            <PolicySelect label={t("completionPolicy.evidenceApproval")} value={value.evidence_only.approval} onChange={(approval) => patch({ evidence_only: { ...value.evidence_only, approval } })} options={(["none", "independent"] as const).map((v) => [v, t(`completionPolicy.approval.${v}`)])} />
            <label className="space-y-1 text-xs font-medium">{t("completionPolicy.evidenceRole")}<Input value={value.evidence_only.review_role ?? ""} onChange={(event) => patch({ evidence_only: { ...value.evidence_only, review_role: event.target.value || null } })} /></label>
          </div>}
        </div>
      </fieldset>}
      {!hideApply && <Button type="button" disabled={disabled || !valid} onClick={onApply}>{t("completionPolicy.apply")}</Button>}
    </section>
  );
}

function PolicySelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return <label className="block space-y-1 text-xs font-medium">{label}<select className="block h-9 w-full rounded-md border bg-background px-2 text-sm" value={value} onChange={(event) => onChange(event.target.value as T)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}
