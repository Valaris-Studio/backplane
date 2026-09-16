// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  LifecycleKindName,
  LifecycleStep,
} from "../../api/pipelineConfig";
import { LifecycleStepEditor } from "./LifecycleStepEditor";
import type { ResolvedLifecycleStepPrompt } from "./LifecycleLLMStepPrompt";

interface SortableLifecycleStepProps {
  step: LifecycleStep;
  dndId: string;
  peerStepNames: string[];
  knownKinds: LifecycleKindName[];
  role: string;
  workspaceSlug: string;
  // Pre-looked-up by LifecycleRoleCard for this step's stage token. Undefined
  // for non-LLM kinds or LLM steps without a stage; the prompt row component
  // itself short-circuits in those cases so we don't gate the render here.
  resolvedPrompt?: ResolvedLifecycleStepPrompt;
  onChange: (next: LifecycleStep) => void;
  onDelete: () => void;
}

// The sortable-list flavour of the step editor: wraps LifecycleStepEditor with
// dnd-kit chrome (drag handle + transform). The editor body itself is shared
// with the focused canvas inspector so both render identically.
export function SortableLifecycleStep({
  step,
  dndId,
  peerStepNames,
  knownKinds,
  role,
  workspaceSlug,
  resolvedPrompt,
  onChange,
  onDelete,
}: SortableLifecycleStepProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: dndId });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style}>
      <LifecycleStepEditor
        step={step}
        peerStepNames={peerStepNames}
        knownKinds={knownKinds}
        role={role}
        workspaceSlug={workspaceSlug}
        resolvedPrompt={resolvedPrompt}
        onChange={onChange}
        onDelete={onDelete}
        className={cn(isDragging && "opacity-60")}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            aria-label={t("pipeline.lifecycle.step.dragHandle")}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        }
      />
    </div>
  );
}
