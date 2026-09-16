# Backplane product glossary

| Field | Value |
|---|---|
| Status | **APPROVED** |
| Version | 1.0 |
| Date | 2026-08-16 |
| Work item | I18N-6 |
| Decision note | `6aef0ccf-e0c1-49b6-a48e-006f704bc54f` |
| Languages | English (`en`), Spanish (`es`), Brazilian Portuguese (`pt-BR`) |

This document defines the canonical product terminology for Backplane. Matías
approved the shortlist in the “Approved decisions” table on 2026-08-16. The
second table records established terms that were already in use and were not
reopened by that decision.

## Scope

The glossary governs Backplane-owned, user-facing copy. It does not translate
user-authored content, agent-authored content, logs, diagnostics, source code,
commands, paths, URLs, API payloads, or third-party product names.

Locale catalogs and localized product content remain bundled, versioned assets
in this repository. Backplane does not depend on a runtime translation service
or an external availability dependency.

## Usage rules

1. Use the visible terms in the active locale when a concept appears in product
   copy.
2. Preserve technical identifiers exactly. Enum values, API fields, JSON and
   YAML keys, route segments, command names, and filenames are never translated.
3. Format a technical identifier as code when it appears inside prose. For
   example, show “Responsável principal” to the user but keep `hero` in an API
   payload.
4. Keep `Backplane`, `MCP`, `API`, `JSON`, `YAML`, and registered third-party
   names unchanged.
5. `Runner` names the credentialed Backplane process. `Agent` is a generic actor
   and is not a synonym for `Runner`.
6. A pipeline `Role` is distinct from a card participant kind such as `hero`,
   `helper`, `viewer`, or `stakeholder`.
7. Permission-level `Viewer` and participant-level `Viewer` are separate
   concepts and use different visible translations.
8. A pipeline `Stage` and a lifecycle `Step` are separate concepts. In PT-BR,
   use `Etapa` for Stage and `Passo` for Step.
9. Workspace `Owner`, card `Assignee`, and card participant `Hero` describe
   different relationships and must remain distinguishable in visible copy.
10. Grammatical inflection and capitalization are allowed when required by the
    sentence. The table records the canonical base form.
11. A change to a canonical term must update this glossary, all affected locale
    catalogs, localized product documentation, and the terminology contract in
    the same reviewed change.

## Approved decisions

| Concept | English | Spanish | Brazilian Portuguese | Technical identifier |
|---|---|---|---|---|
| Card | Card | Tarjeta | Cartão | `card` |
| Stage | Stage | Etapa | Etapa | `stage` |
| Lifecycle step | Step | Paso | Passo | `step` |
| Runner | Runner | Runner | Runner | `runner`, `agent` in legacy schemas |
| Agent | Agent | Agente | Agente | Context-dependent |
| Role | Role | Rol | Função | `role` |
| Workspace owner | Owner | Propietario | Proprietário | `owner` |
| Assignee | Assignee | Responsable | Responsável | `assignee` |
| Hero | Primary owner | Responsable principal | Responsável principal | `hero` |
| Helper | Collaborator | Colaborador | Colaborador | `helper` |
| Viewer, card participant | Observer | Observador | Observador | `viewer` |
| Viewer, permission | Viewer | Lector | Visualizador | `viewer` |
| Stakeholder | Stakeholder | Parte interesada | Parte interessada | `stakeholder` |
| Claim | Claim a card | Tomar una tarjeta | Assumir um cartão | `claim` |
| Label | Label | Etiqueta | Rótulo | `label` |
| Documentator | Documentation owner | Responsable de documentación | Responsável pela documentação | `documentator` |
| Git vocabulary | Branch, commit, merge, pull request or PR | Rama, commit, merge, pull request o PR | Branch, commit, merge, pull request ou PR | Git commands and fields remain unchanged |

## Established terms preserved by this decision

These terms remain canonical because they predate I18N-6. Their inclusion here
does not imply that the 2026-08-16 shortlist reopened or separately approved
them.

| Concept | English | Spanish | Brazilian Portuguese | Technical identifier |
|---|---|---|---|---|
| Workspace | Workspace | Espacio de trabajo | Espaço de trabalho | `workspace` |
| Board | Board | Tablero | Quadro | `board` |
| Column | Column | Columna | Coluna | `column` |
| Pipeline | Pipeline | Pipeline | Pipeline | `pipeline` |
| Backlog | Backlog | Backlog | Backlog | `backlog` |
| Active | Active | Activo | Ativo | `active` |
| Review | Review | Revisión | Revisão | `review` |
| Done | Done | Completado | Concluído | `done` |
| Blocked | Blocked | Bloqueado | Bloqueado | `blocked` |
| Prompt | Prompt | Prompt | Prompt | `prompt` |
| Orchestrator | Orchestrator | Orquestador | Orquestrador | `orchestrator` |
| Implementer | Implementer | Implementador | Implementador | `implementer` |
| Reviewer | Reviewer | Revisor | Revisor | `reviewer` |
| Planner | Planner | Planificador | Planejador | `planner` |
| Researcher | Researcher | Investigador | Pesquisador | `researcher` |

## Approval record

The terminology shortlist in “Approved decisions” was approved by Matías on
2026-08-16 and recorded in the Backplane board note linked above. This resolves
the terminology decision for I18N-6. Native-language copy review remains useful
as quality assurance, but does not reopen these terms unless it produces a
specific change proposal that the product owners accept.

## Change control

1. Treat this file as the product terminology source of truth.
2. Keep technical identifiers byte-stable even when their visible label changes.
3. Update English, Spanish, and PT-BR together.
4. Add or update a contract test for every canonical label exposed by more than
   one product surface.
5. Record future terminology changes as explicit product decisions before
   changing catalogs.
