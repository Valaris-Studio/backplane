// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import {
  FileText,
  GitBranch,
  Kanban,
  MessageSquare,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react";

export type StepId =
  | "board"
  | "context"
  | "notes"
  | "members"
  | "channels"
  | "repos";

export type StepStatus = "pending" | "done" | "skipped";
export type StepGroup = "Proyecto" | "Colaboración" | "Automatización";

export interface PrototypeStep {
  id: StepId;
  icon: LucideIcon;
  title: string;
  hint: string;
  group: StepGroup;
  action: string;
  optional?: boolean;
}

export interface StepView extends PrototypeStep {
  status: StepStatus;
}

export interface OnboardingVariantProps {
  steps: StepView[];
  resolvedCount: number;
  progress: number;
  activeStepId: StepId;
  onComplete: (id: StepId) => void;
  onSkip: (id: StepId) => void;
  onRevisit: (id: StepId) => void;
}

export const INITIAL_STEPS: readonly PrototypeStep[] = [
  {
    id: "board",
    icon: Kanban,
    title: "Lleva el control de lo que hay que hacer",
    hint: "Un tablero ordena las tarjetas desde To Do hasta Done.",
    group: "Proyecto",
    action: "Crear tablero",
  },
  {
    id: "context",
    icon: FileText,
    title: "Cuéntale a Backplane en qué estás trabajando",
    hint: "Unas pocas frases orientan al equipo y a los futuros agentes.",
    group: "Proyecto",
    action: "Guardar contexto",
  },
  {
    id: "notes",
    icon: StickyNote,
    title: "Guarda lo que sabes junto al trabajo",
    hint: "Decisiones, hallazgos y archivos quedan cerca de los tableros.",
    group: "Proyecto",
    action: "Crear nota",
  },
  {
    id: "members",
    icon: Users,
    title: "Trae a tu equipo",
    hint: "Tu equipo comparte tableros, notas, canales y decisiones.",
    group: "Colaboración",
    action: "Invitar miembro",
  },
  {
    id: "channels",
    icon: MessageSquare,
    title: "Dale un lugar a las conversaciones",
    hint: "Los canales conservan decisiones e hilos fáciles de encontrar.",
    group: "Colaboración",
    action: "Crear canal",
  },
  {
    id: "repos",
    icon: GitBranch,
    title: "Conecta el código",
    hint: "Vincula tarjetas y código cuando el proyecto lo necesite.",
    group: "Automatización",
    action: "Vincular repositorio",
    optional: true,
  },
] as const;

const INITIAL_STATUS: Record<StepId, StepStatus> = {
  board: "done",
  context: "done",
  notes: "done",
  members: "done",
  channels: "pending",
  repos: "done",
};

export function usePrototypeChecklist(): OnboardingVariantProps {
  const [statusByStep, setStatusByStep] =
    useState<Record<StepId, StepStatus>>(INITIAL_STATUS);
  const [activeStepId, setActiveStepId] = useState<StepId>("channels");

  const steps = useMemo(
    () =>
      INITIAL_STEPS.map((step) => ({
        ...step,
        status: statusByStep[step.id],
      })),
    [statusByStep],
  );

  const resolvedCount = steps.filter((step) => step.status !== "pending").length;

  function resolveStep(id: StepId, status: Exclude<StepStatus, "pending">) {
    const nextStatus = { ...statusByStep, [id]: status };
    const nextPending = INITIAL_STEPS.find(
      (step) => nextStatus[step.id] === "pending",
    );

    setStatusByStep(nextStatus);
    setActiveStepId(nextPending?.id ?? id);
  }

  function revisitStep(id: StepId) {
    setStatusByStep((current) => ({ ...current, [id]: "pending" }));
    setActiveStepId(id);
  }

  return {
    steps,
    resolvedCount,
    progress: (resolvedCount / steps.length) * 100,
    activeStepId,
    onComplete: (id) => resolveStep(id, "done"),
    onSkip: (id) => resolveStep(id, "skipped"),
    onRevisit: revisitStep,
  };
}
