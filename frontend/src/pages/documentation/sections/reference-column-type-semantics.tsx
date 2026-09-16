// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.2 and
// docs/research/frontend-ux.md §12.

import { SectionPage } from "../shell/SectionPage";
import { ImportantNote } from "../callouts";

export function ReferenceColumnTypeSemantics() {
  return (
    <SectionPage title="Column Type Semantics" eyebrow="Reference">
      <p>
        A column has two identities. Its <strong>name</strong> is what humans
        read on the board. Its <code>column_type</code> is what pipelines and
        runners match against. Rename a column and nothing else changes.
        Retype a column and you've rewired part of the pipeline.
      </p>
      <p>
        Five types exist today. The set is closed — operators can't declare
        new column types the way they can declare new roles. A column can
        also be untyped (<code>null</code>), in which case pipeline stages
        with a <code>by_column_type</code> discover strategy will simply not
        see it.
      </p>

      <h2 id="the-types">The types</h2>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                column_type
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Semantic meaning
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Typical pipeline stages that target it
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>backlog</code>
              </td>
              <td className="py-3 pr-4">
                Unstarted work. Usually unassigned, sometimes untriaged. The
                source of truth for "what could be done next."
              </td>
              <td className="py-3 pr-4">
                Architect stages (<code>plan_work</code>, <code>sprint</code>),
                triage, decomposition.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>active</code>
              </td>
              <td className="py-3 pr-4">
                In-progress work. A runner has claimed a card here (or will).
                Also the destination of "start work" transitions.
              </td>
              <td className="py-3 pr-4">
                Implementer stages (<code>implement</code>,{" "}
                <code>implement_after_approval</code>), pickup.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>review</code>
              </td>
              <td className="py-3 pr-4">
                Work awaiting evaluation. A reviewer role looks here for
                cards to pull and verdict on.
              </td>
              <td className="py-3 pr-4">
                Reviewer stages, rework mediation, documentator walks.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>done</code>
              </td>
              <td className="py-3 pr-4">
                Terminal success. Cards land here after a ship. Documentator
                stages often sweep this column for post-merge notes.
              </td>
              <td className="py-3 pr-4">
                Documentator, post-ship hooks.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>blocked</code>
              </td>
              <td className="py-3 pr-4">
                Work that can't progress — missing dependency, external wait,
                failed sensor. Rarely a destination; usually where a stage
                moves a card when <code>on_failure</code> fires.
              </td>
              <td className="py-3 pr-4">
                Failure paths, sensor rejections, manual operator moves.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ImportantNote title="The type is the contract, the name is cosmetic">
        Pipeline <code>discover</code> strategies and{" "}
        <code>on_success</code> / <code>on_failure</code> actions reference{" "}
        <code>column_type</code>, never <code>column_name</code>. A column
        named "Peer Review" with type <code>review</code> and a column named
        "Review" with type <code>review</code> are indistinguishable to a
        pipeline stage. Two columns sharing a type is supported — stages match
        all of them. A column with no type (<code>null</code>) is invisible to
        type-matching stages.
      </ImportantNote>

      <h2 id="consequences">Practical consequences</h2>
      <ul>
        <li>
          You can have multiple <code>backlog</code> columns (e.g., "Ideas"
          and "Next Sprint") and a single architect stage will treat them as
          one pool.
        </li>
        <li>
          Renaming "Done" to "Shipped" changes what the board looks like, not
          what the documentator stage discovers.
        </li>
        <li>
          Dropping a column's type to <code>null</code> removes it from
          pipeline scope without deleting its cards — useful for staging a
          column out of rotation.
        </li>
        <li>
          Adding a new column-type value is a backend change (enum +
          migration), not a configuration change. The current five cover the
          kanban idioms we've needed.
        </li>
      </ul>
    </SectionPage>
  );
}
