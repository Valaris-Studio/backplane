// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useSyncExternalStore } from "react";

import { commands, type BoardsOverview, type DiscoveredProject, type WorkspaceBoards } from "../ipc/bindings";
import { statusStore } from "./daemon-stream";
import { useStoreSelector } from "./external-store";
import { createRefetchable } from "./refetchable";

/** One mapping of `GET /v1/projects` (the cached policy's shape). */
export interface RawMapping {
  id: string;
  workspace_id: string;
  board_id?: string | null;
  root_path?: string | null;
  repo_url_normalized?: string | null;
  origin?: string | null;
  enabled: boolean;
  content_level?: string | null;
  /** The server's effective capture, passed through by the daemon; absent from older ones. */
  capture?: { content_level: string; effective_content_level: string; reason?: "device_unsupported" | "server_disabled" | null } | null;
}

/** A mapping joined with the names the boards catalog knows; null when it does not. */
export interface ProjectMapping extends RawMapping {
  board_name: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
}

export interface ProjectsOverviewData {
  mappings: readonly RawMapping[];
  discovered: readonly DiscoveredProject[];
  ignored: readonly string[];
}

/** What `boardLinkFor` can resolve: a repo (`host/owner/repo`) or a mapping-like target. */
export type BoardLinkTarget = string | { workspace_id?: string | null; board_id?: string | null } | null | undefined;

