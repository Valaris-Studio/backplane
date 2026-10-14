// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type RefObject } from "react";

import { LinkButton } from "../../components/Button";
import { SectionHead } from "../../components/SectionHead";
import type { CompanionStatus } from "../../ipc/bindings";
import { platformCopy } from "../../platform/copy";
import { SHELL_PANEL_ID } from "../../shell/MainTabs";
import { statusModel } from "../../shell/status-model";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { useEndedSessionsToday, useLiveSessions, type EndedSession, type TrackedSession } from "../../stores/sessions";
import { useSessionBoardName, type SessionBoardName } from "./board-names";
import { safeRepo } from "./format";
import { AttentionBanner, EmptyPanel, PausedBanner, PausedByServerPanel, RevokedPanel, UnreachableBanner } from "./HomeStates";
import { HomeToolbar } from "./HomeToolbar";
import { useServerHost, useWebRootUrl } from "./open-backplane";
import { SessionRow } from "./SessionRow";
import { HOME_SORT_LABEL, filterActive, filterSessions, matchSummary, noResultDetail, soloKeyOf, sortSessions, type HomeSort, type SessionFilter } from "./session-view";
import { TotalsFooter } from "./TotalsFooter";
import { useHomeFilter, useHomeSort, useStableOrder } from "./use-home-view";
import "./home.css";

// Below this many sessions today there is nothing worth sorting or filtering.
export const HOME_TOOLBAR_MIN_SESSIONS = 4;
const ANNOUNCE_FILTER_DELAY_MS = 400;
const NO_FILTER: SessionFilter = { query: "", solo: null };
// The solo tiles' order; an agent this build doesn't know goes last.
const AGENT_TILE_ORDER = ["claude_code", "codex_cli", "codex_desktop", "pi_cli"];

type HomeMode = "revoked" | "paused_by_server" | "paused_locally" | "unreachable" | "capturing";

/**
 * Read off the header's own model, so Home and the header never disagree
 * (e.g. paused from Backplane while the queue backs off reads as unreachable
 * in both). Attention only changes the banner, not the mode.
 */
function homeMode(status: CompanionStatus | null): HomeMode | null {
  if (!status) return null;
  const model = statusModel({ status, attention: [] });
  switch (model.trayState) {
    case "disconnected":
      return "revoked";
    case "offline":
      return "unreachable";
    case "paused":
      return model.pauseControl === "resume" ? "paused_locally" : "paused_by_server";
    default:
      return "capturing";
  }
}

const NO_SESSIONS: readonly TrackedSession[] = [];

type SessionListKind = "live" | "ended";
type RegisterTrigger = (sessionId: string, list: SessionListKind, trigger: HTMLButtonElement | null) => void;

interface SessionListProps {
  label: string;
  kind: SessionListKind;
  sessions: readonly (TrackedSession | EndedSession)[];
  boardNameOf: SessionBoardName;
  waitingToUpload: boolean;
  expanded: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  webRootUrl: string | null;
  registerTrigger: RegisterTrigger;
}

function SessionList({ label, kind, sessions, boardNameOf, waitingToUpload, expanded, onToggle, webRootUrl, registerTrigger }: SessionListProps) {
  return (
    <ul className="home-sessions" data-compact={kind === "ended"} aria-label={label}>
      <AnimatePresence initial={false}>
        {sessions.map((session) => (
          <SessionRow
              key={session.native_session_id}
              session={session}
              endedAt={"ended_at" in session ? session.ended_at : null}
              boardName={boardNameOf({ ...session, repo: safeRepo(session.repo) })}
              waitingToUpload={waitingToUpload}
              open={expanded.has(session.native_session_id)}
              onToggle={onToggle}
              webRootUrl={webRootUrl}
              registerTrigger={registerTrigger}
            />
        ))}
      </AnimatePresence>
    </ul>
  );
}

