// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type SkillVersionStatus =
  | "draft"
  | "proposed"
  | "published"
  | "rejected"
  | "archived";

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  latest_published_version: number | null;
  // null for workspace-native skills, "catalog:{catalog_id}@{catalog_version}"
  // when written by catalog activation.
  origin: string | null;
  updated_at: string;
  // Soft-archive is skill-level: versions keep their own statuses untouched.
  archived_at: string | null;
  // Toolset ids from the resolving version's SKILL.md frontmatter — the hand
  // the skill was written for. Declarative: it never scopes a client listing.
  toolsets: string[];
}

// Optional on purpose: a payload from before the field existed must render
// as "no declared hand", not throw.
export function hasToolsets(skill: { toolsets?: string[] }): boolean {
  return (skill.toolsets ?? []).length > 0;
}

export interface SkillVersionMeta {
  version: number;
  status: SkillVersionStatus;
  content_hash: string;
  created_at: string;
}

export interface SkillDetail extends Skill {
  versions: SkillVersionMeta[];
  // Tools the playbook names outside its declared toolsets (backend lint).
  lint_warnings: string[];
}

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillVersionDetail {
  version: number;
  status: SkillVersionStatus;
  content_hash: string;
  files: SkillFile[];
  toolsets: string[];
}

export interface SkillListResponse {
  skills: Skill[];
  count: number;
}

export interface SkillCatalogEntry {
  catalog_id: string;
  catalog_version: number;
  name: string;
  description: string;
  toolsets: string[];
}

export interface SkillCatalogResponse {
  entries: SkillCatalogEntry[];
}

export interface BoardSkillBinding {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  content_hash: string;
  enabled: boolean;
  pinned_version: number | null;
  role: string | null;
  toolsets: string[];
  // Declared toolsets the board's loop grant cannot cover.
  uncovered_toolsets: string[];
}

export interface BoardSkillBindingList {
  skills: BoardSkillBinding[];
}

/** One RAW binding row: what an operator configured, not what a runner would
 * materialize. `resolved_version` is the version the effective set would use,
 * null when the skill has nothing published and nothing pinned. */
export interface BoardSkillBindingRow {
  skill_id: string;
  slug: string;
  name: string;
  enabled: boolean;
  pinned_version: number | null;
  role: string | null;
  resolved_version: number | null;
  toolsets: string[];
  uncovered_toolsets: string[];
}

export interface BoardSkillBindingRowList {
  bindings: BoardSkillBindingRow[];
}

export interface SkillBindingUpdate {
  enabled: boolean;
  pinned_version?: number | null;
  role?: string | null;
}
