// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import es from "@/i18n/locales/es.json";

/**
 * Spanish copy shipped for months with stripped diacritics ("Configuracion",
 * "ejecucion", "rapido"). i18next has no opinion about orthography, so nothing
 * caught it until a native-reader visual pass did.
 *
 * This guard lists the unaccented spellings that are ALWAYS wrong in Spanish
 * prose. It is deliberately a denylist of known-bad forms rather than a
 * dictionary: a dictionary would fight every product noun in the catalog
 * ("Runner", "pipeline", "prompt", "merge"), which stay English by design.
 */
const MISSING_DIACRITIC_FORMS = [
  "accion",
  "analisis",
  "aplicacion",
  "aprobacion",
  "asignacion",
  "atras",
  "avanzo",
  "autenticacion",
  "automatico",
  "automaticamente",
  "autonomo",
  "autonoma",
  "boton",
  "cancelacion",
  "categoria",
  "clasificacion",
  "codigo",
  "conexion",
  "configuracion",
  "creacion",
  "critico",
  "decidio",
  "decision",
  "definicion",
  "descripcion",
  "despues",
  "documentacion",
  "duracion",
  "edicion",
  "ejecucion",
  "eliminacion",
  "estandar",
  "funcion",
  "historico",
  "informacion",
  "integracion",
  "iteracion",
  "maxima",
  "maximas",
  "maximo",
  "maximos",
  "metodo",
  "migracion",
  "minimo",
  "navegacion",
  "notificacion",
  "numero",
  "operacion",
  "opcion",
  "pagina",
  "parametro",
  "parametros",
  "posicion",
  "publico",
  "rapido",
  "rapida",
  "rapidos",
  "rapidas",
  "razon",
  "revision",
  "seleccion",
  "senal",
  "sesion",
  "sincronizacion",
  "tamano",
  "tambien",
  "titulo",
  "ultimo",
  "ultima",
  "ultimos",
  "ultimas",
  "unico",
  "unica",
  "validacion",
  "valido",
  "version",
];

/**
 * Prose that quotes API/JSON field names verbatim. The card's constraint is
 * explicit: commands, routes, enum values and API fields are preserved
 * byte-for-byte, so a sentence documenting a `{ decision, findings }` payload
 * must keep the field spelled the way the wire spells it.
 *
 * These are exemptions for the QUOTED IDENTIFIER only — the surrounding
 * Spanish in the same string is still checked, because the pattern below only
 * skips the braced fragment, not the whole value.
 */
const TECHNICAL_PROSE_KEYS = new Set([
  // "stages, scheduling, version" enumerates pipeline_config's own field names.
  "ui.tooltips.pipelineBuilder.pageExport.examples.0",
]);

// Braced fragments (`{{count}}` placeholders and `{ decision, findings }` code)
// plus inline-code spans are wire contracts, not prose — blank them before
// scanning while keeping the surrounding Spanish under review.
const TECHNICAL_FRAGMENT = /`[^`]*`|\{\{[^}]*\}\}|\{[^{}]*\}/g;

// The catalog is not uniformly string-valued: tooltip entries nest arrays of
// {label, value} rows, and the roles glossary carries boolean capability flags.
// Walk everything, collect only the strings.
function flatten(node: unknown, prefix = ""): Array<[string, string]> {
  if (typeof node === "string") return [[prefix, node]];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * JavaScript's `\b` treats accented letters as NON-word characters, so a plain
 * `\bseleccion\b` matches inside the perfectly correct "seleccionó".
 *
 * The lookarounds also exclude `_`, which keeps snake_case wire identifiers
 * (`produces_decision`, `post_process_kind`) out of the scan — those are enum
 * values the card's constraint requires preserved byte-for-byte.
 */
const DENY_PATTERN = new RegExp(
  `(?<![\\p{L}_])(${MISSING_DIACRITIC_FORMS.join("|")})(?![\\p{L}_])`,
  "iu",
);

describe("es.json orthography", () => {
  it("has no Spanish prose spelled without its required diacritics", () => {
    const offenders = flatten(es)
      .filter(([key]) => !TECHNICAL_PROSE_KEYS.has(key))
      .filter(([, value]) =>
        DENY_PATTERN.test(value.replace(TECHNICAL_FRAGMENT, " ")),
      )
      .map(([key, value]) => `${key}: ${value}`);

    expect(offenders).toEqual([]);
  });
});

/**
 * The denylist cannot cover forms that are ALSO valid Spanish words in another
 * sense ("aun" = even, "tomo" = volume), so the eight keys reported in card
 * 89f37324 are pinned verbatim here instead.
 */
const CANONICAL_ACCENTED_VALUES: Array<[string, string]> = [
  ["activity.entityTypes.definition", "Definición"],
  ["boardLoop.maxIterationsLabel", "Iteraciones máximas"],
  ["boardLoop.failuresLabel", "Fallos consecutivos máximos"],
  ["boardLoop.iterationLog.outcomes.worked", "Avanzó"],
  ["boardLoop.iterationsEmpty", "Aún no hay iteraciones del bucle."],
  [
    "boardLoop.telemetry.spend",
    "${{spent}} / ${{budget}} gastado (solo iteraciones recientes, no histórico completo)",
  ],
  ["definitions.decisionPlaceholder", "Qué se decidió..."],
  ["definitions.rationalePlaceholder", "Por qué se tomó esta decisión..."],
];

describe("es.json canonical accented copy", () => {
  const catalog = new Map(flatten(es));

  it.each(CANONICAL_ACCENTED_VALUES)("%s reads %j", (key, expected) => {
    expect(catalog.get(key)).toBe(expected);
  });
});
