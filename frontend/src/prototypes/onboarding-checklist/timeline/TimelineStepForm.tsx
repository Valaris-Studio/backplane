// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { StepId, StepStatus, StepView } from "../model";

interface TimelineStepFormProps {
  step: StepView;
  onComplete: (id: StepId) => void;
  onSkip: (id: StepId) => void;
  onRevisit: (id: StepId) => void;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </span>
  );
}

function BoardFields({ status }: { status: StepStatus }) {
  if (status !== "done") {
    return (
      <label className="grid gap-1.5">
        <FieldLabel>Nombre del tablero</FieldLabel>
        <Input defaultValue="Entrega del producto" data-timeline-initial-focus required />
      </label>
    );
  }

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-semibold">¿Qué tienes entre manos ahora mismo?</legend>
      {["Preparar el alcance", "Validar con clientes", "Publicar la primera versión"].map(
        (value, index) => (
          <Input
            key={value}
            defaultValue={value}
            aria-label="Título de tarjeta"
            data-timeline-initial-focus={index === 0 ? "true" : undefined}
          />
        ),
      )}
    </fieldset>
  );
}

function ContextFields() {
  return (
    <label className="grid gap-1.5">
      <FieldLabel>Objetivo principal</FieldLabel>
      <Textarea
        defaultValue="Lanzar la primera versión para clientes piloto y aprender de su uso real."
        className="min-h-24"
        data-timeline-initial-focus
        required
      />
    </label>
  );
}

function NotesFields() {
  return (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <FieldLabel>Título de la nota</FieldLabel>
        <Input defaultValue="Decisiones de arquitectura" data-timeline-initial-focus required />
      </label>
      <label className="grid gap-1.5">
        <FieldLabel>Contenido</FieldLabel>
        <Textarea
          defaultValue="Registrar aquí las decisiones que afecten la entrega y sus motivos."
          className="min-h-20"
          required
        />
      </label>
    </div>
  );
}

function MembersFields() {
  const [rows, setRows] = useState(1);
  return (
    <div className="grid gap-2.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <Input
            type="email"
            placeholder="persona@empresa.com"
            aria-label={`Correo del miembro ${index + 1}`}
            data-timeline-initial-focus={index === 0 ? "true" : undefined}
            required={index === 0}
          />
          <label>
            <span className="sr-only">Rol</span>
            <select
              aria-label={`Rol del miembro ${index + 1}`}
              className="h-9 w-full rounded-[var(--radius-md)] border border-input bg-[color:var(--color-surface-1)] px-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-2 focus:ring-ring/20"
              defaultValue="member"
            >
              <option value="member">Miembro</option>
              <option value="admin">Admin</option>
              <option value="viewer">Lector</option>
            </select>
          </label>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => setRows((current) => Math.min(current + 1, 3))}
        disabled={rows >= 3}
      >
        <Plus /> Sumar a alguien más
      </Button>
    </div>
  );
}

function ChannelsFields() {
  return (
    <label className="grid gap-1.5">
      <FieldLabel>Nombre del canal</FieldLabel>
      <Input defaultValue="general" data-timeline-initial-focus required />
    </label>
  );
}

function ReposFields() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1.5 sm:col-span-2">
        <FieldLabel>URL del repositorio</FieldLabel>
        <Input
          type="url"
          placeholder="https://github.com/empresa/proyecto"
          data-timeline-initial-focus
          required
        />
      </label>
      <label className="grid gap-1.5 sm:col-span-2">
        <FieldLabel>Nombre del repositorio</FieldLabel>
        <Input defaultValue="proyecto" required />
      </label>
    </div>
  );
}

function StepFields({ step }: { step: StepView }) {
  switch (step.id) {
    case "board":
      return <BoardFields status={step.status} />;
    case "context":
      return <ContextFields />;
    case "notes":
      return <NotesFields />;
    case "members":
      return <MembersFields />;
    case "channels":
      return <ChannelsFields />;
    case "repos":
      return <ReposFields />;
  }
}

function primaryAction(step: StepView): string {
  if (step.status === "done") {
    return step.id === "board" ? "Agregar tarjetas" : "Guardar cambios";
  }
  return step.action;
}

export function TimelineStepForm({
  step,
  onComplete,
  onSkip,
  onRevisit,
}: TimelineStepFormProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onComplete(step.id);
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <StepFields step={step} />
      <DialogFooter className="border-t border-border/60 pt-4">
        {step.status === "pending" ? (
          <Button type="button" variant="ghost" onClick={() => onSkip(step.id)}>
            {step.id === "members" ? "Por ahora trabajo en solitario" : "Omitir por ahora"}
          </Button>
        ) : step.status === "skipped" ? (
          <Button type="button" variant="ghost" onClick={() => onRevisit(step.id)}>
            Retomar
          </Button>
        ) : null}
        <Button type="submit">{primaryAction(step)}</Button>
      </DialogFooter>
    </form>
  );
}
