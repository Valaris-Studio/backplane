// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { presentSheet } from "../../shell/layers";
import { PendingCode } from "./switch-pending";
import { SwitchServerSheet } from "./SwitchServerSheet";

export function openSwitchServerSheet(opener: HTMLElement | null, oldEndpoint: string, oldWebOrigin: string | null, deviceName: string | null): void {
  const pending = new PendingCode();
  presentSheet(({ close }) => <SwitchServerSheet close={close} opener={opener} oldEndpoint={oldEndpoint} oldWebOrigin={oldWebOrigin} deviceName={deviceName} pending={pending} />, {
    onClose: () => {
      // Best effort: a code the daemon already forgot (expired, superseded) needs no cancel.
      const id = pending.release();
      if (id) void callDaemon(() => commands.pairCancel(id));
    },
  });
}
