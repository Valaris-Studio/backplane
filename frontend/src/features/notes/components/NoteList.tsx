// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Loader2, Pin, Plus, StickyNote } from "lucide-react";
import { CreateNoteDialog } from "./CreateNoteDialog";
import { NoteCard } from "./NoteCard";
import { NoteEditor } from "./NoteEditor";
import { NoteRow } from "./NoteRow";
import {
  useNotesList,
  type NotesDirection,
  type NotesOrderBy,
} from "../api/use-notes-list";
import { useNote } from "../api/use-note-detail";
import { kindsForOrigins, type NoteOrigin } from "../lib/noteKinds";
import { useMembers } from "@/features/members/api/use-members";
import {
  CollectionLayout,
  CollectionToolbar,
  FilterMultiSelect,
  FilterToggle,
  useCollectionView,
  type FilterOption,
  type SortOption,
} from "@/components/collection";
import { FrozenActionTooltip } from "@/features/kanban/components/FrozenActionTooltip";
import { EmptyState } from "@/components/layout/EmptyState";
import { ExportButton } from "@/components/export/export-button";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { gsap } from "gsap";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { newIdsSince } from "@/features/kanban/utils/new-ids";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { NOTE_SEARCH_PARAM } from "../utils/note-link";
import type { Note, NoteSummary } from "@/types/note";

interface NoteListProps {
  slug: string;
  boardId?: string;
  /** Board tab only — the workspace notes page has no board to freeze. */
  isFrozen?: boolean;
}

// Matches the toolbar's own input debounce: `q` is a full-collection query, so
// one request per keystroke would stampede the API.
const SEARCH_DEBOUNCE_MS = 250;

const ORDER_BY_IDS: NotesOrderBy[] = [
  "updated_at",
  "created_at",
  "title",
  "author",
];

function isOrderBy(value: string): value is NotesOrderBy {
  return (ORDER_BY_IDS as string[]).includes(value);
}

/**
 * The summary's fields minus `preview` — the browse snippet is a display
 * string, never an edit source, so it must not ride along into the editor.
 */