function useExpandedSessions() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((sessionId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  }, []);
  return [expanded, toggle] as const;
}

/**
 * A focused live row that leaves (its exit still animating) must not strand
 * focus: it moves to the same session's Earlier today row, else the next live
 * row, else the Live now heading, else (filtered) the filter field.
 */
function useFocusFollowsLeavingRow(live: readonly TrackedSession[], filterField: RefObject<HTMLInputElement | null>) {
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const liveHeading = useRef<HTMLHeadingElement>(null);
  // The live row last holding focus: a filter can unmount its whole section, taking the row's trigger with it.
  const focusedLiveId = useRef<string | null>(null);
  const previousLiveIds = useRef<string[]>(live.map((session) => session.native_session_id));

  const registerTrigger = useCallback<RegisterTrigger>((sessionId, list, trigger) => {
    const key = `${list}:${sessionId}`;
    if (trigger) triggers.current.set(key, trigger);
    else triggers.current.delete(key);
  }, []);

  useLayoutEffect(() => {
    const previousIds = previousLiveIds.current;
    const currentIds = live.map((session) => session.native_session_id);
    previousLiveIds.current = currentIds;
    const focused = document.activeElement;
    if (!focused) return;

    // The whole row, not just its trigger: focus may be on "Open in Backplane" in the expanded panel.
    const rowOf = (id: string) => triggers.current.get(`live:${id}`)?.closest(".home-session");
    const focusDropped = focused === document.body;
    const leftId = previousIds.find((id) => !currentIds.includes(id) && (rowOf(id)?.contains(focused) || (focusDropped && focusedLiveId.current === id)));
    if (leftId === undefined) return;
    const nextLiveId = previousIds.slice(previousIds.indexOf(leftId) + 1).find((id) => currentIds.includes(id)) ?? currentIds.at(-1);
    // A filtered Home hides an empty Live now section, heading included: the filter is what's left to hold focus.
    const target =
      triggers.current.get(`ended:${leftId}`) ?? (nextLiveId ? triggers.current.get(`live:${nextLiveId}`) : undefined) ?? liveHeading.current ?? filterField.current;
    target?.focus({ preventScroll: true });
  }, [live, filterField]);

  const trackFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const entry = [...triggers.current].find(([key, trigger]) => key.startsWith("live:") && trigger.closest(".home-session")?.contains(event.target));
    focusedLiveId.current = entry ? entry[0].slice("live:".length) : null;
  }, []);

  return { registerTrigger, liveHeading, trackFocus };
}

function agentsSeen(sessions: readonly TrackedSession[]): string[] {
  const keys = [...new Set(sessions.map((session) => soloKeyOf(session.harness)))];
  const rank = (key: string) => (AGENT_TILE_ORDER.includes(key) ? AGENT_TILE_ORDER.indexOf(key) : AGENT_TILE_ORDER.length);
  return keys.sort((a, b) => rank(a) - rank(b));
}

/** Rows hold their order while the pointer or focus is in the lists; an expanded row holds it too. */
function useListHold(anyExpanded: boolean) {
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const handlers = {
    onPointerEnter: () => setPointerIn(true),
    onPointerLeave: () => setPointerIn(false),
    onFocus: () => setFocusIn(true),
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIn(false);
    },
  };
  return { held: pointerIn || focusIn || anyExpanded, handlers };
}

/** What the polite region says: the match count once typing pauses, the sort when it changes, never a live update. */
function useViewAnnouncer(shown: number, total: number) {
  const [announcement, setAnnouncement] = useState("");
  const counts = useRef({ shown, total });
  useEffect(() => {
    counts.current = { shown, total };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const announceFilter = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnnouncement(matchSummary(counts.current.shown, counts.current.total)), ANNOUNCE_FILTER_DELAY_MS);
  }, []);
  const announceSort = useCallback((sort: HomeSort) => {
    clearTimeout(timer.current);
    setAnnouncement(`Sorted by ${HOME_SORT_LABEL[sort].long.toLowerCase()}`);
  }, []);
  return { announcement, announceFilter, announceSort };
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null);

