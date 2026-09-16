// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against backend/app/services/skills/skill_service.py
// (limits, frontmatter, hashes, archive semantics), runner/internal/workloop/
// kind_skills_setup.go + skills_materialize.go (materialization contract),
// runner/internal/llm/skills_locator.go (provider discovery paths), and
// mcp-server/src/valaris_mcp/tools/skills.py (the MCP surface).

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  FutureState,
  HonestRemark,
  ImportantNote,
  ProTip,
} from "../callouts";

export function CoreConceptsSkills() {
  return (
    <SectionPage title="Skills" eyebrow="Core Concepts">
      <p>
        A <strong>skill</strong> is a versioned bundle of procedural knowledge
        — a method, a checklist, a set of conventions — that boards teach to
        the agents working on them. Each bundle is a <code>SKILL.md</code>{" "}
        manifest plus optional text support files. The manifest opens with YAML
        frontmatter whose <code>name</code> and <code>description</code> are
        authoritative for the skill&apos;s identity, and whose{" "}
        <code>toolsets:</code> names the hand the skill plays in — the toolset
        ids its guidance assumes are loaded; the body is plain markdown, the
        same open convention coding agents already discover in project
        directories. The platform stores every file verbatim — it never
        parses, rewrites, or summarizes a skill body.
      </p>

      <CodeExample language="markdown" title="A minimal SKILL.md">
        {`---
name: release-checklist
description: How to cut a release without missing the changelog or the tag.
toolsets: [cards, notes]
---

# Release checklist

1. Update CHANGELOG.md — every merged PR since the last tag.
2. Run the verification script with \`bash scripts/verify.sh\`
   (never \`./scripts/verify.sh\` — materialized files are not executable).
3. Tag, push, and paste the verification output into the release card.`}
      </CodeExample>

      <h2 id="library-and-catalog">Library and catalog</h2>
      <p>
        Skills live in the <strong>workspace library</strong>. They get there
        three ways: a human authors one on the Skills page, a human activates
        one from the built-in <strong>catalog</strong> of platform-curated
        skills, or an agent proposes one and a human approves it. Activation
        copies the catalog entry into the library as an independent published
        v1 — from that moment it is workspace content, versioned like any
        other skill, with no link back to the catalog entry it came from.
      </p>
      <p>
        Retiring a skill is a <strong>soft archive</strong>, never a delete. An
        archived skill keeps serving the boards already bound to it — a
        working pipeline does not change behavior because someone tidied the
        library — but it blocks new bindings and new proposals until
        unarchived.
      </p>

      <h2 id="versions-and-bindings">Versions and bindings</h2>
      <p>
        Versions are integers, each carrying a content hash over the
        bundle&apos;s files. A published version is immutable: fixing a typo
        means publishing the next version, and the hash is what lets you prove
        byte-for-byte which method an agent was given. Drafts and pending
        proposals exist alongside published versions but are never served.
      </p>
      <p>
        A board&apos;s relationship to a skill is deliberately tri-state:{" "}
        <strong>unbound</strong> — the default, the skill does not reach the
        board; <strong>bound but disabled</strong> — the binding and its
        configuration are kept, nothing is served; and{" "}
        <strong>bound and enabled</strong>. An enabled binding may pin a
        specific version; an unpinned binding tracks the latest published
        version automatically.
      </p>
      <p>
        The board&apos;s <em>effective set</em> — what agents actually receive
        — resolves from three rules: enabled bindings only; the pinned version
        when pinned, otherwise the latest published version; and a binding
        whose skill has nothing published yet (draft-only) simply drops out.
      </p>

      <h2 id="how-skills-reach-agents">How skills reach agents</h2>
      <p>
        The runner <strong>pre-materializes</strong> the board&apos;s
        effective set into the working tree before the LLM launches, at each
        coding agent&apos;s own discovery path —{" "}
        <code>{"<repo>"}/.claude/skills/</code> for Claude Code,{" "}
        <code>{"<repo>"}/.codex/skills/</code> for Codex. Files are written
        verbatim; the agent finds them the way it finds any project-local
        skill. Nothing is spliced into a prompt, and the runner has no opinion
        about what a skill says.
      </p>
      <p>
        In a pipeline, that copy happens in the <code>skills_setup</code>{" "}
        lifecycle step — after <code>git_setup</code>, because it needs the
        clone, and before the <code>llm</code> step, because the agent must
        see the files at launch. In{" "}
        <a href="../documentation/loop-mode">loop mode</a> no step is needed:
        the effective set is re-fetched at the top of every iteration, so a
        newly bound skill or version change is live on the next iteration
        with no restart. One asymmetry to know: unbinding a skill mid-run
        stops its updates but leaves the already-materialized files in the
        loop working directory — materialization only ever adds today.
      </p>
      <ImportantNote title="Stored pipelines predating skills need the step added">
        A pipeline config saved before the skills registry existed has no{" "}
        <code>skills_setup</code> step, and the platform does not inject one.
        Bind all the skills you want — nothing materializes until you add the
        step to each role&apos;s lifecycle in the{" "}
        <a href="../documentation/pipeline-builder">pipeline builder</a>.
      </ImportantNote>
      <p>
        Materialized skills never land in diffs or PRs. The runner appends the
        skills directory to <code>.git/info/exclude</code> before writing the
        first file, refuses to overwrite any path the repository already
        tracks, and removes exactly the directories it wrote during cleanup —
        a skill leaking into a commit would put workspace content into a
        customer PR.
      </p>
      <p>
        Interactive and MCP-connected agents skip materialization entirely:{" "}
        <code>list_skills</code> returns the workspace library — or, with a
        board id, that board&apos;s effective set — and <code>get_skill</code>{" "}
        returns full file contents.
      </p>

      <h2 id="toolsets-enforce-skills-guide">Toolsets enforce, skills guide</h2>
      <p>
        No client can scope an MCP listing from a skill. A skill&apos;s{" "}
        <code>allowed-tools</code> is a pre-approval hint some agents honour;
        it never removes a tool from what the server lists. The toolset is
        what the server lists and allows: <code>VALARIS_MCP_TOOLSETS</code>{" "}
        decides the hand, and a tool outside it cannot be listed or called —
        see the <a href="../documentation/mcp-toolsets">MCP Toolsets</a>{" "}
        reference.
      </p>
      <p>
        A skill declares the hand it plays in. <code>toolsets:</code> in the
        frontmatter names the toolset ids the playbook was written for, so a
        reader — and the platform — can tell whether the guidance and the
        session&apos;s hand agree. The platform warns in two places: the
        library flags a playbook that names tools outside its declared
        toolsets, and the board settings flag a bound skill whose toolsets
        the board&apos;s loop grant does not cover. Neither warning changes
        what is served.
      </p>
      <p>
        The runner never parses <code>SKILL.md</code>. It materializes the
        files verbatim; the declaration is validated when a version is stored
        and read from SKILL.md whenever the skill is served, shown to people,
        never enforced on an agent.
      </p>

      <p>
        propose_skill requires a runner-bound key. An interactive AI using a
        human key receives 403; prepare its bundle for an authorized human workspace admin to create a
        draft and publish in the workspace Skills Library. There is no MCP
        draft-authoring tool. Runner proposals still require human approval
        before publication.
      </p>

      <h2 id="the-self-improvement-loop">The self-improvement loop</h2>
      <p>
        Skills are the platform&apos;s mechanism for compounding what agents
        learn. The loop runs like this: a runner-bound agent works a card and, along the
        way, works out something durable — a debugging method that actually
        found the bug, a migration recipe that survived review, a convention
        the codebase enforces the hard way. Instead of letting that die with
        the session, the agent distills the method into a bundle and calls{" "}
        <code>propose_skill</code>.
      </p>
      <p>
        The proposal opens a scored request in the{" "}
        <a href="../documentation/approvals">approvals queue</a> under the{" "}
        <code>skill_publication</code> category, base risk 60 — far above the
        auto-approve threshold, by design, because skill content steers every
        future agent session that receives it. It can never auto-approve. A
        human reads the actual proposed files, and approving is the act that
        publishes the version. From then on, every future run on every board
        bound to that skill receives the distilled method. Rejecting keeps the
        currently published version — or nothing — in place.
      </p>
      <p>
        <strong>Agents propose; humans decide what is published.</strong> That
        split is the whole design: the flywheel spins as fast as agents learn,
        but the knowledge that steers future sessions only changes with a
        human&apos;s name on the decision.
      </p>
      <p>
        Loops opt in per board: <code>skills_proposal_enabled</code> in the
        board&apos;s loop config — on by default — exposes the proposal tool
        to loop sessions. Switch it off for boards whose loops should consume
        skills but never suggest new ones.
      </p>
      <ProTip title="Tell the prompt what qualifies as a skill">
        The proposals worth approving are methodologies — reusable procedure
        that would help a different agent on a different card next month. If
        your loop prompt asks for skill proposals, say what does not qualify:
        status updates, card-specific context, and anything the board
        definition already covers belong on the board, not in the library.
      </ProTip>

      <h2 id="scope-and-roadmap">Scope and roadmap</h2>
      <p>
        Skills are <strong>text-only</strong> bundles today, with hard limits:
        at most 32 files, 64 KiB per file, 512 KiB per bundle. No binaries and
        no executable bit — every file materializes as a plain{" "}
        <code>0644</code> file. A skill that ships a helper script must
        therefore instruct the agent to invoke it through an interpreter —{" "}
        <code>bash scripts/check.sh</code>, never{" "}
        <code>./scripts/check.sh</code>.
      </p>
      <HonestRemark title="Text-only is a real constraint, not a footnote">
        A methodology that depends on a reference image, a binary fixture, or
        a large dataset cannot ship as a skill yet. The limits are deliberate:
        a skill is meant to be a method an agent reads, not an artifact
        pipeline — and every byte of it is reviewed by a human before it
        publishes, which only works while bundles stay small and readable.
      </HonestRemark>
      <FutureState title="Richer ingest is on the roadmap">
        Binary assets referenced as media rather than inlined, and per-file
        modes so a bundled script can be executable, are both on the roadmap.
        Until then, the interpreter-invocation convention above is the
        supported path.
      </FutureState>
    </SectionPage>
  );
}
