// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isApiError } from "@/lib/api-error";
import { useCreatePatConnection } from "../api/use-git-connections";
import type { GitConnectionPatCreate, GitProvider } from "@/types/git";
import { GitHubTokenGuidance } from "./GitHubTokenGuidance";

// Bitbucket is offered in the list only so its absence is explained rather
// than discovered as a 422 — the backend has no PAT probe for it.
const PAT_PROVIDERS: GitProvider[] = [
  "github",
  "gitlab",
  "gitea",
  "bitbucket",
];

const UNSUPPORTED_PROVIDERS = new Set<GitProvider>(["bitbucket"]);

// Gitea has no default host, so a token without a base_url could be stored and
// then never matched to a repo. The backend rejects it; we ask up front.
const REQUIRES_BASE_URL = new Set<GitProvider>(["gitea"]);

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value.trim());
}

interface AddTokenConnectionDialogProps {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddTokenConnectionDialog({
  slug,
  open,
  onOpenChange,
}: AddTokenConnectionDialogProps) {
  const { t } = useTranslation();
  const tokenFieldId = useId();
  const baseUrlFieldId = useId();
  const permissionGuidanceId = useId();
  const [provider, setProvider] = useState<GitProvider>("github");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createConnection = useCreatePatConnection(slug);

  const unsupported = UNSUPPORTED_PROVIDERS.has(provider);
  const baseUrlRequired = REQUIRES_BASE_URL.has(provider);
  const trimmedBaseUrl = baseUrl.trim();
  const baseUrlValid = trimmedBaseUrl === "" || isHttpUrl(trimmedBaseUrl);
  const canSubmit =
    !unsupported &&
    token.trim().length > 0 &&
    baseUrlValid &&
    (!baseUrlRequired || trimmedBaseUrl.length > 0);

  function reset() {
    setProvider("github");
    setToken("");
    setBaseUrl("");
    setSubmitError(null);
  }

  function handleProviderChange(next: GitProvider) {
    setProvider(next);
    setSubmitError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || createConnection.isPending) return;
    setSubmitError(null);

    const payload: GitConnectionPatCreate = {
      provider,
      token: token.trim(),
      ...(trimmedBaseUrl ? { base_url: trimmedBaseUrl } : {}),
    };

    try {
      const { connection, created } = await createConnection.mutateAsync(payload);
      // A 200 means the account was already connected and the stored token
      // was REPLACED in place — the documented rotation path, but it must
      // never happen silently: the old token is gone the moment this returns.
      if (created) {
        toast.success(
          t("integrations.pat.connectedToast", {
            login: connection.account_login,
          }),
        );
      } else {
        toast.info(
          t("integrations.pat.replacedToast", {
            login: connection.account_login,
          }),
        );
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      // The backend's 422 detail is written for the operator ("this token is
      // missing X, re-issue it with Y") — show it as plain text rather than
      // routing it through an i18n lookup we'd have to guess the key for.
      setSubmitError(
        isApiError(err) ? err.message : t("integrations.pat.genericError"),
      );
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const alertMessage = unsupported
    ? t("integrations.pat.unsupportedProvider", {
        provider: t(`gitRepos.providers.${provider}`),
      })
    : submitError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("integrations.pat.title")}</DialogTitle>
            <DialogDescription>
              {t("integrations.pat.subtitle")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t("integrations.pat.providerLabel")}
            </label>
            <Select
              value={provider}
              onValueChange={(v) => handleProviderChange(v as GitProvider)}
            >
              <SelectTrigger aria-label={t("integrations.pat.providerLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAT_PROVIDERS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`gitRepos.providers.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === "github" ? (
            <GitHubTokenGuidance id={permissionGuidanceId} />
          ) : null}

          <div className="space-y-2">
            <label htmlFor={tokenFieldId} className="text-sm font-medium">
              {t("integrations.pat.tokenLabel")}
            </label>
            <Input
              id={tokenFieldId}
              aria-describedby={
                provider === "github" ? permissionGuidanceId : undefined
              }
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("integrations.pat.tokenPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("integrations.pat.tokenHint")}
            </p>
          </div>

          {(baseUrlRequired || provider === "github" || provider === "gitlab") &&
          !unsupported ? (
            <div className="space-y-2">
              <label htmlFor={baseUrlFieldId} className="text-sm font-medium">
                {baseUrlRequired
                  ? t("integrations.pat.baseUrlLabelRequired")
                  : t("integrations.pat.baseUrlLabelOptional")}
              </label>
              <Input
                id={baseUrlFieldId}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://git.example.com"
              />
              <p className="text-xs text-muted-foreground">
                {baseUrlRequired
                  ? t("integrations.pat.baseUrlHintRequired")
                  : t("integrations.pat.baseUrlHintOptional")}
              </p>
            </div>
          ) : null}

          {!unsupported && provider !== "github" ? (
            <div
              data-testid="pat-scope-guidance"
              className="space-y-2 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-4 py-3"
            >
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <KeyRound className="h-4 w-4 text-primary" />
                {t("integrations.pat.scopesTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(`integrations.pat.scopeGuidance.${provider}`)}
              </p>
            </div>
          ) : null}

          {alertMessage ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="flex-1 space-y-1">
                <p className="font-semibold text-destructive">
                  {t("integrations.pat.errorTitle")}
                </p>
                <p className="text-destructive/90">{alertMessage}</p>
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border/70 pt-5">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || createConnection.isPending}
            >
              {createConnection.isPending
                ? t("integrations.pat.submitting")
                : t("integrations.pat.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
