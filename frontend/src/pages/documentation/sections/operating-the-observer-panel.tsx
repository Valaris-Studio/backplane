// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark, ProTip, Screenshot } from "../callouts";

export function OperatingTheObserverPanel() {
  return (
    <SectionPage title="The Observer Panel" eyebrow="Operating the Platform">
      <p>Open the eye in the top bar to inspect WebSocket frames received by this tab. The Observer is available to workspace owners and admins. Its closed-panel badge counts retained unseen events, capped visually at 99+.</p>
      <Screenshot
        alt="Observer panel with received events, capture start time and diagnostic controls"
        caption="A bounded view of frames received by this tab, not a saved event log."
        description="The panel shows All, namespace filters, search, pause and clear controls, plus connection, denial and eviction details."
        aspectRatio="4:3"
      />
      <h2 id="what-streams">What this tab received</h2>
      <p>Received by this tab since marks the start of the current buffer. All clears the namespace filters and shows every retained authorized domain frame, including unknown namespaces. Namespace chips and the event-type or ID search narrow that view without changing capture.</p>
      <p>Select a row to expand its diagnostic JSON payload. Known credential fields, bearer text and tokenized URL queries are redacted before retention. Oversized or deeply nested values are truncated and labeled. This is a bounded diagnostic projection; arbitrary free text can still be sensitive. No extra entity bodies are fetched to fill missing payloads.</p>
      <p>The live buffer retains at most 1000 events and 4 MiB of projected UTF-8 data, with at most 16 KiB per frame. Pausing can retain a second 4 MiB display snapshot, for up to 8 MiB of distinct projected data. These are data limits, not total browser memory limits. Older frames are evicted when a limit is reached. Eviction counts describe this local buffer, not events lost elsewhere.</p>
      <h2 id="pause-clear-reconnect">Pause, clear and reconnect</h2>
      <p>Pause freezes the displayed list while bounded capture continues. New arrivals remain unseen while paused, even with the panel open. Pending arrivals and evictions remain visible as counts. Resume shows the frames still retained. Arrivals while the panel is open and unpaused are treated as seen.</p>
      <p>Clear empties the buffer and resets its counts and capture-start time. Switching workspace, losing access, signing out or reloading also starts a fresh buffer. Data is held only in memory in this tab; it is not a saved log.</p>
      <p>Connection status and subscription denial are separate from the event list. A connected socket does not prove every subscription was accepted. Its last ping describes this tab’s transport, not agent health. A filtered empty list does not mean no frames arrived. Disconnected intervals are gaps: the bus does not replay them, and the panel cannot count events it never received.</p>
      <ProTip title="Check delivery, then the durable record">
        Use the Observer to correlate received event IDs and types with an action. Absence alone cannot distinguish an unpublished event, an authorization filter or a delivery gap. Use History, Timeline and execution records to verify committed state; every click is not guaranteed to publish an event.
      </ProTip>
      <HonestRemark title="Admin access does not grant private-event access">
        The server checks current authority before delivery. Another person's captured-session, device and notification events remain private even from another admin. Internal control frames are intentionally unavailable. Ordinary live updates and notifications use their own subscriptions and continue without the Observer wildcard.
      </HonestRemark>
    </SectionPage>
  );
}
