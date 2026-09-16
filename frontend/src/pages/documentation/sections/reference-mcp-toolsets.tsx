// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every toolset id, group, count, exclusion, and inclusion below comes from
// mcp-reference/data/server-surface.json (exported by
// mcp-server/scripts/export-tool-catalog.py). Never type a count or an id
// into prose: a numeral inside a translatable string mints a new translation
// key on every server release and drops the whole section to English
// fallback, and an id typed by hand drifts the moment the default hand moves.

import { Fragment } from "react";
import { getServerSurface } from "../mcp-reference/data";
import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote } from "../callouts";

const HEADER_CLASS =
  "text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4";
const ROW_CLASS = "border-b border-border align-top";
const CELL_CLASS = "py-3 pr-4";

// Rendered only while server-surface.json carries at least one deprecated
// alias; registered as conditional strings so the translations survive an
// empty map (same rule as the empty catalog summaries).
export const MCP_TOOLSETS_DEPRECATED_ALIASES_STRINGS = [
  "Deprecated aliases",
  "These names still answer for one more minor version, but they are no longer part of the documented surface and no toolset lists them. Move to the replacement before the release that removes them.",
  "Alias",
  "Replacement",
  "Removed in",
] as const;
const [
  DEPRECATED_ALIASES_TITLE,
  DEPRECATED_ALIASES_LEAD,
  DEPRECATED_ALIAS_HEADER,
  DEPRECATED_REPLACEMENT_HEADER,
  DEPRECATED_REMOVED_IN_HEADER,
] = MCP_TOOLSETS_DEPRECATED_ALIASES_STRINGS;