function summaryToShell(summary: NoteSummary): Omit<Note, "content"> {
  return {
    id: summary.id,
    workspace_id: summary.workspace_id,
    board_id: summary.board_id,
    card_id: summary.card_id,
    title: summary.title,
    pinned: summary.pinned,
    kind: summary.kind,
    failure_class: summary.failure_class,
    findings: summary.findings,
    source_execution_id: summary.source_execution_id,
    created_by: summary.created_by,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
}

export function NoteList({ slug, boardId, isFrozen = false }: NoteListProps) {
  const { t } = useTranslation();
  const { data: members } = useMembers(slug);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // The clicked row, kept so the sheet can render its title/metadata while the
  // body is still in flight.
  const [selectedSummary, setSelectedSummary] = useState<NoteSummary | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);
  const compact = Boolean(boardId);
  const [searchParams, setSearchParams] = useSearchParams();
  const noteParam = searchParams.get(NOTE_SEARCH_PARAM);

  const authorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members ?? []) {
      map.set(m.user_id, m.name || m.email);
    }
    return map;
  }, [members]);

  const authorName = (id: string) =>
    authorById.get(id) ?? t("collection.unknownAuthor");

  // Sorting and filtering are the SERVER's job now — search has to reach notes
  // on pages that were never loaded. These descriptors exist only so the
  // toolbar keeps rendering the same menu, so their compare/predicate bodies
  // are never called (useCollectionView is fed an empty item list below).
  const sorters = useMemo<SortOption<NoteSummary>[]>(
    () => [
      { id: "updated_at", label: t("notes.sort.updated"), compare: () => 0 },
      { id: "created_at", label: t("notes.sort.created"), compare: () => 0 },
      { id: "title", label: t("notes.sort.title"), compare: () => 0 },
      { id: "author", label: t("notes.sort.author"), compare: () => 0 },
    ],
    [t],
  );

  const filters = useMemo<FilterOption<NoteSummary>[]>(
    () => [
      {
        id: "pinnedOnly",
        label: t("notes.filter.pinnedOnly"),
        defaultValue: false,
        predicate: () => true,
      },
      {
        id: "authors",
        label: t("notes.filter.authors"),
        defaultValue: [],
        predicate: () => true,
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "origin",
        label: t("notes.filter.origin"),
        defaultValue: [],
        predicate: () => true,
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
    ],
    [t],
  );

  // The hook is kept for what it still owns: the control state, the localStorage
  // persistence of view mode / sort / filters, and the reset button. Its
  // client-side pass is disabled by handing it no items.
  const { viewMode, setViewMode, controls } = useCollectionView<NoteSummary>({
    items: undefined,
    searchFields: () => [],
    sorters,
    filters,
    defaultSortId: "updated_at",
    defaultSortDirection: "desc",
    defaultViewMode: "grid",
    persistenceKey: boardId ? `notes:${boardId}` : `notes:workspace:${slug}`,
  });

  const pinnedActive = controls.filterValues.pinnedOnly === true;
  // Memoised on the stored value, not the `?? []` result: a fresh [] literal
  // every render would re-key the query and refetch in a loop.
  const authorIds = useMemo(
    () => (controls.filterValues.authors ?? []) as string[],
    [controls.filterValues.authors],
  );
  const originValues = useMemo(
    () => (controls.filterValues.origin ?? []) as NoteOrigin[],
    [controls.filterValues.origin],
  );

  const debouncedSearch = useDebouncedValue(controls.search, SEARCH_DEBOUNCE_MS);

  const listParams = useMemo(
    () => ({
      q: debouncedSearch,
      orderBy: isOrderBy(controls.sortId) ? controls.sortId : "updated_at",
      direction: controls.sortDirection as NotesDirection,
      pinnedOnly: pinnedActive,
      authors: authorIds,
      kinds: kindsForOrigins(originValues),
    }),
    [
      debouncedSearch,
      controls.sortId,
      controls.sortDirection,
      pinnedActive,
      authorIds,
      originValues,
    ],
  );

  const {
    items: notes,
    totalCount,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useNotesList(slug, boardId, listParams);

  // A filter/search is active whenever the request carries anything beyond the
  // sort. Distinguishes "this workspace has no notes" (onboarding empty state)
  // from "your filters matched nothing" (keep the toolbar so it can be undone).
  const hasActiveQuery =
    debouncedSearch.trim().length > 0 ||
    pinnedActive ||
    authorIds.length > 0 ||
    originValues.length > 0;

  // URL → editor: ?note=<id> is the deep-link source of truth (notification
  // links land here). With the list paginated, the target is often on a page
  // that was never fetched, so the id goes STRAIGHT to the detail query — list
  // membership is not a precondition for opening it. Mirrors BoardView's ?card=.
  const deepLinkId = noteParam && noteParam !== selectedNoteId ? noteParam : null;
  const openNoteId = editorOpen ? selectedNoteId : null;

  // The one authoritative source of the body — for the deep link and for a
  // clicked card alike. The list payload has no `content` at all now.
  const {
    data: fullSelectedNote,
    isError: detailFailed,
  } = useNote(slug, deepLinkId ?? openNoteId ?? undefined, boardId);

  const clearNoteParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(NOTE_SEARCH_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  useEffect(() => {
    if (!noteParam) return;
    if (fullSelectedNote?.id === noteParam) {
      setSelectedNoteId(noteParam);
      setEditorOpen(true);
      return;
    }
    // Only a definitive "no such note" strips the link. Stripping while the
    // request is still in flight would break every link to a note that simply
    // isn't on the first page.
    if (detailFailed) clearNoteParam();
  }, [noteParam, fullSelectedNote, detailFailed, clearNoteParam]);

  // Closing the editor must also drop the ?note= param, else the deep-link
  // effect re-opens it on the next render. Leaves other params untouched.
  const handleEditorOpenChange = useCallback(
    (open: boolean) => {
      setEditorOpen(open);
      if (!open && noteParam) clearNoteParam();
    },
    [noteParam, clearNoteParam],
  );

  const openNote = useCallback((note: NoteSummary) => {
    setSelectedNoteId(note.id);
    setSelectedSummary(note);
    setEditorOpen(true);
  }, []);

  const isSelectedBodyLoaded =
    !!fullSelectedNote && fullSelectedNote.id === selectedNoteId;

  // The sheet opens on click, before the body has landed, so the metadata strip
  // and title are there immediately. Until the detail query answers, `content`
  // is an empty placeholder and `isBodyAuthoritative` is false, which keeps the
  // editor's writes shut — it can never save the placeholder over the real body.
  const editorNote = useMemo<Note | null>(() => {
    if (isSelectedBodyLoaded) return fullSelectedNote ?? null;
    if (!selectedSummary || selectedSummary.id !== selectedNoteId) return null;
    return { ...summaryToShell(selectedSummary), content: "" };
  }, [isSelectedBodyLoaded, fullSelectedNote, selectedSummary, selectedNoteId]);

  const authorOptions = useMemo(
    () =>
      (members ?? []).map((m) => ({
        value: m.user_id,
        label: m.name || m.email,
      })),
    [members],
  );

  const visibleIds = useMemo(() => notes.map((n) => n.id), [notes]);
  // Stable change signal: re-run on a change to the SET of visible notes, not
  // on every render.
  const visibleIdsKey = visibleIds.join(":");

  // Which note ids have already animated in. A refetch, a filter change or a
  // sort flip must not re-hide and re-reveal notes the user is already looking
  // at — and neither must appending a page. null = not yet mounted.
  const seenIdsRef = useRef<Set<string> | null>(null);

  // Grid mode only. List mode skips GSAP — divider rows look better with no
  // entry animation than a brief flash.
  useEffect(() => {
    if (isLoading || viewMode !== "grid") return;
    if (reducedMotion) {
      seenIdsRef.current = new Set(visibleIds);
      return;
    }
    const container = gridRef.current;
    if (!container) return;

    const firstMount = seenIdsRef.current === null;
    const newIds = newIdsSince(visibleIds, seenIdsRef.current);
    seenIdsRef.current = new Set(visibleIds);

    if (firstMount) {
      // maxStaggered caps total entrance time: uncapped, a page of 60 notes
      // reveals the last card ~3s after load (0.05s each).
      const tween = staggerChildren(container, "[data-stagger-item]", scaleIn, {
        stagger: 0.05,
        duration: 0.2,
        maxStaggered: 12,
      });
      // progress(1) BEFORE kill: the entrance starts notes at autoAlpha 0, so a
      // bare mid-flight kill strands them invisible.
      return () => { tween?.progress(1).kill(); };
    }

    if (newIds.length === 0) return; // filter / sort / update — no entrance

    // A note just arrived (create, an agent wrote one, or the next page landed)
    // — animate only those, leaving the rest of the grid untouched.
    const selector = newIds.map((id) => `[data-stagger-id="${id}"]`).join(",");
    const targets = gsap.utils.toArray<HTMLElement>(selector, container);
    if (!targets.length) return;
    const tween = scaleIn(targets, { stagger: 0.05, duration: 0.2 });
    return () => { tween?.progress(1).kill(); };
    // visibleIdsKey is the content-change signal; `visibleIds` is read fresh
    // inside (intentionally not a dep — re-run on content change, not identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, visibleIdsKey, reducedMotion, viewMode]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-48 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
            />
          ))}
        </div>
      </div>
    );
  }

  const originOptions = [
    { value: "human", label: t("notes.origin.human") },
    { value: "agent", label: t("notes.origin.agent") },
  ];

  return (
    <div className="space-y-[var(--page-section-gap)]">
      {/* Board tab: one slim line (the board chrome already says where you
          are). Workspace page keeps the full header. */}
      <PageHeader
        slim={compact}
        title={t(boardId ? "notes.boardTitle" : "notes.workspaceTitle")}
        description={t("notes.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {boardId ? (
              <ExportButton
                endpoint={`/workspaces/${slug}/boards/${boardId}/notes/export`}
                defaultFilename={`${boardId}.valaris.notes.json`}
                entityLabel={t("export.entity.notes")}
              />
            ) : null}
            <FrozenActionTooltip frozen={isFrozen}>
              <Button onClick={() => setCreateOpen(true)} disabled={isFrozen}>
                <Plus className="h-4 w-4" />
                {t("notes.newNote")}
              </Button>
            </FrozenActionTooltip>
          </div>
        }
      />

      {totalCount === 0 && !hasActiveQuery ? (
        <EmptyState
          icon={StickyNote}
          title={t("notes.title")}
          description={t("notes.empty")}
          action={
            <FrozenActionTooltip frozen={isFrozen}>
              <Button
                size="lg"
                onClick={() => setCreateOpen(true)}
                disabled={isFrozen}
              >
                <Plus className="h-4 w-4" />
                {t("notes.newNote")}
              </Button>
            </FrozenActionTooltip>
          }
        />
      ) : (
        <>
          <CollectionToolbar
            controls={controls}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            searchPlaceholder={t("notes.searchPlaceholder")}
            resultLabel={t("collection.resultCount", {
              count: notes.length,
              total: totalCount,
            })}
            filterSlot={
              <>
                <FilterToggle
                  label={t("notes.filter.pinnedOnly")}
                  active={pinnedActive}
                  onChange={(next) => controls.setFilterValue("pinnedOnly", next)}
                  icon={<Pin className="h-3.5 w-3.5" />}
                />
                <FilterMultiSelect
                  label={t("notes.filter.origin")}
                  options={originOptions}
                  value={originValues}
                  onChange={(next) => controls.setFilterValue("origin", next)}
                />
                <FilterMultiSelect
                  label={t("notes.filter.authors")}
                  options={authorOptions}
                  value={authorIds}
                  onChange={(next) => controls.setFilterValue("authors", next)}
                />
              </>
            }
          />

          <div ref={gridRef}>
            <CollectionLayout
              items={notes}
              viewMode={viewMode}
              getKey={(n) => n.id}
              renderGrid={(note) => (
                <NoteCard
                  note={note}
                  authorName={authorName(note.created_by)}
                  onClick={() => openNote(note)}
                />
              )}
              renderList={(note) => (
                <NoteRow
                  note={note}
                  authorName={authorName(note.created_by)}
                  onClick={() => openNote(note)}
                />
              )}
              emptyState={
                <div className="rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-dashed border-border/60 bg-card/30 px-6 py-10 text-center text-sm text-muted-foreground">
                  {t("collection.noResults")}
                </div>
              }
            />
          </div>

          {hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("collection.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <CreateNoteDialog
        slug={slug}
        boardId={boardId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {editorNote ? (
        <NoteEditor
          note={editorNote}
          isBodyAuthoritative={isSelectedBodyLoaded}
          slug={slug}
          boardId={boardId}
          open={editorOpen}
          onOpenChange={handleEditorOpenChange}
        />
      ) : null}
    </div>
  );
}
