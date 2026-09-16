// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StepId, StepView } from "../model";

export interface TimelineVariantProps {
  steps: StepView[];
  progress: number;
  activeStepId: StepId;
  onOpen: (id: StepId) => void;
}

export interface TimelineStepCopy {
  label: string;
  intro: string;
  bullets: readonly string[];
}

export const ESSENTIAL_META = {
  name: "Rail esencial",
  hypothesis:
    "Seis píldoras alineadas y un progreso punteado muy sutil hacen visible el avance sin competir con el resto del panel.",
} as const;

export const TIMELINE_COPY: Record<StepId, TimelineStepCopy> = {
  board: {
    label: "Tablero",
    intro:
      "Un tablero es donde el trabajo se vuelve visible. En lugar de tenerlo todo en la cabeza o repartido en chats, cada pieza de trabajo se convierte en una tarjeta que avanza por columnas.",
    bullets: [
      "Las tarjetas guardan el detalle: descripción, prioridad, conversación e historial.",
      "Las columnas vienen tipadas desde el inicio, así el avance se lee de un vistazo.",
      "Todo lo demás en Backplane, como contexto, notas y repositorios, cuelga de un tablero.",
    ],
  },
  context: {
    label: "Definición",
    intro:
      "La definición del proyecto es lo que alguien necesita saber antes de poder ayudar. Escrita una sola vez, evita volver a explicar el proyecto a cada compañero y agente que llegue después.",
    bullets: [
      "Los objetivos y las restricciones quedan junto al trabajo que definen.",
      "La búsqueda llega hasta ellos, así las respuestas aparecen en vez de volver a preguntarse.",
      "Los agentes los leen primero y alinean lo que producen con tu intención.",
    ],
  },
  notes: {
    label: "Notas",
    intro:
      "Las notas y los recursos evitan que el conocimiento del proyecto se disperse. Guías, decisiones y enlaces viven junto a los tableros a los que pertenecen.",
    bullets: [
      "Fija lo importante para que quede arriba a la vista de todos.",
      "Adjunta notas a un tablero o a una tarjeta, o déjalas para todo el espacio.",
    ],
  },
  members: {
    label: "Equipo",
    intro:
      "Traer a tu equipo convierte el espacio en terreno compartido. Todos ven los mismos tableros, notas y canales, y el proyecto deja de vivir en una sola persona.",
    bullets: [
      "Los roles deciden quién puede cambiar qué: invita como miembro, admin o lector.",
      "Tu equipo recibe el panorama completo, no un resumen reenviado.",
    ],
  },
  channels: {
    label: "Canal",
    intro:
      "Los canales le dan un hogar a la conversación. Las decisiones y los hilos quedan unidos al espacio de trabajo en vez de perderse en un historial imposible de buscar.",
    bullets: [
      "Cada canal reúne la conversación de un tema o de un público.",
      "Quien llegue después puede leer cómo se tomó una decisión.",
    ],
  },
  repos: {
    label: "Git",
    intro:
      "Vincular un repositorio cierra el círculo entre la planificación y el código. Las tarjetas apuntan al código que modifican y los agentes saben dónde trabajar cuando toman una.",
    bullets: [
      "Las tarjetas y los commits siguen conectados al mismo proyecto.",
      "Los runners necesitan un repositorio vinculado antes de abrir un pull request.",
    ],
  },
};

export function getTimelineLabel(id: StepId): string {
  return TIMELINE_COPY[id].label;
}
