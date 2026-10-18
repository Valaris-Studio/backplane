// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Eye, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useWebSocket } from "@/hooks/use-websocket";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { formatRelative } from "@/lib/date-format";
import { formatDateTime } from "@/lib/format";
import type { ConnectionStatus } from "@/lib/websocket";
import { cn } from "@/lib/utils";
import {
  OBSERVER_NAMESPACES,
  OBSERVER_WIDE_BUFFER_MAX,
  namespaceOf,
  useObserverEvents,
  type ObserverNamespace,
} from "../hooks/useObserverEvents";
import { ObserverEventRow } from "./ObserverEventRow";

// The observer used to be a free-floating draggable overlay whose x/y lived
// here. It is now docked to the top bar, so any surviving entry is dead weight
// on an operator's machine — evict it once, on mount.
const LEGACY_POSITION_STORAGE_KEY = "observer.position";
const MAX_BADGE = 99;

// With no chip selected, All shows every retained frame. `OTHER_FILTER` is the
// chip for everything outside the four named namespaces — a pseudo-namespace,
// not a bus namespace, hence the sentinel rather than a member of
// OBSERVER_NAMESPACES.
const OTHER_FILTER = "__other__" as const;
type ObserverFilter = ObserverNamespace | typeof OTHER_FILTER;

const ACCEPT_ALL = () => true;
const WILDCARD_PATTERN = "*";

// "connecting"/"connected"/"disconnected" reuse the TopBar indicator's labels;
// only "reconnecting" is Observer-specific, because it means a gap in capture.
const CONNECTION_LABEL_KEYS: Record<ConnectionStatus, string> = {
  connecting: "ui.connection.status.connecting",
  connected: "ui.connection.status.connected",
  reconnecting: "observer.diagnostics.reconnecting",
  disconnected: "ui.connection.status.disconnected",
};

interface ObserverPanelProps {
  slug: string;
}

export function ObserverPanel({ slug }: ObserverPanelProps) {
  const { isAdmin, isLoading, membership, accessLost } = useWorkspaceAdmin(slug);
  // Don't unmount while the admin check resolves — on reload, `useMembers`
  // and `/api/me` both fetch cold, so `isAdmin` is false for a tick and the
  // icon flickers out. Render nothing during load, then decide once.
  if (isLoading) return null;
  if (!isAdmin || accessLost) return null;
  // This gate is UX only. The authoritative one is server-side: the events WS
  // rejects observer-grade subscription patterns (`*`, `agent.*`, `execution.*`,
  // `approval.*`) from non-admins with a `subscription_denied` frame, so hand-
  // opening the socket gains nothing (card 6711c45e, docs/events.md).
  //
  // Keyed by workspace and principal: AppShell stays mounted across cached
  // workspace switches and across a /me change from a session switch in
  // another tab, so without a remount one capture would carry into the next.
  return <ObserverPanelInner key={`${slug}:${membership?.user_id ?? ""}`} />;
}

