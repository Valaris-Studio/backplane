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
  "agregalo",
  "algun",
  "analisis",
  "aplicacion",
  "aprobacion",
  "aqui",
  "asi",
  "asignacion",
  "atras",
  "autenticacion",
  "automaticamente",
  "automatico",
  "autonoma",
  "autonomo",
  "avanzo",
  "boton",
  "cancelacion",
  "categoria",
  "clasificacion",
  "codigo",
  "coincidira",
  "completalo",
  "conexion",
  "configuracion",
  "creacion",
  "critico",
  "decidio",
  "decision",
  "definicion",
  "dejalo",
  "descripcion",
  "despues",
  "dia",
  "dias",
  "direccion",
  "documentacion",
  "duracion",
  "edicion",
  "ejecucion",
  "ejecutara",
  "eliminacion",
  "estan",
  "estandar",
  "estara",
  "exito",
  "explicitamente",
  "finalizacion",
  "funcion",
  "historico",
  "informacion",
  "integracion",
  "iteracion",
  "linea",
  "maxima",
  "maximas",
  "maximo",
  "maximos",
  "membresias",
  "metodo",
  "metrica",
  "metricas",
  "migracion",
  "minimo",
  "navegacion",
  "ningun",
  "notificacion",
  "numerico",
  "numericos",
  "numero",
  "opcion",
  "operacion",
  "pagina",
  "parametro",
  "parametros",
  "podria",
  "posicion",
  "proxima",
  "proximo",
  "publico",
  "rapida",
  "rapidas",
  "rapido",
  "rapidos",
  "razon",
  "revision",
  "segun",
  "seleccion",
  "senal",
  "sera",
  "sesion",
  "sincronizacion",
  "tamano",
  "tambien",
  "tecnica",
  "tecnicas",
  "tecnico",
  "tecnicos",
  "telefono",
  "titulo",
  "todavia",
  "transicion",
  "traves",
  "ultima",
  "ultimas",
  "ultimo",
  "ultimos",
  "unica",
  "unico",
  "vacia",
  "vacio",
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
 * Forms that are correct Spanish in one sense and a missing accent in another
 * ("aun" = even / "aún" = still, "esta" = this / "está" = is, "mas" = but /
 * "más" = more, "limite" = may limit / "límite" = limit). A plain denylist
 * would false-fail the valid sense, so each is flagged only in the frames
 * where it can only be the accented word.
 */
const AMBIGUOUS_FORM_CONTEXTS: Array<[string, RegExp]> = [
  // "aun así" (even so) is correct unaccented; "aun no/sin" and a trailing
  // "aun" can only mean "still".
  ["aun = aún", /(?<![\p{L}_])aun(?:\s+(?:no|sin)(?![\p{L}_])|\s*[.!?]?$)/iu],
  // A demonstrative needs a noun after it; a preposition, a location or a
  // participle/adjective after "esta" makes it the verb. The word BEFORE is no
  // signal: "no esta pantalla" is a demonstrative.
  [
    "esta = está",
    /(?<![\p{L}_])esta\s+(?:en|dentro|vac[ií][oa]|activad[oa]|inactiv[oa]|congelad[oa]|bloquead[oa]|atascad[oa]|conectad[oa]|asignad[oa]|definid[oa]|autorad[oa]|disponible)(?![\p{L}_])/iu,
  ],
  // The adversative "mas" (but) is literary and never product copy; these
  // frames are the comparative.
  [
    "mas = más",
    /(?:(?<![\p{L}_])mas\s+(?:de|tarde|reciente|recientes)(?![\p{L}_])|(?<![\p{L}_])(?:cargar|carga|hay)\s+mas(?![\p{L}_])|(?<![\p{L}_])mas\s*[.!?]?$)/iu,
  ],
  // "que limite" / "no limites" are the verb; everywhere else it is the noun.
  ["limite = límite", /(?<![\p{L}_])(?<!(?:que|no)\s)limites?(?![\p{L}_])/iu],
  // Subjunctive "esté" after a "que" clause, followed by a state adjective
  // or participle. The adjectives are listed rather than matched by suffix:
  // the demonstrative "este" precedes nouns such as "estado" or "activo".
  [
    "este = esté",
    /(?<![\p{L}_])que(?![\p{L}_])[^.!?]*?(?<![\p{L}_])este\s+(?:accesible|disponible|vac[ií][oa]|list[oa]|en|conectad[oa]|habilitad[oa]|deshabilitad[oa]|bloquead[oa]|configurad[oa])(?![\p{L}_])/iu,
  ],
];

describe("es.json ambiguous forms in unambiguous frames", () => {
  const catalog = flatten(es).filter(([key]) => !TECHNICAL_PROSE_KEYS.has(key));

  it.each(AMBIGUOUS_FORM_CONTEXTS)("%s", (_rule, pattern) => {
    const offenders = catalog
      .filter(([, value]) => pattern.test(value.replace(TECHNICAL_FRAGMENT, " ")))
      .map(([key, value]) => `${key}: ${value}`);

    expect(offenders).toEqual([]);
  });

  it("still accepts the valid unaccented senses", () => {
    const validSenses = [
      "aun así requiere un tick humano",
      "esta tarjeta está en revisión",
      "Los nombres los declara el servidor, no esta pantalla.",
      "Lanza un runner para que limite el gasto",
      "Verifica que este tablero tenga un repo vinculado.",
      "Revisa que este estado vacío sea el esperado.",
    ];
    for (const sentence of validSenses) {
      for (const [rule, pattern] of AMBIGUOUS_FORM_CONTEXTS) {
        expect(pattern.test(sentence), `${rule} on "${sentence}"`).toBe(false);
      }
    }
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
