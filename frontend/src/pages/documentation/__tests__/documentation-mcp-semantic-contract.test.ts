// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  getDocumentationSourceStrings,
  LOCALIZED_SECTION_TRANSLATIONS,
} from "../section-registry";

type LocalizedDocumentationLanguage = "es" | "pt-BR";

interface DeliberateTechnicalTokenOmission {
  source: string;
  token: string;
  reason: string;
}

interface MissingTechnicalTokens {
  source: string;
  translation: string;
  missingTokens: string[];
}

interface DestructivelyCollapsedOperationalSegments {
  source: string;
  translation: string;
  sourceOperationalSegments: string[];
  translatedNarrativeSegments: string[];
}

interface SpanishSafetyCriticalTranslationContract {
  slug:
    | "mcp-tool-catalog"
    | "mcp-prompt-catalog"
    | "api-authentication-modes";
  source: string;
  clauses: Readonly<Record<string, RegExp>>;
}

const MCP_TOOL_CATALOG_SLUG = "mcp-tool-catalog";
const PROSE_DOTTED_ABBREVIATIONS = new Set(["e.g", "i.e"]);

const DELIBERATE_TECHNICAL_TOKEN_OMISSIONS: Record<
  LocalizedDocumentationLanguage,
  readonly DeliberateTechnicalTokenOmission[]
> = {
  es: [],
  "pt-BR": [],
};

const SOURCE_OPERATIONAL_MARKER =
  /\b(?:use|call|read|write|fetch|list|create|delete|remove|set|return|require|wait|check|pass|send|save|update|move|claim|retry|ensure|discover|inspect|verify|reject|fail|keep|clear|replace|must|cannot|never|only|before|after|until|when)\w*\b/i;

