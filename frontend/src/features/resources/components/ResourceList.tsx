// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  type Modifier,
} from "@dnd-kit/core";
import {
  ChevronRight,
  Download,
  FileText,
  FolderClosed,
  FolderOpen,
  MoreHorizontal,
  Move,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { FileUploadButton } from "./FileUploadButton";
import { ResourceEditor } from "./ResourceEditor";
import { ResourceGrid } from "./ResourceGrid";
import { ResourceToolbar, type ViewMode } from "./ResourceToolbar";
import { MoveDialog } from "./MoveDialog";
import {
  useDeleteResource,
  useDownloadUrl,
  usePreviewDownloadUrl,
  useResources,
  useTags,
  useUpdateResource,
} from "../api/use-resources";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { FrozenActionTooltip } from "@/features/kanban/components/FrozenActionTooltip";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fadeInUp, staggerChildren } from "@/lib/animations";
import { formatBytes, formatDate } from "@/lib/format";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import type { Resource, ResourceSearchParams } from "@/types/resource";

const snapToPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (activatorEvent instanceof PointerEvent && draggingNodeRect) {
    const offsetX = activatorEvent.clientX - draggingNodeRect.left;
    const offsetY = activatorEvent.clientY - draggingNodeRect.top;
    return {
      ...transform,
      x: transform.x + offsetX - 16,
      y: transform.y + offsetY - 16,
    };
  }
  return transform;
};

interface Breadcrumb {
  id: string | null;
  name: string;
}

interface ResourceListProps {
  slug: string;
  boardId?: string;
  /** Board tab only — the workspace resources page has no board to freeze. */
  isFrozen?: boolean;
}

// --- Inline editable name ---
function InlineEditName({
  resource,
  onRename,
}: {
  resource: Resource;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(resource.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const dotIndex = name.lastIndexOf(".");
      inputRef.current.setSelectionRange(0, dotIndex > 0 ? dotIndex : name.length);
    }
  }, [editing]);

  function handleSubmit() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== resource.name) {
      onRename(resource.id, trimmed);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") {
            setName(resource.name);
            setEditing(false);
          }
        }}
        className="h-7 text-sm"
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className="cursor-default truncate"
    >
      {resource.name}
    </span>
  );
}

// --- Draggable resource row ---
function DraggableResourceRow({
  resource,
  children,
}: {
  resource: Resource;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: resource.id,
    data: { resource },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "opacity-40")}
    >
      {children}
    </div>
  );
}

