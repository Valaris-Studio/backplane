// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { ImportantNote, ProTip } from "../callouts";

export function GettingStartedYourFirstBoardAndCard() {
  return (
    <SectionPage title="Your First Board and Card" eyebrow="Getting Started">
      <p>
        A board is the project surface where people and runners coordinate.
        It contains typed columns and cards, plus definitions, resources,
        notes, history, timeline replay, git integration, and alerts.
      </p>

      <h2 id="create-the-board">Create the board</h2>
      <p>
        Open /&#123;slug&#125;/boards and choose Create board. The current dialog
        asks for a name and an optional description; it does not ask for board
        tags. After creation, Backplane opens the kanban view.
      </p>
      <p>
        A new board is not empty. It receives four default columns: To Do with
        type backlog, In Progress with type active, Blocked with type blocked,
        and Done with type done. You may rename or reconfigure them later, but
        pipeline discovery reads column type rather than the visible title.
      </p>
      <p>
        The board header exposes eight tabs: kanban, definitions, resources,
        notes, history, timeline, git, and alerts. Timeline is a replay and
        inspection surface; history is the activity record.
      </p>

      <h2 id="create-a-card">Create the first card</h2>
      <p>
        Use Add card at the bottom of a column. Title is the only required
        field. The dialog also exposes an optional description, card type,
        priority, target column, due date, status, labels, and participants.
        Creation defaults to type task and priority medium.
      </p>
      <p>
        The supported card types are task, issue, feature, and bug. The UI
        offers low, medium, high, and urgent priorities; the stored model also
        supports none. See the internal{" "}
        <a href="../documentation/card-type-and-priority">
          Card Type and Priority
        </a>{" "}
        reference before building automation around those values.
      </p>

      <h2 id="markdown-mermaid">Markdown, Mermaid, and notes</h2>
      <p>
        Card descriptions and workspace notes use the shared rich-text editor.
        Pasting plain text that looks like Markdown converts headings, lists,
        links, and other supported structure; pasted HTML takes precedence.
        Pasting inside a code block remains literal.
      </p>
      <p>
        The editor can insert a Mermaid code block and render the diagram in
        place. Use it for compact flows or architecture context that belongs
        with the work. The note editor also offers Export .md. Card
        descriptions do not currently expose that Markdown export action.
      </p>
      <p>
        The same export exists over the API: fetching a workspace or board
        note with <code>?format=markdown</code> returns its content serialized
        to Markdown instead of the default raw editor JSON. The conversion is
        a read-time projection of the stored document — nothing is mutated —
        so scripts and agents can pull notes as plain Markdown without
        touching the editor.
      </p>
      <p>
        Diagrams render under Mermaid's <code>strict</code> security level:
        the produced SVG is sanitized and click bindings are disabled. Any{" "}
        <code>%%&#123;init&#125;%%</code> directive embedded in the diagram
        source is stripped before rendering, because an embedded directive
        outranks the app's own configuration — without the strip, note content
        could relax that security level itself. A pasted diagram is drawn, not
        trusted.
      </p>

      <ImportantNote title="A useful card still needs an executable brief">
        Rich formatting does not replace scope. State the goal, constraints,
        relevant files or resources, acceptance criteria, and what must not be
        changed. A runner receives the card description as working context.
      </ImportantNote>

      <h2 id="detail">Continue in the card detail sheet</h2>
      <p>
        Open a card to edit its description and metadata, manage labels and
        participants, link notes, record dependencies, or explain why work is
        stuck. The board remains the scanning and movement surface; the detail
        sheet is where the durable implementation context belongs.
      </p>

      <ProTip title="Validate persistence before adding automation">
        Create a card with a Markdown list and a Mermaid block, reload the
        board, reopen the card, and export a related note as .md. This verifies
        the editor, database, and board route before a runner enters the loop.
      </ProTip>
    </SectionPage>
  );
}
