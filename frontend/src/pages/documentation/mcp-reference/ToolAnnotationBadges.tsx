// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";
import { useDocumentationCopy } from "../use-documentation-copy";
import type { ServerSurfaceAnnotations } from "./data";

const BADGE_BASE =
  "rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em]";

function AnnotationBadge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return <span className={cn(BADGE_BASE, className)}>{label}</span>;
}

// Mirrors the MCP tool annotations the model receives on the wire; each hint
// renders only when the server sets it.
export function ToolAnnotationBadges({
  annotations,
}: {
  annotations: ServerSurfaceAnnotations;
}) {
  const { copy } = useDocumentationCopy();
  return (
    <>
      {annotations.readOnlyHint ? (
        <AnnotationBadge
          label={copy.mcpReference.annotationReadOnly}
          className="border-border text-muted-foreground"
        />
      ) : null}
      {annotations.destructiveHint ? (
        <AnnotationBadge
          label={copy.mcpReference.annotationDestructive}
          className="border-destructive/50 bg-destructive/10 text-destructive"
        />
      ) : null}
      {annotations.idempotentHint ? (
        <AnnotationBadge
          label={copy.mcpReference.annotationIdempotent}
          className="border-foreground/30 text-foreground/80"
        />
      ) : null}
    </>
  );
}
