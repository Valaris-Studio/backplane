// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Github } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIntegrationsConfigStatus } from "../api/use-integrations-config-status";

interface ConnectGitHubButtonProps {
  slug: string;
  disabled?: boolean;
}

// Full-page redirect (not fetch) — backend returns 302 to GitHub which then
// completes the OAuth dance. SPA cannot follow that with axios, so we hand off
// the location bar entirely and let the backend redirect us back to
// `/{slug}/settings#integrations` (or `?oauth_error=...`) when done.
//
// If the platform admin hasn't provisioned the GitHub OAuth env vars,
// /oauth/github/start would 503 on click — gate the button on
// /integrations/config-status so the not-yet-configured state surfaces
// as a tooltip instead of a failed redirect.
export function ConnectGitHubButton({
  slug,
  disabled = false,
}: ConnectGitHubButtonProps) {
  const { t } = useTranslation();
  const configStatus = useIntegrationsConfigStatus();
  const oauthConfigured = configStatus.data?.github_oauth_configured ?? true;

  function handleClick() {
    window.location.href = `/api/workspaces/${slug}/oauth/github/start`;
  }

  const button = (
    <Button onClick={handleClick} disabled={disabled || !oauthConfigured}>
      <Github className="h-4 w-4" />
      {t("integrations.connectGitHub")}
    </Button>
  );

  if (oauthConfigured) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{t("integrations.notConfiguredTooltip")}</TooltipContent>
    </Tooltip>
  );
}
