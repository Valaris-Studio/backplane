// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useState } from "react";

import { Button } from "../../components/Button";
import { Group, Row, RowText, RowValue } from "../../components/Group";
import { SectionHead } from "../../components/SectionHead";
import type { CompanionStatus } from "../../ipc/bindings";
import { saveDiagnostics } from "../../ipc/native";
import { showToast } from "../../shell/layers";
import { exportFailure, formatBytes, lastErrorCopy } from "./copy";

type ExportState = "idle" | "saving" | "saved";

function queueSummary(records: number, bytes: number): string {
  return records === 0 ? "Empty" : `${records} waiting · ${formatBytes(bytes)}`;
}

export function DiagnosticsSection({ status }: { status: CompanionStatus }) {
  const [exportState, setExportState] = useState<ExportState>("idle");

  const exportDiagnostics = async () => {
    if (exportState === "saving") return;
    setExportState("saving");
    const result = await saveDiagnostics();
    if (!result.ok) {
      setExportState("idle");
      showToast(exportFailure(result.error), { tone: "error" });
      return;
    }
    // Cancelling the save panel is a choice, not a failure: nothing to say.
    if (!result.value.saved) {
      setExportState("idle");
      return;
    }
    setExportState("saved");
    showToast(result.value.file_name ? `Saved ${result.value.file_name}` : "Saved the diagnostics.");
  };

  const service = status.daemon_running ? "Background service running" : "Background service not running";

  return (
    <>
      <SectionHead title="Diagnostics" />
      <Group label="Diagnostics">
        <Row>
          <RowText title="Companion" sub={service} />
          <RowValue>{status.companion.version}</RowValue>
        </Row>
        <Row>
          <RowText title="Upload queue" />
          <RowValue>{queueSummary(status.queue.records, status.queue.bytes)}</RowValue>
        </Row>
        <Row>
          <RowText title="Last error" />
          <RowValue>{lastErrorCopy(status.queue.last_error)}</RowValue>
        </Row>
        <Row>
          <RowText
            title="Export for support"
            sub={
              <>
                A zip with logs and status. Home paths become <span className="settings-mono">~</span>; prompts, commands, outputs and tokens are
                removed.
              </>
            }
          />
          <Button
            size="sm"
            icon={exportState === "saved" ? "check" : "download"}
            loading={exportState === "saving"}
            onClick={() => void exportDiagnostics()}
          >
            {exportState === "saving" ? "Saving…" : exportState === "saved" ? "Saved" : "Export…"}
          </Button>
        </Row>
      </Group>
    </>
  );
}
