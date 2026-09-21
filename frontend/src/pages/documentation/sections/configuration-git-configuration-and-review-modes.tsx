// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: backend/app/models/git, backend/app/services/git,
// backend/app/services/merge_executor.py, runner/internal/forge,
// runner/internal/workloop/kind_merge_pr.go, and runner/configs/runner.example.yaml.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  WhatThisIsNot,
} from "../callouts";

export function ConfigurationGitConfigurationAndReviewModes() {
  return (
    <SectionPage
      title="Git Configuration and Review Modes"
      eyebrow="Configuration"
    >
      <p>
        Backplane separates three concerns that used to be described as one
        GitHub-only path: repository metadata on the board, encrypted workspace
        credentials, and the forge driver or merge executor that performs PR
        operations. A provider value alone does not grant access or select a
        credential.
      </p>

      <h2 id="repository-record">Repository record</h2>
      <p>
        A board&apos;s <code>GitRepo</code> row carries the remote URL, provider,
        default and optional integration branches, a board-unique slug, policy,
        and an optional <code>connection_id</code>. The backend accepts five
        provider identifiers; executable capabilities differ by provider and
        path.
      </p>

      <CodeExample language="python" title="The GitRepo model (trimmed)">
        {`class GitProvider(str, enum.Enum):
    github = "github"
    gitlab = "gitlab"
    bitbucket = "bitbucket"
    gitea = "gitea"
    other = "other"

class GitRepo(Base, UUIDMixin, TimestampMixin):
    board_id: UUID
    workspace_id: UUID
    name: str
    slug: str
    url: str
    provider: GitProvider
    default_branch: str = "main"
    integration_branch: str | None
    require_branch_protection: bool = True
    connection_id: UUID | None`}
      </CodeExample>

      <h2 id="workspace-credentials">Workspace credentials</h2>
      <p>
        Workspace administrators can connect GitHub, GitLab, and Gitea with a
        personal access token. GitHub also has an OAuth connection flow. The
        backend probes the token against the selected forge before storing it,
        derives the account identity from the forge response, encrypts the
        token at rest, and never returns the token in read responses.
      </p>
      <p>
        GitHub defaults to <code>https://api.github.com</code> and GitLab defaults
        to <code>https://gitlab.com</code>; either may receive an optional{" "}
        <code>base_url</code> for a self-hosted installation. Gitea requires a{" "}
        <code>base_url</code> because there is no canonical Gitea host.
        Bitbucket appears in the provider model, but token verification is not
        implemented and the connection dialog disables submission for it.
      </p>
      <p>
        A repository may bind one credential explicitly through{" "}
        <code>connection_id</code>. Without a binding, the resolver may use the
        workspace&apos;s only connection for that provider; multiple candidates
        are treated as ambiguous. Every resolved credential is host-checked
        against the repository URL before it can be inserted into a clone URL.
      </p>
      <p>
        Connections are managed under Git Connections in Workspace Settings.
        Workspace administrators add, verify, and remove them; other members
        see the provider, the account, and the connection health, but never
        the token.
      </p>
      <p>
        The Verify action re-runs the probe and reports named checks with
        guidance. <code>identity</code> confirms that the forge recognized the
        token and named the account. <code>scopes</code> appears only when the
        forge disclosed nothing about the token, which is normal for every
        GitHub fine-grained token; confirm the permissions by hand.{" "}
        <code>scope:repo</code> on GitHub and <code>scope:api</code> on GitLab
        confirm that the required classic-token scope is present.{" "}
        <code>ci-read</code> confirms that a GitHub token can read CI state
        from Actions runs. A successful Verify clears any recorded error; a
        failure records it and the panel shows the connection as unhealthy.
        Health is also written from production use: a 401 or 403 during a
        merge, a Done-gate check, or a reconciler pass marks the connection
        unhealthy with the real error, and a later successful use clears it.
      </p>
      <p>
        For every backend operation the credential is resolved in order: the
        connection the repository is bound to, then the workspace&apos;s only
        connection for that provider, then the platform token from the
        deployment environment such as <code>GITHUB_TOKEN</code>, then none.
        At every step the credential is used only when the repository host
        matches the host it was issued for. Storing any connection requires{" "}
        <code>INTEGRATIONS_TOKEN_KEY</code>, the Fernet key that encrypts
        tokens at rest; when it is unset the Add token action is disabled and
        the API answers 503. Setting <code>ALLOW_GLOBAL_TOKEN_FALLBACK</code> to{" "}
        <code>false</code> removes the platform-token step, which is the
        posture for a multi-tenant deployment. Both are listed in the{" "}
        <a href="../documentation/environment-variables">
          environment variables reference
        </a>
        .
      </p>

      <ImportantNote title="Connections and Runner forge drivers are different layers">
        A GitLab credential is real and can authenticate clone, push, and the
        backend merge queue even though the Runner has no GitLab forge driver.
        Conversely, selecting <code>provider: gitea</code> on a repository does
        not dynamically rebuild a Runner. Each Runner constructs one configured
        forge driver at startup.
      </ImportantNote>

      <p>Credentials belong to the workspace; repositories bind to a matching provider credential on the board.</p>

      <span id="branch-prefix-and-safety" />
      <h2 id="runner-forge">Runner forge configuration</h2>
      <p>
        The Runner builds a <code>forge.Provider</code> from{" "}
        <code>git.forge</code> at startup. It ships GitHub and Gitea/Forgejo
        drivers. The GitHub driver wraps the existing <code>gh</code> CLI; the
        Gitea driver calls the Gitea REST API and requires{" "}
        <code>git.forge_base_url</code> plus <code>git.forge_token</code>.
        An empty <code>git.forge</code> defaults to <code>github</code> for
        backward compatibility, and an unknown value fails startup.
      </p>

      <CodeExample language="yaml" title="Runner forge selection">
        {`git:
  forge: "gitea"
  forge_base_url: "https://git.example.com"
  forge_token: "<gitea-access-token>"
  merge_strategy: "squash"
  review_on_github: true
  review_mode: "platform"`}
      </CodeExample>

      <h2 id="review-mode">Review mode</h2>
      <p>
        <code>review_on_github</code> is the historical switch that enables the{" "}
        <code>post_pr_review</code> lifecycle step. Despite the field name, the
        step now calls the configured <code>forge.Provider</code>.{" "}
        <code>review_mode: platform</code> posts a comment and is the default;
        <code>review_mode: github</code> posts a formal forge review. The latter
        name is also historical and a single GitHub identity still cannot
        approve its own PR.
      </p>

      <span id="merge-trigger" />
      <h2 id="merge-path">Merge path</h2>
      <p>
        The active merge happens only when an approved lifecycle branch reaches
        a <code>merge_pr</code> step. That handler reads the top-level{" "}
        <code>pipeline_config.merge_via_queue</code> flag. When the flag is{" "}
        <code>false</code> or absent, the Runner asks its configured forge
        driver to merge. When it is <code>true</code>, the Runner enqueues the
        PR for the backend merge worker.
      </p>
      <p>
        The backend queue resolves the repository&apos;s workspace credential,
        rebases the PR branch onto <code>integration_branch</code>, and merges
        only after its configured gate. GitHub uses the native{" "}
        <code>gh pr merge</code> path. Other providers use a provider-neutral
        fast-forward merge and push through plain git; that can leave the host&apos;s
        PR or MR open when the host does not infer closure from the branch.
      </p>

      <CodeExample language="json" title="Reviewer merge step and queue switch">
        {`{
  "version": 3,
  "merge_via_queue": true,
  "stages": [
    {
      "role": "reviewer",
      "lifecycle": [
        {
          "name": "merge_the_pr",
          "kind": "merge_pr",
          "params": { "strategy": "squash" },
          "on_failure": "merge_failed"
        },
        {
          "name": "merge_failed",
          "kind": "move_card",
          "params": { "to_column_type": "blocked" }
        }
      ]
    }
  ]
}`}
      </CodeExample>

      <span id="what-this-is-not" />
      <WhatThisIsNot title="Provider metadata is not a capability promise">
        <ul>
          <li>
            GitHub has a Runner forge driver, OAuth and PAT connections, native
            repository discovery, native PR merge, and GitHub CI inspection.
          </li>
          <li>
            Gitea/Forgejo has PAT connections and a Runner REST forge driver.
            Its driver is unit-tested against HTTP fixtures, not certified
            against every live Gitea or Forgejo version.
          </li>
          <li>
            GitLab has verified PAT connections and works through plain git and
            the backend queue&apos;s non-GitHub merge path. A native Runner GitLab
            forge driver and repository picker are not implemented.
          </li>
          <li>
            Bitbucket and <code>other</code> remain metadata values without a
            verified token connection or Runner forge driver.
          </li>
        </ul>
      </WhatThisIsNot>

      <HonestRemark title="Some public configuration names still say GitHub">
        <code>review_on_github</code> and the <code>github</code> review mode
        predate the forge abstraction. They remain wire-compatible names even
        where the implementation now dispatches through{" "}
        <code>forge.Provider</code>. Treat the identifiers as technical API,
        not as an up-to-date statement of provider scope.
      </HonestRemark>
    </SectionPage>
  );
}
