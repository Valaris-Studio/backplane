// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { BackplaneSection } from "./BackplaneSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { RemoveSection } from "./RemoveSection";
import { ThisMacSection } from "./ThisMacSection";
import { UpdateBanners, UpdatesSection } from "./UpdatesSection";
import { useUpdates } from "./use-updates";
import "./settings.css";

export function SettingsScreen() {
  const status = useStoreSelector(statusStore, (current) => current);
  const runningVersion = status?.companion.version ?? "";
  const updates = useUpdates(runningVersion);
  if (!status) return null;

  return (
    <div data-testid="screen-settings">
      <UpdateBanners updates={updates} />
      <ThisMacSection status={status} />
      <BackplaneSection status={status} />
      <UpdatesSection updates={updates} runningVersion={runningVersion} />
      <DiagnosticsSection status={status} />
      <RemoveSection />
    </div>
  );
}
