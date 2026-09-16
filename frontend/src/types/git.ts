// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type GitProvider =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "other";

export type GitConnectionAccountType = "user" | "organization";

// How the credential was obtained. OAuth connections come from the GitHub
// redirect dance; PATs are pasted by an admin and probed before they're stored.
export type GitConnectionAuthKind = "oauth" | "pat";

// Backend never returns the token in this payload — only the metadata the UI
// needs to display + identify the connection. Tokens stay server-side.
export interface GitConnection {
  id: string;
  workspace_id: string;
  provider: GitProvider;
  account_login: string;
  account_type: GitConnectionAccountType;
  auth_kind: GitConnectionAuthKind;
  scopes: string[];
  expires_at: string | null;
  base_url: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  // Whether the last probe substantiated the scopes the platform needs.
  // null means no probe has ever assessed the row, which is not the same
  // claim as false ("we looked and could not confirm").
  scopes_confirmed: boolean | null;
  connected_by: string;
  created_at: string;
  updated_at: string;
}

// One duty the platform needs the credential to perform. `ok: false` is a
// health report, not a transport error — verify returns 200 either way.
export interface GitConnectionCheck {
  name: string;
  ok: boolean;
  guidance: string;
}

export interface GitConnectionVerifyResult {
  connection: GitConnection;
  checks: GitConnectionCheck[];
}

export interface GitConnectionPatCreate {
  provider: GitProvider;
  token: string;
  // Required for gitea (no default host to match against), optional elsewhere
  // to point at a self-hosted install.
  base_url?: string;
}

export interface GitConnectionRepository {
  provider: GitProvider;
  // Provider-native id — for github this is "owner/repo".
  id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  clone_url_https: string;
  updated_at: string;
}

export interface GitConnectionRepositoryPage {
  items: GitConnectionRepository[];
  next_cursor: string | null;
}

export interface GitRepo {
  id: string;
  // Null until backfill migration runs in every environment.
  slug: string | null;
  board_id: string;
  workspace_id: string;
  name: string;
  url: string;
  provider: GitProvider;
  default_branch: string;
  // PAR-1: optional staging branch parallel runners base new work on.
  // Null means "use default_branch" — preserves pre-PAR-1 behavior.
  integration_branch: string | null;
  // Which workspace credential authenticates against this repo. Null falls
  // back to the platform-wide token.
  connection_id: string | null;
  description: string;
  added_by: string;
  created_at: string;
  updated_at: string;
}