// --- Droppable folder target ---
function DroppableFolder({
  folderId,
  children,
}: {
  folderId: string;
  children: (isOver: boolean) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${folderId}`,
    data: { folderId },
  });

  return <div ref={setNodeRef}>{children(isOver)}</div>;
}

// --- Droppable breadcrumb ---
function DroppableBreadcrumb({
  folderId,
  children,
}: {
  folderId: string | null;
  children: (isOver: boolean) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `breadcrumb-${folderId ?? "root"}`,
    data: { folderId },
  });

  return <span ref={setNodeRef}>{children(isOver)}</span>;
}

function RootDropZone() {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: "drop-root",
    data: { folderId: null },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mx-[var(--card-padding)] my-2 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors",
        isOver
          ? "border-primary bg-primary/10 text-primary"
          : "border-border/70 text-muted-foreground",
      )}
    >
      <FolderOpen className="h-4 w-4" />
      {t("resources.home")}
    </div>
  );
}

export function ResourceList({ slug, boardId, isFrozen = false }: ResourceListProps) {
  const { t, i18n } = useTranslation();
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([
    { id: null, name: "home" },
  ]);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [previewResource, setPreviewResource] = useState<Resource | null>(null);
  const [moveResource, setMoveResource] = useState<Resource | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [draggingResource, setDraggingResource] = useState<Resource | null>(null);
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string | undefined>(undefined);
  const [filterTag, setFilterTag] = useState<string | undefined>(undefined);
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (localStorage.getItem("resource-view-mode") as ViewMode) ?? "list",
  );

  const debouncedQuery = useDebouncedValue(searchQuery, 300);

  const searchParams: ResourceSearchParams | undefined =
    debouncedQuery || filterType || filterTag
      ? {
          q: debouncedQuery || undefined,
          resource_type: filterType,
          tag: filterTag,
        }
      : undefined;

  const currentParentId = breadcrumbs[breadcrumbs.length - 1]!.id;
  const { data: resources, isLoading } = useResources(
    slug,
    boardId,
    searchParams ? undefined : currentParentId,
    searchParams,
  );
  const { data: availableTags } = useTags(slug, boardId);
  const deleteResource = useDeleteResource(slug, boardId);
  const downloadUrl = useDownloadUrl(slug, boardId);
  const updateResource = useUpdateResource(slug, boardId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem("resource-view-mode", mode);
  }

  useEffect(() => {
    if (isLoading || reducedMotion || viewMode !== "list") return;
    const tween = staggerChildren(
      listRef.current,
      "[data-stagger-item]",
      fadeInUp,
      { stagger: 0.03, duration: 0.16, offset: 10, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts rows at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => { tween?.progress(1).kill(); };
    // Deliberately NOT keyed on the resource count: a row added or removed in
    // place would replay the entrance from autoAlpha 0 across the whole list.
    // Folder navigation and view switches DO re-run it — those are new lists.
  }, [currentParentId, isLoading, reducedMotion, viewMode]);

  async function handleDownload(resource: Resource) {
    try {
      const { download_url } = await downloadUrl.mutateAsync(resource.id);
      window.open(download_url, "_blank");
    } catch (error) {
      toast.error(t("resources.downloadFailed", { name: resource.name }), {
        description: resolveApiErrorMessage(error, t, i18n, { fallbackKey: "resources.requestFailed" }),
        action: { label: t("resources.retry"), onClick: () => void handleDownload(resource) },
      });
    }
  }

  function handlePreview(resource: Resource) {
    if (resource.resource_type === "file") {
      setPreviewResource(resource);
    }
  }

  function navigateToFolder(folder: Resource) {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }

  function navigateToBreadcrumb(index: number) {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  }

  function handleDelete(resource: Resource) {
    setDeleteTarget(resource);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteResource.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  function handleInlineRename(resourceId: string, newName: string) {
    updateResource.mutate({ resourceId, name: newName });
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingResource(event.active.data.current?.resource ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingResource(null);
    const { active, over } = event;
    if (!over) return;

    const draggedId = active.id as string;
    const dropData = over.data.current;
    const targetFolderId = dropData?.folderId ?? null;

    // Don't drop on self
    if (draggedId === targetFolderId) return;
    // Don't drop on current parent (no-op)
    const draggedResource = active.data.current?.resource as Resource | undefined;
    if (draggedResource?.parent_id === targetFolderId) return;

    updateResource.mutate({ resourceId: draggedId, parent_id: targetFolderId });
  }

  const sorted = resources
    ? [...resources].sort((a, b) => {
        if (a.resource_type !== b.resource_type) {
          return a.resource_type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
    : [];

  const isSearching = Boolean(searchParams);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <Skeleton className="h-80 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-[var(--page-section-gap)]">
        {/* Board tab: one slim line; workspace page keeps the full header. */}
        <PageHeader
          slim={Boolean(boardId)}
          title={t(boardId ? "resources.boardTitle" : "resources.workspaceTitle")}
          description={t("resources.subtitle")}
          actions={
            <>
              <FrozenActionTooltip frozen={isFrozen}>
                <FileUploadButton
                  slug={slug}
                  boardId={boardId}
                  parentId={currentParentId}
                  disabled={isFrozen}
                />
              </FrozenActionTooltip>
              <FrozenActionTooltip frozen={isFrozen}>
                <Button onClick={() => setCreateOpen(true)} disabled={isFrozen}>
                  <Plus className="h-4 w-4" />
                  {t("resources.newFolder")}
                </Button>
              </FrozenActionTooltip>
            </>
          }
        />

        <Card className="overflow-hidden border-border/75">
          {/* Toolbar */}
          <div className="border-b border-border/70 px-[var(--card-padding)] py-3">
            <ResourceToolbar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              resourceType={filterType}
              onResourceTypeChange={setFilterType}
              selectedTag={filterTag}
              onTagChange={setFilterTag}
              availableTags={availableTags ?? []}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
            />
          </div>

          {/* Breadcrumbs (hidden when searching) */}
          {!isSearching && (
            <div className="border-b border-border/70 px-[var(--card-padding)] py-3">
              <nav className="flex flex-wrap items-center gap-1.5 text-sm">
                {breadcrumbs.map((crumb, index) => (
                  <DroppableBreadcrumb
                    key={crumb.id ?? "root"}
                    folderId={crumb.id}
                  >
                    {(isOver) => (
                      <span className="flex items-center gap-1.5">
                        {index > 0 && (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <button
                          type="button"
                          onClick={() => navigateToBreadcrumb(index)}
                          className={cn(
                            "rounded-full px-2 py-1 transition-colors",
                            index === breadcrumbs.length - 1
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            isOver && "ring-2 ring-primary/40 bg-primary/10",
                          )}
                        >
                          {crumb.id === null ? t("resources.home") : crumb.name}
                        </button>
                      </span>
                    )}
                  </DroppableBreadcrumb>
                ))}
              </nav>
            </div>
          )}

          {/* Root drop zone — visible when dragging inside a subfolder */}
          {draggingResource && currentParentId !== null && (
            <RootDropZone />
          )}

          {/* Content */}
          {!sorted.length ? (
            <div className="p-[var(--card-padding)]">
              <EmptyState
                icon={FolderOpen}
                title={t("resources.title")}
                description={
                  isSearching
                    ? t("resources.empty")
                    : t("resources.empty")
                }
              />
            </div>
          ) : viewMode === "grid" ? (
            <ResourceGrid
              resources={sorted}
              onNavigateFolder={navigateToFolder}
              onPreview={handlePreview}
              onDownload={handleDownload}
              onRename={(r) => {
                setSelectedResource(r);
                setEditorOpen(true);
              }}
              onMove={(r) => {
                setMoveResource(r);
                setMoveOpen(true);
              }}
              onDelete={handleDelete}
            />
          ) : (
            <div ref={listRef} className="divide-y divide-border/70">
              {sorted.map((resource) => {
                const isFolder = resource.resource_type === "folder";
                const row = (isOverDrop: boolean) => (
                  <DraggableResourceRow resource={resource}>
                    <div
                      data-stagger-item
                      className={cn(
                        "group flex items-center gap-4 px-[var(--card-padding)] py-4 transition-colors duration-200 hover:bg-[color:var(--color-surface-1)]",
                        isOverDrop && isFolder && "bg-primary/8 ring-1 ring-inset ring-primary/30",
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-4 text-left"
                        onClick={() => {
                          if (isFolder) navigateToFolder(resource);
                          else handlePreview(resource);
                        }}
                      >
                        <div
                          className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-[var(--radius-cap)] shadow-soft",
                            isFolder
                              ? "bg-primary/10 text-primary"
                              : "bg-secondary text-secondary-foreground",
                          )}
                        >
                          {isFolder ? (
                            <FolderClosed className="h-5 w-5" />
                          ) : (
                            <FileText className="h-5 w-5" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">
                              <InlineEditName
                                resource={resource}
                                onRename={handleInlineRename}
                              />
                            </p>
                            {resource.metadata?.tags?.length > 0 && (
                              <div className="flex items-center gap-1">
                                {resource.metadata.tags.slice(0, 2).map((tag) => (
                                  <Badge
                                    key={tag}
                                    variant="secondary"
                                    className="text-[0.58rem] px-1.5 py-0"
                                  >
                                    {tag}
                                  </Badge>
                                ))}
                                {resource.metadata.tags.length > 2 && (
                                  <Badge
                                    variant="outline"
                                    className="text-[0.58rem] px-1.5 py-0"
                                  >
                                    +{resource.metadata.tags.length - 2}
                                  </Badge>
                                )}
                              </div>
                            )}
                          </div>
                          {resource.description ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {resource.description}
                            </p>
                          ) : (
                            <p className="truncate text-xs uppercase tracking-[0.14em] text-muted-foreground">
                              {resource.resource_type}
                            </p>
                          )}
                        </div>
                      </button>

                      <span className="hidden text-sm text-muted-foreground md:block">
                        {resource.resource_type === "file" && resource.size_bytes != null
                          ? formatBytes(resource.size_bytes)
                          : ""}
                      </span>

                      <span className="hidden text-sm text-muted-foreground lg:block">
                        {formatDate(resource.updated_at, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>

                      <DropdownMenu>
                        <DropdownMenuTrigger className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground">
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {resource.resource_type === "file" && (
                            <DropdownMenuItem onClick={() => handlePreview(resource)}>
                              <FileText className="h-4 w-4" />
                              {t("resources.preview")}
                            </DropdownMenuItem>
                          )}
                          {resource.resource_type === "file" && (
                            <DropdownMenuItem onClick={() => handleDownload(resource)}>
                              <Download className="h-4 w-4" />
                              {t("common.download")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => {
                              setSelectedResource(resource);
                              setEditorOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                            {t("common.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setMoveResource(resource);
                              setMoveOpen(true);
                            }}
                          >
                            <Move className="h-4 w-4" />
                            {t("resources.moveTo")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => handleDelete(resource)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </DraggableResourceRow>
                );

                if (isFolder) {
                  return (
                    <DroppableFolder key={resource.id} folderId={resource.id}>
                      {(isOver) => row(isOver)}
                    </DroppableFolder>
                  );
                }
                return <div key={resource.id}>{row(false)}</div>;
              })}
            </div>
          )}
        </Card>

        {/* Drag overlay */}
        <DragOverlay dropAnimation={null} modifiers={[snapToPointer]}>
          {draggingResource && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2 shadow-lg">
              {draggingResource.resource_type === "folder" ? (
                <FolderClosed className="h-4 w-4 text-primary" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">{draggingResource.name}</span>
            </div>
          )}
        </DragOverlay>

        {/* Create folder dialog */}
        <CreateFolderDialog
          slug={slug}
          boardId={boardId}
          parentId={currentParentId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />

        {/* Resource editor sheet */}
        {selectedResource && (
          <ResourceEditor
            resource={selectedResource}
            slug={slug}
            boardId={boardId}
            open={editorOpen}
            onOpenChange={setEditorOpen}
          />
        )}

        {/* Move dialog */}
        <MoveDialog
          resource={moveResource}
          slug={slug}
          boardId={boardId}
          open={moveOpen}
          onOpenChange={setMoveOpen}
        />

        {/* Delete confirmation */}
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title={t("resources.deleteTitle")}
          description={t("resources.deleteConfirm", {
            name: deleteTarget?.name ?? "",
          })}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          pending={deleteResource.isPending}
          onConfirm={confirmDelete}
        />

        {/* Preview sheet */}
        <Sheet
          open={previewResource !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewResource(null);
          }}
        >
          <SheetContent className="flex flex-col gap-4 overflow-y-auto">
            {previewResource && (
              <PreviewContent
                key={`${slug}:${boardId ?? "workspace"}:${previewResource.id}`}
                resource={previewResource}
                slug={slug}
                boardId={boardId}
                onDownload={handleDownload}
              />
            )}
          </SheetContent>
        </Sheet>
      </div>
    </DndContext>
  );
}

// --- Preview content inside sheet ---
function PreviewContent({
  resource,
  slug,
  boardId,
  onDownload,
}: {
  resource: Resource;
  slug: string;
  boardId?: string;
  onDownload: (r: Resource) => void;
}) {
  const { t } = useTranslation();
  const { data: signedUrl, isError, isFetching, refetch } = usePreviewDownloadUrl(slug, boardId, resource);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-lg">{resource.name}</SheetTitle>
        {resource.description && (
          <SheetDescription>{resource.description}</SheetDescription>
        )}
      </SheetHeader>

      {/* Preview area */}
      <div className="flex-1 overflow-hidden rounded-lg border border-border/50 bg-muted/20">
        {isError || !resource.gcs_path ? (
          <div role="alert" className="space-y-3 p-4 text-sm">
            <p>{t("resources.previewFailed", { name: resource.name })}</p>
            <p>{t(resource.gcs_path ? "resources.requestFailed" : "resources.fileUnavailable")}</p>
            {resource.gcs_path ? (
              <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
                {t("resources.retry")}
              </Button>
            ) : null}
          </div>
        ) : signedUrl ? (
          <LazyFilePreview
            resource={resource}
            downloadUrl={signedUrl}
            onRefreshUrl={async () => {
              const result = await refetch();
              return result.isError ? undefined : result.data;
            }}
          />
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="space-y-3">
        {resource.metadata?.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {resource.metadata.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-muted-foreground">{t("resources.type")}</p>
            <p className="font-medium">{resource.mime_type ?? resource.resource_type}</p>
          </div>
          {resource.size_bytes != null && (
            <div>
              <p className="text-muted-foreground">{t("resources.size")}</p>
              <p className="font-medium">{formatBytes(resource.size_bytes)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-border/70 pt-4">
        <Button size="sm" variant="outline" onClick={() => onDownload(resource)}>
          <Download className="mr-1 h-4 w-4" />
          {t("common.download")}
        </Button>
      </div>
    </>
  );
}

// Lazy-load FilePreview to avoid circular imports and keep bundle split clean
function LazyFilePreview({
  resource,
  downloadUrl,
  onRefreshUrl,
}: {
  resource: Resource;
  downloadUrl: string;
  onRefreshUrl: () => Promise<string | undefined>;
}) {
  const [Preview, setPreview] = useState<React.ComponentType<{
    resource: Resource;
    downloadUrl: string;
    onRefreshUrl?: () => Promise<string | undefined>;
  }> | null>(null);

  useEffect(() => {
    import("./preview/FilePreview").then((mod) => {
      setPreview(() => mod.FilePreview);
    });
  }, []);

  if (!Preview) return null;
  return <Preview resource={resource} downloadUrl={downloadUrl} onRefreshUrl={onRefreshUrl} />;
}
