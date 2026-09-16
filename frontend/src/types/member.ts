// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceMember {
  user_id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joined_at: string;
}

export interface AddMemberRequest {
  email: string;
  role: WorkspaceRole;
  // Applied by the backend only when the account has no password yet.
  initial_password?: string;
}

export interface UpdateMemberRoleRequest {
  role: WorkspaceRole;
}
