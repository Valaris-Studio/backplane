// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBlocker, type Location } from "react-router-dom";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";

interface NavigationGuard {
  isDirty: boolean;
  canSave: boolean;
  save: () => Promise<boolean>;
  discard?: () => void;
  leavesScope?: (next: Location, current: Location) => boolean;
}

type GuardReader = () => NavigationGuard;
type RegisterGuard = (id: string, read: GuardReader) => () => void;
const NavigationGuardContext = createContext<RegisterGuard | null>(null);

/** One blocker owns route departure; editors register their existing save path. */
export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<string, GuardReader>());
  const pending = useRef<string[]>([]);
  const attempt = useRef(0);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const register = useCallback<RegisterGuard>((id, read) => {
    guards.current.set(id, read);
    setRevision((value) => value + 1);
    return () => {
      guards.current.delete(id);
      setRevision((value) => value + 1);
    };
  }, []);

  const shouldBlock = useCallback(({ currentLocation, nextLocation }: { currentLocation: Location; nextLocation: Location }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search) return false;
    pending.current = [...guards.current].filter(([, read]) => {
      const guard = read();
      return guard.isDirty && (guard.leavesScope?.(nextLocation, currentLocation) ?? true);
    }).map(([id]) => id);
    return pending.current.length > 0;
  }, []);
  const blocker = useBlocker(shouldBlock);
  const activeId = pending.current[0];
  const active = blocker.state === "blocked" && activeId ? guards.current.get(activeId)?.() : undefined;
  const dirty = [...guards.current.values()].some((read) => read().isDirty);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const remaining = pending.current.filter((id) => guards.current.has(id));
    if (remaining.length === pending.current.length) return;
    // Access loss can remove an editor while its departure prompt is open.
    // Cancel its pending save/departure instead of leaving an invisible blocker.
    pending.current = remaining;
    attempt.current += 1;
    setSaving(false);
    if (remaining.length === 0) blocker.reset();
    else setRevision((value) => value + 1);
  }, [blocker, revision]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  function keepEditing() {
    attempt.current += 1;
    pending.current = [];
    setSaving(false);
    if (blocker.state === "blocked") blocker.reset();
  }

  function advance() {
    pending.current.shift();
    pending.current = pending.current.filter((id) => guards.current.get(id)?.().isDirty);
    if (pending.current.length === 0 && blocker.state === "blocked") blocker.proceed();
    else setRevision((value) => value + 1);
  }

  async function save() {
    // Cache refreshes can change an editor's save baseline without changing
    // isDirty/canSave. Read its current callback when acting, not at render.
    const current = pending.current[0] ? guards.current.get(pending.current[0])?.() : undefined;
    if (!current?.canSave || saving) return;
    const currentAttempt = ++attempt.current;
    setSaving(true);
    try {
      // Mutation hooks report their own errors; a failed save keeps both the
      // draft and pending destination available for retry or cancellation.
      const saved = await current.save();
      if (attempt.current === currentAttempt && saved) advance();
    } finally {
      if (attempt.current === currentAttempt) setSaving(false);
    }
  }

  return (
    <NavigationGuardContext.Provider value={register}>
      {children}
      <UnsavedChangesPrompt
        open={!!active}
        canSave={!!active?.canSave}
        pending={saving}
        onSave={() => { void save(); }}
        onDiscard={() => {
          if (saving) return;
          const id = pending.current[0];
          if (id) guards.current.get(id)?.().discard?.();
          advance();
        }}
        onKeepEditing={keepEditing}
      />
    </NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard(guard: NavigationGuard) {
  const register = useContext(NavigationGuardContext);
  const id = useId();
  const current = useRef(guard);
  current.current = guard;
  useEffect(() => register?.(id, () => current.current), [register, id, guard.isDirty, guard.canSave]);
}