/** `/` or ⌘F / Ctrl+F jumps to the filter, unless the user is typing somewhere. */
function useFilterHotkey(filterField: RefObject<HTMLInputElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || isEditable(event.target)) return;
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey;
      const find = event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (!slash && !find) return;
      event.preventDefault();
      filterField.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filterField, enabled]);
}

/** A toolbar that unmounts under focus (its last filter cleared) hands focus to the tab panel, never to <body>. */
function useFocusSurvivesToolbar(showToolbar: boolean) {
  const wasShown = useRef(showToolbar);
  useLayoutEffect(() => {
    const hidden = wasShown.current && !showToolbar;
    wasShown.current = showToolbar;
    if (hidden && (document.activeElement === null || document.activeElement === document.body)) {
      document.getElementById(SHELL_PANEL_ID)?.focus({ preventScroll: true });
    }
  }, [showToolbar]);
}

export function HomeScreen() {
  const mode = useStoreSelector(statusStore, homeMode);
  const queuedRecords = useStoreSelector(statusStore, (status) => status?.queue.records ?? 0);
  const live = useLiveSessions();
  const endedToday = useEndedSessionsToday();
  const boardNameOf = useSessionBoardName();
  const webRootUrl = useWebRootUrl();
  const serverHost = useServerHost();
  const [expanded, toggleExpanded] = useExpandedSessions();
  const [sort, setSort] = useHomeSort();
  const { filter, setQuery, setSolo, clear } = useHomeFilter();
  const filterField = useRef<HTMLInputElement>(null);
  const lists = useRef<HTMLDivElement>(null);

  const showLive = mode !== "paused_locally";
  // Paused here: Live now is hidden, so the toolbar counts and filters Earlier today only.
  const liveInScope = showLive ? live : NO_SESSIONS;
  const sessionsInScope = liveInScope.length + endedToday.length;
  const filtering = filterActive(filter);
  // An active filter keeps its toolbar whatever is in view, so its clear control is never stranded (design §2c).
  const showToolbar = mode !== "revoked" && mode !== "paused_by_server" && (filtering || sessionsInScope >= HOME_TOOLBAR_MIN_SESSIONS);
  // A hidden toolbar can't explain an order or a filter, so none applies.
  const viewSort: HomeSort = showToolbar ? sort : "recent";
  const viewFilter = showToolbar ? filter : NO_FILTER;
  const controlKey = JSON.stringify([viewSort, viewFilter.query.trim().toLocaleLowerCase(), viewFilter.solo]);

  const liveMatches = useMemo(() => sortSessions(filterSessions(liveInScope, viewFilter, boardNameOf), viewSort), [liveInScope, viewFilter, boardNameOf, viewSort]);
  const endedMatches = useMemo(() => sortSessions(filterSessions(endedToday, viewFilter, boardNameOf), viewSort), [endedToday, viewFilter, boardNameOf, viewSort]);
  const anyExpanded = [...liveMatches, ...endedMatches].some((session) => expanded.has(session.native_session_id));
  const { held, handlers: holdHandlers } = useListHold(anyExpanded);
  const shownLive = useStableOrder(liveMatches, controlKey, held);
  const shownEnded = useStableOrder(endedMatches, controlKey, held);

  const { registerTrigger, liveHeading, trackFocus } = useFocusFollowsLeavingRow(shownLive, filterField);
  const { announcement, announceFilter, announceSort } = useViewAnnouncer(shownLive.length + shownEnded.length, sessionsInScope);
  useFilterHotkey(filterField, showToolbar);
  useFocusSurvivesToolbar(showToolbar);

  const changeQuery = (query: string) => {
    setQuery(query);
    announceFilter();
  };
  const changeSolo = (solo: string | null) => {
    setSolo(solo);
    announceFilter();
  };
  const changeSort = (next: HomeSort) => {
    setSort(next);
    announceSort(next);
  };
  const clearFilters = () => {
    clear();
    announceFilter();
    filterField.current?.focus();
  };
  const focusFirstRow = () => lists.current?.querySelector<HTMLButtonElement>(".home-session-main")?.focus();

  if (!mode) return null;

  if (mode === "revoked" || mode === "paused_by_server") {
    return (
      <div className="home-screen" data-testid="screen-home">
        {mode === "revoked" ? <RevokedPanel webRootUrl={webRootUrl} /> : <PausedByServerPanel webRootUrl={webRootUrl} />}
      </div>
    );
  }

  const unreachable = mode === "unreachable";
  const nothingToday = live.length === 0 && endedToday.length === 0;
  const listProps = { boardNameOf, expanded, onToggle: toggleExpanded, webRootUrl, registerTrigger };
  const filtered = showToolbar && filtering;
  const noMatches = filtered && shownLive.length === 0 && shownEnded.length === 0;
  const seen = agentsSeen([...liveInScope, ...endedToday]);
  // A soloed agent keeps its tile even once none of its sessions remain, so the solo can always be cleared.
  const agents = filter.solo !== null && !seen.includes(filter.solo) ? [...seen, filter.solo] : seen;

  return (
    <div className="home-screen" data-testid="screen-home">
      {mode === "paused_locally" ? <PausedBanner /> : unreachable ? <UnreachableBanner host={serverHost} queued={queuedRecords} /> : <AttentionBanner />}

      {nothingToday ? (
        showLive ? <EmptyPanel /> : null
      ) : (
        <>
          {showToolbar ? (
            <HomeToolbar
              query={filter.query}
              onQueryChange={changeQuery}
              fieldRef={filterField}
              onArrowDown={focusFirstRow}
              agents={agents}
              solo={filter.solo}
              onSoloChange={changeSolo}
              showAgents={agents.length >= 2 || filter.solo !== null}
              sort={sort}
              onSortChange={changeSort}
            />
          ) : null}
          <div
            ref={lists}
            className="home-lists"
            {...holdHandlers}
            onFocus={(event) => {
              holdHandlers.onFocus();
              trackFocus(event);
            }}
          >
            {showLive && (!filtered || shownLive.length > 0) ? (
              <section>
                {/* Focusable: focus lands on the heading when the last live row leaves. */}
                <SectionHead
                  title="Live now"
                  headingRef={liveHeading}
                  aside={
                    filtered
                      ? `${shownLive.length} of ${live.length}`
                      : live.length > 0
                        ? unreachable
                          ? `saved on ${platformCopy().thisDevice}`
                          : "updates as they run"
                        : undefined
                  }
                />
                <SessionList label="Live now" kind="live" sessions={shownLive} waitingToUpload={unreachable} {...listProps} />
                {live.length === 0 ? <p className="bp-help">No agent is running in a bound project right now.</p> : null}
              </section>
            ) : null}
            {shownEnded.length > 0 ? (
              <section>
                <SectionHead title="Earlier today" aside={filtered ? `${shownEnded.length} of ${endedToday.length}` : endedToday.length} />
                <SessionList label="Earlier today" kind="ended" sessions={shownEnded} waitingToUpload={false} {...listProps} />
              </section>
            ) : null}
          </div>
          {noMatches ? (
            <div className="home-noresults" role="status">
              <p>
                <b>No sessions match.</b> {noResultDetail(viewFilter)}
              </p>
              <LinkButton onClick={clearFilters}>Clear filters</LinkButton>
            </div>
          ) : null}
          <TotalsFooter />
        </>
      )}
      <p className="sr-only" aria-live="polite" data-testid="home-filter-announcer">
        {announcement}
      </p>
    </div>
  );
}
