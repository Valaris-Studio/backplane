// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.1, §2.2.

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark } from "../callouts";

export function CoreConceptsWorkspacesBoardsColumnsCards() {
  return (
    <SectionPage
      title="Workspaces, Boards, Columns, Cards"
      eyebrow="Core Concepts"
    >
      <p>
        Backplane nests four containers: a <strong>workspace</strong> holds{" "}
        <strong>boards</strong>, each board holds <strong>columns</strong>, and
        each column holds <strong>cards</strong>. Every URL in the app starts
        with <code>/{"{slug}"}</code> — the workspace slug is the tenancy
        boundary. If you don't have a workspace, you don't have anything.
      </p>

      <h2 id="workspace">Workspace</h2>
      <p>
        The workspace is the top-level tenancy unit. It owns boards, members,
        channels, teams, pipeline config, budgets, API keys, approvals, and
        activity history. Membership carries one of four roles —{" "}
        <code>owner &gt; admin &gt; member &gt; viewer</code> — and access to
        every feature endpoint resolves through a single dependency that checks
        the slug against the caller's membership.
      </p>
      <p>
        With <code>AUTH_AUTO_PROVISION=true</code>, verified IAP, trusted-proxy,
        and OIDC callback identities can be provisioned automatically. Local
        authentication instead uses first-run or administrator-created accounts
        and does not provide public self-registration. Workspaces themselves are
        created on demand from the landing page by an authenticated user.
      </p>

      <h2 id="board">Board</h2>
      <p>
        A board is a kanban project. It owns an ordered list of columns and,
        transitively, every card in those columns. Eight tabs hang off a board:
        kanban, definitions, resources, notes, history, timeline, git, and
        alerts. The kanban tab is where drag-and-drop happens; definitions,
        files, and notes preserve project context; History is the durable event
        feed; Timeline replays board state; Git binds repositories; and Alerts
        holds board-scoped rules.
      </p>
      <p>
        Cards carry a denormalized <code>board_id</code> alongside their{" "}
        <code>column_id</code>. It's redundant — you could walk from card to
        column to board — but it lets board-level queries skip the join.
      </p>
      <p>
        Resources have two navigation scopes. The sidebar's Resources page
        opens the workspace collection; the board's Resources tab passes that
        board ID to the same file browser. A frozen board makes its scoped
        resource view read-only without freezing workspace-wide resources.
      </p>

      <h2 id="column">Column</h2>
      <p>
        Columns have a human-facing <strong>name</strong> and a semantic{" "}
        <strong>column_type</strong>. The types are{" "}
        <code>backlog</code>, <code>active</code>, <code>review</code>,{" "}
        <code>done</code>, and <code>blocked</code>. Pipeline stages reference
        the type, never the name — so a column named "Review" and a column
        named "Peer Review" behave identically if they share the{" "}
        <code>review</code> type. The type is what runners match against when
        discovering work; the name is what humans read on the board.
      </p>

      <HonestRemark title="Renaming a column is cosmetic. Retyping it changes behavior.">
        Operators sometimes rename "Backlog" to "Intake" or "Triage" expecting
        the pipeline to notice. It won't. Runners find cards by column type.
        If you want the backlog-discovery stage to stop matching that column,
        change the type — not the name. Ask us how we know.
      </HonestRemark>

      <h2 id="card">Card</h2>
      <p>
        Cards are the unit of work. Each has a title, a rich-text description,
        a <code>card_type</code> (<code>task | bug | feature | issue</code>), a
        priority, string labels, a status, an optional due date, and a list of{" "}
        <strong>participants</strong>. A participant is a user or runner
        attached to the card in one of four roles: <code>hero</code> (the
        primary executor), <code>helper</code>, <code>viewer</code>, or{" "}
        <code>stakeholder</code>. The one-hero-per-card rule lives in the
        claim service, not as a database constraint — the hero is how runners
        coordinate "I've got this one."
      </p>

      <h2 id="fractional-positions">Fractional positions</h2>
      <p>
        Columns and cards use <code>FLOAT</code> positions instead of integer
        ordering. A new item gets <code>max_position + 1024</code>; a move
        computes the midpoint between its new neighbors. No O(N) reorder
        updates, no index rebuilds, no races when two users drag at the same
        time. The frontend computes positions; the backend just stores the
          number. See{" "}
        <a href="../documentation/fractional-indexing">Fractional Indexing</a>{" "}
        under Under the Hood for the full story.
      </p>
    </SectionPage>
  );
}