export function ReferenceMcpToolsets() {
  const surface = getServerSurface();
  const toolsets = surface.toolsets ?? [];
  const defaultToolset = surface.default_toolset;
  const defaultIds = defaultToolset?.ids ?? [];
  const optInGroupIds = toolsets
    .filter(({ kind, id }) => kind === "group" && !defaultIds.includes(id))
    .map(({ id }) => id);
  const exclusions = Object.entries(defaultToolset?.exclusions ?? {});
  const inclusions = Object.entries(defaultToolset?.inclusions ?? {});
  const defaultHandSize = defaultToolset?.tools.length ?? 0;
  const deprecatedAliases = Object.entries(surface.deprecated ?? {});

  return (
    <SectionPage title="MCP Toolsets" eyebrow="MCP Reference">
      <p>
        A toolset is a named slice of the MCP surface. Every group and every
        category of the tool catalog is one, addressed by its id, and the
        server lists and serves only the tools in the toolsets you load. A tool
        that is not listed cannot be called either, so the model never sees a
        name it may not use.
      </p>
      <p>
        A <a href="../documentation/skills">skill</a> declares the toolsets its
        playbook plays in; that declaration is guidance, and only the loaded
        toolsets enforce.
      </p>

      <h2 id="env-contract">The env contract</h2>
      <p>
        <code>VALARIS_MCP_TOOLSETS</code> is read once when the MCP server
        starts. Unset or empty it means <code>default</code>, the interactive
        hand described below. <code>all</code> loads every tool. Anything else
        is a comma-separated list of toolset ids; <code>default</code> may
        appear in that list and expands to the default hand. Ids are
        case-sensitive and whitespace around the commas is ignored.
      </p>
      <ImportantNote title="Unknown ids fail closed">
        An id that is not a group id, a category id, <code>all</code>, or{" "}
        <code>default</code> stops the server at startup with an error naming
        the offending ids and the valid ones. A typo never silently disables
        the gate.
      </ImportantNote>

      <h2 id="default-hand">The default hand</h2>
      <p>
        Unless told otherwise the server serves the interactive default hand:
        the union of these group toolsets minus a short exclusion list, plus a
        short inclusion list of read-only helpers from the other groups. It
        currently resolves to {defaultHandSize} tools.
      </p>
      <p>
        Groups in the default hand:{" "}
        {defaultIds.map((id, index) => (
          <Fragment key={id}>
            {index > 0 ? ", " : null}
            <code>{id}</code>
          </Fragment>
        ))}
      </p>
      <p>
        Excluded from it, even though their group is loaded:
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={HEADER_CLASS}>Tool</th>
              <th className={HEADER_CLASS}>Why it is excluded</th>
            </tr>
          </thead>
          <tbody>
            {exclusions.map(([name, reason]) => (
              <tr key={name} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <code>{name}</code>
                </td>
                <td className={CELL_CLASS}>{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Pulled into it from groups the default hand does not load:
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={HEADER_CLASS}>Tool</th>
              <th className={HEADER_CLASS}>Why it is included</th>
            </tr>
          </thead>
          <tbody>
            {inclusions.map(([name, reason]) => (
              <tr key={name} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <code>{name}</code>
                </td>
                <td className={CELL_CLASS}>{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        The other groups are opt-in:{" "}
        {optInGroupIds.map((id, index) => (
          <Fragment key={id}>
            {index > 0 ? ", " : null}
            <code>{id}</code>
          </Fragment>
        ))}
        . Add them to the list when the session needs workspace setup or
        runner administration.
      </p>

      <h2 id="available-toolsets">Available toolsets</h2>
      <p>
        One row per toolset. Group ids are slugified from the group titles of
        the tool catalog; category ids are the catalog's own.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={HEADER_CLASS}>Toolset</th>
              <th className={HEADER_CLASS}>Kind</th>
              <th className={HEADER_CLASS}>Title</th>
              <th className={HEADER_CLASS}>Group</th>
              <th className={HEADER_CLASS}>Tools</th>
            </tr>
          </thead>
          <tbody>
            {toolsets.map((toolset) => (
              <tr key={toolset.id} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <code>{toolset.id}</code>
                </td>
                <td className={CELL_CLASS}>
                  {toolset.kind === "group" ? "Group" : "Category"}
                </td>
                <td className={CELL_CLASS}>{toolset.title}</td>
                <td className={CELL_CLASS}>{toolset.group}</td>
                {/* Leading space: without it the count's text run glues to
                    the group title ("Start here6") in copy/paste and
                    screen-reader output. */}
                <td className={CELL_CLASS}>{` ${toolset.tools.length}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deprecatedAliases.length > 0 ? (
        <>
          <h2 id="deprecated-aliases">{DEPRECATED_ALIASES_TITLE}</h2>
          <p>{DEPRECATED_ALIASES_LEAD}</p>
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={HEADER_CLASS}>{DEPRECATED_ALIAS_HEADER}</th>
                  <th className={HEADER_CLASS}>{DEPRECATED_REPLACEMENT_HEADER}</th>
                  <th className={HEADER_CLASS}>{DEPRECATED_REMOVED_IN_HEADER}</th>
                </tr>
              </thead>
              <tbody>
                {deprecatedAliases.map(([name, { replacement, removed_in }]) => (
                  <tr key={name} className={ROW_CLASS}>
                    <td className={CELL_CLASS}>
                      <code>{name}</code>
                    </td>
                    <td className={CELL_CLASS}>{replacement}</td>
                    <td className={CELL_CLASS}>
                      <code>{removed_in}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 id="examples">Examples</h2>
      <ul>
        <li>
          Everyday project work: default keeps the interactive catalog compact.
        </li>
      <li>Loops and runners:{" "}<code>default,autonomous-operations</code> is for an interactive human connection to prepare and manage loops.</li>
        <li>
          Everything: all is an explicit opt-in to a larger catalog that may
          exceed client tool limits.
        </li>
      </ul>
      <p>
        Presets are starting selections. Preserve custom toolset compositions
        and existing credentials. Actual autonomous runner launches use all
        intersected with their authorized allowlist; do not replace that
        execution configuration with the interactive loops preset.
      </p>

      <ul>
        <li>
          <code>all</code> loads every tool. This is what runner launches pin.
        </li>
        <li>
          <code>default</code> loads the interactive hand, the same as leaving
          the variable unset.
        </li>
        <li>
          <code>default,autonomous-operations</code> loads the interactive hand
          plus one whole opt-in group.
        </li>
        <li>
          <code>cards,notes</code> loads just those two categories, for a
          session that only edits cards and notes.
        </li>
      </ul>

      <h2 id="composition">Composition with the allowlist</h2>
      <p>
        <code>VALARIS_MCP_ALLOWLIST</code> and{" "}
        <code>VALARIS_MCP_TOOLSETS</code> are independent gates, and the served
        hand is their intersection: a tool must be in a loaded toolset and, when
        an allowlist is set, on that allowlist to be listed or called. Neither
        variable can widen what the other narrowed.
      </p>
      <p>
        Runners pin <code>all</code>. The stage allowlist a runner receives
        from the backend is meant to be the only narrowing, so the runner's
        generated MCP config always sets <code>VALARIS_MCP_TOOLSETS</code> to{" "}
        <code>all</code>; a default-hand template would clip a stage grant
        twice.
      </p>

      <h2 id="discovery">Discovery from inside a session</h2>
      <p>
        <code>get_server_info</code> reports which toolsets are loaded, how
        many tools resolved, what the default hand is, every id that exists,
        and a hint on how to widen the hand. A denied call to a tool outside
        the loaded toolsets names the loaded ids in its error, so the model can
        ask for a wider hand instead of guessing.
      </p>
      <p>
        <code>VALARIS_MCP_TOOLSETS</code> picks the initial hand;{" "}
        <code>enable_toolsets</code> widens a running session by adding
        toolsets, and the server then sends{" "}
        <code>tools/list_changed</code> to request a client refresh; delivery
        does not prove the agent received new tools. Widening is one-way and
        not persisted. If tools remain absent, use the returned restart_env in
        the MCP server startup configuration, restart the server/connection
        and start a new agent session. For remote HTTP, the server operator
        must update that environment. Keep the runner allowlist unchanged.
      </p>
      <p>
        Use the exact returned restart_env for recovery: it preserves every
        enabled group, including custom toolsets. Keep existing credentials and
        VALARIS_MCP_ALLOWLIST unchanged. The following fresh connection example
        is for interactive loops; it must not replace a wider recovered
        selection.
      </p>
      <CodeExample language="bash" title="Remote MCP service startup environment">
        {`MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
VALARIS_MCP_TOOLSETS=default,autonomous-operations`}
      </CodeExample>
      <p>
        The remote operator applies these values to the actual MCP service
        startup environment, retains the existing API/authentication
        configuration, and protects the endpoint behind authenticated access or
        a trusted private network. MCP_HOST=0.0.0.0 is a bind address, not
        access control. Local client environment cannot change a remote service.
      </p>
      <p>
        Restart the MCP server/connection, then start a fresh agent session and
        repeat the read-only native checks. A new chat alone may reuse a stale
        server or cached catalog. Repeating enable_toolsets cannot force a
        client refresh. If a tool is still missing, check the running version,
        startup toolsets and authorized allowlist before changing configuration.
      </p>
    </SectionPage>
  );
}
