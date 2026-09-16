// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
import { ArrowRight, Plug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { prefersReducedMotion } from "@/lib/animations";
import {
  mcpCalloutDismissedKey,
  readFlag,
  writeFlag,
} from "@/features/dashboard/utils/onboarding-storage";
import { useApiKeys } from "@/features/settings/api/use-api-keys";

/**
 * The activation prompt: connecting a coding agent over MCP is the step that
 * decides whether a new user keeps using Backplane, so this stays on the
 * dashboard — louder than a quick-action tile — until it has happened, or
 * until the user explicitly closes it (persisted per workspace; the
 * quick-action tile stays as the permanent wizard re-entry point).
 *
 * "Connected" needs no stored flag: it is derived from live key data (any key
 * with a last_used_at), which the wizard's WS listener and polling already
 * refresh under `apiKeyKeys.all`. The callout therefore disappears the moment
 * verification succeeds, with no reload.
 */
export function ConnectAgentCallout({
  slug,
  onConnect,
}: {
  slug: string;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const { data: keys } = useApiKeys();
  const [dismissed, setDismissed] = useState(() =>
    readFlag(mcpCalloutDismissedKey(slug)),
  );
  const cardRef = useRef<HTMLDivElement>(null);

  if (dismissed) return null;
  // While the key list is unknown — loading OR errored — render nothing. A
  // transient 500 must not flash a "connect your agent" banner at a user who
  // connected months ago (the WelcomeModal boardCount:undefined lesson).
  if (!keys) return null;
  if (keys.some((key) => key.last_used_at != null)) return null;

  const dismiss = () => {
    // Persist first: a reload mid-exit-tween must not resurrect the callout.
    writeFlag(mcpCalloutDismissedKey(slug), true);
    const node = cardRef.current;
    if (!node || prefersReducedMotion()) {
      setDismissed(true);
      return;
    }
    gsap.to(node, {
      autoAlpha: 0,
      height: 0,
      duration: 0.22,
      ease: "power2.in",
      onComplete: () => setDismissed(true),
    });
  };

  return (
    <Card
      ref={cardRef}
      data-testid="connect-agent-callout"
      className="relative overflow-hidden border-primary/30 bg-[linear-gradient(110deg,color-mix(in_oklab,var(--color-primary)_9%,var(--color-card)),color-mix(in_oklab,var(--color-primary)_3%,var(--color-card)))]"
    >
      <button
        type="button"
        onClick={dismiss}
        data-testid="connect-agent-callout-dismiss"
        aria-label={t("a11y.mcpOnboarding.dismissCallout")}
        className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-200 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      <CardContent className="flex flex-col gap-5 p-[var(--card-padding)] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-cap)] border border-primary/25 bg-primary/12 text-primary shadow-soft">
            <Plug className="h-6 w-6" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-foreground">
              {t("mcpOnboarding.calloutHeadline")}
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("mcpOnboarding.calloutBody")}
            </p>
          </div>
        </div>
        <Button
          size="lg"
          onClick={onConnect}
          data-testid="connect-agent-callout-cta"
          className="shrink-0 self-start sm:mr-6 sm:self-auto"
        >
          {t("mcpOnboarding.calloutAction")}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
