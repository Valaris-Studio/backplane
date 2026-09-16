// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.2 and
// docs/research/frontend-ux.md §12.

import { SectionPage } from "../shell/SectionPage";

export function ReferenceCardTypeAndPriority() {
  return (
    <SectionPage title="Card Type and Priority" eyebrow="Reference">
      <p>
        Two enums on every card affect both visual styling on the board and
        the order in which discover strategies offer cards to runners. They
        are cosmetic in isolation and load-bearing in combination —{" "}
        <code>priority</code> in particular drives which card a polling
        runner sees first.
      </p>

      <h2 id="card-type">Card type</h2>
      <p>
        Four values. Each maps to a Tailwind token in{" "}
        <code>KanbanCard.tsx</code> — no hex strings in the source. Type
        does not affect pipeline matching unless a stage filter explicitly
        references it; it's primarily a visual and human-filter concern.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                card_type
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Visual
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Intended use
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>task</code>
              </td>
              <td className="py-3 pr-4">Neutral token — the default.</td>
              <td className="py-3 pr-4">
                The generic unit of work. Anything not obviously a bug, a new
                feature, or an open issue.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>bug</code>
              </td>
              <td className="py-3 pr-4">Rose / red-accented token.</td>
              <td className="py-3 pr-4">
                Regression, defect, broken behavior. Pipelines that run a
                reproduction-first TDD flow typically filter to this type.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>feature</code>
              </td>
              <td className="py-3 pr-4">Emerald / green-accented token.</td>
              <td className="py-3 pr-4">
                New capability. Usually decomposed by an architect stage
                before an implementer claims it.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>issue</code>
              </td>
              <td className="py-3 pr-4">Amber-accented token.</td>
              <td className="py-3 pr-4">
                Open question, investigation, ambiguous report. Promoted to
                <code>bug</code> or <code>feature</code> once triaged.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="priority">Priority</h2>
      <p>
        Five values, ordered. The ordering matters: discover strategies that
        return "highest priority first" use this enum as their sort key.
        Ties break on fractional position within the column, so priority
        acts as the primary key and position acts as the secondary.
      </p>
      <p>
        The API schema and the <code>create_card</code> MCP tool default to{" "}
        <code>none</code>. The create-card dialog defaults to medium and does
        not currently offer none in its selector, although existing{" "}
        <code>none</code> cards render correctly elsewhere in the UI. Callers
        that need an explicit unset priority should use the API or MCP surface.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                priority
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Rank
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Discover implication
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>urgent</code>
              </td>
              <td className="py-3 pr-4">Highest</td>
              <td className="py-3 pr-4">
                Pulled first by priority-ordered discover. Runners will claim
                an <code>urgent</code> card in{" "}
                <code>backlog</code> before touching a{" "}
                <code>high</code> card in the same column.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>high</code>
              </td>
              <td className="py-3 pr-4">High</td>
              <td className="py-3 pr-4">
                Second wave. The default for non-trivial work an architect
                stage creates via <code>plan_work</code>.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>medium</code>
              </td>
              <td className="py-3 pr-4">Medium (create-dialog default)</td>
              <td className="py-3 pr-4">
                The browser's create-card dialog preselects this value. API
                and MCP callers that omit priority create a{" "}
                <code>none</code> card instead.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>low</code>
              </td>
              <td className="py-3 pr-4">Low</td>
              <td className="py-3 pr-4">
                Pulled after medium but before unprioritized <code>none</code>.
                Useful for nice-to-haves when the runner has spare capacity.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>none</code>
              </td>
              <td className="py-3 pr-4">Unprioritized (API and MCP default)</td>
              <td className="py-3 pr-4">
                Sorted after <code>low</code>. Use this value when priority has
                not been triaged yet; it is not selectable in the current
                create-card dialog.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="combined">Combined effect</h2>
      <p>
        A <code>by_priority</code> discover strategy sorts{" "}
        <code>urgent</code> → <code>high</code> → <code>medium</code> →{" "}
        <code>low</code> → <code>none</code>, then by fractional position within
        each bucket. A human dragging a card to the top of a column is effectively saying
        "same priority, try me first"; an operator bumping priority is
        saying "jump the line across buckets." Both paths reach the same
        runner; the runner doesn't know or care which one put the card on
        top.
      </p>
    </SectionPage>
  );
}
