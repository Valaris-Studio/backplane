// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Info, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FieldError } from "./FieldError";
import type {
  PipelineValidationError,
  SchedulingDef,
} from "../../api/pipelineConfig";

interface SchedulingEditorProps {
  value: SchedulingDef;
  onChange: (next: SchedulingDef) => void;
  knownRoles: string[];
  errorsByPath: Map<string, PipelineValidationError[]>;
}

export function SchedulingEditor({
  value,
  onChange,
  knownRoles,
  errorsByPath,
}: SchedulingEditorProps) {
  const { t } = useTranslation();
  const rootId = useId();
  const fieldId = (name: string) => `${rootId}-${name}`;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = value.priority_order.indexOf(String(active.id));
    const newIdx = value.priority_order.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = [...value.priority_order];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved!);
    onChange({ ...value, priority_order: next });
  }

  function removeRole(role: string) {
    onChange({
      ...value,
      priority_order: value.priority_order.filter((r) => r !== role),
    });
  }

  function addRole(role: string) {
    if (!role || value.priority_order.includes(role)) return;
    onChange({ ...value, priority_order: [...value.priority_order, role] });
  }

  const addable = knownRoles.filter((r) => !value.priority_order.includes(r));

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>{t("pipelineBuilder.scheduling.priorityOrder")}</span>
          <RichTooltip i18nKey="pipelineBuilder.schedulingPriorityOrder" side="top">
            <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
          </RichTooltip>
        </h4>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={value.priority_order}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-1.5">
              {value.priority_order.map((role) => (
                <PriorityRow key={role} role={role} onRemove={() => removeRole(role)} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <FieldError errors={errorsByPath.get("scheduling.priority_order")} />

        {addable.length > 0 && (
          <div className="mt-2">
            <label htmlFor={fieldId("addRole")} className="sr-only">
              {t("pipelineBuilder.scheduling.addRole")}
            </label>
            <Select value="" onValueChange={addRole}>
              <SelectTrigger id={fieldId("addRole")} className="h-8 text-xs">
                <SelectValue placeholder={t("pipelineBuilder.scheduling.addRole")}>
                  <span className="text-muted-foreground">
                    <Plus className="mr-1 inline h-3 w-3" />
                    {t("pipelineBuilder.scheduling.addRole")}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {addable.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div>
        <label
          htmlFor={fieldId("mode")}
          className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground"
        >
          <span>{t("pipelineBuilder.scheduling.mode.label")}</span>
          <RichTooltip i18nKey="pipelineBuilder.schedulingMode" side="top">
            <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
          </RichTooltip>
        </label>
        <Select
          value={value.mode}
          onValueChange={(next) =>
            onChange({ ...value, mode: next as "priority" | "round_robin" })
          }
        >
          <SelectTrigger id={fieldId("mode")} className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="priority">
              {t("pipelineBuilder.scheduling.mode.priority")}
            </SelectItem>
            <SelectItem value="round_robin">
              {t("pipelineBuilder.scheduling.mode.roundRobin")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          {value.mode === "round_robin"
            ? t("pipelineBuilder.scheduling.mode.roundRobinHelp")
            : t("pipelineBuilder.scheduling.mode.priorityHelp")}
        </p>
      </div>
    </div>
  );
}

function PriorityRow({ role, onRemove }: { role: string; onRemove: () => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: role });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border/60 bg-[color:var(--color-surface-1)] px-2 py-1.5",
        isDragging && "opacity-60",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-muted"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="flex-1 text-sm">{role}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}