function ObserverPanelInner() {
  const { t } = useTranslation();
  const { status, deniedPatterns, onHeartbeat } = useWebSocket();
  const [open, setOpen] = useState(false);
  const {
    events,
    paused,
    unreadCount,
    pendingCount,
    evictedCount,
    captureStartedAt,
    interrupted,
    accessRevoked,
    pause,
    resume,
    clear,
  } = useObserverEvents({
    accept: ACCEPT_ALL,
    bufferMax: OBSERVER_WIDE_BUFFER_MAX,
    viewing: open,
  });

  const [activeFilters, setActiveFilters] = useState<Set<ObserverFilter>>(
    new Set(),
  );
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);

  // `now` only feeds relative timestamps (visible rows, last ping), and this
  // panel is mounted in the top bar on every authed route — ticking while the
  // sheet is closed re-renders the whole app shell every 5s for nothing.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open || !onHeartbeat) return;
    return onHeartbeat(setLastHeartbeatAt);
  }, [open, onHeartbeat]);

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_POSITION_STORAGE_KEY);
    } catch {
      // storage may be disabled — nothing to evict
    }
  }, []);

  const toggleFilter = useCallback((ns: ObserverFilter) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => setActiveFilters(new Set()), []);
  const clearFiltersAndSearch = useCallback(() => {
    clearFilters();
    setSearch("");
  }, [clearFilters]);

  // The chip is derived from traffic actually seen, not a hardcoded list — its
  // whole purpose is surfacing namespaces nobody enumerated in advance.
  const hasOtherTraffic = useMemo(
    () => events.some((e) => namespaceOf(e.event) === null),
    [events],
  );

  const visibleEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((e) => {
      const namespaceMatches =
        activeFilters.size === 0 ||
        activeFilters.has(namespaceOf(e.event) ?? OTHER_FILTER);
      if (!namespaceMatches) return false;
      if (!needle) return true;
      return (
        e.event.toLowerCase().includes(needle) ||
        e.event_id.toLowerCase().includes(needle)
      );
    });
  }, [events, activeFilters, search]);

  const showAllChip = activeFilters.size === 0;
  const hasUnread = unreadCount > 0;
  const wildcardDenied = deniedPatterns?.has(WILDCARD_PATTERN) ?? false;
  const heartbeatLabel =
    lastHeartbeatAt === null
      ? t("observer.diagnostics.noPing")
      : t("observer.diagnostics.lastPing", {
          time: formatRelative(new Date(lastHeartbeatAt).toISOString(), {
            withSeconds: true,
          }),
        });
  const badgeText =
    unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : String(unreadCount);

  return (
    <>
      <RichTooltip avoidCollisions i18nKey="chrome.observerPanel.intro" side="bottom">
        <Button
          data-testid="observer-trigger"
          variant="ghost"
          size="icon"
          className="relative shrink-0"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={t("observer.triggerAria", { count: unreadCount })}
        >
          <Eye className="h-4 w-4" />
          {/* Neutral, not primary: a diagnostic count beside the
              NotificationBell must not borrow its urgency. */}
          {hasUnread ? (
            <span
              data-testid="observer-unread-badge"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-border bg-muted px-1 text-[0.62rem] font-semibold leading-none text-foreground"
            >
              {badgeText}
            </span>
          ) : null}
        </Button>
      </RichTooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          data-testid="observer-expanded"
          side="right"
          className="w-[min(26rem,calc(100vw-2rem))] gap-0 p-0"
          aria-label={t("observer.title")}
        >
          <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 pr-11">
            <RichTooltip avoidCollisions i18nKey="chrome.observerPanel.intro" side="bottom">
              <h2 className="text-sm font-semibold text-foreground">
                {t("observer.title")}
              </h2>
            </RichTooltip>
            <div className="ml-auto flex items-center gap-1">
              <RichTooltip avoidCollisions i18nKey="chrome.observerPanel.pause" side="bottom">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={paused ? resume : pause}
                  aria-label={
                    paused
                      ? t("observer.actions.resume")
                      : t("observer.actions.pause")
                  }
                >
                  {paused ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" />
                  )}
                  <span className="ml-1">
                    {paused
                      ? t("observer.actions.resume")
                      : t("observer.actions.pause")}
                  </span>
                </Button>
              </RichTooltip>
              <RichTooltip avoidCollisions i18nKey="chrome.observerPanel.clear" side="bottom">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={clear}
                  aria-label={t("observer.actions.clear")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </RichTooltip>
            </div>
          </header>

          <div
            role="group"
            aria-label={t("observer.diagnostics.label")}
            className="flex flex-col gap-1 border-b border-border/40 px-3 py-2 text-[0.7rem] text-muted-foreground"
          >
            <p>
              {t("observer.scope.since", {
                time: formatDateTime(captureStartedAt),
              })}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-foreground">
                {t(CONNECTION_LABEL_KEYS[status])}
              </span>
              <span>{heartbeatLabel}</span>
            </p>
            {accessRevoked ? (
              <DiagnosticWarning>
                {t("observer.diagnostics.accessRevoked")}
              </DiagnosticWarning>
            ) : null}
            {wildcardDenied ? (
              <DiagnosticWarning>
                {t("observer.diagnostics.wildcardDenied")}
              </DiagnosticWarning>
            ) : null}
            {interrupted ? (
              <DiagnosticWarning>{t("observer.diagnostics.gap")}</DiagnosticWarning>
            ) : null}
            {paused ? (
              <p>{t("observer.diagnostics.paused", { count: pendingCount })}</p>
            ) : null}
            {evictedCount > 0 ? (
              <p>{t("observer.diagnostics.evicted", { count: evictedCount })}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1 border-b border-border/40 px-3 py-2">
            <RichTooltip
              avoidCollisions
              i18nKey="chrome.observerPanel.namespaceFilter"
              side="bottom"
            >
              <FilterChip
                active={showAllChip}
                onClick={clearFilters}
                label={t("observer.namespaces.all")}
              />
            </RichTooltip>
            {OBSERVER_NAMESPACES.map((ns) => (
              <FilterChip
                key={ns}
                active={activeFilters.has(ns)}
                onClick={() => toggleFilter(ns)}
                label={t(`observer.namespaces.${ns}`)}
              />
            ))}
            {hasOtherTraffic ? (
              <FilterChip
                active={activeFilters.has(OTHER_FILTER)}
                onClick={() => toggleFilter(OTHER_FILTER)}
                label={t("observer.namespaces.other")}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
            <Input
              data-testid="observer-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("observer.search.placeholder")}
              aria-label={t("observer.search.label")}
              className="h-7 flex-1 text-xs"
            />
            <span
              data-testid="observer-counts"
              className="shrink-0 text-[0.65rem] text-muted-foreground"
            >
              {t("observer.counts", {
                shown: visibleEvents.length,
                total: events.length,
                max: OBSERVER_WIDE_BUFFER_MAX,
              })}
            </span>
          </div>

          <ul
            data-testid="observer-event-list"
            className="flex-1 overflow-auto"
          >
            {events.length === 0 ? (
              <li className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
                <p className="text-sm font-medium text-foreground">
                  {t("observer.empty.title")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("observer.empty.hint")}
                </p>
              </li>
            ) : visibleEvents.length === 0 ? (
              <li className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
                <p className="text-sm font-medium text-foreground">
                  {t("observer.empty.filteredTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("observer.empty.filteredHint", { count: events.length })}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFiltersAndSearch}
                  className="mt-1 pointer-coarse:min-h-11"
                >
                  {t("observer.empty.clearFilters")}
                </Button>
              </li>
            ) : (
              visibleEvents.map((evt) => (
                <ObserverEventRow key={evt.event_id} event={evt} now={now} />
              ))
            )}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

function DiagnosticWarning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[color:var(--color-warning-foreground)]">
      <AlertTriangle aria-hidden className="mt-px h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

function FilterChip({ active, onClick, label }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:px-3",
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border/60 bg-transparent text-muted-foreground hover:bg-muted/40",
      )}
    >
      {label}
    </button>
  );
}
