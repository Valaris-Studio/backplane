// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: runner/internal/forge, runner/internal/forge/registry,
// runner/internal/config/config.go, backend/app/services/git, and
// backend/app/services/merge_executor.py.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  WhatThisIsNot,
} from "../callouts";

export function ExtendingIntegratingANewGitHost() {
  return (
    <SectionPage
      title="Integrating a New Git Host"
      eyebrow="Extending Backplane"
    >
      <p>
        The Runner no longer hard-wires every PR operation to{" "}
        <code>git.Manager</code>. A provider-neutral{" "}
        <code>forge.Provider</code> interface now owns change creation, review,
        comments, status, merge, branch protection, and open-change queries.
        Backplane ships GitHub and Gitea/Forgejo drivers today. A GitLab driver
        is not implemented.
      </p>
      <p>
        Plain git remains separate. Clone, fetch, checkout, commit, rebase, and
        push stay in the git layer because those operations are already
        host-neutral. The forge interface covers only the API or CLI surface a
        code host adds around a repository.
      </p>

      <span id="todays-surface" />
      <span id="proposed-interface" />
      <h2 id="implemented-interface">Implemented interface</h2>
      <CodeExample language="go" title="Current forge.Provider contract">
        {`type Provider interface {
    Kind() string
    OpenChange(ctx context.Context, repoDir string, in OpenChangeInput) (string, error)
    Review(ctx context.Context, repoDir, changeURL string, decision ReviewDecision, body string) error
    CommentOn(ctx context.Context, repoDir, changeURL, body string) error
    ChangeStatusFor(ctx context.Context, repoDir, changeURL string) (ChangeStatus, error)
    ListOpenChanges(ctx context.Context, repoDir, repoSlug string) ([]ChangeFiles, error)
    CurrentChangeForBranch(ctx context.Context, repoDir, branch string) (string, error)
    TargetBranchFor(ctx context.Context, repoDir, changeURL string) (string, error)
    Merge(ctx context.Context, repoDir, changeURL string, strategy MergeStrategy) error
    EnsureBranchProtection(ctx context.Context, repoDir, branch string) error
}`}
      </CodeExample>
      <p>
        The neutral vocabulary calls a pull request or merge request a{" "}
        <code>Change</code>. Persisted database fields keep their existing{" "}
        <code>pr_*</code> names for compatibility. Merge strategies are the
        closed values <code>squash</code>, <code>rebase</code>, and{" "}
        <code>merge</code>; review decisions are <code>approve</code>,{" "}
        <code>request-changes</code>, and <code>comment</code>.
      </p>

      <h2 id="drivers-that-ship">Drivers that ship</h2>
      <ul>
        <li>
          <strong>GitHub</strong> wraps the existing <code>gh</code>-backed{" "}
          <code>git.Manager</code> methods. This preserves the established
          GitHub behavior behind the neutral interface.
        </li>
        <li>
          <strong>Gitea/Forgejo</strong> calls the Gitea v1 REST API. It uses{" "}
          <code>git.forge_base_url</code> and <code>git.forge_token</code>, and
          parses Gitea pull-request URLs for repository identity.
        </li>
      </ul>
      <p>
        <code>runner/internal/forge/registry.New</code> constructs exactly one
        driver from <code>git.forge</code> at Runner startup. Empty means{" "}
        <code>github</code>; <code>gitea</code> requires both its base URL and
        token; any other value returns an explicit startup error.
      </p>

      <ImportantNote title="Git credentials are a separate backend capability">
        Workspace PAT connections already support GitHub, GitLab, and Gitea.
        That does not mean all three have a Runner forge driver. Credentials
        answer “may this workspace authenticate to this host?”; a driver
        answers “can this Runner call this host&apos;s PR API?”
      </ImportantNote>

      <h2 id="adding-a-driver">Adding another Runner driver</h2>
      <ol>
        <li>
          Implement <code>forge.Provider</code> in a provider-specific package
          under <code>runner/internal/forge</code>.
        </li>
        <li>
          Map neutral decisions, statuses, merge strategies, and change fields
          at the driver edge. Do not leak provider-specific response types into
          the base interface.
        </li>
        <li>
          Register the new <code>git.forge</code> value in{" "}
          <code>runner/internal/forge/registry</code> and validate every
          provider-specific credential or base-URL requirement.
        </li>
        <li>
          Add an injectable client seam and hermetic tests for request shape,
          response mapping, invalid values, authentication errors, and idempotent
          change creation.
        </li>
        <li>
          Update <code>runner/configs/runner.example.yaml</code> and the
          configuration drift tests in the same change.
        </li>
      </ol>

      <span id="integration-surface" />
      <h2 id="gitlab-boundary">Current GitLab boundary</h2>
      <p>
        GitLab tokens can be probed, encrypted, host-matched, bound to a
        repository, and used by the backend merge queue for authenticated git
        operations. The queue&apos;s non-GitHub path rebases and fast-forwards
        through plain git. What is missing is a native Runner driver for merge
        requests, reviews, status rollups, and branch protection, plus a GitLab
        repository-picker adapter.
      </p>

      <WhatThisIsNot title="A forge driver does not normalize webhooks">
        <p>
          <code>forge.Provider</code> covers outbound Runner operations. It
          does not normalize inbound webhook payloads, and it does not add a
          backend repository picker. Those are separate provider surfaces that
          must be implemented and tested independently.
        </p>
      </WhatThisIsNot>

      <HonestRemark title="The Gitea driver has fixture coverage, not broad live certification">
        The driver is unit-tested through an injected HTTP client against the
        documented Gitea v1 shapes. The source explicitly records that it has
        not yet been exercised against a live matrix of Gitea and Forgejo
        versions. Treat a new deployment as an integration test, especially
        around review events and mergeability responses.
      </HonestRemark>
    </SectionPage>
  );
}
