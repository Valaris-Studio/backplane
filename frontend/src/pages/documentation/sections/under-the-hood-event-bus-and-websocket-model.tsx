// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §7.3,
// docs/research/backend-architecture.md §5, docs/research/frontend-ux.md §6,
// and docs/events.md.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark, ImportantNote } from "../callouts";

export function UnderTheHoodEventBusAndWebsocketModel() {
  return (
    <SectionPage
      title="The Event Bus and WebSocket Model"
      eyebrow="Under the Hood"
    >
      <p>
        Every published mutation fans out through one event-bus interface.{" "}
        <code>EVENT_BUS_BACKEND=memory</code> keeps delivery in process;
        <code>EVENT_BUS_BACKEND=postgres</code> adds cross-instance fan-out via
        Postgres LISTEN/NOTIFY while preserving the same local subscribers.
        The backend's WebSocket router translates those into outbound frames
        for every connection subscribed to a matching pattern. A webhook
        subscriber drains the same bus for outbound HTTP fan-out. The
        frontend has a one-line React hook that turns a WS subscription into
        a React Query cache invalidation. The runner has a WS client that
        wakes its work loop on any matching event. This is the low-latency path
        across the four surfaces; the runner still keeps its scheduled poll as
        a fallback.
      </p>

      <h2 id="the-in-process-bus">The local bus and the Postgres adapter</h2>
      <p>
        <code>EventBus</code> lives at{" "}
        <code>backend/app/core/event_bus.py</code>. It is a subscribe /
        publish ring backed by a list of{" "}
        <code>(workspace_id, fnmatch_pattern, callback)</code> tuples.
        Subscriptions can be workspace-scoped or global. Patterns are shell
        globs — <code>activity.card.*</code>,{" "}
        <code>activity.*.deleted</code>, <code>*</code> — so fine-grained
        filtering is declarative, not procedural. Publish is fan-out via{" "}
        <code>asyncio.gather(..., return_exceptions=True)</code>. Subscriber
        errors are logged but never raised back to the publisher. The{" "}
        <code>PostgresEventBus</code> subclass dispatches locally, sends a
        NOTIFY on <code>valaris_events</code>, and re-injects LISTEN messages
        from other instances without echoing them back. A single module-level{" "}
        <code>event_bus</code> singleton is shared by the direct publishers.
      </p>

      <h2 id="activity-fanout">activity.&#123;entity&#125;.&#123;action&#125; fan-out</h2>
      <p>
        <code>ActivityService.record</code> is the cross-cutting mutation
        recorder. Services use it for audited entity mutations. The method
        writes the activity row to the database, then unconditionally
        publishes <code>activity.&#123;entity_type&#125;.&#123;action&#125;</code> on the
        bus — <code>activity.card.created</code>,{" "}
        <code>activity.board.updated</code>,{" "}
        <code>activity.note.deleted</code>, and so on. Agent lifecycle now also
        records <code>activity.agent.updated</code> and{" "}
        <code>activity.agent.deleted</code>. Adding a new pair needs no
        per-event constant because the event name derives from the{" "}
        <code>ActivityEntityType</code> and <code>ActivityAction</code>{" "}
        enums.
      </p>
      <p>
        Service-specific events that are not activity-shaped —{" "}
        <code>execution.started</code> / <code>completed</code>,{" "}
        <code>execution.warning</code>,{" "}
        <code>approval.created</code> / <code>updated</code>,{" "}
        <code>agent.status_changed</code> / <code>heartbeat_received</code> /{" "}
        <code>poll_requested</code> / <code>paused</code> / <code>resumed</code> /{" "}
        <code>restart_requested</code> / <code>hard_deleted</code>,{" "}
        <code>board.loop_updated</code>, <code>api_key.first_used</code>,{" "}
        <code>notification.created</code>, <code>merge_queue.*</code>,{" "}
        <code>config.changed</code>, and <code>cost.threshold_crossed</code> —
        publish directly from their owning services. Most constants live in{" "}
        <code>backend/app/core/events.py</code>; merge-queue and notification
        names live beside their publishers.
      </p>

      <h2 id="bridge-events">Bridge events: deprecated but still emitting</h2>
      <p>
        A small map — <code>card.created</code>, <code>card.updated</code>,{" "}
        <code>card.moved</code>, <code>card.deleted</code>,{" "}
        <code>column.created</code>, <code>column.updated</code>,{" "}
        <code>column.deleted</code> — publishes in parallel with the{" "}
        <code>activity.*</code> twin. These are bridge events kept for
        backward compatibility. The source is explicitly commented{" "}
        <em>"deprecated, do not extend"</em>. New consumers should subscribe
        to the <code>activity.*</code> namespace; the bridge is what exists
        so pre-M-Observability consumers keep working while they migrate.
        The bridge map in <code>backend/app/services/activity.py</code> is
        the sunset list — removing it requires confirming no live consumer
        depends on the old name.
      </p>

      <h2 id="ws-subscribe-protocol">The WebSocket subscribe protocol</h2>
      <p>
        A WebSocket client connects to{" "}
        <code>/ws/workspaces/&#123;slug&#125;/events</code> with an API key
        in <code>Authorization: Bearer vlr_...</code>, a signed browser session,
        or an IAP/trusted-proxy identity. The legacy <code>?token=vlr_...</code>
        fallback is still accepted, but the runner uses the header so secrets
        do not land in access logs. On accept, the connection is registered with
        the <code>ConnectionManager</code>, which holds live socket handles
        and bridges bus events to them. The client then sends{" "}
        <code>&#123;"subscribe": ["card.*", "approval.*"]&#125;</code>. The
        connection manager re-subscribes on every such frame: each pattern
        becomes one <code>EventBus</code> subscription whose callback
        serializes the event as JSON and sends it over the socket.
      </p>
      <p>
        Heartbeats flow both ways. The server sends{" "}
        <code>&#123;"type": "ping"&#125;</code> every{" "}
        <code>WS_HEARTBEAT_INTERVAL</code> seconds; runners additionally
        push <code>&#123;"type": "heartbeat"&#125;</code> frames carrying
        CPU, memory, card counts, and current board to keep the backend's
        live runner view fresh.
      </p>

      <ImportantNote title="Timing mitigations are load-bearing, not decorative">
        There is no event replay between connect and subscribe. An event
        published in the window between <code>accept()</code> and the first{" "}
        <code>subscribe</code> frame is lost to that client. The mitigations
        for subscribe timing are stacked for a reason. The transport{" "}
        (<code>src/lib/websocket.ts</code>) carries a stale-connection guard
        that checks <code>this.ws !== ws</code> on every callback — defence
        against React StrictMode's double-mount race where the stale
        socket's <code>onclose</code> would otherwise flip state belonging
        to the newer connection. The provider{" "}
        (<code>src/providers/WebSocketProvider.tsx</code>) holds a{" "}
        <code>serviceEpoch</code> state counter that invalidates every
        memoized <code>subscribe</code> closure when a new service is
        created, so children subscribing <em>before</em> the provider's
        effect ran don't hold a null service ref. Subscribe frames are
        re-sent on reconnect and on every new pattern registration — the
        server does not remember patterns across connections.
      </ImportantNote>

      <h2 id="useDomainSync">useDomainSync: the one-line bridge</h2>
      <p>
        Every React Query hook that wants live sync gets it with a single
        line. <code>useDomainSync(domain, queryKey, debounceMs?)</code>{" "}
        subscribes to <code>&#123;domain&#125;.*</code>, debounces for 250ms by default
        (to coalesce bursts during a drag operation), and invalidates the
        query key. No manual subscribe / unsubscribe lifecycle. No cache
        mutation logic. The WS stream invalidates; React Query refetches;
        the UI re-renders.
      </p>

      <CodeExample
        language="tsx"
        title="useDomainSync — shared live-sync hook across the frontend"
      >
        {`import { useQuery } from "@tanstack/react-query";
import { useDomainSync } from "@/hooks/useDomainSync";
import { boardKeys } from "@/lib/query-keys";
import { fetchBoardDetail } from "./client";

export function useBoardDetail(slug: string, boardId: string) {
  // One line. Any card.*, column.*, or activity.*.* event fires on this
  // workspace's WS, debounces for 250ms, and invalidates the cache.
  useDomainSync("card", boardKeys.detail(slug, boardId));
  useDomainSync("column", boardKeys.detail(slug, boardId));

  return useQuery({
    queryKey: boardKeys.detail(slug, boardId),
    queryFn: () => fetchBoardDetail(slug, boardId),
    enabled: Boolean(boardId),
  });
}`}
      </CodeExample>

      <p>
        Optimistic mutations (card move, card create, column reorder)
        snapshot the cache, mutate locally, rollback on error, and{" "}
        <code>useDomainSync</code> on the same key re-confirms or corrects
        the optimistic state once the backend commits. Two hooks on the
        same key — one optimistic, one WS-backed — compose cleanly because
        both fall through to the same React Query key.
      </p>

      <h2 id="runner-subscribes-too">The runner uses the same bus</h2>
      <p>
        The Go runner connects to the same WebSocket endpoint with its API
        key and subscribes to <code>card.*</code>, <code>approval.*</code>,{" "}
        <code>execution.*</code>, <code>config.*</code>, and{" "}
        <code>agent.*</code>, plus <code>board.*</code>. Any matching event wakes{" "}
        <code>Loop.TriggerPoll</code>, short-circuiting the default
        two-minute poll interval. Approval waits are implemented as a
        subscribe-and-block on a specific approval ID — the runner does not
        poll for decisions, it sleeps on the WS event and wakes on{" "}
        <code>approval.updated</code>.
      </p>
      <p>
        The runner drops any event whose <code>payload.agent_id</code> or{" "}
        <code>payload.actor_id</code> matches itself, to avoid self-trigger
        loops. The exception is <code>agent.poll_requested</code>, which
        carries <code>target_agent_id</code> and is the one event a runner
        should act on only when addressed specifically.
      </p>

      <HonestRemark title="Cross-instance delivery is not durable delivery">
        The memory backend is correct only for one instance: a publish reaches
        local subscribers and nowhere else. The Postgres backend closes that
        multi-instance visibility gap with LISTEN/NOTIFY, including automatic
        LISTEN reconnects and thin payloads above Postgres's notification size
        limit. It is still at-most-once and has no replay. A process failure,
        full receive queue, or NOTIFY outage can drop cross-instance delivery;
        local delivery has already happened. Webhooks intentionally ignore
        remote copies so only the originating instance sends external HTTP.
        Durable or financially consequential workflows need persisted state,
        not this notification bus.
      </HonestRemark>

      <p>
        The event taxonomy itself is documented at{" "}
        <code>docs/events.md</code> with every live event, its publishers,
        its subscribers, and its payload shape. Adding a new event is a
        three-step process — pick an <code>activity.*</code> name if the
        mutation is CRUD-shaped, otherwise define a constant in{" "}
        <code>backend/app/core/events.py</code>, publish it from the owning
        service, and register a frontend consumer. The taxonomy doc is the
        single authoritative reference for what's on the wire.
      </p>
    </SectionPage>
  );
}