const SPANISH_SAFETY_CRITICAL_TRANSLATION_CONTRACTS: readonly SpanishSafetyCriticalTranslationContract[] =
  [
    {
      slug: "mcp-tool-catalog",
      source:
        "Verify the row is a real zombie first (list_executions status='inflight'); cancelling a live run lets the runner reserve new work while the old run keeps going.",
      clauses: {
        "verify a real zombie first": /(?:verifica|confirma).+primero.+zombi/iu,
        "live-run cancellation warning": /cancelar.+ejecuci[oó]n (?:activa|en curso)/iu,
        "runner can reserve new work": /runner.+reserv(?:e|ar).+(?:trabajo|tarea).+nuev/iu,
        "old run keeps going": /ejecuci[oó]n (?:anterior|original|antigua).+(?:sigue|contin[uú]a).+(?:ejecut)/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " and extracts the email claim. A missing or invalid JWT is a 403, not a fallback.",
      clauses: {
        "missing or invalid JWT gets 403": /JWT.+ausente.+inv[aá]lido.+403/iu,
        "invalid JWT does not fall back": /sin fallback/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " switches to invite-only. IAP and trusted-proxy requests receive HTTP 403 when the verified email has no existing account. The OIDC callback redirects with HTTP 302 to",
      clauses: {
        "verified unknown IAP or proxy identity gets 403": /IAP.+trusted proxy.+403.+correo verificado.+no tiene.+cuenta/iu,
        "OIDC callback redirects with 302": /callback.+OIDC.+redirige.+HTTP 302/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " instead; it does not return a 403 page from the callback. Neither path creates a fresh user row. The domain allowlist also gates the local-auth paths that mint a login-capable account: first-run setup and an admin invite that grants an initial password (a plain, passwordless membership invite is a deliberate act and is not domain-checked). Rejections are logged with reason codes such as ",
      clauses: {
        "OIDC callback does not return a 403 page": /callback.+no devuelve.+p[aá]gina 403/iu,
        "no fresh user is created": /ningun.+(?:camino|ruta).+crea.+(?:nueva )?fila.+usuario/iu,
        "allowlist gates first-run setup": /allowlist.+(?:setup|configuraci[oó]n inicial)/iu,
        "allowlist gates initial-password admin invites": /invitaci[oó]n.+admin.+contrase(?:ñ|n)a inicial/iu,
        "passwordless membership invite is not domain-checked": /invitaci[oó]n.+sin contrase(?:ñ|n)a.+no.+dominio/iu,
        "rejections carry diagnostic reason codes": /rechazo.+c[oó]digo.+(?:motivo|raz[oó]n)/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source: " so an auth outage is diagnosable from logs alone.",
      clauses: {
        "auth outage is diagnosable from logs alone": /ca[ií]da.+autenticaci[oó]n.+diagnostic.+solo.+logs/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " table serves a first-run setup screen: the first account created there becomes the instance's first user, and the setup route self-closes the moment any user exists (it reopens only if the table is ever empty again — an empty table means nobody can log in anyway). Passwords are stored as argon2id hashes with a 12-character minimum and no composition rules.",
      clauses: {
        "first account becomes first user": /primera cuenta.+primer usuario/iu,
        "setup closes once a user exists": /setup.+se cierra.+usuario/iu,
        "setup reopens only for an empty table": /solo.+(?:reabre|vuelve a abrir).+tabla.+vac[ií]a/iu,
        "empty table means nobody can sign in": /tabla.+vac[ií]a.+nadie.+iniciar sesi[oó]n/iu,
        "argon2id hashes": /hashes? argon2id/iu,
        "12-character minimum": /m[ií]nimo.+12 caracteres/iu,
        "no password composition rules": /sin reglas.+composici[oó]n/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " row, so it holds across replicas and restarts, and it expires on its own. On the wire a locked account, a wrong password, and a nonexistent email are all the same 401; operators can tell them apart from log reason codes.",
      clauses: {
        "lockout survives replicas and restarts": /r[eé]plicas.+reinicios/iu,
        "lockout expires automatically": /expira.+(?:s[ií] sol[oa]|autom[aá]ticamente)/iu,
        "locked, wrong-password and unknown-email responses match": /cuenta bloqueada.+contrase(?:ñ|n)a incorrecta.+correo.+inexistente.+401/iu,
        "operators diagnose by log reason code": /operador.+distinguir.+c[oó]digo.+(?:motivo|raz[oó]n).+log/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        " can add a member by email with an optional initial password (applied only if the account has no password yet), and can generate a temporary password for any member of that workspace — shown exactly once, and it clears an active lockout. That temporary password is the recovery path: there is no SMTP dependency and no email-based reset. Everyone can change their own password from the sidebar, which requires the current password.",
      clauses: {
        "initial password applies only to passwordless accounts": /contrase(?:ñ|n)a inicial.+solo.+cuenta.+no tiene.+contrase(?:ñ|n)a/iu,
        "temporary password is available for any member": /contrase(?:ñ|n)a temporal.+cualquier miembro/iu,
        "temporary password is shown exactly once": /se muestra.+una sola vez/iu,
        "temporary password clears an active lockout": /elimina.+bloqueo activo/iu,
        "temporary password is the recovery path": /contrase(?:ñ|n)a temporal.+v[ií]a de recuperaci[oó]n/iu,
        "recovery has no SMTP or email reset dependency": /no.+SMTP.+ni.+restablecimiento.+correo/iu,
        "self-service change requires current password": /cambiar.+propia.+requiere.+contrase(?:ñ|n)a actual/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        'string is displayed once in the "API key created" dialog and never again. The backend stores only the prefix and a hash. If a key is lost, there is no recovery path — revoke it and mint a new one. Don\'t share keys over chat, don\'t commit them to repos, and don\'t bake them into runner config files that will be checked in. Treat a leaked key as an incident: revoke first, investigate second.',
      clauses: {
        "key is displayed once and never again": /una sola vez.+nunca.+(?:vuelve|de nuevo)/iu,
        "backend stores only prefix and hash": /solo.+prefijo.+hash/iu,
        "lost keys cannot be recovered": /(?:no hay|no existe).+recuperaci[oó]n/iu,
        "lost keys must be revoked and replaced": /rev[oó]cala.+(?:crea|emite|genera).+nueva/iu,
        "keys stay out of chat, repos and runner config": /chat.+repositorio.+configuraci[oó]n.+runner/iu,
        "leaks are incidents with revoke-first response": /filtrada.+incidente.+revoca primero.+investiga despu[eé]s/iu,
      },
    },
  ];

const SPANISH_AUDITED_SEMANTIC_TRANSLATION_CONTRACTS: readonly SpanishSafetyCriticalTranslationContract[] =
  [
    {
      slug: "mcp-tool-catalog",
      source:
        "Only queued/merging entries hide a card from next_assignment — cancelling one of those un-hides it (other eligibility gates still apply); a conflict or failed entry was not hiding the card in the first place.",
      clauses: {
        "queued and merging entries hide the card": /queued\/merging.+ocultan.+next_assignment/iu,
        "cancellation makes the card visible again": /cancelar.+(?:visible|mostrar)/iu,
        "all other eligibility gates still apply": /siguen.+todas.+(?:puertas|condiciones).+elegibilidad/iu,
        "conflict and failed entries never hid it": /conflict.+failed.+nunca.+ocult/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Freeze a board: still readable by every member, but every mutation and runner pickup is rejected with board_frozen until the workspace owner unfreezes it.",
      clauses: {
        "every member retains read access": /todos los miembros.+(?:leer|legible)/iu,
        "mutations and runner pickup are rejected": /mutaci[oó]n.+(?:asignaci[oó]n|recogida).+board_frozen/iu,
        "workspace owner must unfreeze": /owner.+espacio de trabajo.+descongel/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Read a board's loop-mode config: enabled flag, prompts, provider/model, tool allowlist, safety caps, and disabled_reason (why the loop last stopped).",
      clauses: {
        "disabled_reason explains the last stop": /disabled_reason.+por qu[eé].+detuvo.+[uú]ltima vez/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "The runner re-fetches this config at the top of every iteration — edits apply on the next cycle without a restart.",
      clauses: {
        "configuration is fetched at iteration start": /inicio.+cada iteraci[oó]n/iu,
        "edits apply on the next cycle": /(?:ediciones|cambios).+ciclo siguiente/iu,
        "edits do not affect the current cycle": /no.+ciclo actual/iu,
        "restart is unnecessary": /sin reinicio|no requieren reinicio/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "The backend does not validate the list: nonexistent ids are silently skipped, omitted columns keep their old positions, and ids are never checked against this board — a partial or mixed-up list yields an unpredictable order. Always send exactly this board's full column id list.",
      clauses: {
        "nonexistent ids are silently skipped": /omite silenciosamente.+ids inexistentes/iu,
        "omitted columns retain old positions": /columnas omitidas.+posiciones/iu,
        "ids are not board checked": /ids.+nunca.+(?:comprueban|verifican).+tablero/iu,
        "partial or mixed lists are unpredictable": /lista parcial.+mezclada.+orden impredecible/iu,
        "exact full list for this board is required": /exactamente.+lista completa.+este tablero/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "pipeline_role removes every participant holding that role, and matches the pipeline_role field, not the display role (hero/viewer/stakeholder/helper).",
      clauses: {
        "every holder of the role is removed": /pipeline_role.+quita.+todos.+participantes.+ese rol/iu,
        "matches the pipeline_role field not the display role": /campo pipeline_role.+no.+rol visible/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "On rework, clear the stale implementer by pipeline_role rather than user_id — in multi-runner deployments the implementer is a different user than the mediator.",
      clauses: {
        "rework clears the implementer by pipeline_role not user_id": /devolver trabajo.+implementer.+pipeline_role.+no.+user_id/iu,
        "multi-runner implementer differs from the mediator": /varios runners.+implementer.+distinto.+mediador/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "git_repo_slug is preserved for each card. An unknown slug or a repository outside this board rejects the entire batch with 422; no cards are created. This does not change the historical create_card fallback.",
      clauses: {
        "git_repo_slug is preserved": /git_repo_slug.+conserva.+cada tarjeta/iu,
        "unknown or non-board repository rejects whole batch": /slug desconocido.+repositorio ajeno al tablero.+rechaza el lote completo.+422/iu,
        "no partial card creation": /no se crea ninguna tarjeta/iu,
        "single-create historical fallback unchanged": /no cambia.+hist[oó]rica.+create_card/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Request a specific role instead of the runner's primary role; must be a role the runner holds in its team.",
      clauses: {
        "requested role replaces primary role": /rol espec[ií]fico.+sustituye.+rol primario/iu,
        "replacement is assignment scoped": /para esa asignaci[oó]n/iu,
        "runner must hold the role in its team": /rol.+runner.+tenga.+equipo/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "A {\"status\": \"no_work\"} response is normal, not an error — sleep 60-120s and retry.",
      clauses: {
        "no_work is not an error": /\{"status": "no_work"\}.+normal.+no.+error/iu,
        "retry follows the wait": /espera.+60-120\s?s.+(?:vuelve a intentar|reintenta)/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "A paused runner gets no_work rather than an error; 423 means the workspace cost circuit breaker tripped — no cards are handed out until it clears.",
      clauses: {
        "paused runner gets no_work": /runner pausado.+no_work/iu,
        "423 identifies cost circuit breaker": /423.+circuit breaker.+costos/iu,
        "cards remain blocked until it clears": /no.+(?:entrega|asigna).+tarjeta.+hasta.+(?:libere|restablezca)/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Note kind — \"user_note\" (default) for free-form prose; pipeline kinds like \"plan\", \"rework_brief\", \"review_verdict\" are structural notes consumed by runner stages.",
      clauses: {
        "user_note is the free-prose default": /"user_note".+predeterminad.+prosa libre/iu,
        "structured kinds are named exactly": /"plan".+"rework_brief".+"review_verdict"/iu,
        "runner stages consume structured kinds": /notas estructurales.+consumidas.+etapas.+runner/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Send content as markdown — the backend normalizes markdown, HTML, plain text, and ProseMirror JSON to canonical ProseMirror before storing (headings h1-h3, bold/italic, code, lists, links, blockquotes).",
      clauses: {
        "all accepted input formats are named": /markdown.+HTML.+texto plano.+JSON.+ProseMirror/iu,
        "normalization happens before storage": /ProseMirror can[oó]nico.+antes.+almacenar/iu,
        "headings and emphasis survive normalization": /h1-h3.+negrita.+cursiva/iu,
        "code lists links and blockquotes survive": /c[oó]digo.+listas.+links.+citas/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Notes with kind=\"review_verdict\" are append-only audit records — updates are rejected with a permission error.",
      clauses: {
        "review_verdict is an audit record": /kind="review_verdict".+registro.+auditor[ií]a/iu,
        "record is append-only": /append-only/iu,
        "updates fail with permission error": /updates.+rechaz.+error.+permis/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Read a board's definition document — the scope, goals, conventions, and structured context to load before working on the board.",
      clauses: {
        "definition includes complete context": /alcance.+objetivos.+convenciones.+contexto/iu,
        "definition loads before work begins": /cargar.+antes.+(?:empezar|comenzar).+trabajar.+tablero/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Create or update a board's definition (idempotent upsert). Fields you pass are merged over the existing content; everything else is preserved.",
      clauses: {
        "operation is an idempotent upsert": /upsert idempotente/iu,
        "sent fields merge over existing content": /campos.+enviados.+fusionan.+contenido existente/iu,
        "omitted content is preserved": /(?:omitido|dem[aá]s).+conserva/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Merge is shallow and per-key: sending a list field replaces that whole list, so read-modify-write when appending.",
      clauses: {
        "merge is shallow per key": /merge.+superficial.+clave/iu,
        "list fields replace the whole list": /campo.+lista.+reemplaza.+lista completa/iu,
        "append requires read modify write": /(?:lee|leer).+(?:modifica|modificar).+(?:escribe|escribir)/iu,
        "workflow prevents data loss": /sin perder datos/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Role uniqueness is pipeline-config-driven: roles whose stage is marked unique (all seven default pipeline roles) allow one runner per team; roles not flagged unique allow several.",
      clauses: {
        "role uniqueness comes from pipeline_config": /unicidad.+pipeline_config/iu,
        "seven default roles are unique": /siete roles predeterminados.+unique/iu,
        "unique roles allow one runner per team": /un runner por equipo/iu,
        "non-unique roles allow several": /no.+unique.+varios/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Omitting both roles and role defaults the member to [\"custom\"] — that is NOT role-agnostic (custom is not a pipeline role). The backend treats an empty roles list as claim-every-pipeline-role, but this tool never sends one; pass explicit roles for pipeline members.",
      clauses: {
        "omission defaults to custom": /omitir roles y role.+\["custom"\]/iu,
        "custom is not role agnostic": /NO.+agn[oó]stico.+custom.+no.+rol.+pipeline/iu,
        "empty roles means claim every pipeline role": /lista.+roles vac[ií]a.+reclamar.+todos los roles.+pipeline/iu,
        "tool never sends an empty list": /herramienta.+nunca env[ií]a.+lista vac[ií]a/iu,
        "pipeline members need explicit roles": /roles expl[ií]citos.+miembros.+pipeline/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Explicit URL slug (lowercase alphanum + hyphens); derived from name when omitted.",
      clauses: {
        "slug is lowercase alphanumeric with hyphens": /slug.+alfanum[eé]ricos.+min[uú]scula.+guiones/iu,
        "slug derives from name when omitted": /deriva.+name.+omite/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "New URL slug (lowercase alphanum + hyphens, unique within the board).",
      clauses: {
        "new slug is lowercase alphanumeric with hyphens": /slug.+alfanum[eé]ricos.+min[uú]scula.+guiones/iu,
        "new slug is board unique": /[uú]nico.+tablero/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Payloads are signed HMAC-SHA256 with your secret: the X-Webhook-Signature-256 header carries sha256=<hex> and X-Webhook-Event names the event — verify on the receiver.",
      clauses: {
        "payload uses HMAC-SHA256": /payloads.+HMAC-SHA256/iu,
        "signature header contains sha256 hex": /X-Webhook-Signature-256.+sha256=<hex>/iu,
        "event header identifies the event": /X-Webhook-Event.+identifica.+evento/iu,
        "receiver verifies the signature": /verifica.+receptor/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "The URL is SSRF-guarded at registration: https-only outside development, and hosts resolving to private/internal addresses are rejected.",
      clauses: {
        "SSRF guard runs at registration": /SSRF.+registr/iu,
        "HTTPS is required outside development": /fuera de desarrollo.+solo.+HTTPS/iu,
        "private and internal resolved addresses are rejected": /rechaz.+hosts.+resuelv.+direcciones privadas.+internas/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Re-creating an existing runner is idempotent but returns raw_api_key null (a lost key requires rotation) — and silently reactivates the runner if it had been deactivated.",
      clauses: {
        "recreation is idempotent": /volver a crear.+idempotente/iu,
        "raw_api_key is null": /raw_api_key null/iu,
        "lost key requires rotation": /clave perdida.+requiere rotaci[oó]n/iu,
        "deactivated runner is silently reactivated": /desactivado.+reactiva silenciosamente/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Passing card_id flips the card to 'actively worked' presence on the board immediately — always bind it for card-scoped runs.",
      clauses: {
        "card_id marks active presence immediately": /card_id.+['"]actively worked['"].+inmediato/iu,
        "card_id is always bound for card-scoped runs": /vinc[uú]lalo siempre.+ejecuciones.+alcance de tarjeta/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "A late 'failed' write to an already-completed execution keeps status completed (the other fields still apply); failed → completed stays allowed — the runner's close is authoritative.",
      clauses: {
        "late failed preserves completed": /'failed'.+conserva.+completed/iu,
        "all other fields still apply": /dem[aá]s campos.+aplican/iu,
        "failed to completed remains allowed": /failed → completed.+permit/iu,
        "runner close is authoritative": /cierre.+runner.+autoritativo/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "A typo'd execution_id may not 404: when the runner has exactly one in-flight execution, the backend applies the write to that row instead — double-check the id before cancelling.",
      clauses: {
        "mistyped execution_id may not return 404": /execution_id.+err[oó]neo.+puede no devolver 404/iu,
        "fallback requires exactly one inflight execution": /exactamente una ejecuci[oó]n.+in-?flight/iu,
        "backend writes to that row": /backend.+escritura.+esa fila/iu,
        "id is double checked before cancellation": /verifica.+id.+antes.+cancelar/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "enabled_tools is what THIS session can actually call — the registered surface intersected with the allowlist (allowlist null = unrestricted).",
      clauses: {
        "enabled_tools is callable session surface": /enabled_tools.+sesi[oó]n.+llamar/iu,
        "surface intersects registered tools and allowlist": /intersecci[oó]n.+superficie registrada.+allowlist|superficie registrada.+intersecci[oó]n.+allowlist/iu,
        "allowlist null means unrestricted": /allowlist null.+irrestricto/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "`pipeline_config` is never null in the response: an unconfigured workspace gets the platform-default multi-role pipeline (the read even seeds it onto a stored record whose pipeline is null).",
      clauses: {
        "pipeline_config is never null in response": /`pipeline_config`.+nunca.+null.+respuesta/iu,
        "unconfigured workspace gets platform default": /espacio.+sin configurar.+predeterminado.+plataforma/iu,
        "read can persist the default": /lectura.+(?:persist|guarda)/iu,
        "stored null pipeline is seeded": /registro almacenado.+pipeline.+null/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source: "Per-model $/token overrides; merges over platform defaults.",
      clauses: {
        "values are per-model overrides": /overrides.+\$\/token.+modelo/iu,
        "overrides merge over platform defaults": /fusionan.+predeterminados.+plataforma/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Re-importing is idempotent: prompts with identical content are skipped, differing content updates in place. Requires workspace admin/owner role.",
      clauses: {
        "reimport is idempotent": /reimportar.+idempotente/iu,
        "identical prompts are skipped": /prompts.+contenido id[eé]ntico.+omiten/iu,
        "different prompts update in place": /contenido diferente.+actualiza.+in situ/iu,
        "admin or owner role is required": /requiere.+admin\/owner/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.",
      clauses: {
        "bootstrap creates the complete project surface": /tablero.+columnas.+definici[oó]n.+canales.+tarjetas.+nota.+repositorio git/iu,
        "named team members become workspace members": /miembros.+nombrados.+brief.+agregan.+miembros.+espacio de trabajo/iu,
        "membership grants workspace access": /concede.+acceso.+espacio/iu,
        "bootstrap is used once per new project": /una sola vez.+proyecto nuevo/iu,
      },
    },
    {
      slug: "mcp-tool-catalog",
      source:
        "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.",
      clauses: {
        "backlog cards are sequenced": /tarjetas.+backlog.+secuenciadas/iu,
        "cards are one to three days each": /1-3 d[ií]as.+cada/iu,
        "ACCEPT card gates the sequence": /controladas.+tarjeta.+aceptaci[oó]n.+ACCEPT-/iu,
        "intended for a new feature or work chunk": /feature nueva.+bloque de trabajo/iu,
      },
    },
    {
      slug: "mcp-prompt-catalog",
      source:
        "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.",
      clauses: {
        "prompt bootstrap creates the complete project surface": /tablero.+columnas.+definici[oó]n.+canales.+tarjetas.+nota.+repositorio git/iu,
        "prompt adds named team members": /miembros.+nombrados.+brief.+agregan.+miembros.+espacio de trabajo/iu,
        "prompt grants workspace access": /concede.+acceso.+espacio/iu,
        "prompt is used once per new project": /una sola vez.+proyecto nuevo/iu,
      },
    },
    {
      slug: "api-authentication-modes",
      source:
        "Instance-level authority is deliberately derived from workspace roles — there is no separate admin flag. The corollary: on an instance with several workspaces owned by different people, each of those owners (and their admins) can create instance-wide accounts and set temporary passwords for their own members. If that is too broad for your deployment, keep workspace ownership narrow. Two more honest notes: changing a password does not invalidate sessions minted earlier (the cookie is stateless), and admin-set passwords are not flagged temporary — nothing forces a rotation on first login.",
      clauses: {
        "there is no separate admin flag": /no existe.+(?:admin flag|indicador.+admin)/iu,
        "different workspace owners have instance authority": /varios espacios.+personas distintas.+owner.+admins/iu,
        "owners can create instance-wide accounts": /crear cuentas.+toda la instancia/iu,
        "owners can set member temporary passwords": /contrase(?:ñ|n)as temporales.+propios miembros/iu,
        "mitigation is narrow workspace ownership": /limita.+ownership.+espacios de trabajo/iu,
        "password change does not invalidate old sessions": /cambiar.+contrase(?:ñ|n)a.+no invalida.+sesiones/iu,
        "admin-set passwords do not force first-login rotation": /admin.+no.+temporales.+nada obliga.+rotar.+primer inicio/iu,
      },
    },
  ];

function extractTechnicalTokens(value: string): string[] {
  const inlineCodeTokens = [...value.matchAll(/`([^`\n]+)`/gu)].flatMap(
    ([, token]) => (token === undefined ? [] : [token]),
  );
  const identifiers = [
    ...value.matchAll(
      /(?<![\p{L}\p{N}_])(?:[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|\*))+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\p{L}\p{N}_])/gu,
    ),
  ].map(([identifier]) => identifier);

  return [
    ...new Set(
      [...inlineCodeTokens, ...identifiers].filter(
        (token) => !PROSE_DOTTED_ABBREVIATIONS.has(token),
      ),
    ),
  ];
}

function isDeliberateTechnicalTokenOmission(
  locale: LocalizedDocumentationLanguage,
  source: string,
  token: string,
): boolean {
  return DELIBERATE_TECHNICAL_TOKEN_OMISSIONS[locale].some(
    (omission) =>
      omission.source === source &&
      omission.token === token &&
      omission.reason.trim().length > 0,
  );
}

function collectMissingTechnicalTokens(
  locale: LocalizedDocumentationLanguage,
): MissingTechnicalTokens[] {
  const translations =
    LOCALIZED_SECTION_TRANSLATIONS[locale][MCP_TOOL_CATALOG_SLUG] ?? {};

  return getDocumentationSourceStrings(MCP_TOOL_CATALOG_SLUG).flatMap(
    (source) => {
      const translation = translations[source] ?? "";
      const missingTokens = extractTechnicalTokens(source).filter(
        (token) =>
          !translation.includes(token) &&
          !isDeliberateTechnicalTokenOmission(locale, source, token),
      );

      return missingTokens.length > 0
        ? [{ source, translation, missingTokens }]
        : [];
    },
  );
}

function splitNarrativeSegments(value: string): string[] {
  return value
    .split(/(?:[.!?](?:\s+|$)|\s+[—–]\s+|;\s*)/u)
    .map((segment) => segment.trim())
    .filter((segment) => /[\p{L}\p{N}]/u.test(segment));
}

function collectDestructivelyCollapsedOperationalSegments(
  locale: LocalizedDocumentationLanguage,
): DestructivelyCollapsedOperationalSegments[] {
  const translations =
    LOCALIZED_SECTION_TRANSLATIONS[locale][MCP_TOOL_CATALOG_SLUG] ?? {};

  return getDocumentationSourceStrings(MCP_TOOL_CATALOG_SLUG).flatMap(
    (source) => {
      const translation = translations[source] ?? "";
      const sourceOperationalSegments = splitNarrativeSegments(source).filter(
        (segment) => SOURCE_OPERATIONAL_MARKER.test(segment),
      );
      const translatedNarrativeSegments = splitNarrativeSegments(translation);

      return sourceOperationalSegments.length >= 3 &&
        translatedNarrativeSegments.length < 2
        ? [
            {
              source,
              translation,
              sourceOperationalSegments,
              translatedNarrativeSegments,
            },
          ]
        : [];
    },
  );
}

function collectMissingSpanishSafetyCriticalClauses(): string[] {
  return [
    ...SPANISH_SAFETY_CRITICAL_TRANSLATION_CONTRACTS,
    ...SPANISH_AUDITED_SEMANTIC_TRANSLATION_CONTRACTS,
  ].flatMap(
    ({ slug, source, clauses }) => {
      const translation = LOCALIZED_SECTION_TRANSLATIONS.es[slug]?.[source];
      if (translation === undefined) return [`${slug}: missing source mapping`];

      return Object.entries(clauses).flatMap(([clause, pattern]) =>
        pattern.test(translation) ? [] : [`${slug}: ${clause}`],
      );
    },
  );
}

describe("documentation semantic localization contract", () => {
  it.each(["es", "pt-BR"] as const)(
    "preserves every inline-code and snake_case/dotted token in %s",
    (locale) => {
      const violations = collectMissingTechnicalTokens(locale);
      const missingTokenCount = violations.reduce(
        (count, violation) => count + violation.missingTokens.length,
        0,
      );

      expect(
        violations,
        `${locale}: ${violations.length} source strings lost ${missingTokenCount} technical tokens`,
      ).toEqual([]);
    },
  );

  it.each(["es", "pt-BR"] as const)(
    "preserves safety-critical operational meaning in %s without a length heuristic",
    (locale) => {
      const violations =
        collectDestructivelyCollapsedOperationalSegments(locale);
      expect(
        violations,
        `${locale}: ${violations.length} source strings destructively collapsed operational clauses`,
      ).toEqual([]);
    },
  );

  it("pins all 35 independently audited Spanish semantic mappings", () => {
    expect(SPANISH_AUDITED_SEMANTIC_TRANSLATION_CONTRACTS).toHaveLength(35);
    expect(
      SPANISH_AUDITED_SEMANTIC_TRANSLATION_CONTRACTS.reduce(
        (count, { clauses }) => count + Object.keys(clauses).length,
        0,
      ),
    ).toBe(118);
  });

  it("preserves audited Spanish semantic clauses that technical-token parity cannot detect", () => {
    expect(collectMissingSpanishSafetyCriticalClauses()).toEqual([]);
  });
});
