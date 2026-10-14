// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";

import type { DaemonResult } from "../../ipc/daemon";
import { showToast } from "../../shell/layers";

interface Preference {
  /** null until the first read answers (or when it failed): the switch stays disabled. */
  value: boolean | null;
  saving: boolean;
  change: (next: boolean) => Promise<void>;
}

/** A native on/off setting that the shell owns; a refused change snaps back and says why. */
export function usePreference(
  load: () => Promise<DaemonResult<boolean>>,
  save: (enabled: boolean) => Promise<DaemonResult<boolean>>,
  refusedMessage: string,
): Preference {
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (current && result.ok) setValue(result.value);
    });
    return () => {
      current = false;
    };
  }, [load]);

  const change = async (next: boolean) => {
    if (saving) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    const result = await save(next);
    setSaving(false);
    if (result.ok) {
      setValue(result.value);
      return;
    }
    setValue(previous);
    showToast(refusedMessage, { tone: "error" });
  };

  return { value, saving, change };
}
