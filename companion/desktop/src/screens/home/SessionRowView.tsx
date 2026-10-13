// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useCallback, useId } from "react";

import { LinkButton } from "../../components/Button";
import { AgentTile } from "../../components/AgentTile";
import { DisclosurePanel } from "../../components/Disclosure";
import { Icon } from "../../components/Icon";
import { LiveDot } from "../../components/LiveDot";
import { MotionListItem } from "../../motion/MotionListItem";
import { NumberTick } from "../../motion/NumberTick";
import type { TrackedSession } from "../../stores/sessions";
import { agentLabel, agentTileId } from "./agent-label";
import { useSecondClock } from "./clock";
import {
  COST_BASIS_HELP,
  COST_BASIS_LABEL,
  UNKNOWN_COST_HELP,
  cacheWasRebuilt,
  costOf,
  formatClockTime,
  formatCost,
  formatElapsed,
  formatMinutes,
  formatTokens,
  repoLabel,
  safeRepo,
  totalTokens,
  usagePending,
} from "./format";
import { openInBackplane, sessionLink } from "./open-backplane";
import {
  COLD_CACHE_HINT,
  COUNTING_TOKENS,
  PENDING_USAGE_HELP,
  USAGE_SCOPE_CAPTION,
  USAGE_TERMS,
  deletedHistoryCopy,
} from "./usage-copy";
import { UsageTermTip } from "./UsageTermTip";

export interface SessionRowProps {
  session: TrackedSession;
  /** Set for a session in Earlier today. */
  endedAt: string | null;
  boardName: string | undefined;
  waitingToUpload: boolean;
  open: boolean;
  onToggle: (sessionId: string) => void;
  webRootUrl: string | null;
  /** Hands the row's trigger to Home, so focus can follow a session that moves lists. */
  registerTrigger: (sessionId: string, list: "live" | "ended", trigger: HTMLButtonElement | null) => void;
}

// Its own component so the per-second tick re-renders this label, never the row.
function Elapsed({ startedAt }: { startedAt: string }) {
  const now = useSecondClock();
  return <span className="tabular-nums">{formatElapsed(now - Date.parse(startedAt))}</span>;
}

const Separator = () => <span aria-hidden="true">·</span>;

function TokensLabel({ count }: { count: number }) {
  return (
    <span className="home-s-shrink tabular-nums">
      <NumberTick value={formatTokens(count)} /> tokens
    </span>
  );
}

function LiveTokens({ session, pending }: { session: TrackedSession; pending: boolean }) {
  if (!pending) return <TokensLabel count={totalTokens(session.tokens)} />;
  return <span className="home-s-shrink">{deletedHistoryCopy(session.history_deleted)?.label ?? COUNTING_TOKENS}</span>;
}

function LiveLine({ session, waitingToUpload, pending }: { session: TrackedSession; waitingToUpload: boolean; pending: boolean }) {
  return (
    <>
      <LiveDot />
      {session.started_at ? <Elapsed startedAt={session.started_at} /> : null}
      <Separator />
      {waitingToUpload ? <span className="home-s-tag">Waiting to upload</span> : <LiveTokens session={session} pending={pending} />}
    </>
  );
}

function UsageDetail({ session }: { session: TrackedSession }) {
  const cost = costOf(session);
  return (
    <>
      <dl>
        {USAGE_TERMS.map(({ field, label, tip }) => (
          <div key={field}>
            <dt>
              <UsageTermTip label={label} tip={tip} />
            </dt>
            <dd>
              <NumberTick value={formatTokens(session.tokens?.[field] ?? 0)} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="home-s-scope">{deletedHistoryCopy(session.history_deleted)?.caption ?? USAGE_SCOPE_CAPTION}</p>
      {cacheWasRebuilt(session.tokens) ? <p>{COLD_CACHE_HINT}</p> : null}
      <p>{cost ? COST_BASIS_HELP[cost.basis] : UNKNOWN_COST_HELP}</p>
    </>
  );
}

function EndedLine({ session, endedAt }: { session: TrackedSession; endedAt: string }) {
  const ended = new Date(endedAt);
  return (
    <>
      <span className="tabular-nums">{formatClockTime(ended)}</span>
      {session.started_at ? (
        <>
          <Separator />
          <span className="tabular-nums">{formatMinutes(ended.getTime() - Date.parse(session.started_at))}</span>
        </>
      ) : null}
      <Separator />
      <TokensLabel count={totalTokens(session.tokens)} />
    </>
  );
}

// Renders only the fields named below: whatever else rides on the event (prompts, paths) never reaches the DOM.
export function SessionRowView({ session, endedAt, boardName, waitingToUpload, open, onToggle, webRootUrl, registerTrigger }: SessionRowProps) {
  const id = session.native_session_id;
  // A generated id: the daemon's session id stays out of the DOM.
  const detailId = useId();
  const list = endedAt ? "ended" : "live";
  const triggerRef = useCallback((trigger: HTMLButtonElement | null) => registerTrigger(id, list, trigger), [registerTrigger, id, list]);
  const cost = costOf(session);
  // An ended session will report nothing more: its zero is final, not pending.
  const pending = !endedAt && usagePending(session);

  return (
    <MotionListItem className="home-session" data-open={open}>
      <button ref={triggerRef} type="button" className="home-session-main" aria-expanded={open} aria-controls={detailId} onClick={() => onToggle(id)}>
        <AgentTile agent={agentTileId(session.harness)} />
        <span className="sr-only">{agentLabel(session.harness)}:</span>
        <span className="home-s-body">
          <span className="home-s-line1">
            <span className="home-s-repo">{repoLabel(session.repo)}</span>
            {boardName ? (
              <>
                <Icon name="arrow" />
                <span className="sr-only">to board</span>
                <span className="home-s-board">{boardName}</span>
              </>
            ) : null}
          </span>
          <span className="home-s-line2">{endedAt ? <EndedLine session={session} endedAt={endedAt} /> : <LiveLine session={session} waitingToUpload={waitingToUpload} pending={pending} />}</span>
        </span>
        <span className="home-s-meta">
          {pending ? null : <span className="home-s-cost">{cost ? <NumberTick value={formatCost(cost.usd)} /> : "—"}</span>}
          {cost ? <span className="home-s-basis">{COST_BASIS_LABEL[cost.basis]}</span> : null}
        </span>
      </button>
      <DisclosurePanel open={open} id={detailId}>
        <div className="home-s-detail">
          {pending ? <p>{deletedHistoryCopy(session.history_deleted)?.help ?? PENDING_USAGE_HELP}</p> : <UsageDetail session={session} />}
          <LinkButton icon="external" onClick={() => void openInBackplane(sessionLink({ ...session, repo: safeRepo(session.repo) }, webRootUrl))}>
            Open in Backplane
          </LinkButton>
        </div>
      </DisclosurePanel>
    </MotionListItem>
  );
}
