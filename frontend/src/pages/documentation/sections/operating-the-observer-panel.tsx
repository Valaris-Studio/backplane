// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/research/frontend-ux.md §1.5 and
// docs/platform-source-of-truth.md §4.7.

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark, ProTip, Screenshot } from "../callouts";

export function OperatingTheObserverPanel() {
  return (
    <SectionPage title="The Observer Panel" eyebrow="Operating the Platform">
      <p>
        The observer is the eye icon in the top bar. Click it and a sheet slides
        in from the right streaming WebSocket events live. It is mounted once
        per workspace session — as soon as you have a <code>slug</code> in the
        URL, the icon is there — and the icon badges an unread count while the
        sheet is closed, capped visually at <code>99+</code>. It used to be a free-floating draggable window whose
        x/y lived in <code>localStorage</code>; that is gone, and the stale
        <code>observer.position</code> entry is evicted on mount.
      </p>

      <Screenshot
        aspectRatio="4:3"
        alt="Observer sheet docked to the right edge showing a live stream of events with namespace chips, a search box, and a buffered counter"
        caption="The panel is the fastest way to answer 'did the backend actually fire that event' without opening DevTools."
        description={[
          "Right-side sheet roughly 420px wide, docked flush to the viewport edge, with a dark-surface background.",
          "Header reads 'Observer' with a pause button (showing two vertical bars) and a clear button (trash icon).",
          "Filter chip row with no chip selected by default: 'All', 'Card', 'Runner', 'Execution', 'Approval', and — only after such traffic is seen — 'Other'.",
          "Below the chips, a search input reading 'Search event type or id…' and a muted counter 'Showing 24 of 137 buffered (cap 1000)'.",
          "Event list below showing rows in reverse-chronological order: 'card.moved  a1f3c2d4  12s ago', 'execution.started  9b7e1a05  14s ago', 'agent.heartbeat_received  4c2d8f61  16s ago'.",
          "Each row carries a namespace badge, raw event type, full mono event_id, and relative timestamp; selecting it expands the JSON payload.",
        ]}
      />

      <h2 id="what-streams">What streams through it</h2>
      <p>
        The panel subscribes to <code>*</code> and buffers the whole bus — the
        most recent 1000 events — but, with no chip selected, shows only four agentic namespaces by default:{" "}
        <code>card</code>, <code>agent</code>, <code>execution</code>, and{" "}
        <code>approval</code>. Everything else the bus carries is one chip away:
        an <strong>Other</strong> chip appears as soon as non-agentic traffic
        lands, so a namespace nobody enumerated in advance is still diagnosable
        here rather than invisible platform-wide.
      </p>
      <p>
        The namespace chips are toggleable and additive. <strong>All</strong>{" "}
        clears the selected filters and returns to the default four-namespace
        view; it does not change the panel into an unfiltered whole-bus view.
        The search box narrows the list by event type or <code>event_id</code>{" "}
        substring, and the counter beside it reads <em>shown of buffered</em>{" "}
        against the cap. Selecting a row expands its raw JSON payload. Pause
        freezes the list at its current state without unsubscribing, so you can
        inspect a frame without events scrolling off — events arriving while
        paused are dropped, not queued. Clear empties the buffer without
        touching the subscription.
      </p>
      <p>
        The buffer is in-memory and live-only: nothing is persisted and a reload
        starts empty. The stored audit trail is <code>/history</code>, which is
        a different surface answering a different question.
      </p>

      <h2 id="when-to-reach-for-it">When to reach for it</h2>
      <p>Three situations where it earns its keep:</p>
      <ol>
        <li>
          Verifying a mutation actually broadcast. If you changed a card and the
          board didn't update in another tab, first question is "did the event
          fire at all?" The panel answers that in under a second.
        </li>
        <li>
          Tracing a pipeline run end-to-end. Watch the{" "}
          <code>execution.started</code> → <code>activity.card.moved</code> →{" "}
          <code>execution.completed</code> sequence line up in real time.
        </li>
        <li>
          Spotting noisy subscribers. If the panel shows the same event
          repeating, someone is publishing in a loop.
        </li>
      </ol>

      <ProTip title="Keep it open during smoke tests">
        When you are walking through a new pipeline or a fresh runner, open the
        sheet on your second monitor and leave it open. Every click in the app
        should produce a visible event, and any click that doesn't is
        interesting. It turns "did that work?" into "I can see it worked" —
        faster than tailing server logs, and available to anyone on the team
        without shell access.
      </ProTip>

      <HonestRemark title="Admin-only, deliberately">
        The panel is mounted for every user but gated behind{" "}
        <code>useWorkspaceAdmin</code>. Non-admins get no trigger icon at all —
        not a placeholder, nothing. And the client gate is only the UX half: the
        events socket rejects observer-grade subscription patterns from
        non-admins server-side, so hand-opening it gains nothing. This is on
        purpose — the bus carries actor IDs, payloads, and change JSON for every
        mutation in the workspace, which is a perfectly reasonable audit surface
        for an admin and a mildly uncomfortable privacy surface for a regular
        member. If we ever need a member-safe observer view, it will be a
        separate, filtered feed. Until then: admin gate.
      </HonestRemark>
    </SectionPage>
  );
}
