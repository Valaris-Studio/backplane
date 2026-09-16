// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { copyTextToClipboard } from "@/lib/clipboard";
import { fadeInUp } from "@/lib/animations";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useCreateApiKey } from "@/features/settings/api/use-api-keys";
import type { ApiKey } from "@/types/api-key";

export interface SelectedKey {
  id: string;
  // Present only for a key minted in this session. An existing key's secret is
  // unrecoverable by design, so the connect step falls back to a placeholder.
  rawKey: string | null;
}

// The key name becomes the actor in activity history, so it is worth a default
// that reads like a person's tool rather than "key 3".
function defaultKeyName(name?: string, email?: string): string {
  const firstName = name?.trim().split(/\s+/)[0];
  const fallback = email?.split("@")[0];
  const identity = firstName || fallback;
  return identity ? `claude-code — ${identity}` : "claude-code";
}

export function StepKey({
  existingKeys,
  selected,
  onSelect,
  onNext,
  onBack,
}: {
  existingKeys: ApiKey[];
  selected: SelectedKey | null;
  onSelect: (key: SelectedKey) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  const createKey = useCreateApiKey();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(existingKeys.length === 0);

  // /me resolves after first paint; seed the default then, but never clobber
  // what the user has already typed.
  useEffect(() => {
    if (nameEdited) return;
    setName(defaultKeyName(user?.name, user?.email));
  }, [user?.name, user?.email, nameEdited]);

  const create = () => {
    if (!name.trim()) return;
    // mutate, not mutateAsync: the mutation's own error state drives the
    // message, and an unawaited rejection here would surface as an unhandled
    // promise rejection rather than UI.
    createKey.mutate(
      { name: name.trim() },
      {
        onSuccess: (created) => {
          setRawKey(created.raw_key);
          onSelect({ id: created.id, rawKey: created.raw_key });
        },
      },
    );
  };

  if (rawKey) {
    return (
      <div className="space-y-4" data-testid="wizard-step-key">
        <RevealedKey rawKey={rawKey} />
        <DialogFooter>
          <Button onClick={onNext} data-testid="wizard-next">
            {t("mcpOnboarding.next")}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="wizard-step-key">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.keyIntro")}
      </p>

      {existingKeys.length > 0 ? (
        <ExistingKeys
          keys={existingKeys}
          selectedId={creatingNew ? null : (selected?.id ?? null)}
          onPick={(key) => {
            setCreatingNew(false);
            onSelect({ id: key.id, rawKey: null });
          }}
        />
      ) : null}

      {creatingNew || existingKeys.length === 0 ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border/60 bg-muted/30 px-3 py-2.5">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("mcpOnboarding.keyIdentityHint")}
            </p>
          </div>
          <div>
            <label
              htmlFor="wizard-key-name"
              className="mb-1.5 block text-sm font-medium text-foreground"
            >
              {t("mcpOnboarding.keyNameLabel")}
            </label>
            <Input
              id="wizard-key-name"
              data-testid="wizard-key-name"
              value={name}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
              }}
              placeholder={t("mcpOnboarding.keyNamePlaceholder")}
            />
          </div>
          {createKey.isError ? (
            <p
              data-testid="wizard-key-error"
              role="alert"
              className="flex items-start gap-2 text-sm leading-relaxed text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t("mcpOnboarding.keyCreateError")}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={!name.trim() || createKey.isPending}
            data-testid="wizard-create-key"
          >
            {createKey.isPending
              ? t("mcpOnboarding.keyCreatingAction")
              : createKey.isError
                ? t("mcpOnboarding.keyRetryAction")
                : t("mcpOnboarding.keyCreateAction")}
          </Button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreatingNew(true)}
          data-testid="wizard-create-new-key"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("mcpOnboarding.keyCreateNewAction")}
        </button>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onBack} data-testid="wizard-back">
          {t("mcpOnboarding.back")}
        </Button>
        <Button onClick={onNext} disabled={!selected} data-testid="wizard-next">
          {t("mcpOnboarding.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ExistingKeys({
  keys,
  selectedId,
  onPick,
}: {
  keys: ApiKey[];
  selectedId: string | null;
  onPick: (key: ApiKey) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">
        {t("mcpOnboarding.keyExistingHeading")}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.keyExistingHint")}
      </p>
      <ul className="space-y-1.5">
        {keys.map((key) => (
          <li key={key.id}>
            <button
              type="button"
              onClick={() => onPick(key)}
              data-testid={`wizard-pick-key-${key.id}`}
              aria-pressed={selectedId === key.id}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors",
                selectedId === key.id
                  ? "border-primary/50 bg-primary/5"
                  : "border-border/60 hover:border-border",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {key.name}
                </span>
                <span className="block font-mono text-xs text-muted-foreground">
                  {key.key_prefix}…
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {t("mcpOnboarding.keyCreatedOn", {
                    date: formatDate(key.created_at),
                  })}
                </span>
                {selectedId === key.id ? (
                  <Check className="h-4 w-4 text-primary" aria-hidden />
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevealedKey({ rawKey }: { rawKey: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  // The form → key swap is the step's one-time reveal; bridge it instead of
  // teleporting.
  useEffect(() => {
    if (!revealRef.current) return;
    fadeInUp(revealRef.current, { offset: 6, duration: 0.2 });
  }, []);

  const copy = async () => {
    const copiedSuccessfully = await copyTextToClipboard(rawKey);
    if (!copiedSuccessfully) return;
    setCopied(true);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={revealRef} className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">
        {t("mcpOnboarding.keyRevealTitle")}
      </h3>
      <div className="flex items-center gap-2">
        <code
          data-testid="wizard-raw-key"
          className="flex-1 overflow-x-auto rounded-[var(--radius-sm)] border border-border/70 bg-[color:var(--color-surface-1)] px-3 py-2.5 font-mono text-xs select-all"
        >
          {rawKey}
        </code>
        <Button
          variant="outline"
          size="icon"
          onClick={copy}
          className="shrink-0"
          aria-label={t("a11y.mcpOnboarding.copyApiKey")}
        >
          {copied ? (
            <Check className="h-4 w-4 text-success motion-safe:animate-pop-in" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <p className="flex items-start gap-2 text-sm leading-relaxed text-[color:var(--color-warning)]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t("mcpOnboarding.keyRevealWarning")}
      </p>
    </div>
  );
}
