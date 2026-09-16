// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Download,
  FileText,
  FolderClosed,
  MoreHorizontal,
  Pencil,
  Move,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Resource } from "@/types/resource";

function DraggableGridCard({
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

function DroppableGridFolder({
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

interface ResourceGridProps {
  resources: Resource[];
  onNavigateFolder: (folder: Resource) => void;
  onPreview: (resource: Resource) => void;
  onDownload: (resource: Resource) => void;
  onRename: (resource: Resource) => void;
  onMove: (resource: Resource) => void;
  onDelete: (resource: Resource) => void;
}

export function ResourceGrid({
  resources,
  onNavigateFolder,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onDelete,
}: ResourceGridProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 gap-3 p-[var(--card-padding)] sm:grid-cols-3 lg:grid-cols-4">
      {resources.map((resource) => {
        const isFolder = resource.resource_type === "folder";

        const card = (isOverDrop: boolean) => (
          <DraggableGridCard resource={resource}>
            <div
              className={cn(
                "group relative rounded-xl border border-border/70 bg-card transition-colors duration-200 hover:bg-[color:var(--color-surface-1)]",
                isOverDrop && isFolder && "ring-2 ring-primary/40 bg-primary/8",
              )}
            >
              <button
                type="button"
                className="flex w-full flex-col items-center p-4 text-center"
                onClick={() => {
                  if (isFolder) {
                    onNavigateFolder(resource);
                  } else {
                    onPreview(resource);
                  }
                }}
              >
                <div
                  className={cn(
                    "mb-3 flex h-14 w-14 items-center justify-center rounded-[var(--radius-cap)] shadow-soft",
                    isFolder
                      ? "bg-primary/10 text-primary"
                      : "bg-secondary text-secondary-foreground",
                  )}
                >
                  {isFolder ? (
                    <FolderClosed className="h-7 w-7" />
                  ) : (
                    <FileText className="h-7 w-7" />
                  )}
                </div>
                <p className="w-full truncate text-sm font-semibold text-foreground">
                  {resource.name}
                </p>
                {resource.resource_type === "file" && resource.size_bytes != null && (
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(resource.size_bytes)}
                  </p>
                )}
              </button>

              {resource.metadata?.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 px-3 pb-3">
                  {resource.metadata.tags.slice(0, 3).map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[0.6rem] px-1.5 py-0">
                      {tag}
                    </Badge>
                  ))}
                  {resource.metadata.tags.length > 3 && (
                    <Badge variant="outline" className="text-[0.6rem] px-1.5 py-0">
                      +{resource.metadata.tags.length - 3}
                    </Badge>
                  )}
                </div>
              )}

              <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {resource.resource_type === "file" && (
                      <DropdownMenuItem onClick={() => onPreview(resource)}>
                        <FileText className="h-4 w-4" />
                        {t("resources.preview")}
                      </DropdownMenuItem>
                    )}
                    {resource.resource_type === "file" && (
                      <DropdownMenuItem onClick={() => onDownload(resource)}>
                        <Download className="h-4 w-4" />
                        {t("common.download")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onRename(resource)}>
                      <Pencil className="h-4 w-4" />
                      {t("common.rename")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMove(resource)}>
                      <Move className="h-4 w-4" />
                      {t("resources.moveTo")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => onDelete(resource)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </DraggableGridCard>
        );

        if (isFolder) {
          return (
            <DroppableGridFolder key={resource.id} folderId={resource.id}>
              {(isOver) => card(isOver)}
            </DroppableGridFolder>
          );
        }
        return <div key={resource.id}>{card(false)}</div>;
      })}
    </div>
  );
}
