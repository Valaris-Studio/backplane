// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/i18n/config";
import { TimelineScrubber } from "../../src/features/timeline/components/TimelineScrubber";
import type { TimelineEvent } from "../../src/features/timeline/types";

const single = new URLSearchParams(location.search).has("single");
const contextIndices = new Set(single ? [0] : [0, 1, 2, 500, 997, 998, 999]);
const events: TimelineEvent[] = Array.from({ length: single ? 1 : 1000 }, (_, index) => ({
  id: `event-${index}`,
  workspace_id: "fixture-workspace",
  board_id: "fixture-board",
  actor_id: "fixture-actor",
  actor_name: "Alice",
  actor_email: null,
  agent_id: null,
  entity_type: contextIndices.has(index) ? "note" : "card",
  entity_id: `entity-${index}`,
  entity_title: `Decision ${index}`,
  action: "updated",
  summary: `Decision ${index}`,
  changes: null,
  via_api_key: null,
  created_at: new Date(Date.UTC(2026, 9, 8, 0, index)).toISOString(),
  before_state: null,
  after_state: null,
}));

function BoundaryFixture() {
  const [frameIndex, setFrameIndex] = useState(single ? 0 : 500);
  return (
    <main style={{ margin: 16, paddingTop: 64 }}>
      {/* BoardLayout's vertical scrollport also clips negative horizontal overflow. */}
      <div data-testid="board-scrollport" style={{ height: 280, overflowY: "auto", border: "1px solid var(--color-border)" }}>
        <TimelineScrubber
          events={events}
          frameIndex={frameIndex}
          frameCount={events.length}
          columnNames={{}}
          flags={single ? [0] : [0, 500, 997]}
          onSeek={setFrameIndex}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<BoundaryFixture />);
