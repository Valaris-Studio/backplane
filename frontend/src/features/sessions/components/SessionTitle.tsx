// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type { AgentSession } from "@/types/agent-session";
import { boundFolder } from "../utils/format";
import { isUsageOnly } from "../utils/group-sessions";

export type SessionTitleForm =
  | { kind: "title"; text: string }
  | { kind: "withheld"; text: string }
  | { kind: "usageOnly"; text: string };

// The title is the first prompt as captured; nothing is ever generated or
// summarised, and a missing title is explained, never "Untitled".
export function useSessionTitle(session: AgentSession): SessionTitleForm {
  const { t } = useTranslation();
  if (session.title) return { kind: "title", text: session.title };
  if (isUsageOnly(session)) {
    return { kind: "usageOnly", text: t("sessions.row.usageOnlyTitle", { agent: session.harness_display_name }) };
  }
  const folder = boundFolder(session.cwd);
  return {
    kind: "withheld",
    text: folder ? t("sessions.row.titleWithheld", { folder }) : t("sessions.row.titleWithheldNoFolder"),
  };
}

export function WithheldTitleGlyph() {
  return <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