const NO_MAPPINGS: readonly ProjectMapping[] = [];
const NO_DISCOVERED: readonly DiscoveredProject[] = [];
const NO_IGNORED: readonly string[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseOverview(raw: unknown): ProjectsOverviewData | null {
  if (!isRecord(raw)) return null;
  const { mappings, discovered, ignored } = raw;
  if (!Array.isArray(mappings) || !Array.isArray(discovered) || !Array.isArray(ignored)) return null;
  const mappingsWellFormed = mappings.every((mapping) => isRecord(mapping) && typeof mapping.id === "string" && typeof mapping.workspace_id === "string");
  const discoveredWellFormed = discovered.every((project) => isRecord(project) && typeof project.root === "string");
  const ignoredWellFormed = ignored.every((path) => typeof path === "string");
  if (!mappingsWellFormed || !discoveredWellFormed || !ignoredWellFormed) return null;
  return { mappings: mappings as RawMapping[], discovered: discovered as DiscoveredProject[], ignored: ignored as string[] };
}

function parseCatalog(raw: unknown): BoardsOverview | null {
  if (!isRecord(raw) || !Array.isArray(raw.workspaces)) return null;
  const wellFormed = raw.workspaces.every(
    (workspace) => isRecord(workspace) && typeof workspace.id === "string" && typeof workspace.slug === "string" && Array.isArray(workspace.boards),
  );
  return wellFormed ? (raw as BoardsOverview) : null;
}

export const overviewResource = createRefetchable(() => commands.projects(), parseOverview);
export const catalogResource = createRefetchable(() => commands.boards(), parseCatalog);

export const projectsStore = {
  get: () => ({ overview: overviewResource.store.get(), catalog: catalogResource.store.get() }),
};

/** The SSE `projects` event carries the whole `GET /v1/projects` object. */
export function applyProjectsEvent(data: unknown): void {
  const overview = parseOverview(data);
  if (overview) overviewResource.push(overview);
}

/** A mapping or settings write changed the policy, and with it the catalog's reach. */
export function refreshAfterPolicyChange(): void {
  overviewResource.invalidate();
  catalogResource.invalidate();
}

export function refreshProjectsAfterReconnect(): void {
  overviewResource.refetchIfUsed();
  catalogResource.refetchIfUsed();
}

/**
 * The daemon went away, or another installation took over: one account's
 * mappings and catalog must never be joined with another's origin.
 */
export function forgetProjects(): void {
  overviewResource.forget();
  catalogResource.forget();
}

function findWorkspace(catalog: BoardsOverview, workspaceId: string): WorkspaceBoards | undefined {
  return catalog.workspaces.find((workspace) => workspace.id === workspaceId);
}

function joinMapping(mapping: RawMapping, catalog: BoardsOverview | null): ProjectMapping {
  const workspace = catalog ? findWorkspace(catalog, mapping.workspace_id) : undefined;
  const board = workspace?.boards.find((candidate) => candidate.id === mapping.board_id);
  return { ...mapping, board_name: board?.name ?? null, workspace_name: workspace?.name ?? null, workspace_slug: workspace?.slug ?? null };
}

// Joined once per (overview, catalog) pair so every subscriber gets the same array.
let joinedFrom: { overview: ProjectsOverviewData | null; catalog: BoardsOverview | null; mappings: readonly ProjectMapping[] } = {
  overview: null,
  catalog: null,
  mappings: NO_MAPPINGS,
};

function joinedMappings(): readonly ProjectMapping[] {
  const { overview, catalog } = projectsStore.get();
  if (overview !== joinedFrom.overview || catalog !== joinedFrom.catalog) {
    joinedFrom = { overview, catalog, mappings: overview ? overview.mappings.map((mapping) => joinMapping(mapping, catalog)) : NO_MAPPINGS };
  }
  return joinedFrom.mappings;
}

function subscribeProjects(listener: () => void): () => void {
  const unsubscribers = [overviewResource.store.subscribe(listener), catalogResource.store.subscribe(listener)];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

function webOrigin(): string | null {
  const status = statusStore.get();
  const origin = status?.account?.web_origin || status?.endpoint || "";
  const trimmed = origin.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

// encodeURIComponent keeps "." and "..", which a browser resolves as path steps.
const isPathSegment = (segment: string) => segment !== "" && segment !== "." && segment !== "..";

export interface BoardPlace {
  workspaceSlug: string;
  boardId: string;
  boardName: string;
}

/**
 * What decided a session's capture, strongest first: the board the server
 * filed it under, the mapping that captured it (a folder bound by path has no
 * repo), then its repo.
 */
export interface SessionCapture {
  repo: string | null;
  mapping_id?: string | null;
  server_workspace_id?: string | null;
  server_board_id?: string | null;
  server_mapping_id?: string | null;
}

function placeOfBoard(catalog: BoardsOverview, workspaceId: string | null | undefined, boardId: string | null | undefined): BoardPlace | null {
  if (!boardId) return null;
  const workspaces = workspaceId ? catalog.workspaces.filter((workspace) => workspace.id === workspaceId) : catalog.workspaces;
  for (const workspace of workspaces) {
    const board = workspace.boards.find((candidate) => candidate.id === boardId);
    if (board) return { workspaceSlug: workspace.slug, boardId, boardName: board.name };
  }
  return null;
}

/** A repo resolves through its mappings first, else through the one catalog board that lists it. */
function placeOfRepo(catalog: BoardsOverview, mappings: readonly RawMapping[], repo: string): BoardPlace | null {
  const mapped = mappings.filter((mapping) => mapping.repo_url_normalized === repo && mapping.board_id);
  const [firstMapped] = mapped;
  if (firstMapped) {
    const oneBoard = mapped.every((mapping) => mapping.board_id === firstMapped.board_id);
    return oneBoard ? placeOfBoard(catalog, firstMapped.workspace_id, firstMapped.board_id) : null;
  }
  const listing = catalog.workspaces.flatMap((workspace) =>
    workspace.boards.filter((board) => board.repos.includes(repo)).map((board) => ({ workspaceSlug: workspace.slug, boardId: board.id, boardName: board.name })),
  );
  return listing.length === 1 ? (listing[0] ?? null) : null;
}

/**
 * A known capturing board or mapping is final: when the catalog cannot place
 * it, the session has no board rather than one guessed from its repo. Only a
 * mapping gone from the policy falls through to the repo.
 */
export function boardOfSession(catalog: BoardsOverview, mappings: readonly RawMapping[], session: SessionCapture): BoardPlace | null {
  if (session.server_board_id) return placeOfBoard(catalog, session.server_workspace_id, session.server_board_id);
  const mappingId = session.mapping_id || session.server_mapping_id;
  const mapping = mappingId ? mappings.find((candidate) => candidate.id === mappingId) : undefined;
  if (mapping) return placeOfBoard(catalog, mapping.workspace_id, mapping.board_id);
  return session.repo ? placeOfRepo(catalog, mappings, session.repo) : null;
}

function kanbanLink(place: BoardPlace | null): string | null {
  const origin = webOrigin();
  if (!origin || !place || !isPathSegment(place.workspaceSlug) || !isPathSegment(place.boardId)) return null;
  return `${origin}/${encodeURIComponent(place.workspaceSlug)}/boards/${encodeURIComponent(place.boardId)}/kanban`;
}

/**
 * The board's kanban on the web app (contract v1.6): the web has no session
 * or device pages yet. Null whenever the origin, the board or its workspace
 * is unknown.
 */
export function boardLinkFor(target: BoardLinkTarget): string | null {
  const { overview, catalog } = projectsStore.get();
  if (!catalog || !target) return null;
  return kanbanLink(
    typeof target === "string" ? placeOfRepo(catalog, overview?.mappings ?? [], target) : placeOfBoard(catalog, target.workspace_id, target.board_id),
  );
}

/** The kanban of the board that captured the session (`boardOfSession`); null when unknown. */
export function boardLinkForSession(session: SessionCapture): string | null {
  const { overview, catalog } = projectsStore.get();
  return catalog ? kanbanLink(boardOfSession(catalog, overview?.mappings ?? [], session)) : null;
}

function useOverviewLoaded(): void {
  useEffect(() => overviewResource.ensure(), []);
}

// The catalog is what the owner can reach right now, so each consumer that
// mounts asks again; concurrent mounts share one request.
function useCatalogFresh(): void {
  useEffect(() => catalogResource.refresh(), []);
}

export function useMappings(): readonly ProjectMapping[] {
  useOverviewLoaded();
  useCatalogFresh();
  return useSyncExternalStore(subscribeProjects, joinedMappings, joinedMappings);
}

export function useDiscovered(): readonly DiscoveredProject[] {
  useOverviewLoaded();
  return useStoreSelector(overviewResource.store, (overview) => overview?.discovered ?? NO_DISCOVERED);
}

export function useIgnored(): readonly string[] {
  useOverviewLoaded();
  return useStoreSelector(overviewResource.store, (overview) => overview?.ignored ?? NO_IGNORED);
}

/** null until the first catalog arrives. */
export function useBoardsCatalog(): BoardsOverview | null {
  useCatalogFresh();
  return useStoreSelector(catalogResource.store, (catalog) => catalog);
}

function subscribeBoardLink(listener: () => void): () => void {
  const unsubscribeProjects = subscribeProjects(listener);
  const unsubscribeStatus = statusStore.subscribe(listener);
  return () => {
    unsubscribeProjects();
    unsubscribeStatus();
  };
}

/** `boardLinkFor`, re-evaluated as the status, mappings or catalog change. */
export function useBoardLink(target: BoardLinkTarget): string | null {
  useOverviewLoaded();
  useCatalogFresh();
  const link = () => boardLinkFor(target);
  return useSyncExternalStore(subscribeBoardLink, link, link);
}

export function resetProjectsForTests(): void {
  overviewResource.reset();
  catalogResource.reset();
}
