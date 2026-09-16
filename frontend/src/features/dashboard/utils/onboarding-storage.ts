// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-workspace onboarding flags — same try/catch localStorage mechanics as
// the old FirstRunPanel dismiss key (private-mode safe, best-effort writes).

export function welcomeSeenKey(slug: string): string {
  return `valaris:onboardingWelcome:seen:${slug}`;
}

export function checklistDismissedKey(slug: string): string {
  return `valaris:onboardingChecklist:dismissed:${slug}`;
}

export function checklistCollapsedKey(slug: string): string {
  return `valaris:onboardingChecklist:collapsed:${slug}`;
}

export function mcpCalloutDismissedKey(slug: string): string {
  return `valaris:mcpCallout:dismissed:${slug}`;
}

function skippedStepsKey(slug: string): string {
  return `valaris:onboardingChecklist:skippedSteps:${slug}`;
}

export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // localStorage blocked (private mode, quota) — flags are best-effort.
  }
}

export function readSkippedSteps(slug: string): string[] {
  try {
    const raw = window.localStorage.getItem(skippedStepsKey(slug));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((step): step is string => typeof step === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeSkippedSteps(slug: string, steps: string[]): void {
  try {
    window.localStorage.setItem(skippedStepsKey(slug), JSON.stringify(steps));
  } catch {
    // best-effort, same as writeFlag
  }
}

// Same-document signal from the welcome modal's "explore on my own" CTA to an
// already-mounted checklist — "storage" events only fire in OTHER documents.
export const CHECKLIST_COLLAPSE_EVENT = "valaris:onboardingChecklist:collapse";

export function dispatchChecklistCollapse(slug: string): void {
  window.dispatchEvent(
    new CustomEvent(CHECKLIST_COLLAPSE_EVENT, { detail: { slug } }),
  );
}
