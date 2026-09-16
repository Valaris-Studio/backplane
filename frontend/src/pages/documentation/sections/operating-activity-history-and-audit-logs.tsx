// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against the activity API, feed hooks, and Timeline route.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote, Screenshot } from "../callouts";

export function OperatingActivityHistoryAndAuditLogs() {
  return (
    <SectionPage
      title="Activity History and Audit Logs"
      eyebrow="Operating the Platform"
    >
      <p>
        Recorded platform mutations write durable <code>Activity</code> rows and
        publish live bus events. Workspace History at{" "}
        <code>/{`{slug}`}/history</code> spans the workspace; a board's History
        tab scopes the same feed to that board. The stored feed is the source to
        use for audit questions after a live WebSocket event has passed.
      </p>

      <Screenshot
        aspectRatio="16:9"
        alt="History feed with entity, action, and search controls"
        caption="History uses server-side filters and bounded infinite scrolling rather than loading the workspace into the browser."
        description={[
          "Filter controls for Entity type and Action, plus a debounced Search field for activity summaries.",
          "Reverse-chronological rows grouped by date, with icons, localized messages, actor context, and relative timestamps.",
          "Resolvable card and note titles are links; repeated loop or cycle events can be grouped into one expandable row.",
          "The bottom sentinel fetches the next page when more durable history is available.",
        ]}
      />

      <h2 id="query-behavior">Filtering and pagination</h2>
      <p>
        Entity type, action, and search are sent as server-side query
        parameters. Search is debounced by 300 milliseconds. Each request asks
        for 50 rows using a <code>before</code> timestamp cursor, and the client
        retains at most three pages at once. The current History controls do not
        offer person or time-window selectors.
      </p>
      <p>
        Board History also keeps its live subscription strictly scoped to the
        active board. Incoming events invalidate or extend the visible feed;
        older rows continue through the same bounded cursor path.
      </p>

      <h2 id="row-shape">What a stored row carries</h2>
      <p>
        Identity and ordering fields include <code>id</code>,{" "}
        <code>workspace_id</code>, <code>seq</code>, <code>entity_type</code>,{" "}
        <code>entity_id</code>, optional <code>board_id</code>, optional{" "}
        <code>agent_id</code>, <code>actor_id</code>, and{" "}
        <code>created_at</code>. Display data includes a structured{" "}
        <code>message_key</code> plus <code>message_params</code>, with legacy{" "}
        <code>summary</code> as fallback. <code>changes</code>,{" "}
        <code>before_state</code>, and <code>after_state</code> preserve the
        structured detail needed by audit views and replay. A{" "}
        <code>via_api_key</code> marker identifies API-key activity in the feed.
      </p>

      <CodeExample language="json" title="Representative card-move activity">
        {`{
  "id": "6b3d...a12f",
  "seq": 418,
  "entity_type": "card",
  "entity_id": "3f91...88d7",
  "action": "moved",
  "board_id": "a2cd...9e14",
  "agent_id": "7b54...221c",
  "actor_id": "7b54...221c",
  "message_key": "activity.card.moved",
  "message_params": { "card": "Add OAuth flow", "from": "In Progress", "to": "Review" },
  "changes": { "column_id": { "from": "c1...", "to": "c2..." } },
  "via_api_key": true,
  "created_at": "2026-04-19T14:03:22Z"
}`}
      </CodeExample>

      <h2 id="timeline">Timeline replay</h2>
      <p>
        History answers who did what; Timeline reconstructs how the board
        changed. Open the board route shown below from its Timeline tab or the
        History link. The frontend requests up to 5000 events, receives them in
        ascending order with a current-board baseline, and replays snapshots in
        the browser with transport controls and a scrubber.
      </p>

      <CodeExample language="text" title="Board replay route">
        {`/{slug}/boards/{id}/timeline`}
      </CodeExample>

      <ImportantNote title="Replay is deliberately bounded">
        The timeline endpoint defaults to 500 rows and enforces a hard cap of
        5000. Its response marks <code>truncated</code> when more history exists.
        A truncated replay is useful evidence, but it is not proof that the
        visible first event was the board's original state.
      </ImportantNote>

      <h2 id="live-events">Durable rows and live events are related, not identical</h2>
      <p>
        Recording activity publishes a namespaced live event for that entity
        and action, plus a small compatibility bridge for selected legacy card
        and column events. The live payload contains the mutation context used
        for immediate UI updates; the database row adds durable identifiers,
        ordering, and timestamps. Use History or Timeline when exact replay
        matters instead of treating the observer buffer as storage.
      </p>
    </SectionPage>
  );
}
