// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIntegrationsConfigStatus } from "../api/use-integrations-config-status";

interface AddTokenButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

// Same gate as ConnectGitHubButton, for the PAT path: without
// INTEGRATIONS_TOKEN_KEY the backend 503s on the first pasted token, and the
// workspace admin seeing that cannot fix a platform env var. Disabling with a
// tooltip that names the variable routes them to the operator instead.
export function AddTokenButton({
  onClick,
  disabled = false,
}: AddTokenButtonProps) {
  const { t } = useTranslation();
  const configStatus = useIntegrationsConfigStatus();
  const storageConfigured =
    configStatus.data?.token_storage_configured ?? true;

  const button = (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={disabled || !storageConfigured}
    >
      <KeyRound className="h-4 w-4" />
      {t("integrations.addToken")}
    </Button>
  );

  if (storageConfigured) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {t("integrations.tokenStorageNotConfiguredTooltip")}
      </TooltipContent>
    </Tooltip>
  );
}
