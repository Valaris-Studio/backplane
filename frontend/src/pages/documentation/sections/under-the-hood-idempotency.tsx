// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §7.1 and
// docs/research/backend-architecture.md §7.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark } from "../callouts";

export function UnderTheHoodIdempotency() {
  return (
    <SectionPage title="Idempotency and Why It Matters" eyebrow="Under the Hood">
      <p>
        Create and add endpoints return the existing entity on duplicate
        instead of raising <code>409 Conflict</code>. This is a correctness
        invariant, not a nicety. LLM retries, multi-role pipeline ticks, and
        frontend double-clicks all depend on it. An "already exists" result
        is a success, not an error — the requested end state is reached,
        regardless of how many times the request arrived.
      </p>
      <p>
        This principle is one of the things the platform gets asked about
        most by engineers who haven't spent time inside the system. It looks
        like a REST convention violation. It is not. When the primary
        operator of your API is a retry-happy LLM that will re-issue a
        request on any transient failure — network timeout, rate limit,
        partial response truncation — a 409 on the second call costs a tick
        and a token bill with no added information. The request succeeded
        the first time. The only correct behavior is to acknowledge the
        successful state.
      </p>

      <h2 id="the-pattern">The pattern</h2>
      <p>
        Every idempotent create in the service layer follows the same
        shape. Check for the existing entity by its business-unique key.
        If present, return it. Otherwise create, return the new row. One
        round-trip to the database in the hit case, two in the miss case.
        No 409 branch, no retry coordination needed at the caller.
      </p>

      <CodeExample
        language="python"
        title="The idempotent-create pattern, canonical shape"
      >
        {`async def create_workspace(
    self,
    name: str,
    slug: str,
    owner_id: UUID,
) -> Workspace:
    # Slug collision: idempotent only for MEMBERS of the existing
    # workspace — multi-agent pipelines may retry from two stages, and
    # both should win. A stranger gets an opaque 409: returning the row
    # would hand any authed caller workspace metadata by slug probe.
    existing = await self.workspace_repo.get_by_slug(slug)
    if existing is not None:
        membership = await self.member_repo.get_membership(
            existing.id, owner_id,
        )
        if membership is not None:
            return existing
        raise ConflictError(f"Workspace slug '{slug}' is already taken")

    workspace = await self.workspace_repo.create(
        Workspace(name=name, slug=slug),
    )
    await self.member_repo.create(
        WorkspaceMember(
            workspace_id=workspace.id,
            user_id=owner_id,
            role=WorkspaceRole.OWNER,
        ),
    )
    await self.activity_service.record(
        workspace_id=workspace.id,
        entity_type=ActivityEntityType.workspace,
        action=ActivityAction.created,
        actor_id=owner_id,
    )
    return workspace`}
      </CodeExample>

      <h2 id="where-applied">Where the pattern is applied</h2>
      <p>
        Every mutation where "this already exists" can be spelled as
        success gets the idempotent treatment. The list is specific, not
        aspirational:
      </p>
      <ul>
        <li>
          <strong>Workspace create.</strong>{" "}
          <code>WorkspaceService.create_workspace</code> — idempotent on
          slug for members of the existing workspace, who get it back
          unchanged. A non-member colliding on a taken slug gets an
          opaque 409 that leaks no workspace metadata.
        </li>
        <li>
          <strong>Board create.</strong>{" "}
          <code>BoardService.create_board</code> — idempotent on{" "}
          <code>(workspace_id, slug)</code>.
        </li>
        <li>
          <strong>Card create via slug.</strong> Cards posted with an
          explicit slug reconcile against the existing row if present.
        </li>
        <li>
          <strong>Add participant.</strong>{" "}
          <code>CardService.add_participant</code> — returns the card
          unchanged if the user is already a participant in that role.
        </li>
        <li>
          <strong>Add workspace member.</strong>{" "}
          <code>WorkspaceService.add_member</code> — returns the existing
          membership on duplicate.
        </li>
        <li>
          <strong>Create team.</strong>{" "}
          <code>TeamService.create_team</code> — idempotent on slug within
          the workspace.
        </li>
        <li>
          <strong>Add team member.</strong> Repeating an add overwrites
          the role list rather than conflicting.
        </li>
        <li>
          <strong>Create prompt config.</strong>{" "}
          <code>PromptConfigService.create_config</code> — idempotent on
          the full scope tuple{" "}
          <code>(workspace_id, team_id, team_role, stage, slug)</code>.
        </li>
        <li>
          <strong>Agent registration.</strong>{" "}
          <code>AgentService.create_agent</code> — idempotent on{" "}
          <code>(owner_id, name)</code>. Also reactivates soft-deleted
          runners.
        </li>
      </ul>

      <h2 id="where-deliberately-not">Where it is deliberately not idempotent</h2>
      <p>
        Three mutations refuse the idempotent treatment because the
        second caller is reporting a visible race that should fail loudly,
        not quietly.
      </p>
      <ul>
        <li>
          <strong>Claim card.</strong>{" "}
          <code>CardService.claim_card</code> issues{" "}
          <code>SELECT ... FOR UPDATE</code>, refuses the claim if a hero
          participant already exists, returns{" "}
          <code>409 already_claimed</code>. A second claim is two runners
          racing for the same card — the loser needs to know it lost, not
          silently believe it won.
        </li>
        <li>
          <strong>Hero reassign via add_participant.</strong> Adding a
          non-hero participant to a card with an existing hero is fine.
          Adding a <em>hero</em> to a card that already has a different
          hero returns <code>409 already_claimed</code>. Silently
          re-hosting the card would break every downstream consumer
          reading <code>hero_id</code>.
        </li>
        <li>
          <strong>Approval decide.</strong>{" "}
          <code>ApprovalService.decide</code> — re-deciding a non-pending
          approval returns 409. The terminal state transitions{" "}
          (<code>pending → approved</code>, <code>pending → rejected</code>,{" "}
          <code>pending → expired</code>) are one-way. A second decision
          means two humans both thought they were the decider and one of
          them needs to see the original verdict.
        </li>
      </ul>

      <h2 id="the-st3-anchor">The incident that anchored the rule</h2>
      <p>
        The idempotency principle has a specific origin: ST#3. A reviewer
        role was getting <code>409 already_exists</code> on re-adding
        itself as a card participant from a subsequent pipeline tick.
        Each 409 ate a tick. Across a full smoke run, the reviewer
        burned tokens to repeatedly rediscover that it was already on
        the card. The fix was not "add better retry logic at the caller"
        — the caller is an LLM, it already retries. The fix was "return
        the existing participant with a 200." Three hundred lines of
        runner-side retry coordination dissolved.
      </p>
      <p>
        Every idempotent endpoint since ST#3 has been written with that
        incident in mind. When a design review asks "should this 409 or
        return the existing row?" the answer is almost always the latter,
        and when it is the former — claim, hero reassign, approval decide
        — the reason is articulated in the service method's docstring.
      </p>

      <HonestRemark title="A few stragglers are on cleanup">
        Not every mutation the platform ships today honors the rule.
        Audit findings surface the occasional service path that still
        raises 409 when the caller would be better served by the existing
        row. <code>create_workspace</code> on the MCP side, specifically,
        does a pre-GET to detect duplicates rather than leaning on the
        backend contract — which is deliberately member-scoped: a member
        retrying a taken slug gets the existing workspace back, while a
        stranger gets an opaque 409 so slug collisions cannot harvest
        workspace metadata. Every new
        endpoint review includes the "is this idempotent, or is there a
        principled reason it isn't?" question on the checklist. Ask us
        how we know.
      </HonestRemark>

      <h2 id="why-it-matters-operationally">What this buys you</h2>
      <p>
        The observable effect of this rule is that an LLM retry loop
        does not compound. When a runner re-issues the same{" "}
        <code>add_card_participant</code> from four pipeline stages —
        because each stage independently decides it needs to be on the
        card — the cost is four cheap 200s instead of three 409s
        followed by bespoke error handling. When the frontend
        double-posts a card create because a user double-clicked the
        button, the second post returns the first card's row and the
        UI renders a single card rather than an error toast. When a
        webhook redelivery fires the same{" "}
        <code>create_team</code> twice, the team exists exactly once.
      </p>
      <p>
        None of these are large individually. Multiplied across every
        mutation an agentic platform executes, they are the difference
        between a system that tolerates its operators and one that
        fights them.
      </p>
    </SectionPage>
  );
}
