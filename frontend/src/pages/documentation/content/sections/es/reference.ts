// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

const ES_MCP_TOOL_CATALOG = {
  "Full UUID of the card.": "UUID completo de la tarjeta.",
  "Read the effective completion policy, inheritance, capabilities and incompatibilities.": "Lee la política efectiva de finalización, su herencia, capacidades e incompatibilidades.",
  "Read the current candidate, exact source and merge revisions, and public completion history.": "Lee el candidato actual, las revisiones exactas de origen y fusión y el historial público de finalización.",
  "Submit current execution provenance for source or operator-selected evidence-only completion.": "Envía la procedencia de la ejecución actual para finalizar código o evidencia seleccionada por el operador.",
  "Request policy-authorized merge-queue landing for the current candidate.": "Solicita la fusión mediante la cola autorizada por la política para el candidato actual.",
  "Retry a failed resumable completion phase on the current candidate.": "Reintenta una fase de finalización fallida que puede reanudarse en el candidato actual.",
  "This iteration's execution UUID, supplied by the runner.": "UUID de ejecución de esta iteración, proporcionado por el runner.",
  "Full source commit SHA for evidence-only work.": "SHA completo del commit de origen para trabajo de evidencia.",
  "Exact artifact records: [{name, uri, sha256}].": "Registros exactos de artefactos: [{name, uri, sha256}].",
  "Named check results: [{id, source_sha, exit_code, output}].": "Resultados de comprobaciones: [{id, source_sha, exit_code, output}].",
  "Proposed unsaved loop rails for fit or preview.": "Parámetros propuestos del loop sin guardar para fit o preview.",
  "Exact published template version; use with draft=false.": "Versión publicada exacta de la plantilla; usa draft=false.",
  "Select draft text with true or published text with false; rehearsals default to draft and full reads default to published.": "Selecciona el borrador con true o el texto publicado con false; los ensayos usan el borrador y las lecturas completas usan la versión publicada por defecto.",
  "For fit or preview: proposed slot values. Explicit values take precedence over board autofill and template defaults.": "Para fit o preview: valores de slots propuestos. Los valores explícitos tienen prioridad sobre el autocompletado del tablero y los valores predeterminados.",
  "Before binding, rehearse with draft=false and the exact published version. Unavailable versions conflict before writes. Lint reads the draft.": "Antes de vincular, ensaya con draft=false y la versión publicada exacta. Las versiones no disponibles fallan antes de escribir. Lint lee el borrador.",
  "Prerequisites follow the effective completion policy: accepted or Done release. Legacy boards still use the done-type column.": "Los requisitos previos siguen la política efectiva: liberación al aceptar o al pasar a Done. Los tableros heredados siguen usando la columna de tipo done.",


  "Browse a bounded page of workspace-level or board notes. Bodies are omitted by default; read one note with get_note(format=\"markdown\").": "Consulta una página acotada de notas del espacio de trabajo o del tablero. Los cuerpos se omiten de forma predeterminada; lee una nota con get_note(format=\"markdown\").",
  "Omit content bodies (default: true). Set false only when the bounded page needs raw ProseMirror bodies.": "Omite los cuerpos content (default: true). Usa false solo cuando la página acotada necesite cuerpos ProseMirror sin convertir.",
  "Returns {notes, total, limit, offset, has_more, next_offset, _hint}, not a bare list. Follow next_offset with unchanged filters until has_more=false.": "Devuelve {notes, total, limit, offset, has_more, next_offset, _hint}, no una lista directa. Sigue next_offset con los mismos filtros hasta has_more=false.",
  "Pages are a live view, not a snapshot: restart at offset=0 if notes change during traversal. An older backend without pagination metadata fails explicitly.": "Las páginas muestran datos actuales, no una instantánea: reinicia en offset=0 si las notas cambian durante el recorrido. Un backend anterior sin metadatos de paginación falla explícitamente.",
  "card_id requires board_id and combines with q, pinned_only and kinds before pagination. Without board_id, only workspace-level notes are listed.": "card_id requiere board_id y se combina con q, pinned_only y kinds antes de paginar. Sin board_id, solo se enumeran las notas del espacio de trabajo.",
  "Case-insensitive substring in title and plain-text body, applied before paging.": "Subcadena sin distinción de mayúsculas en el título y el cuerpo de texto plano, aplicada antes de paginar.",
  "Only pinned notes when true (default: false).": "Solo notas fijadas cuando es true (default: false).",
  "Match any listed note kind, such as plan or review_verdict.": "Coincide con cualquiera de los tipos de nota indicados, como plan o review_verdict.",
  "Page size, 1–100 (default: 25).": "Tamaño de página, 1–100 (default: 25).",
  "Zero-based offset (default: 0); reuse next_offset with the same filters.": "Desplazamiento desde cero (default: 0); reutiliza next_offset con los mismos filtros.",
  "List of card objects. Each needs column_id and title; optional: description, card_type, priority, due_date, status, labels and git_repo_slug.": "Lista de objetos de tarjeta. Cada uno necesita column_id y title; opcionales: description, card_type, priority, due_date, status, labels y git_repo_slug.",
  "git_repo_slug is preserved for each card. An unknown slug or a repository outside this board rejects the entire batch with 422; no cards are created. This does not change the historical create_card fallback.": "git_repo_slug se conserva en cada tarjeta. Un slug desconocido o un repositorio ajeno al tablero rechaza el lote completo con 422; no se crea ninguna tarjeta. Esto no cambia la alternativa histórica de create_card.",
  "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.": "Las respuestas de escritura pueden contener JSON ProseMirror sin convertir, identificado por _content_format o _description_format y _hint. No reutilices una respuesta como markdown editable: lee get_note(format=\"markdown\") o get_card, o conserva tu markdown original antes de editar.",

  "Set these nullable fields to null: due_date, status, labels, pr_url, branch_name, git_repo_slug. For example, clear_fields=[\"due_date\"].":
    "Establece estos campos anulables en null: due_date, status, labels, pr_url, branch_name, git_repo_slug. Por ejemplo, clear_fields=[\"due_date\"].",
  "Omitted fields and explicit null values keep their current values. Use clear_fields to remove nullable values; setting and clearing the same field is rejected. Use description=\"\" to clear a description, and labels=[] for an empty label list.":
    "Los campos omitidos y los valores null explícitos conservan sus valores actuales. Usa clear_fields para borrar valores anulables; no se permite establecer y borrar el mismo campo. Usa description=\"\" para borrar una descripción y labels=[] para una lista de etiquetas vacía.",
  "List product documentation from the connected platform, including version and translation status.": "Lista la documentación del producto de la plataforma conectada, incluida la versión y el estado de traducción.",
  "Read a bounded Markdown section from the connected platform.": "Lee una sección Markdown acotada de la plataforma conectada.",
  "Registered documentation locale: en, es or pt-BR.": "Idioma registrado de la documentación: en, es o pt-BR.",
  "Section offset, starting at zero.": "Desplazamiento de secciones, comenzando en cero.",
  "Maximum sections to return (1–100).": "Cantidad máxima de secciones a devolver (1–100).",
  "Section slug returned by list_documentation.": "Slug de sección devuelto por list_documentation.",
  "Version returned by list_documentation; a mismatch fails explicitly.": "Versión devuelta por list_documentation; una discrepancia falla explícitamente.",
  "Character offset for continuing a section.": "Desplazamiento de caracteres para continuar una sección.",
  "Maximum characters to return (1–30000).": "Cantidad máxima de caracteres a devolver (1–30000).",
  "Follow next_offset with the same locale and version. No bundled documentation fallback is used.": "Sigue next_offset con el mismo idioma y versión. No se usa documentación local como alternativa.",
  "Product documentation contains no workspace data. Normal authentication and MCP allowlists still apply.": "La documentación del producto no contiene datos del espacio de trabajo. Se siguen aplicando la autenticación normal y las listas de permitidos MCP.",

  "Start here": "Empieza aquí",
  "Work management": "Gestión del trabajo",
  "Knowledge & content": "Conocimiento y contenido",
  "Collaboration": "Colaboración",
  "Autonomous operations": "Operaciones autónomas",
  "Project Context": "Contexto del proyecto",
  "Search": "Búsqueda",
  "Assignments": "Asignaciones",
  "Bulk Operations": "Operaciones masivas",
  "Board Health": "Salud del tablero",
  "Server Info": "Información del servidor",
  "Workspaces": "Espacios de trabajo",
  "Boards": "Tableros",
  "Columns": "Columnas",
  "Cards": "Tarjetas",
  "Card Dependencies": "Dependencias de tarjetas",
  "Notes": "Notas",
  "Definitions": "Definiciones",
  "Resources": "Recursos",
  "Activity": "Actividad",
  "Teams": "Equipos",
  "Channels": "Canales",
  "Git Repos": "Repositorios Git",
  "Webhooks": "Webhooks",
  "Agents & Executions": "Agentes y ejecuciones",
  "Approvals": "Aprobaciones",
  "Merge Queue": "Cola de merge",
  "Workspace Config": "Configuración del espacio de trabajo",
  "Prompt Configs": "Configuraciones de prompts",
  "Enqueue a card's pull request for the platform merge queue: the executor rebases and lands it once CI is green, and the reconciler moves the card to Done.":
    "Encola el pull request de una tarjeta en la cola de merge de la plataforma: el ejecutor hace rebase y lo integra cuando la CI está en verde, y el reconciliador mueve la tarjeta a Done.",
  "UUID of the card the pull request belongs to.":
    "UUID de la tarjeta a la que pertenece el pull request.",
  "UUID of the board's git repo (see list_git_repos).":
    "UUID del repositorio git del tablero; consulta list_git_repos.",
  "The pull request's URL.": "URL del pull request.",
  "The pull request's head branch name.":
    "Nombre de la rama head del pull request.",
  "Target branch; defaults to the repo's integration branch, then its default branch.":
    "Rama de destino. Usa primero la rama de integración del repositorio y, si no existe, su rama predeterminada.",
  "This is the INITIAL enqueue — distinct from enqueue_for_merge, which only RE-queues an existing entry after conflict consolidation.":
    "Este es el encolado INICIAL. Es distinto de enqueue_for_merge, que solo vuelve a encolar una entrada existente después de consolidar conflictos.",
  "Runner callers on a loop-configured board need the board's loop config to opt in with loop_landing=\"merge_queue\" — otherwise the backend rejects with loop_landing_not_enabled (per-board owner decision; humans are never gated).":
    "Los runners que llaman desde un tablero con loop configurado necesitan que la configuración del tablero habilite loop_landing=\"merge_queue\". De lo contrario, el backend rechaza la solicitud con loop_landing_not_enabled. Es una decisión del owner por tablero y nunca limita a las personas.",
  "A red or pending CI blocks the merge (retryable ci_not_green state) until checks go green; repos with no CI at all merge as before.":
    "Una CI roja o pendiente bloquea el merge con el estado reintentable ci_not_green hasta que los checks estén en verde. Los repositorios sin CI se integran como antes.",
  "Idempotent: an already-queued card returns its existing entry.":
    "Idempotente: una tarjeta que ya está en cola devuelve su entrada existente.",
  "Permanently delete a workspace and everything inside it. The widest-blast-radius tool on the server — confirm the slug with list_workspaces first.":
    "Elimina permanentemente un espacio de trabajo y todo su contenido. Es la herramienta de mayor alcance destructivo del servidor; confirma primero el slug con list_workspaces.",
  "The URL slug identifying the workspace to delete.":
    "Slug de URL que identifica el espacio de trabajo que se eliminará.",
  "Requires workspace admin or owner rights — the backend gate is the authorization boundary.":
    "Requiere permisos de admin u owner del espacio de trabajo. La validación del backend es el límite de autorización.",
  "Idempotent: deleting an already-deleted workspace reports that calmly instead of erroring, so a retrying agent converges.":
    "Idempotente: eliminar un espacio de trabajo ya eliminado lo informa sin generar error, por lo que un agente que reintenta converge.",
  "Irreversible cascade: deletes every board in the workspace (with their columns, cards, definitions, and git-repo bindings) plus the workspace's notes, resources, channels, and memberships. No undo, no archive, no export step.":
    "Cascada irreversible: elimina todos los tableros del espacio de trabajo, incluidas columnas, tarjetas, definiciones y vínculos a repositorios git, además de notas, recursos, canales y membresías. No hay deshacer, archivo ni paso de exportación.",
  "Secrets are never returned — read a webhook's id here, then use update_webhook to rotate the secret if you need to.":
    "Los secrets nunca se devuelven. Lee aquí el id de un webhook y usa update_webhook para rotar el secret si es necesario.",
  "Read one webhook's URL, subscribed events, active state, and delivery health (last delivery, failure count) by id.":
    "Consulta por id la URL, los eventos suscritos, el estado activo y la salud de entrega de un webhook, incluidos la última entrega y el número de fallos.",
  "The workspace slug that owns the webhook.":
    "Slug del espacio de trabajo propietario del webhook.",
  "The UUID of the webhook to read.": "UUID del webhook que se consultará.",
  "Workspace-scoped: a webhook belonging to another workspace reads as not-found, so the slug must be the one it was created under.":
    "Tiene alcance de espacio de trabajo: un webhook de otro espacio se devuelve como not-found, por lo que el slug debe ser aquel con el que se creó.",
  "A climbing failure_count means the receiver is rejecting deliveries — check the URL and the signature verification on their side.":
    "Un failure_count en aumento indica que el receptor rechaza entregas. Comprueba la URL y la verificación de firma del receptor.",
  "The UUID of the webhook to update.": "UUID del webhook que se actualizará.",
  "New delivery URL, re-validated against the same SSRF guard as create_webhook.":
    "Nueva URL de entrega, validada de nuevo con la misma protección SSRF que create_webhook.",
  "Replacement event list — see create_webhook for the vocabulary. This replaces the subscription wholesale.":
    "Lista de eventos de reemplazo; consulta el vocabulario en create_webhook. Sustituye toda la suscripción.",
  "New HMAC signing secret.": "Nuevo secret de firma HMAC.",
  "False pauses deliveries without deleting the registration; true resumes.":
    "False pausa las entregas sin eliminar el registro; true las reanuda.",
  "events REPLACES the current list, it does not merge — read the webhook first and pass the full set you want.":
    "events REEMPLAZA la lista actual, no hace merge. Lee primero el webhook y envía el conjunto completo que deseas conservar.",
  "Rotating the secret invalidates signatures the receiver was verifying with the old one; update both sides together.":
    "Rotar el secret invalida las firmas que el receptor verificaba con el valor anterior. Actualiza ambos lados al mismo tiempo.",
  "Workspace-scoped: a webhook belonging to another workspace reads as not-found.":
    "Tiene alcance de espacio de trabajo: un webhook de otro espacio se devuelve como not-found.",
  "Change a webhook's URL, events, signing secret, or active state; only passed fields change. delete=true removes the registration for good instead.":
    "Cambia la URL, los eventos, el secret de firma o el estado activo de un webhook; solo cambian los campos enviados. delete=true elimina el registro de forma definitiva en su lugar.",
  "delete=true is permanent. Deliveries stop at once and the registration cannot be restored — pause with is_active=false when you may want it back.":
    "delete=true es permanente. Las entregas se detienen de inmediato y el registro no se puede restaurar; pausa con is_active=false si podrías querer recuperarlo.",
  "True permanently removes the webhook (no undo); must be the only field besides the ids. Prefer is_active=false to pause.":
    "True elimina el webhook de forma permanente (sin deshacer); debe ser el único campo además de los ids. Prefiere is_active=false para pausar.",
  "delete=true accepts no other field — a call mixing edits with the delete is rejected before any request is sent.":
    "delete=true no acepta ningún otro campo: una llamada que mezcle ediciones con la eliminación se rechaza antes de enviar cualquier solicitud.",
  "Idempotent: deleting an already-gone webhook reports so calmly instead of erroring, so a retried call converges.":
    "Idempotente: eliminar un webhook que ya no existe lo informa sin generar error, por lo que una llamada reintentada converge.",
  "Declare that one card must finish before another can start. Use when ordering work — the scheduler will not assign a card until all its prerequisites are done.":
    "Declara que una tarjeta debe terminar antes de que otra pueda empezar. Úsalo para ordenar el trabajo: el scheduler no asignará una tarjeta hasta que se completen todos sus prerrequisitos.",
  "URL slug identifying the workspace.": "Slug de URL que identifica el espacio de trabajo.",
  "UUID of the board (URL scope, resolved for routing).":
    "UUID del tablero (alcance de la URL, resuelto para el enrutamiento).",
  "Full UUID of the card that depends on another, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta que depende de otra, o un prefijo de id único (≥4 caracteres).",
  "Full UUID of the prerequisite card, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta prerrequisito, o un prefijo de id único (≥4 caracteres).",
  "Both card ids accept a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.":
    "Ambos ids de tarjeta aceptan un prefijo de id corto (≥4 caracteres), que se resuelve dentro de este tablero. Un prefijo ambiguo devuelve un error con la lista de candidatos.",
  "Idempotent: re-adding an existing edge returns the existing row instead of erroring.":
    "Idempotente: volver a agregar una arista existente devuelve la fila actual en vez de generar un error.",
  "Cycles and self-dependencies are rejected with a 422 error — the graph stays acyclic.":
    "Los ciclos y las autodependencias se rechazan con un error 422; el grafo se mantiene acíclico.",
  "Edges are workspace-scoped, not board-checked: linking cards on different boards succeeds, but validate_board_dependencies flags such edges as orphans.":
    "Las aristas tienen alcance de espacio de trabajo, no se validan por tablero: vincular tarjetas de tableros distintos funciona, pero validate_board_dependencies marca esas aristas como orphans.",
  "Remove a depends-on edge between two cards. Use to unblock a card when a prerequisite no longer applies.":
    "Elimina una arista de dependencia entre dos tarjetas. Úsalo para desbloquear una tarjeta cuando un prerrequisito deje de corresponder.",
  "UUID of the board.": "UUID del tablero.",
  "Full UUID of the dependent card, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta dependiente, o un prefijo de id único (≥4 caracteres).",
  "Full UUID of the prerequisite card to unlink, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta prerrequisito que se desvinculará, o un prefijo de id único (≥4 caracteres).",
  "Both card ids accept a short id prefix (≥4 chars), resolved against this board.":
    "Ambos ids de tarjeta aceptan un prefijo de id corto (≥4 caracteres), que se resuelve dentro de este tablero.",
  "Idempotent: removing an edge that does not exist succeeds as a no-op.":
    "Idempotente: eliminar una arista inexistente funciona sin producir cambios.",
  "List a card's dependency edges in both directions: the cards it depends on and the cards it blocks. Use to inspect wiring before adding or removing edges.":
    "Enumera las aristas de dependencia de una tarjeta en ambas direcciones: las tarjetas de las que depende y las que bloquea. Úsalo para revisar las conexiones antes de agregar o eliminar aristas.",
  "Full UUID of the card, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta, o un prefijo de id único (≥4 caracteres).",
  "card_id accepts a short id prefix (≥4 chars), resolved against this board.":
    "card_id acepta un prefijo de id corto (≥4 caracteres), que se resuelve dentro de este tablero.",
  "depends_on = this card's prerequisites; blocks = cards waiting on this one.":
    "depends_on = prerrequisitos de esta tarjeta; blocks = tarjetas que esperan a esta.",
  "Edges carry the other card's title, status, and column type — often enough without fetching each card.":
    "Las aristas incluyen el título, el status y el tipo de columna de la otra tarjeta; suele bastar sin consultar cada tarjeta.",
  "Check a whole board's dependency graph for cycles, conflicts, and dangling edges. Use before sprint planning or when cards seem stuck for no clear reason.":
    "Comprueba el grafo de dependencias de un tablero completo en busca de ciclos, conflictos y aristas colgantes. Úsalo antes de planificar un sprint o cuando las tarjetas parezcan bloqueadas sin una razón clara.",
  "UUID of the board to validate.": "UUID del tablero que se validará.",
  "Read-only: reports faults but fixes nothing — repair with add/remove/bulk_set_card_dependencies or by moving cards.":
    "Solo lectura: informa fallas, pero no corrige nada. Repara con add/remove/bulk_set_card_dependencies o moviendo las tarjetas.",
  "Cards trapped in a cycle can never become eligible for pickup until the loop is broken.":
    "Las tarjetas atrapadas en un ciclo nunca serán elegibles para asignación hasta que se rompa el ciclo.",
  "conflicts = done cards whose prerequisites are not done; orphans = edges pointing at cards not on this board.":
    "conflicts = tarjetas done cuyos prerrequisitos no están done; orphans = aristas que apuntan a tarjetas fuera de este tablero.",
  "Answer whether a card is unblocked in one call: is every prerequisite done, and if not, exactly which cards still block it. Use before scheduling or picking up work.":
    "Responde en una llamada si una tarjeta está desbloqueada: ¿todos sus prerrequisitos están terminados? Si no, indica exactamente qué tarjetas aún la bloquean. Úsalo antes de programar o tomar trabajo.",
  "Full UUID of the card to check, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta que se comprobará, o un prefijo de id único (≥4 caracteres).",
  "card_id accepts a short id prefix (≥4 chars); the returned card_id is always the resolved full UUID.":
    "card_id acepta un prefijo de id corto (≥4 caracteres); el card_id devuelto siempre es el UUID completo resuelto.",
  "satisfied mirrors the exact condition the scheduler gates pickup on: every prerequisite in a done-type column.":
    "satisfied refleja la condición exacta con la que el scheduler habilita la asignación: cada prerrequisito debe estar en una columna de tipo done.",
  "blocking lists only the unfinished prerequisites, each with title, status, and column type — the finish-first list.":
    "blocking enumera solo los prerrequisitos sin terminar, cada uno con título, status y tipo de columna: la lista de lo que debe completarse primero.",
  "Fetch the latest review verdict on a card — the decision and the reviewer's reasoning. Use during rework to learn why the card was approved or rejected.":
    "Obtén el veredicto de revisión más reciente de una tarjeta: la decisión y el razonamiento del reviewer. Úsalo durante el retrabajo para saber por qué se aprobó o rechazó.",
  "Full UUID of the card whose verdict you want, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta cuyo veredicto quieres consultar, o un prefijo de id único (≥4 caracteres).",
  "Returns a structured 404 error when the card has never been reviewed — expect it for un-reviewed cards.":
    "Devuelve un error 404 estructurado cuando la tarjeta nunca se revisó; es esperable en tarjetas sin revisión.",
  "Replace a card's entire depends-on set atomically in one call. Use when planning to declare a card's full prerequisite list instead of adding edges one by one.":
    "Reemplaza de forma atómica todo el conjunto depends-on de una tarjeta en una llamada. Úsalo al planificar para declarar la lista completa de prerrequisitos en vez de agregar aristas una por una.",
  "Full UUID of the card whose dependencies you are replacing, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta cuyas dependencias se reemplazarán, o un prefijo de id único (≥4 caracteres).",
  "Full replacement list of prerequisite cards, each a full UUID or a unique id prefix (≥4 chars). An empty list clears every dependency.":
    "Lista completa de reemplazo de tarjetas prerrequisito; cada elemento puede ser un UUID completo o un prefijo de id único (≥4 caracteres). Una lista vacía elimina todas las dependencias.",
  "Every id accepts a short prefix (≥4 chars), each costing one resolve round-trip — pass full UUIDs for large sets.":
    "Cada id acepta un prefijo corto (≥4 caracteres), pero cada uno requiere un viaje de ida y vuelta para resolverse; usa UUIDs completos en conjuntos grandes.",
  "REPLACES the whole set: edges missing from the list are removed, and an empty list clears every dependency.":
    "REEMPLAZA el conjunto completo: se eliminan las aristas ausentes de la lista y una lista vacía borra todas las dependencias.",
  "All-or-nothing: the proposed set is validated for cycles before any change — on rejection existing edges are untouched.":
    "Todo o nada: el conjunto propuesto se valida contra ciclos antes de cambiar nada. Si se rechaza, las aristas actuales quedan intactas.",
  "Ask a human to approve a high-impact action (deletion, deployment, bulk change) before running it. Use when about to do something risky, then wait for the decision.":
    "Pide a una persona que apruebe una acción de alto impacto (eliminación, deployment o cambio masivo) antes de ejecutarla. Úsalo antes de una acción riesgosa y espera la decisión.",
  "Risk category: deletion, bulk_change, deployment, schema_change, permission_change, or external_action.":
    "Categoría de riesgo: deletion, bulk_change, deployment, schema_change, permission_change o external_action.",
  "Human-readable description of what will happen if approved.":
    "Descripción legible de lo que ocurrirá si se aprueba.",
  "JSON payload of the action to execute once approved.":
    "Payload JSON de la acción que se ejecutará tras la aprobación.",
  "UUID of the requesting agent.": "UUID del agente solicitante.",
  "Board UUID if the action is board-scoped.":
    "UUID del tablero si la acción tiene alcance de tablero.",
  "Do not proceed after calling — poll get_approval_status until the request is approved or rejected.":
    "No continúes después de llamar: consulta get_approval_status hasta que la solicitud se apruebe o rechace.",
  "Low-risk requests can come back auto_approved immediately, with no human involved.":
    "Las solicitudes de bajo riesgo pueden volver como auto_approved de inmediato, sin intervención humana.",
  "expires_at is stamped 24 hours out, but nothing ever flips the stored status to expired — a stale undecided request still reads pending; compare expires_at yourself.":
    "expires_at se fija 24 horas hacia adelante, pero nada cambia el status almacenado a expired; una solicitud antigua sin decisión sigue como pending. Compara expires_at por tu cuenta.",
  "List approval requests in a workspace, optionally filtered by status. Use to discover what is waiting on a decision when you have no approval id in hand.":
    "Enumera las solicitudes de aprobación de un espacio de trabajo, con filtro opcional por status. Úsalo para descubrir qué espera una decisión cuando no tienes un id de aprobación.",
  "Filter: pending, approved, rejected, expired, or auto_approved. Approvers usually want pending.":
    "Filtro: pending, approved, rejected, expired o auto_approved. Quien aprueba suele buscar pending.",
  "status is the only filter — there is no board, agent, or category filter; scan the results yourself.":
    "status es el único filtro; no existe filtro por tablero, agente o categoría. Revisa los resultados.",
  "Discover-then-decide: find pending requests here, then act on each with decide_approval.":
    "Primero descubre y luego decide: encuentra aquí las solicitudes pending y procesa cada una con decide_approval.",
  "Check where one approval request stands: pending, approved, rejected, expired, or auto_approved. Use to poll after request_approval before acting.":
    "Consulta el estado de una solicitud de aprobación: pending, approved, rejected, expired o auto_approved. Úsalo para sondear después de request_approval antes de actuar.",
  "Approval id returned by request_approval.": "Id de aprobación devuelto por request_approval.",
  "auto_approved means policy granted it without a human — treat it as approved.":
    "auto_approved significa que la política lo concedió sin una persona; trátalo como approved.",
  "The expired status exists in the enum but the backend never sets it — a past-deadline request still reads pending. Compare expires_at yourself; if it has passed, treat the request as dead and file a fresh one.":
    "El status expired existe en el enum, pero el backend nunca lo asigna; una solicitud vencida sigue como pending. Compara expires_at. Si ya pasó, considera la solicitud terminada y crea otra.",
  "Approve or reject a pending approval request as the human in the loop. Use after reviewing what a request asks, typically discovered via list_approvals.":
    "Aprueba o rechaza una solicitud pending como la persona responsable. Úsalo después de revisar lo solicitado, normalmente descubierto con list_approvals.",
  "UUID of the approval request to decide.": "UUID de la solicitud de aprobación que se decidirá.",
  "Either 'approved' or 'rejected'.": "'approved' o 'rejected'.",
  "Reason recorded alongside the decision.": "Motivo registrado junto con la decisión.",
  "Only pending requests can be decided — an already-decided one returns a 409 conflict.":
    "Solo se pueden decidir solicitudes pending; una ya decidida devuelve un conflicto 409.",
  "Expiry is not enforced here: a request past its expires_at still reads pending and can still be decided.":
    "Aquí no se aplica el vencimiento: una solicitud posterior a expires_at sigue como pending y aún puede decidirse.",
  "A decision is final: there is no un-approve or un-reject; the requester must file a new request.":
    "La decisión es definitiva: no se puede deshacer una aprobación ni un rechazo; el solicitante debe crear otra solicitud.",
  "List a workspace's in-flight merge queue entries — queued, merging, conflict, failed, or blocked. Use to see what is waiting to land or wedged.":
    "Enumera las entradas en curso de la cola de merge de un espacio de trabajo: queued, merging, conflict, failed o blocked. Úsalo para ver qué espera integrarse o está atascado.",
  "Also return entries merged within this many hours, 1..720. Omitted, merged entries are excluded.":
    "Devuelve también las entradas integradas dentro de esta cantidad de horas, de 1 a 720. Si se omite, las entradas merged quedan excluidas.",
  "Only merged is terminal and it is excluded by default — pass merged_within_hours to see recently landed work.":
    "Solo merged es terminal y se excluye de forma predeterminada; envía merged_within_hours para ver el trabajo integrado recientemente.",
  "blocked_pending_consolidation entries DO show up: they are still in flight, parked until their consolidator card lands.":
    "Las entradas blocked_pending_consolidation SÍ aparecen: siguen en curso, estacionadas hasta que se integre su tarjeta consolidadora.",
  "Entry state is a closed enum: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflict with a consolidator card on the board).":
    "El estado de la entrada es un enum cerrado: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflicto con una tarjeta consolidadora del tablero).",
  "Fetch one merge queue entry by id to inspect its state, branch, and attempt history. Use when triaging a specific stuck or failed merge.":
    "Obtén una entrada de la cola de merge por id para revisar su estado, rama e historial de intentos. Úsalo al diagnosticar un merge específico atascado o fallido.",
  "UUID of the merge queue entry.": "UUID de la entrada de la cola de merge.",
  "Re-queue a card's existing merge-queue entry so the merge is retried, typically after a conflict was resolved. Use when a failed or conflicted merge is now fixable.":
    "Vuelve a encolar la entrada existente de una tarjeta para reintentar el merge, normalmente tras resolver un conflicto. Úsalo cuando un merge fallido o en conflicto ya se pueda corregir.",
  "UUID of the original (parent) card whose merge entry should be retried.":
    "UUID de la tarjeta original (padre) cuya entrada de merge debe reintentarse.",
  "Despite the name, this calls the RE-enqueue endpoint: it 404s unless a merge-queue entry already exists for the card — initial enqueueing happens inside the merge worker.":
    "Pese al nombre, llama al endpoint de RE-enqueue: devuelve 404 si todavía no existe una entrada para la tarjeta. El enqueue inicial ocurre dentro del merge worker.",
  "Idempotent: if the entry is already queued, the existing row is returned with no side effects.":
    "Idempotente: si la entrada ya está queued, devuelve la fila actual sin efectos secundarios.",
  "The retry happens on the merge worker's next tick, not immediately; each retry increments the entry's attempt count.":
    "El reintento ocurre en el siguiente ciclo del merge worker, no de inmediato; cada reintento aumenta el contador de intentos.",
  "No state guard: an entry in ANY non-queued state — including one already merged — is reset to queued, and the worker will attempt the merge again.":
    "No hay protección por estado: una entrada en CUALQUIER estado distinto de queued, incluso merged, vuelve a queued y el worker intentará el merge otra vez.",
  "Remove a merge queue entry so a wedged conflict or failure stops holding the card. Use when human triage needs to take a merge out of the automated path.":
    "Elimina una entrada de la cola de merge para que un conflicto o fallo atascado deje de retener la tarjeta. Úsalo cuando una persona deba sacar un merge del flujo automático.",
  "UUID of the merge queue entry to cancel.":
    "UUID de la entrada de la cola de merge que se cancelará.",
  "Admin/owner only — regular workspace members get a 403.":
    "Solo admin/owner; los miembros normales reciben 403.",
  "Deletes the entry row permanently — there is no undo; re-queueing later requires the worker to create a fresh entry.":
    "Elimina la fila de forma permanente; no se puede deshacer. Para volver a encolarla, el worker deberá crear una entrada nueva.",
  "Only queued/merging entries hide a card from next_assignment — cancelling one of those un-hides it (other eligibility gates still apply); a conflict or failed entry was not hiding the card in the first place.":
    "Solo las entradas queued/merging ocultan una tarjeta de next_assignment; cancelar una de ellas vuelve a hacer visible la tarjeta, pero siguen aplicándose todas las demás puertas de elegibilidad. Una entrada conflict o failed nunca ocultó la tarjeta.",
  "List every workspace you can access. Use it first in a session to discover the workspace_slug that all other workspace-scoped tools require.":
    "Enumera todos los espacios de trabajo accesibles. Úsalo primero para descubrir el workspace_slug que exigen las demás herramientas.",
  "Fetch one workspace's metadata — name, slug, owner, timestamps. Use when you already know the slug and need details, not the roster or counts.":
    "Obtén los metadatos de un espacio de trabajo: nombre, slug, owner y timestamps. Úsalo cuando ya conozcas el slug y necesites detalles.",
  "The URL slug identifying the workspace.": "Slug de URL que identifica el espacio de trabajo.",
  "Does NOT return the member roster — use list_workspace_members for people.":
    "NO devuelve los miembros; usa list_workspace_members.",
  "Entity counts come back null here — only list_workspaces and get_workspace_summary compute them.":
    "Aquí los recuentos de entidades son null; solo list_workspaces y get_workspace_summary los calculan.",
  "List a workspace's members with user_id, email, name, and role. Use it to resolve a person to their user_id before participant or removal calls.":
    "Enumera los miembros con user_id, email, nombre y rol. Úsalo para resolver una persona a su user_id antes de llamadas de participación o eliminación.",
  "Case-insensitive search over member names and emails.":
    "Búsqueda de nombres y emails sin distinguir mayúsculas.",
  "Cap on matches when query is set (default 10, max 20). Ignored without query.":
    "Límite de coincidencias con query (predeterminado 10, máximo 20). Se ignora sin query.",
  "Passing query switches to a capped autocomplete-style match, not the full roster.":
    "Enviar query activa una búsqueda limitada tipo autocompletado, no la lista completa.",
  "Card participant tools and remove_workspace_member need the user_id returned here — get_workspace does not include members.":
    "Las herramientas de participantes y remove_workspace_member necesitan el user_id devuelto aquí; get_workspace no incluye miembros.",
  "Identify the caller of this MCP session — your authenticated user id, email, and name. Use it to learn your own user_id or confirm which account you act as.":
    "Identifica a quien llama esta sesión MCP: id, email y nombre del usuario autenticado. Úsalo para conocer tu user_id o confirmar la cuenta activa.",
  "This is the USER behind the session — get_agent_config answers the different question of which runner is configured.":
    "Este es el USUARIO de la sesión; get_agent_config responde qué runner está configurado.",
  "Get a one-call workspace overview: entity counts, recent activity, per-board stats, and a 30-day activity trend. Use before opening a board.":
    "Obtén en una llamada un resumen del espacio de trabajo: recuentos de entidades, actividad reciente, estadísticas por tablero y una tendencia de actividad de 30 días. Úsalo antes de abrir un tablero.",
  "Create a new workspace with you as owner. Use only when starting a new top-level tenancy — individual projects are boards inside an existing workspace.":
    "Crea un espacio de trabajo contigo como owner. Úsalo solo para una tenancy nueva; cada proyecto es un tablero dentro de un espacio existente.",
  "Display name for the workspace.": "Nombre visible del espacio de trabajo.",
  "URL-friendly identifier; derived from name when omitted.":
    "Identificador apto para URL; se deriva del nombre si se omite.",
  "Not idempotent: if the slug is already taken you get an error payload embedding the existing workspace, not a success.":
    "No es idempotente: si el slug ya existe, devuelve un payload de error con el espacio actual, no un éxito.",
  "Add a user to a workspace by email, with a role. Unknown emails are auto-provisioned as new accounts — there is no invite or registration step.":
    "Agrega un usuario por email y rol. Los emails desconocidos crean cuentas automáticamente; no hay paso de invitación o registro.",
  "Email address of the user to add.": "Email del usuario que se agregará.",
  "One of owner, admin, member, viewer. Defaults to member.":
    "Uno de owner, admin, member o viewer. El predeterminado es member.",
  "A typo'd email silently creates a brand-new auto-provisioned account instead of failing.":
    "Un email mal escrito crea silenciosamente una cuenta nueva en vez de fallar.",
  "Re-adding an existing member is a silent no-op: the role you pass is IGNORED and the old role kept — this tool cannot change a member's role.":
    "Volver a agregar un miembro no hace nada: el rol enviado se IGNORA y se conserva el anterior. Esta herramienta no cambia roles.",
  "Caller must be a workspace admin or owner; granting the owner role is owner-only.":
    "Quien llama debe ser admin u owner; solo un owner puede conceder owner.",
  "Remove a member from a workspace by their user_id. Resolve the id from a name or email with list_workspace_members first.":
    "Elimina un miembro por user_id. Resuelve primero el id desde nombre o email con list_workspace_members.",
  "UUID of the user to remove (not their email).": "UUID del usuario que se eliminará, no su email.",
  "Takes a user_id UUID, not an email — look it up with list_workspace_members.":
    "Recibe un UUID user_id, no un email; consúltalo con list_workspace_members.",
  "Caller must be a workspace admin or owner. Removing an owner is owner-only, and the last owner can never be removed.":
    "Quien llama debe ser admin u owner. Solo un owner puede quitar a otro y nunca se puede eliminar al último owner.",
  "Change an existing workspace member's role by their user_id. Resolve the id from a name or email with list_workspace_members first.":
    "Cambia el rol de un miembro existente por user_id. Resuelve primero el id desde nombre o email con list_workspace_members.",
  "The UUID of the member whose role to change.": "UUID del miembro cuyo rol se cambiará.",
  "New role — one of owner, admin, member, viewer.": "Nuevo rol: uno de owner, admin, member o viewer.",
  "Role changes touching the owner role — granting it or demoting an owner — require an acting owner and are human-only: runner keys receive a 403 human_required.":
    "Los cambios que tocan el rol owner — concederlo o degradar a un owner — requieren que actúe un owner y son solo humanos: las claves de runner reciben 403 human_required.",
  "Calling with the role the member already holds is an idempotent no-op — no activity is recorded.":
    "Llamar con el rol que el miembro ya tiene es una operación idempotente sin efecto: no se registra actividad.",
  "List all boards in a workspace with their metadata. Use it to find a board's id or slug before making board-scoped calls.":
    "Enumera los tableros de un espacio de trabajo. Úsalo para encontrar el id o slug antes de llamadas con alcance de tablero.",
  "Fetch a board in one call: metadata plus every column with its cards. The primary way to read board state; shrink the payload via summary_only or titles_only.":
    "Obtén un tablero con metadatos y todas sus columnas y tarjetas. Reduce el payload con summary_only o titles_only.",
  "UUID of the board; the board's slug also works.": "UUID del tablero; también funciona su slug.",
  "Return per-column counts and priority/status breakdowns with no cards. Most compact.":
    "Devuelve recuentos por columna y distribuciones de prioridad/status sin tarjetas. Es la opción más compacta.",
  "Keep the cards but slim each to id/column_id/title/status/priority/card_type/labels for large boards.":
    "Conserva las tarjetas, pero limita cada una a id/column_id/title/status/priority/card_type/labels.",
  "Large boards can overflow the response cap — fall back to titles_only, then summary_only.":
    "Los tableros grandes pueden exceder el límite; usa titles_only y luego summary_only.",
  "summary_only wins over titles_only when both are set.":
    "summary_only prevalece sobre titles_only si se envían ambos.",
  "Create a board in a workspace, optionally seeding its structured definition (scope, objectives, milestones, and more) in the same call.":
    "Crea un tablero y, opcionalmente, inicializa su definición estructurada en la misma llamada.",
  "Display name for the board.": "Nombre visible del tablero.",
  "URL slug for the board and the idempotency key — reuse it to make retries return the existing board.":
    "Slug del tablero y clave de idempotencia; reutilízalo para que los reintentos devuelvan el tablero actual.",
  "Description of the board's purpose.": "Descripción del propósito del tablero.",
  "List of tags for categorization.": "Lista de etiquetas para categorizar.",
  "Skip creating the default To Do / In Progress / Done columns.":
    "Omite la creación de columnas predeterminadas To Do / In Progress / Done.",
  "High-level scope/summary for the board's definition.":
    "Alcance o resumen general de la definición.",
  "Goals, as [{\"text\", \"priority\"?}].": "Objetivos como [{\"text\", \"priority\"?}].",
  "Out-of-scope items, as a list of strings.": "Elementos fuera de alcance como lista de strings.",
  "Milestones, as [{\"title\", \"date\", \"type\"?}].":
    "Hitos como [{\"title\", \"date\", \"type\"?}].",
  "Technologies, as a list of strings.": "Tecnologías como lista de strings.",
  "Stakeholders, as [{\"name\", \"role\"?, \"member_id\"?, \"channel_id\"?}].":
    "Stakeholders como [{\"name\", \"role\"?, \"member_id\"?, \"channel_id\"?}].",
  "Hard constraints, as a list of strings.": "Restricciones estrictas como lista de strings.",
  "Locked decisions, as [{\"decision\", \"rationale\"?}].":
    "Decisiones cerradas como [{\"decision\", \"rationale\"?}].",
  "Reference links, as [{\"url\", \"label\"?}].":
    "Enlaces de referencia como [{\"url\", \"label\"?}].",
  "Extra key/value fields, as [{\"key\", \"value\"?}].":
    "Campos extra como [{\"key\", \"value\"?}].",
  "Free-text coding standards for the definition.": "Estándares de código en texto libre.",
  "Raw content dict for forward-compat/unknown definition keys.":
    "Diccionario de contenido sin procesar para claves futuras o desconocidas.",
  "Idempotent ONLY with slug: same slug returns the existing board. Slugless calls always mint a NEW board (auto-slug, '-2' suffix on collision).":
    "Idempotente SOLO con slug: el mismo slug devuelve el tablero actual. Sin slug siempre crea uno NUEVO, con sufijo '-2' si hay colisión.",
  "Re-running with slug plus definition fields overwrites the existing board's definition — the definition upsert re-applies either way.":
    "Repetir con slug y campos de definición sobrescribe la definición del tablero actual.",
  "The default To Do/In Progress/Blocked/Done columns are typed (backlog/active/blocked/done), so runner pickup works on a fresh board out of the box.":
    "Las columnas predeterminadas To Do/In Progress/Blocked/Done tienen tipos backlog/active/blocked/done, por lo que la asignación funciona desde el inicio.",
  "Change a board's name, description, or tags. Only fields you pass are changed; the definition is edited separately with update_definition.":
    "Cambia nombre, descripción o etiquetas de un tablero. Solo cambian los campos enviados; la definición se edita con update_definition.",
  "New display name.": "Nuevo nombre visible.",
  "New description.": "Nueva descripción.",
  "New tag list — replaces the existing list entirely.":
    "Nueva lista de etiquetas; reemplaza la lista completa.",
  "Human keys only — the backend 403s runner callers on every board update, so a runner cannot rewrite board metadata or loosen the done-merge gate that judges its own moves.":
    "Solo claves humanas: el backend devuelve 403 a los llamantes de tipo runner en toda actualización de tablero, así que un runner no puede reescribir los metadatos del tablero ni aflojar el control de merge para done que juzga sus propios movimientos.",
  "tags replaces the whole list — send the full set you want to keep.":
    "tags reemplaza la lista completa; envía todo lo que quieras conservar.",
  "Freeze a board: still readable by every member, but every mutation and runner pickup is rejected with board_frozen until the workspace owner unfreezes it.":
    "Congela un tablero: todos los miembros todavía pueden leerlo, pero toda mutación y toda asignación del runner se rechazan con board_frozen hasta que el owner del espacio de trabajo lo descongele.",
  "Requires workspace admin or owner. Idempotent — freezing a frozen board is a no-op.":
    "Requiere admin u owner. Es idempotente: congelar un tablero congelado no cambia nada.",
  "Mutations on a frozen board fail with 409 and error_code board_frozen — stop retrying and surface the state instead.":
    "Las mutaciones fallan con 409 y error_code board_frozen; deja de reintentar y muestra el estado.",
  "Runners stop picking up the board's cards immediately; in-flight executions may still report telemetry.":
    "Los runners dejan de tomar tarjetas de inmediato; las ejecuciones activas aún pueden enviar telemetría.",
  "Unfreeze a frozen board, restoring all mutations and runner pickup. Workspace OWNER only — admins can freeze but not unfreeze.":
    "Descongela un tablero. Solo el OWNER; los admins pueden congelar, pero no descongelar.",
  "Owner-only by design: runners and admins get 403 — ask the workspace owner instead of retrying.":
    "Restringido a owner: runners y admins reciben 403; pide ayuda al owner.",
  "Idempotent — unfreezing an unfrozen board is a no-op.":
    "Idempotente: descongelar un tablero activo no cambia nada.",
  "Read a board's loop-mode config: enabled flag, prompts, provider/model, tool allowlist, safety caps, and disabled_reason (why the loop last stopped).":
    "Lee la configuración de loop mode: enabled, prompts, provider/model, allowlist de herramientas, límites de seguridad y disabled_reason, que explica por qué se detuvo el loop la última vez.",
  "Returns a 404 error payload until loop mode is first configured (board settings → Loop Mode, or PUT /loop).":
    "Devuelve 404 hasta configurar loop mode por primera vez desde ajustes o PUT /loop.",
  "The runner re-fetches this config at the top of every iteration — edits apply on the next cycle without a restart.":
    "El runner vuelve a leer esta configuración al inicio de cada iteración; las ediciones se aplican en el ciclo siguiente, no dentro del ciclo actual, y no requieren reinicio.",
  "This is the effective config. The raw authoring state behind it — template, version, slot values, drift — is get_board_loop_binding_raw.":
    "Esta es la configuración efectiva. El estado de autoría crudo detrás de ella (plantilla, versión, valores de slot, drift) es get_board_loop_binding_raw.",
  "Edit a board's loop config and/or flip loop mode on or off. Loop agents call this with enabled=false and a concise reason when done or blocked.":
    "Edita la configuración de loop de un tablero o activa y desactiva loop mode. Los agentes del loop llaman a esta herramienta con enabled=false y un motivo conciso cuando terminan o quedan bloqueados.",
  "True to start/resume the loop, false to stop it. Omit to edit config without touching the state.":
    "True inicia o reanuda el loop; false lo detiene. Omite el campo para editar la configuración sin modificar el estado.",
  "Why the loop is being turned off — stored as disabled_reason and shown on the board. Ignored when enabling.":
    "Razón para detener el loop; se guarda como disabled_reason. Se ignora al activarlo.",
  "The per-iteration user prompt — the loop's brain.":
    "Prompt de usuario por iteración: el cerebro del loop.",
  "The session system prompt.": "Prompt de sistema de la sesión.",
  'Coding-agent suggestion (free string; "" = runner default).':
    'Sugerencia de agente de código (string libre; "" usa el valor predeterminado del runner).',
  "Tier alias (premium/mid/low) or a concrete model id.":
    "Alias de nivel (premium/mid/low) o id concreto de modelo.",
  "MCP tool allowlist (mcp__valaris__* names; empty list = full platform surface). Replaces the stored list.":
    "Allowlist de herramientas MCP (nombres mcp__valaris__*; una lista vacía habilita toda la superficie de la plataforma). Reemplaza la lista almacenada.",
  "Decline lever for the self_merge auto-relax: false keeps the board's done-merge gate armed on a save that lands on self_merge (the loop will then dead-end on its first Done move). Applies to that save only — never stored. The auto-relax itself fires only when loop_landing is passed in the same call; an inherited stored landing never relaxes. Omit to accept the default; only meaningful alongside other config fields.":
    "Palanca de rechazo para el auto-relax de self_merge: false mantiene armada la compuerta de Hecho del tablero en un guardado que aterriza en self_merge (el bucle entonces se atascará en su primer movimiento a Hecho). Aplica solo a ese guardado — nunca se almacena. El auto-relax en sí solo se dispara cuando loop_landing viene en la misma llamada; un aterrizaje heredado del almacenado nunca relaja. Omítelo para aceptar el valor predeterminado; solo tiene sentido junto a otros campos de configuración.",
  "Per-process iteration cap (>= 1).":
    "Límite de iteraciones por proceso (>= 1).",
  "Cooldown between iterations (>= 0).":
    "Pausa entre iteraciones (>= 0).",
  "Per-session timeout (>= 1).":
    "Tiempo máximo por sesión (>= 1).",
  "Cumulative budget rail since the last enable (> 0).":
    "Límite acumulado de presupuesto desde la última activación (> 0).",
  "Failure breaker (>= 1).": "Cortacircuito de fallos (>= 1).",
  "Consecutive sessions reporting outcome=blocked_on_human before the runner stops the loop with a reason naming the blocker (>= 0; 0 opts out — blocked_on_human then only parks).":
    "Cantidad de sesiones consecutivas que informan outcome=blocked_on_human antes de que el runner detenga el loop con un motivo que nombre el bloqueo (>= 0; 0 desactiva esta conducta y blocked_on_human solo estaciona el loop).",
  '"park" (probe readiness, sleep free when nothing is actionable) or "always_run".':
    '"park" comprueba la disponibilidad y espera sin gastar cuando no hay nada accionable; "always_run" sigue iterando.',
  '"human", "self_merge" (the loop agent merges its own PR — grants nothing) or "merge_queue" — the per-board opt-in for autonomous landing via the platform merge queue.':
    '"human", "self_merge" (el agente del bucle mergea su propio PR: no concede nada) o "merge_queue": la habilitación por tablero del landing autónomo mediante la cola de merge de la plataforma.',
  '"forge_ci" requires forge CI green before the merge queue lands the PR; "none" merges without a CI gate.':
    '"forge_ci" exige que la CI del forge esté en verde antes de que la cola de merge integre el PR; "none" integra sin gate de CI.',
  'Declarative run-complete condition, {"label": ..., "exclude_column_type": "done"} — the runner evaluates it before each iteration and disables the loop itself when zero cards match, without spawning a session. It also verifies any session\'s objective_complete claim. Pass {} to clear it (omitting the field leaves it unchanged).':
    'Condición declarativa de finalización de la ejecución, {"label": ..., "exclude_column_type": "done"}: el runner la evalúa antes de cada iteración y desactiva el loop cuando no coincide ninguna tarjeta, sin iniciar una sesión. También verifica cualquier afirmación objective_complete de una sesión. Envía {} para borrarla; omitir el campo la deja sin cambios.',
  "Omitted means unchanged: any config field you don't pass keeps its stored value. Config edits apply on the NEXT iteration.":
    "Omitir significa no cambiar: cualquier campo de configuración que no envíes conserva su valor almacenado. Las ediciones de configuración se aplican en la SIGUIENTE iteración.",
  "completion_query is how a curated run ends for free: zero matching cards disables the loop before any session is spawned, and refutes a session that claims objective_complete while cards remain.":
    "completion_query permite que una ejecución curada termine sin costo: si no coincide ninguna tarjeta, desactiva el loop antes de iniciar una sesión y refuta a cualquier sesión que afirme objective_complete mientras queden tarjetas.",
  "Passing nothing at all (no config field and no enabled flag) returns an error instead of a silent no-op.":
    "No enviar absolutamente nada, ni campos de configuración ni el flag enabled, devuelve un error en vez de una operación silenciosa sin efecto.",
  "Idempotent — setting the current state is a no-op (no version bump).":
    "Idempotente: establecer el estado actual no aumenta la versión.",
  "Enabling requires a configured non-empty loop_prompt; otherwise the backend rejects with 422.":
    "Activarlo exige un loop_prompt no vacío; de lo contrario devuelve 422.",
  "Config writes are last-write-wins — there is no optimistic lock, so coordinate prompt edits out of band.":
    "Las escrituras de configuración siguen la regla de última escritura; no existe un bloqueo optimista, por lo que debes coordinar las ediciones de prompts fuera de banda.",
  "Requires member or better; runner keys inherit their creating user's role.":
    "Requiere member o superior; las claves de runners heredan el rol del usuario creador.",
  "Permanently delete a board and everything scoped to it. Use to tear down finished or sandbox boards — verify the id with list_boards first.":
    "Elimina permanentemente un tablero y todo su alcance. Verifica primero el id con list_boards.",
  "board_id accepts a slug too — confirm what it resolves to before deleting.":
    "board_id también acepta un slug; confirma qué resuelve antes de eliminar.",
  "Activity and execution history survive but are unlinked from the board.":
    "El historial de actividad y ejecución sobrevive, pero queda desvinculado.",
  "Irreversible cascade: deletes the board's columns, cards (with their participants and dependencies), notes, definition, git-repo bindings, and resources in one call. No undo.":
    "Cascada irreversible: elimina columnas, tarjetas, participantes, dependencias, notas, definición, vínculos git y recursos. No se puede deshacer.",
  "Add a column to the end of a board. Set column_type so runner pipelines can discover the column and route cards through it.":
    "Agrega una columna al final. Define column_type para que los pipelines puedan descubrirla y enrutar tarjetas.",
  "Display name for the column.": "Nombre visible de la columna.",
  "Semantic type: backlog, active, review, done, or blocked.":
    "Tipo semántico: backlog, active, review, done o blocked.",
  "Hex color string for the column header.": "Color hexadecimal del encabezado.",
  "Runners resolve pipeline stages by column_type, never by column name — a column without a type is a human-only zone they ignore.":
    "Los runners resuelven etapas por column_type, nunca por nombre; una columna sin tipo es solo humana.",
  "Interactive claims work by moving a card (move_card) into the column whose column_type matches the target stage, not by naming conventions.":
    "La asignación interactiva mueve una tarjeta con move_card a la columna cuyo column_type coincide con la etapa.",
  "Rename, recolor, or retype a column. Only fields you pass are changed; column_type controls whether runners see the column at all.":
    "Cambia nombre, color o tipo de una columna. column_type determina si los runners la ven.",
  "The UUID of the column to update.": "UUID de la columna que se actualizará.",
  "New hex color string for the header.": "Nuevo color hexadecimal del encabezado.",
  "Semantic type: backlog, active, review, done, or blocked. Pass \"null\" or \"none\" to clear it.":
    "Tipo semántico: backlog, active, review, done o blocked. Envía \"null\" o \"none\" para quitarlo.",
  "Clearing the type takes the literal string \"null\" (or \"none\") — a cleared column becomes a human-only zone runners no longer discover cards in.":
    "Quitar el tipo exige la string literal \"null\" o \"none\"; la columna pasa a ser solo humana.",
  "Retyping changes which pipeline stage the column represents for runners — stages resolve by column_type, not name.":
    "Cambiar el tipo cambia la etapa que representa; se resuelve por column_type, no por nombre.",
  "Permanently delete a column together with every card inside it. Move cards you want to keep to another column first.":
    "Elimina permanentemente una columna y todas sus tarjetas. Mueve antes las que quieras conservar.",
  "The UUID of the column to delete.": "UUID de la columna que se eliminará.",
  "Deletes ALL cards in the column along with it — including their participants and dependency edges. It does not reject non-empty columns; the cascade happens immediately, with no undo.":
    "Elimina TODAS sus tarjetas, participantes y dependencias. No rechaza columnas con contenido y no se puede deshacer.",
  "Set the left-to-right order of a board's columns by sending the complete ordered list of column ids.":
    "Ordena las columnas de izquierda a derecha enviando todos sus ids.",
  "Every column UUID on the board, in the desired left-to-right order.":
    "Todos los UUIDs de columna, en el orden deseado.",
  "The backend does not validate the list: nonexistent ids are silently skipped, omitted columns keep their old positions, and ids are never checked against this board — a partial or mixed-up list yields an unpredictable order. Always send exactly this board's full column id list.":
    "El backend no valida la lista: omite silenciosamente los ids inexistentes, las columnas omitidas conservan sus posiciones anteriores y los ids nunca se comprueban contra este tablero. Una lista parcial o mezclada produce un orden impredecible. Envía siempre exactamente la lista completa de ids de las columnas de este tablero.",
  "List every card on a board grouped by column. Use for a full-board snapshot; prefer search_cards when you only need a filtered subset.":
    "Enumera todas las tarjetas agrupadas por columna. Para subconjuntos usa search_cards.",
  "Fetches the entire board detail under the hood — on large boards this is a heavy response; filter with search_cards instead.":
    "Carga el tablero completo; en tableros grandes usa search_cards.",
  "Fetch one card with full details and participants. Accepts a full UUID or a short id prefix (4+ chars) from a note or standup — the server resolves it.":
    "Obtén una tarjeta con detalles y participantes. Acepta UUID o prefijo único de 4+ caracteres.",
  "UUID of the board containing the card.": "UUID del tablero de la tarjeta.",
  "The card's full UUID, or a unique short id prefix (at least 4 characters).":
    "UUID completo o prefijo único de al menos 4 caracteres.",
  "Anything shorter than a full 36-char UUID is treated as a prefix and resolved against this board only.":
    "Un valor menor a 36 caracteres se resuelve como prefijo dentro del tablero.",
  "An ambiguous prefix returns an error listing the candidate cards — retry with more characters.":
    "Un prefijo ambiguo devuelve candidatos; repite con más caracteres.",
  "Create a single card in a chosen column. Use when adding one piece of work; for turning a plan into many cards use bulk_create_cards.":
    "Crea una tarjeta en una columna. Para varias usa bulk_create_cards.",
  "UUID of the column to place the card in.": "UUID de la columna de destino.",
  "Card title. Max 500 characters.":
    "Título de la tarjeta. Máximo 500 caracteres.",
  "Card description (supports rich text). Defaults to empty.":
    "Descripción con rich text; vacía por defecto.",
  "One of task, issue, feature, bug. Defaults to task.":
    "Uno de task, issue, feature o bug. Predeterminado task.",
  "One of none, low, medium, high, urgent. Defaults to none.":
    "Uno de none, low, medium, high o urgent. Predeterminado none.",
  "Due date in YYYY-MM-DD format.": "Fecha límite YYYY-MM-DD.",
  "Free-form status string. Max 255 characters — a short state label, not prose.":
    "String de status libre. Máximo 255 caracteres: una etiqueta de estado breve, no prosa.",
  "List of label strings.": "Lista de labels.",
  "On multi-repo boards, the slug of the repo this card targets. Omit on single-repo boards to use the board's primary repo.":
    "En tableros multirrepositorio, slug del repositorio objetivo. Omite para usar el principal.",
  "NOT idempotent: cards have no unique slug, so a retried call mints a duplicate card. Search for an existing card before re-creating.":
    "NO es idempotente: reintentar crea duplicados. Busca antes de recrear.",
  "git_repo_slug only matters on multi-repo boards; omitting it falls back to the board's primary repo.":
    "git_repo_slug solo afecta tableros multirrepositorio; si se omite usa el principal.",
  "An unknown git_repo_slug is silently dropped (never a 422) — the board's primary repo applies and the drop is recorded in the activity feed.":
    "Un git_repo_slug desconocido se descarta sin 422; se usa el principal y se registra en actividad.",
  "Change fields on an existing card — title, description, priority, labels, due date, and more. Use for edits; moving between columns is move_card.":
    "Edita una tarjeta. Para cambiarla de columna usa move_card.",
  "Full UUID of the card to update, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta que se actualizará, o un prefijo de id único (≥4 caracteres).",
  "New card title. Max 500 characters.":
    "Nuevo título. Máximo 500 caracteres.",
  "New type: task, issue, feature, or bug.": "Nuevo tipo: task, issue, feature o bug.",
  "New priority: none, low, medium, high, or urgent.":
    "Nueva prioridad: none, low, medium, high o urgent.",
  "New due date in YYYY-MM-DD format.": "Nueva fecha YYYY-MM-DD.",
  "New status string. Max 255 characters — a short state label, not prose.":
    "Nuevo string de status. Máximo 255 caracteres: una etiqueta de estado breve, no prosa.",
  "New list of label strings — replaces the existing list.":
    "Nueva lista de labels; reemplaza la anterior.",
  "On multi-repo boards, the slug of the repo this card targets.":
    "Slug del repositorio objetivo en un tablero multirrepositorio.",
  "URL of the pull request this card shipped as — a first-class field, not a link in the description.":
    "URL del pull request con el que se entregó esta tarjeta: es un campo de primera clase, no un enlace dentro de la descripción.",
  "Name of the branch the card's work landed on.":
    "Nombre de la rama en la que se integró el trabajo de la tarjeta.",
  "pr_url and branch_name are update-only — create_card has no equivalent, because the backend's create schema does not accept them.":
    "pr_url y branch_name solo se pueden actualizar; create_card no tiene campos equivalentes porque el schema de creación del backend no los acepta.",
  "labels REPLACES the whole list; to add one label, send the existing labels plus the new one.":
    "labels REEMPLAZA toda la lista; envía anteriores + nuevo.",
  "An unrecognised field name is rejected with a 422 naming it, not silently ignored — a misspelling fails loudly instead of costing you the write.":
    "Un nombre de campo no reconocido se rechaza con un 422 que lo identifica; no se ignora silenciosamente. Un error ortográfico falla de forma visible en vez de hacerte perder la escritura.",
  "Permanently delete a card. Use only for mistakes or truly obsolete items — finished work should instead be moved to the done column.":
    "Elimina una tarjeta permanentemente. El trabajo terminado debe moverse a done.",
  "Full UUID of the card to delete, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta que se eliminará, o un prefijo de id único (≥4 caracteres).",
  "Permanent — there is no undo or archive. Confirm with get_card before deleting.":
    "Permanente; confirma con get_card.",
  "Move a card to another column and/or reorder it within one. This is how humans and interactive agents progress work through the board lifecycle.":
    "Mueve o reordena una tarjeta dentro del ciclo de vida del tablero.",
  "Full UUID of the card to move, or a unique id prefix (≥4 chars).":
    "UUID completo de la tarjeta que se moverá, o un prefijo de id único (≥4 caracteres).",
  "UUID of the target column.": "UUID de la columna objetivo.",
  "Optional fractional position within the target column (a float). Omit it to append the card to the end of the column.":
    "Posición fraccionaria opcional dentro de la columna de destino (un float). Omítela para agregar la tarjeta al final de la columna.",
  "Omit position for a plain column move — the server appends the card (max position + 1024). Pass a float only when the ordering matters: it is a fractional index, so use the midpoint between neighbors.":
    "Omite position para un movimiento simple entre columnas: el servidor agrega la tarjeta al final (posición máxima + 1024). Envía un float solo cuando importe el orden; es un índice fraccionario, así que usa el punto medio entre las tarjetas vecinas.",
  "card_id accepts a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.":
    "card_id acepta un prefijo de id corto (≥4 caracteres), que se resuelve dentro de este tablero. Un prefijo ambiguo devuelve un error con la lista de candidatos.",
  "Pick the target column by its column_type (backlog/active/review/done/blocked), never by its display name.":
    "Elige la columna por column_type, nunca por nombre.",
  "A same-column move that changes position by less than 1.0 is silently treated as a no-op.":
    "Un movimiento en la misma columna menor que 1.0 no hace nada.",
  "Runner-authenticated moves into a done-typed column hit the merge gate: 422 if the card's description has no PR URL, 409 if the PR is unmerged or lacks an approving reviewer verdict. Human sessions skip the gate.":
    "Mover como runner a done activa el gate de merge: 422 sin URL de PR; 409 si no está merged o aprobado. Las personas lo omiten.",
  "Interactively claiming a card = move_card to the active column + add_card_participant; runners use next_assignment instead.":
    "Asignación interactiva = move_card a active + add_card_participant; runners usan next_assignment.",
  "Add a person or agent to a card with a display role (hero = responsible). Pair with move_card when interactively claiming a card.":
    "Agrega una persona o un agente a una tarjeta con un rol visible (hero = responsable). Combínalo con move_card al reclamar una tarjeta de forma interactiva.",
  "UUID of the user or agent to add.": "UUID del usuario o agente.",
  "Display role: hero (responsible), viewer, stakeholder, or helper. Defaults to hero.":
    "Rol visible: hero, viewer, stakeholder o helper. Predeterminado hero.",
  "Pipeline-stage role string (max 64 chars), e.g. planner or implementer — set when claiming on behalf of a pipeline stage.":
    "Rol de etapa, máximo 64 caracteres, por ejemplo planner o implementer.",
  "Idempotent: adding an existing participant returns the card instead of erroring, so retries are safe.":
    "Idempotente: agregar un participante existente devuelve la tarjeta.",
  "A card has at most one hero — adding a different user with role hero returns 409 (already_claimed).":
    "Solo puede haber un hero; otro devuelve 409 already_claimed.",
  "On an existing participant row, a NULL pipeline_role is backfilled in place, but a conflicting non-NULL value is preserved (not overwritten).":
    "Un pipeline_role NULL se completa, pero uno no NULL conflictivo se conserva.",
  "Remove participants from a card: one person by user_id, or every holder of a pipeline_role. Use on rework to clear the stale implementer before it is re-claimed.":
    "Quita participantes de una tarjeta: una persona por user_id o todos los que tengan un pipeline_role. Úsalo al devolver trabajo para quitar al implementer obsoleto antes de que se vuelva a reclamar.",
  "UUID of the one participant to remove. Pass this or pipeline_role, never both.":
    "UUID del único participante que se quita. Pasa este o pipeline_role, nunca ambos.",
  "Pipeline-stage role to clear instead of user_id: planner, implementer, reviewer, rework_mediator, or any custom role. Every holder is removed.":
    "Rol de etapa del pipeline que se limpia en lugar de user_id: planner, implementer, reviewer, rework_mediator o uno personalizado. Se quita a todos los que lo tengan.",
  "Exactly one selector: pass user_id or pipeline_role — neither or both is rejected before any request is sent.":
    "Exactamente un selector: pasa user_id o pipeline_role; ninguno o ambos se rechaza antes de enviar cualquier solicitud.",
  "pipeline_role removes every participant holding that role, and matches the pipeline_role field, not the display role (hero/viewer/stakeholder/helper).":
    "pipeline_role quita a todos los participantes que tengan ese rol y compara el campo pipeline_role, no el rol visible (hero/viewer/stakeholder/helper).",
  "Idempotent: removing a user who is not a participant, or clearing a role nobody holds, succeeds as a no-op.":
    "Idempotente: quitar a un usuario que no participa, o limpiar un rol que nadie tiene, funciona sin efecto.",
  "On rework, clear the stale implementer by pipeline_role rather than user_id — in multi-runner deployments the implementer is a different user than the mediator.":
    "Al devolver trabajo, quita al implementer obsoleto por pipeline_role y no por user_id: en despliegues con varios runners el implementer es un usuario distinto del mediador.",
  "Create up to 50 cards on one board in a single call. Use when turning a plan or backlog list into cards instead of looping create_card.":
    "Crea hasta 50 tarjetas en un mismo tablero con una sola llamada. Úsalo al convertir un plan o una lista del backlog en tarjetas, en lugar de repetir create_card.",
  "Hard cap of 50 cards per request — split larger plans into batches.": "Máximo 50 por solicitud.",
  "All-or-nothing: one invalid column_id rejects the entire batch.":
    "Todo o nada: un column_id inválido rechaza el lote.",
  "NOT idempotent: like create_card, a retried batch creates duplicates.":
    "NO es idempotente: al igual que create_card, reintentar el lote crea duplicados.",
  "Find cards on a board by text, priority, type, status, label, assignee, column, or overdue state. Use instead of list_cards whenever you need a subset.":
    "Encuentra tarjetas en un tablero por texto, prioridad, tipo, status, label, responsable, columna o atraso. Usa esta herramienta en lugar de list_cards siempre que necesites un subconjunto.",
  "Text to search in card titles and descriptions.": "Texto para títulos y descripciones.",
  "Filter by priority: none, low, medium, high, urgent.":
    "Filtra prioridad: none, low, medium, high, urgent.",
  "Filter by type: task, issue, feature, bug.": "Filtra tipo: task, issue, feature, bug.",
  "Filter by status string.": "Filtra por status.",
  "Filter to cards carrying this label.": "Filtra por label.",
  "True for cards with a hero, False for cards with no hero (helpers/viewers don't count as assigned).":
    "True con hero; False sin hero.",
  "Filter to cards where this user/agent UUID is a participant.": "Filtra por UUID de participante.",
  "Filter to a specific column UUID.": "Filtra por UUID de columna.",
  "Filter by semantic column type: backlog, active, review, done, blocked.":
    "Filtra column_type: backlog, active, review, done, blocked.",
  "Exclude cards in columns of this semantic type.": "Excluye este column_type.",
  "Include cards from untyped (human-only) columns. Default true; autonomous runners must pass false to keep human parking zones out of pickup scans.":
    "Incluye columnas sin tipo. Predeterminado true; runners autónomos deben usar false.",
  "True for cards past their due date.": "True para tarjetas vencidas.",
  "Maximum results, 1-100. Defaults to 50.": "Máximo 1-100; predeterminado 50.",
  "Return compact cards — id, title, column_id, column_name, column_type, labels, priority, status, card_type only. Recommended for browse and triage queries; full responses carry every description and participant list.":
    "Devuelve tarjetas compactas: solo id, title, column_id, column_name, column_type, labels, priority, status y card_type. Se recomienda para consultas de exploración y triage; las respuestas completas incluyen todas las descripciones y listas de participantes.",
  "Untyped-column cards (human scratchpad zones) are INCLUDED by default. Autonomous runners picking up work must pass include_untyped=false — those cards were deliberately parked by a human. User-facing reports can omit the flag.":
    "Las columnas sin tipo se INCLUYEN por defecto. Runners deben usar include_untyped=false.",
  "Full responses include every matched card's description, so a broad label or text query on a busy board can overflow the tool-result token budget. Pass summary_only=true to browse, then get_card for the one you need.":
    "Las respuestas completas incluyen la descripción de cada tarjeta coincidente, por lo que una consulta amplia por label o texto en un tablero activo puede exceder el presupuesto de tokens del resultado. Envía summary_only=true para explorar y luego usa get_card con la tarjeta que necesites.",
  "Reserve the next eligible card for a runner — the pickup path. The backend applies all role filters and returns the card with its work context.":
    "Reserva la próxima tarjeta elegible para un runner: la ruta de asignación. El backend aplica todos los filtros de rol y devuelve la tarjeta con su contexto de trabajo.",
  "URL slug of the workspace to scan for eligible work.": "Slug del espacio que se examinará.",
  "UUID of the runner requesting work.": "UUID del runner solicitante.",
  "Request a specific role instead of the runner's primary role; must be a role the runner holds in its team.":
    "Solicita un rol específico que sustituye al rol primario del runner para esa asignación; debe ser un rol que el runner tenga en su equipo.",
  "Restrict the scan to one board UUID. Defaults to all boards the runner can access.":
    "Limita a un UUID de tablero; por defecto todos los accesibles.",
  "Returns a bundle: reserved card + board, column, repo, default branch, effective role, stage_action verb, and a TTL'd reservation — no follow-up fetches needed to start work.":
    "Devuelve tarjeta, tablero, columna, repositorio, rama, rol, stage_action y reserva TTL.",
  "A {\"status\": \"no_work\"} response is normal, not an error — sleep 60-120s and retry.":
    "Una respuesta {\"status\": \"no_work\"} es normal, no un error; espera 60-120 s y vuelve a intentar.",
  "Idempotent while your reservation is active: repeated calls return the same card. The reservation auto-expires, so a crashed runner cannot starve the board.":
    "Idempotente mientras la reserva esté activa; luego expira.",
  "409 means the runner already has an in-flight execution on a different card (response carries active_card_id and execution_id) — finish or cancel that first.":
    "Un 409 significa que el runner ya tiene una ejecución en curso en otra tarjeta (la respuesta incluye active_card_id y execution_id). Termina o cancela primero esa ejecución.",
  "A paused runner gets no_work rather than an error; 423 means the workspace cost circuit breaker tripped — no cards are handed out until it clears.":
    "Un runner pausado recibe no_work en vez de un error; 423 indica que se activó el circuit breaker de costos del espacio de trabajo y no se entrega ninguna tarjeta hasta que se libere.",
  "Get a full project briefing in one call: board summary, definition, notes, git repos, and recent activity. Make this the first call of any workflow.":
    "Obtén un briefing completo: tablero, definición, notas, repositorios y actividad. Úsalo primero.",
  "URL slug of the workspace.": "Slug del espacio de trabajo.",
  "UUID of the board to brief on.": "UUID del tablero.",
  "Heavy sections are capped (25 notes, 20 activity rows, definition ~8KB). Trimmed responses carry `_..._truncated` markers and an `_hint` naming the tool that returns the full data.":
    "Las secciones se limitan a 25 notas, 20 actividades y ~8 KB de definición; `_..._truncated` y `_hint` indican cómo ampliar.",
  "The board section is always a compact per-column summary — never full cards. Use list_cards or search_cards for card detail.":
    "El tablero siempre es un resumen por columna; usa list_cards o search_cards para detalles.",
  "Check a board's computed health: 0-100 score, stale/overdue/unassigned cards, priority and column distribution, and velocity. Use for triage and standups.":
    "Calcula salud 0-100, tarjetas estancadas, vencidas o sin asignar, distribuciones y velocidad.",
  "UUID of the board to score.": "UUID del tablero que se puntuará.",
  "Complements get_project_context — health adds the stale/overdue/velocity signals the briefing does not include.":
    "Complementa get_project_context con señales de atraso y velocidad.",
  "Board UUID to list board-scoped notes instead of workspace-level ones.":
    "UUID del tablero para notas con ese alcance.",
  "Card UUID to filter to notes linked to that card (requires board_id).":
    "UUID de tarjeta para filtrar, junto con board_id.",
  "Read a single note by id. Prefer format=\"markdown\" for a readable, token-cheap body; the default returns raw ProseMirror JSON.":
    "Lee una nota. Prefiere format=\"markdown\"; el predeterminado es ProseMirror.",
  "UUID of the note to read.": "UUID de la nota.",
  "Board UUID if the note is board-scoped; omit for workspace notes.":
    "UUID del tablero si corresponde.",
  "\"prosemirror\" (default, raw JSON tree) or \"markdown\" (converted, readable).":
    "\"prosemirror\" o \"markdown\".",
  "format=\"markdown\" converts the stored ProseMirror document to markdown — it round-trips with the markdown create_note accepts. Use it unless you need the JSON tree.":
    "format=\"markdown\" convierte el documento y hace round-trip con create_note.",
  "board_id only selects the URL path — the lookup is by note_id within the workspace, so a board-scoped note is also retrievable without board_id.":
    "board_id solo elige la ruta; note_id se busca en todo el espacio.",
  "Create a note on a workspace or board, optionally linked to a card. Use for plans, briefs, decisions, or any prose worth keeping next to the work.":
    "Crea una nota de espacio o tablero, opcionalmente ligada a una tarjeta.",
  "The note title.": "Título de la nota.",
  "Note body — send markdown (recommended); HTML, plain text, or ProseMirror JSON are also accepted and normalized.":
    "Contenido; se recomienda markdown. También acepta HTML, texto o ProseMirror.",
  "Pin the note to the top of the list.": "Fijar la nota arriba.",
  "Board UUID to scope the note to a board instead of the workspace.":
    "UUID del tablero para ese alcance.",
  "Card UUID to link the note to; the card must belong to the note's board (pass board_id alongside it — a workspace-level create with card_id is rejected).":
    "UUID de la tarjeta que se vinculará a la nota; la tarjeta debe pertenecer al tablero de la nota (pasa board_id junto con ella; una creación a nivel de espacio de trabajo con card_id se rechaza).",
  "Note kind — \"user_note\" (default) for free-form prose; pipeline kinds like \"plan\", \"rework_brief\", \"review_verdict\" are structural notes consumed by runner stages.":
    "Note kind: \"user_note\" es el valor predeterminado para prosa libre; los kinds del pipeline como \"plan\", \"rework_brief\" y \"review_verdict\" son notas estructurales consumidas por las etapas del runner.",
  "Send content as markdown — the backend normalizes markdown, HTML, plain text, and ProseMirror JSON to canonical ProseMirror before storing (headings h1-h3, bold/italic, code, lists, links, blockquotes).":
    "Envía content como markdown: el backend normaliza markdown, HTML, texto plano y JSON de ProseMirror a ProseMirror canónico antes de almacenarlo, incluidos encabezados h1-h3, negrita y cursiva, código, listas, links y citas en bloque.",
  "kind is NOT validated — any string is stored verbatim (deliberately operator-extensible), so a typo silently creates an inert note. Only known kinds (plan, rework_brief, review_verdict, system) drive pipeline behavior.":
    "kind NO se valida: cualquier string se almacena literalmente para permitir que el operador lo extienda, por lo que un error tipográfico crea silenciosamente una nota inerte. Solo los tipos conocidos (plan, rework_brief, review_verdict, system) controlan el comportamiento del pipeline.",
  "A note created with kind=\"review_verdict\" is permanently immutable — update_note and delete_note are rejected on it.":
    "Una nota creada con kind=\"review_verdict\" es inmutable de forma permanente. update_note y delete_note se rechazan para ella.",
  "Edit a note's title, pinned flag, card link, or body. mode picks how content lands: replace the whole body, append at the end, or rewrite one section.":
    "Edita el título, el estado pinned, el vínculo con la tarjeta o el cuerpo de una nota. mode decide qué hace content: reemplazar todo el cuerpo, añadir al final o reescribir una sección.",
  "Body blocks — markdown recommended, normalized like create_note. mode decides where they land: the whole body (mode=\"replace\"), after the existing body (mode=\"append\", where content is required), or under one heading (mode=\"section\").":
    "Bloques del cuerpo; se recomienda markdown y se normalizan igual que en create_note. mode decide dónde van: todo el cuerpo (mode=\"replace\"), después del cuerpo existente (mode=\"append\", donde content es obligatorio) o bajo un encabezado (mode=\"section\").",
  "\"replace\" (default) rewrites the whole body with content; \"append\" adds content blocks at the end; \"section\" rewrites only the body under anchor_heading.":
    "\"replace\" (predeterminado) reescribe todo el cuerpo con content; \"append\" añade los bloques de content al final; \"section\" reescribe solo el cuerpo bajo anchor_heading.",
  "mode=\"section\" only: heading text whose section is rewritten, without the leading # marks — \"Cluster I\", not \"## Cluster I\". Matching is trimmed and case-insensitive.":
    "Solo con mode=\"section\": texto del encabezado cuya sección se reescribirá, sin los signos # iniciales: \"Cluster I\", no \"## Cluster I\". La comparación ignora espacios en los extremos y diferencias entre mayúsculas y minúsculas.",
  "mode=\"replace\" (the default) swaps the whole body, not a merge. For logs and journals use mode=\"append\", which adds blocks after the existing body and leaves the rest untouched.":
    "mode=\"replace\" (el predeterminado) sustituye el cuerpo completo, no hace merge. Para logs y diarios usa mode=\"append\", que añade bloques después del cuerpo existente y deja el resto intacto.",
  "mode=\"append\" is additive, not idempotent — calling it twice appends twice, and empty content is rejected. If a call's result was lost, read the note back before retrying.":
    "mode=\"append\" es aditivo, no idempotente: llamarlo dos veces añade el contenido dos veces, y un content vacío se rechaza. Si se perdió el resultado de una llamada, vuelve a leer la nota antes de reintentar.",
  "mode=\"section\" is the idempotent way to edit a status inside a long tracker: only the body under anchor_heading changes, the heading itself stays, and empty or omitted content clears the section. Replaying the same call converges.":
    "mode=\"section\" es la forma idempotente de editar un estado dentro de un tracker extenso: solo cambia el cuerpo bajo anchor_heading, el encabezado se conserva y un content vacío u omitido limpia la sección. Repetir la misma llamada converge.",
  "A section runs to the next heading of the same or higher level, so rewriting a ## section also rewrites the ### subsections nested under it.":
    "Una sección se extiende hasta el siguiente encabezado del mismo nivel o uno superior. Por eso, reescribir una sección ## también reescribe las subsecciones ### que contiene.",
  "In mode=\"section\" a heading that does not exist is a not-found error, not an insert (use mode=\"append\" to add a new section), and a heading that appears more than once is a conflict — disambiguate the headings in the note first.":
    "Con mode=\"section\", un encabezado inexistente produce un error not-found, no una inserción (usa mode=\"append\" para añadir una sección nueva), y un encabezado repetido produce un conflicto. Primero diferencia los encabezados de la nota.",
  "title, pinned, card_id and detach_card apply in every mode and are saved before the body operation, so a rejected append or section edit can still have changed the metadata.":
    "title, pinned, card_id y detach_card se aplican en todos los modos y se guardan antes de la operación sobre el cuerpo, por lo que un append o una edición de sección rechazados pueden haber cambiado igualmente los metadatos.",
  "UUID of the note to update.": "UUID de la nota que se actualizará.",
  "New title for the note.": "Nuevo título.",
  "Whether the note should be pinned.": "Si debe quedar fijada.",
  "Board UUID if the note is board-scoped.": "UUID del tablero.",
  "Card UUID to link the note to; the card must belong to the note's board. Omit to leave any existing link untouched.":
    "UUID de la tarjeta que se vinculará a la nota; la tarjeta debe pertenecer al tablero de la nota. Omítelo para no tocar el vínculo existente.",
  "Pass true to clear the note's card link (sends an explicit null). Wins over card_id if both are passed.":
    "Pasa true para quitar el vínculo de la nota con su tarjeta (envía un null explícito). Gana sobre card_id si se pasan ambos.",
  "Notes with kind=\"review_verdict\" are append-only audit records — updates are rejected with a permission error.":
    "Las notas con kind=\"review_verdict\" son registros de auditoría append-only; los updates se rechazan con un error de permisos.",
  "Delete a note permanently. Use when a note is obsolete or was created by mistake.":
    "Elimina una nota obsoleta o errónea.",
  "UUID of the note to delete.": "UUID de la nota que se eliminará.",
  "Permanent — there is no trash or undo.": "Permanente; sin papelera.",
  "Notes with kind=\"review_verdict\" cannot be deleted — the backend rejects it with a permission error (append-only audit record).":
    "Las notas review_verdict no se pueden eliminar.",
  "Runner pipeline stages read structural notes (e.g. kind=plan) — deleting one can strand an in-flight card's context.":
    "Eliminar notas estructurales puede dejar sin contexto una tarjeta activa.",
  "Read a board's definition document — the scope, goals, conventions, and structured context to load before working on the board.":
    "Lee el documento de definición del tablero: alcance, objetivos, convenciones y contexto estructurado que debes cargar antes de empezar a trabajar en el tablero.",
  "get_project_context embeds the definition too but truncates large fields — this call returns the full text.":
    "get_project_context la trunca; esta llamada devuelve todo.",
  "Returns a 404 if the board has no definition yet — create one with update_definition (it upserts).":
    "Devuelve 404 sin definición; créala con update_definition.",
  "Create or update a board's definition (idempotent upsert). Fields you pass are merged over the existing content; everything else is preserved.":
    "Crea o actualiza la definición del tablero mediante un upsert idempotente. Los campos enviados se fusionan con el contenido existente y todo lo omitido se conserva.",
  "High-level scope/summary paragraph for the project.": "Alcance o resumen general.",
  "Technologies/tools, as a list of strings.": "Tecnologías como lista.",
  "Recorded decisions, as [{\"decision\", \"rationale\"?}].":
    "Decisiones como [{\"decision\", \"rationale\"?}].",
  "Links and docs, as [{\"url\", \"label\"?}].": "Enlaces como [{\"url\", \"label\"?}].",
  "Arbitrary key/values, as [{\"key\", \"value\"?}].":
    "Valores arbitrarios como [{\"key\", \"value\"?}].",
  "Free-text coding standards and conventions.": "Estándares y convenciones en texto libre.",
  "Raw content dict for keys not yet exposed as dedicated params; explicit params win on conflict.":
    "Contenido para claves sin parámetros; los parámetros explícitos prevalecen.",
  "Upsert — creates the definition if the board has none yet.": "Upsert: crea si no existe.",
  "Merge is shallow and per-key: sending a list field replaces that whole list, so read-modify-write when appending.":
    "El merge es superficial y por clave: enviar un campo de lista reemplaza la lista completa; para añadir elementos sin perder datos, primero lee, modifica y vuelve a escribir.",
  "Explicit structured params override the same key passed inside content.":
    "Los parámetros explícitos prevalecen sobre content.",
  "Browse files and folders in a workspace or board, or search them by name, type, or tag. Use before downloading or organizing attachments.":
    "Explora archivos y carpetas o busca por nombre, tipo o tag.",
  "Board UUID to list board-scoped resources instead of workspace-level ones.":
    "UUID del tablero para recursos con ese alcance.",
  "Folder UUID to list that folder's children.": "UUID de carpeta para sus hijos.",
  "Filter resources by name.": "Filtra por nombre.",
  "Filter by type — \"file\" or \"folder\".": "Filtra por \"file\" o \"folder\".",
  "Filter by metadata tag.": "Filtra por tag.",
  "Without filters it returns only root-level resources — pass parent_id to descend into a folder.":
    "Sin filtros devuelve solo la raíz; usa parent_id para descender.",
  "When search/resource_type/tag filters are set, parent_id is ignored — filtered queries search the whole scope.":
    "Cuando se establecen los filtros search/resource_type/tag, se ignora parent_id. Las consultas filtradas buscan en todo el alcance.",
  "Fetch one resource's record — name, type, size, MIME type, storage path, tags, description. Use before updating or downloading it.":
    "Obtén metadatos del recurso antes de actualizar o descargar.",
  "UUID of the resource.": "UUID del recurso.",
  "Board UUID if the resource is board-scoped.": "UUID del tablero si corresponde.",
  "Returns the metadata record only — use get_download_url to fetch the file's contents.":
    "Solo metadatos; usa get_download_url para el contenido.",
  "Register a file or folder in the resource library. For uploads: call get_upload_url, PUT the file, then pass the returned gcs_path here.":
    "Registra archivo o carpeta. Para upload: get_upload_url, PUT y create_resource con gcs_path.",
  "The resource name.": "Nombre del recurso.",
  "\"file\" (default) or \"folder\".": "\"file\" o \"folder\".",
  "Parent folder UUID for nesting.": "UUID de carpeta padre.",
  "Optional description of the resource.": "Descripción opcional.",
  "Metadata dict — only {\"tags\": [...]} is kept (max 20 tags, 50 chars each).":
    "Metadatos; solo {\"tags\": [...]} se conserva, máximo 20 de 50 caracteres.",
  "Storage path returned by get_upload_url; required to link an uploaded file.":
    "gcs_path devuelto por get_upload_url.",
  "Board UUID to scope the resource to a board instead of the workspace.":
    "UUID del tablero para ese alcance.",
  "metadata is validated to a closed shape — only the \"tags\" key survives; any other key is silently dropped.":
    "metadata solo conserva \"tags\".",
  "parent_id must reference a folder-type resource in the same workspace.":
    "parent_id debe ser folder del mismo espacio.",
  "A file created without gcs_path gets a generated storage path with no uploaded bytes behind it — get_download_url on it will not serve a file.":
    "Un archivo creado sin gcs_path recibe una ruta de almacenamiento generada, pero no contiene bytes subidos. get_download_url no podrá servir ese archivo.",
  "Rename, re-describe, re-tag, or move a resource to another folder. Only fields you pass are changed.":
    "Cambia nombre, descripción, tags o carpeta.",
  "UUID of the resource to update.": "UUID del recurso que se actualizará.",
  "New resource name.": "Nuevo nombre.",
  "Metadata dict, shallow-merged over the existing one; only tags are kept.":
    "Metadatos con merge superficial; solo tags.",
  "Folder UUID to move the resource into.": "UUID de nueva carpeta.",
  "metadata is shallow-merged per key, then validated — only the tags key survives, and a tags array you send replaces the ENTIRE existing list. To append a tag, read the resource first and send old + new tags together.":
    "Un array tags REEMPLAZA todo; lee y envía anteriores + nuevos.",
  "Moves are cycle-checked: the new parent must be a folder and cannot sit inside the resource being moved.":
    "Los movimientos validan ciclos y que el padre sea folder.",
  "Mint a signed URL for uploading a file. PUT the file bytes to the URL, then register it with create_resource using the returned gcs_path.":
    "Genera una URL firmada para subir un archivo. Haz PUT de los bytes en la URL y luego regístralo con create_resource usando el gcs_path devuelto.",
  "File name, e.g. \"report.pdf\".": "Nombre, por ejemplo \"report.pdf\".",
  "MIME type, e.g. \"application/pdf\" or \"image/png\".":
    "MIME type, por ejemplo \"application/pdf\".",
  "Board UUID to scope the upload to a board.": "UUID del tablero.",
  "The signed URL expires after 15 minutes — upload promptly.": "Expira en 15 minutos.",
  "Your PUT must send the same Content-Type the URL was signed for, or storage rejects it.":
    "PUT debe usar el mismo Content-Type.",
  "Uploading alone does not create a resource — the file is invisible to the platform until create_resource registers the gcs_path.":
    "Subir el archivo no crea por sí solo un recurso. El archivo permanece invisible para la plataforma hasta que create_resource registre el gcs_path.",
  "Mint a signed URL (valid 1 hour) to download a file resource's contents. Use after list_resources or get_resource identifies the file.":
    "Genera una URL firmada, válida por 1 hora, para descargar el contenido de un recurso de archivo. Úsala después de que list_resources o get_resource identifique el archivo.",
  "UUID of the file resource.": "UUID del archivo.",
  "Errors only when the resource has no storage path — in practice, folders. A file registered without an actual upload still returns a URL; the download itself then fails because no bytes were ever written.":
    "Solo falla sin ruta; un archivo sin bytes devuelve URL pero la descarga falla.",
  "The URL expires after 1 hour.": "Expira en 1 hora.",
  "Delete a resource record permanently. Use for obsolete files or folders.":
    "Elimina permanentemente un recurso obsoleto.",
  "UUID of the resource to delete.": "UUID del recurso que se eliminará.",
  "Permanent — no trash or undo.": "Permanente; sin papelera.",
  "Deletes only the platform record; the uploaded file stays in cloud storage.":
    "Solo elimina el registro; el archivo queda en cloud storage.",
  "Deleting a folder that still has children fails — move or delete its contents first.":
    "Una carpeta con hijos no se elimina; vacíala primero.",
  "List the teams in a workspace with their members and board assignments. Use to see which runner crews exist before staffing or binding one to a board.":
    "Enumera equipos, miembros y tableros asignados.",
  "The workspace slug to list teams for.": "Slug del espacio cuyos equipos se listarán.",
  "Include deactivated teams (default false).": "Incluir equipos inactivos; predeterminado false.",
  "Deactivated teams are hidden unless include_inactive is true.":
    "Los inactivos se ocultan salvo include_inactive=true.",
  "Fetch one team's full profile: members, their roles, and board scope. Use before changing membership so you know each member's current roles.":
    "Obtén el perfil, miembros, roles y alcance de un equipo.",
  "The workspace slug the team belongs to.": "Slug del espacio del equipo.",
  "The UUID of the team to retrieve.": "UUID del equipo.",
  "Read the current roles here before calling add_team_member — a re-add replaces a member's roles rather than appending.":
    "Lee los roles antes de add_team_member; volver a agregar los reemplaza.",
  "Create a team of runners in a workspace, optionally scoped to one board. Use when setting up a runner crew before assigning members and roles.":
    "Crea un equipo de runners, opcionalmente limitado a un tablero.",
  "The workspace slug.": "Slug del espacio.",
  "Team name.": "Nombre del equipo.",
  "What this team does (default empty).": "Propósito del equipo; vacío por defecto.",
  "Board UUID to scope the team to one board; omit for a workspace-wide team.":
    "UUID del tablero; omite para todo el espacio.",
  "The team starts empty — follow up with add_team_member to give it runners and roles.":
    "Empieza vacío; agrega runners con add_team_member.",
  "Rename a team, change its description, or re-scope it to a different board. Only the fields you pass are changed.":
    "Cambia nombre, descripción o tablero del equipo.",
  "The UUID of the team to update.": "UUID del equipo que se actualizará.",
  "New team name.": "Nuevo nombre.",
  "New board UUID to scope the team to.": "Nuevo UUID de tablero.",
  "You cannot un-scope a team back to workspace-wide here — a null board_id is dropped by the tool; use the UI/REST for that.":
    "Aquí no puedes quitar el alcance de tablero a un equipo para devolverlo al alcance completo del espacio de trabajo. La herramienta descarta un board_id null; usa la UI/REST para hacerlo.",
  "Reactivating a deactivated team is also not exposed here (no is_active field) — use the UI/REST.":
    "La reactivación de un equipo desactivado tampoco está expuesta aquí, porque no existe el campo is_active. Usa la UI/REST.",
  "Soft-disable a team so it drops out of active listings. Use to retire a crew without losing its membership history — this is the off switch, not a delete.":
    "Desactiva de forma reversible un equipo para que deje de aparecer en los listados activos. Úsalo para retirar un grupo sin perder su historial de miembros. Esta operación desactiva el equipo, no lo elimina.",
  "The UUID of the team to deactivate.": "UUID del equipo que se desactivará.",
  "Not a delete: the team and its member records remain, hidden from list_teams unless include_inactive is true.":
    "No es una eliminación: el equipo y los registros de sus miembros se conservan, ocultos de list_teams salvo que include_inactive sea true.",
  "No MCP reactivation path — update_team does not expose is_active, so re-enabling the team needs the UI/REST.":
    "No hay una ruta de reactivación por MCP: update_team no expone is_active, por lo que volver a habilitar el equipo requiere la UI/REST.",
  "Add a runner to a team with one or more roles, or change an existing member's roles. Use when staffing a team for pipeline work.":
    "Agrega un runner y roles, o reemplaza sus roles actuales.",
  "The UUID of the team.": "UUID del equipo.",
  "The UUID of the runner to add.": "UUID del runner.",
  "Roles to grant, matched against the workspace's pipeline roles (default pipeline: planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler). Free-form strings are accepted; roles not in the pipeline are flagged not_in_pipeline in the response.":
    "Roles que se concederán, comparados con los roles del pipeline del espacio de trabajo (pipeline predeterminado: planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler). Se aceptan strings libres; los roles que no están en el pipeline se marcan como not_in_pipeline en la respuesta.",
  "Single role (legacy backward-compat — prefer roles).": "Rol único legado; prefiere roles.",
  "Re-adding an existing member REPLACES their roles — send the union of old and new roles, not just the addition.":
    "Volver a agregar REEMPLAZA roles; envía antiguos + nuevos.",
  "Role uniqueness is pipeline-config-driven: roles whose stage is marked unique (all seven default pipeline roles) allow one runner per team; roles not flagged unique allow several.":
    "La unicidad de roles depende de pipeline_config: los siete roles predeterminados tienen su etapa marcada unique y permiten un runner por equipo; los roles no marcados unique permiten varios.",
  "Omitting both roles and role defaults the member to [\"custom\"] — that is NOT role-agnostic (custom is not a pipeline role). The backend treats an empty roles list as claim-every-pipeline-role, but this tool never sends one; pass explicit roles for pipeline members.":
    "Omitir roles y role asigna [\"custom\"] al miembro; eso NO equivale a ser agnóstico respecto del rol, porque custom no es un rol del pipeline. El backend interpreta una lista de roles vacía como reclamar todos los roles del pipeline, pero esta herramienta nunca envía una lista vacía; especifica roles explícitos para los miembros del pipeline.",
  "Remove a runner from a team. Use when unstaffing a crew or freeing a unique pipeline role (planner, reviewer, ...) for another runner.":
    "Quita un runner del equipo y libera su rol.",
  "The UUID of the runner to remove.": "UUID del runner que se quitará.",
  "Only the team membership is removed — the runner itself keeps existing and stays on its other teams.":
    "Solo elimina la membresía; el runner sigue existiendo.",
  "List a workspace's contact channels (email, Slack, phone, and more). Use to find out how to reach the humans behind a project.":
    "Enumera canales de contacto del espacio.",
  "Register a contact point (email, Slack, WhatsApp, phone, website, other) in a workspace. Use during project setup so agents know how to reach people.":
    "Registra email, Slack, WhatsApp, teléfono, sitio u otro contacto.",
  "Display name for the channel.": "Nombre visible del canal.",
  "One of: email, slack, whatsapp, phone, website, other.":
    "Uno de email, slack, whatsapp, phone, website, other.",
  "The contact address or identifier (e.g. email address, phone number).":
    "Dirección o identificador de contacto.",
  "What this channel is for (default empty).": "Propósito; vacío por defecto.",
  "Dict of extra metadata to attach to the channel.": "Metadatos extra.",
  "Change a channel's name, type, contact address, description, or metadata. Only the fields you pass are changed.":
    "Cambia nombre, tipo, contacto, descripción o metadatos.",
  "The UUID of the channel to update.": "UUID del canal.",
  "New display name for the channel.": "Nuevo nombre visible.",
  "New type (email, slack, whatsapp, phone, website, other).": "Nuevo tipo.",
  "New contact address or identifier.": "Nueva dirección o identificador.",
  "Metadata dict, shallow-merged key by key with the existing metadata.":
    "Metadatos con merge superficial.",
  "metadata_json is shallow-merged — only the keys you send are replaced; set a key to null to remove it.":
    "metadata_json reemplaza solo claves enviadas; null elimina.",
  "Delete a contact channel from a workspace. Use when a contact point is obsolete or was created by mistake.":
    "Elimina un canal obsoleto o erróneo.",
  "The UUID of the channel to delete.": "UUID del canal que se eliminará.",
  "Permanent — there is no undo or soft-delete for channels.": "Permanente; sin soft-delete.",
  "List the git repositories linked to a board, with URLs, slugs, and branch settings. Use to see which repos cards can target before assigning work.":
    "Enumera repositorios git vinculados, URLs, slugs y ramas.",
  "The UUID of the board.": "UUID del tablero.",
  "On multi-repo boards, each repo's slug is what cards reference through their git_repo_slug field.":
    "En multirrepositorio, las tarjetas usan el slug vía git_repo_slug.",
  "Link a git repository to a board so cards and runners can target real branches and PRs. Use during board setup, before launching autonomous work.":
    "Vincula un repositorio para que tarjetas y runners usen ramas y PRs reales.",
  "Display name for the repository.": "Nombre visible del repositorio.",
  "The repository URL (e.g. https://github.com/org/repo).":
    "URL, por ejemplo https://github.com/org/repo.",
  "Hosting provider: github, gitlab, bitbucket, gitea, or other.":
    "Proveedor: github, gitlab, bitbucket, gitea u other.",
  "The default branch name (default \"main\").": "Rama predeterminada, \"main\" por defecto.",
  "What this repository holds (default empty).": "Contenido del repositorio; vacío por defecto.",
  "When true (default), the runner ensures branch protection on default_branch at first clone.":
    "Cuando es true (predeterminado), el runner asegura la protección de rama en default_branch durante el primer clone.",
  "Explicit URL slug (lowercase alphanum + hyphens); derived from name when omitted.":
    "Slug de URL explícito, compuesto solo por alfanuméricos en minúscula y guiones; se deriva de name cuando se omite.",
  "require_branch_protection defaults to true so runner auto-merge has protection to arm against — set false for legacy or human-owned repos where flipping protection would disrupt workflows.":
    "require_branch_protection usa true; define false si alteraría flujos existentes.",
  "On multi-repo boards, slug is the per-card selector (card.git_repo_slug); pick it deliberately.":
    "En tableros con varios repositorios, slug es el selector por tarjeta (card.git_repo_slug). Elígelo de forma deliberada.",
  "integration_branch cannot be set at creation — link the repo first, then set it with update_git_repo.":
    "integration_branch se configura después con update_git_repo.",
  "Change a linked repo's URL, branches, protection policy, or slug. Only the fields you pass are changed — and this is where integration_branch is set.":
    "Cambia URL, ramas, protección o slug; aquí se define integration_branch.",
  "The UUID of the git repo to update.": "UUID del repositorio.",
  "New display name for the repository.": "Nuevo nombre visible.",
  "New repository URL.": "Nueva URL.",
  "New provider (github, gitlab, bitbucket, gitea, other).": "Nuevo proveedor.",
  "New default branch name.": "Nueva rama predeterminada.",
  "Staging branch parallel runners base new work on instead of default_branch.":
    "Rama de staging en la que los runners paralelos basan el trabajo nuevo en vez de hacerlo en default_branch.",
  "Toggle the branch-protection policy.": "Activa o desactiva branch protection.",
  "New URL slug (lowercase alphanum + hyphens, unique within the board).":
    "Nuevo slug de URL, compuesto solo por alfanuméricos en minúscula y guiones, y único dentro del tablero.",
  "integration_branch only takes effect for pipeline stages configured with git.base_ref=\"integration_branch\"; leave it unset to keep forking from default_branch.":
    "integration_branch solo surte efecto en las etapas del pipeline configuradas con git.base_ref=\"integration_branch\". Déjalo sin definir para seguir creando ramas desde default_branch.",
  "Re-slugging a repo on a multi-repo board changes which cards' git_repo_slug resolve to it — update affected cards too.":
    "Cambiar slug exige actualizar git_repo_slug de tarjetas afectadas.",
  "Unlink a git repository from a board. Use when the board should stop targeting a repo — the repository itself is never touched.":
    "Desvincula un repositorio sin tocar el remoto.",
  "The UUID of the git repo to unlink.": "UUID del repositorio que se desvinculará.",
  "Removes only the board binding — the remote repository, its branches, and PRs are untouched.":
    "Solo quita el vínculo; ramas y PRs siguen intactos.",
  "Cards whose git_repo_slug pointed at this repo stop being schedulable: on next pickup the scheduler parks them with the repo-slug-unresolved label. Re-link a repo with the same slug (or fix the cards) and remove the label to recover.":
    "Las tarjetas cuyo git_repo_slug apuntaba a este repositorio dejan de ser programables. En la siguiente asignación, el scheduler las detiene con el label repo-slug-unresolved. Vuelve a vincular un repositorio con el mismo slug, o corrige las tarjetas, y elimina el label para recuperarlas.",
  "Subscribe an external URL to workspace events (card moves, executions, approvals, cost alerts). Use to wire Backplane into CI, chat, or monitoring systems.":
    "Suscribe una URL a eventos del espacio para CI, chat o monitoreo.",
  "Delivery URL for webhook payloads (https in production).": "URL de entrega; https en producción.",
  "Events to subscribe to: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed, plus the activity.* namespace (activity.card.moved, activity.note.updated, ...). Bare card.*/column.* names still work but are deprecated aliases of activity.card.*/activity.column.*.":
    "Eventos a los que puedes suscribirte: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed y el namespace activity.* (activity.card.moved, activity.note.updated, ...). Los nombres sin prefijo card.*/column.* todavía funcionan, pero son alias obsoletos de activity.card.*/activity.column.*.",
  "HMAC signing secret used to sign every delivery.": "Secret HMAC para firmar entregas.",
  "Payloads are signed HMAC-SHA256 with your secret: the X-Webhook-Signature-256 header carries sha256=<hex> and X-Webhook-Event names the event — verify on the receiver.":
    "Los payloads se firman con HMAC-SHA256 usando tu secret: el header X-Webhook-Signature-256 contiene sha256=<hex> y X-Webhook-Event identifica el evento. Verifica la firma en el receptor.",
  "The URL is SSRF-guarded at registration: https-only outside development, and hosts resolving to private/internal addresses are rejected.":
    "La URL queda protegida contra SSRF al registrarla: fuera de desarrollo solo se admite HTTPS y se rechazan los hosts que resuelven a direcciones privadas o internas.",
  "List the webhooks registered in a workspace with their URLs, subscribed events, and active state. Use to audit existing subscriptions before adding one.":
    "Enumera webhooks, URLs, eventos y estado.",
  "Filter by state: true for active only, false for inactive only; omit for all.":
    "true activos, false inactivos; omite para todos.",
  "Get the runner identity linked to the current API key (vs whoami, which is the calling user). Use at session start to discover your agent_id and constraints.":
    "Obtén la identidad del runner vinculada a la API key actual, a diferencia de whoami, que identifica al usuario que llama. Úsalo al iniciar la sesión para descubrir tu agent_id y sus restricciones.",
  "Distinct from whoami: whoami returns the calling user; get_agent_config returns the runner bound to the API key.":
    "whoami devuelve usuario; get_agent_config devuelve runner.",
  "Falls back to the user identity when no runner is linked to the key — execution tracking and approvals need a linked runner.":
    "Sin runner usa la identidad del usuario; ejecuciones y aprobaciones requieren vínculo.",
  "Register a runner identity (an agents row) with an API key, workspace allowlist, rate limit, and optional budget cap. Use when onboarding a new runner.":
    "Registra una identidad de runner (una fila de agents) con API key, allowlist de espacios de trabajo, rate limit y presupuesto opcional. Úsalo al incorporar un runner nuevo.",
  "Runner display name.": "Nombre visible del runner.",
  "One of 'coding', 'manager', 'reviewer', 'secretary', 'improver'.":
    "Uno de 'coding', 'manager', 'reviewer', 'secretary' o 'improver'.",
  "Workspace slugs the runner may access. Must contain at least one.":
    "Slugs de espacios accesibles; al menos uno.",
  "What this runner does.": "Propósito del runner.",
  "Allowed action names; omit to allow all.": "Acciones permitidas; omite para todas.",
  "Rate limit (default 100).": "Rate limit; predeterminado 100.",
  "Optional spending cap in USD.": "Límite opcional en USD.",
  "The raw_api_key in the response is shown exactly once — save it immediately.":
    "raw_api_key se muestra una vez; guárdala.",
  "Re-creating an existing runner is idempotent but returns raw_api_key null (a lost key requires rotation) — and silently reactivates the runner if it had been deactivated.":
    "Volver a crear un runner existente es idempotente, pero devuelve raw_api_key null; una clave perdida requiere rotación. Además, si el runner estaba desactivado, lo reactiva silenciosamente.",
  "An empty allowed_workspaces makes the runner invisible to every workspace — list each workspace it must see.":
    "allowed_workspaces vacía lo vuelve invisible; enumera cada espacio.",
  "Fetch one runner's profile — type, allowlists, limits, budget, and active state. Use when auditing a runner or before updating it.":
    "Obtén tipo, allowlists, límites, presupuesto y estado.",
  "UUID of the runner to retrieve.": "UUID del runner.",
  "Never returns the API key — only its prefix. Raw keys are shown once, at create time.":
    "Nunca devuelve la API key. Solo devuelve su prefijo. Las claves completas se muestran una sola vez, al crearlas.",
  "UUID of the runner to update.": "UUID del runner que se actualizará.",
  "New workspace slug allowlist. Must be non-empty if provided.": "Nueva allowlist no vacía.",
  "New action allowlist.": "Nueva allowlist de acciones.",
  "New rate limit.": "Nuevo rate limit.",
  "New spending cap in USD.": "Nuevo límite en USD.",
  "Changes apply on the runner's next config refresh (heartbeat cycle), not instantly.":
    "Aplica en el próximo heartbeat.",
  "You cannot clear allowed_workspaces to empty — omit it to leave it unchanged.":
    "No puedes vaciar allowed_workspaces; omite para conservar.",
  "Change a runner's profile or guardrails — name, allowlists, rate limit, budget, active flag. Only passed fields change; hard_delete=true erases the runner instead.":
    "Cambia el perfil o los guardrails de un runner: nombre, allowlists, rate limit, presupuesto, indicador activo. Solo cambian los campos enviados; hard_delete=true borra el runner en su lugar.",
  "hard_delete=true is irreversible. Unlike is_active=false, nothing survives to re-enable — the runner, its API key, executions, approvals and team memberships are gone.":
    "hard_delete=true es irreversible. A diferencia de is_active=false, no queda nada que se pueda volver a habilitar: se eliminan el runner, su API key, sus ejecuciones, aprobaciones y membresías de equipo.",
  "Set false to disable the runner — the reversible retirement.":
    "false desactiva el runner: el retiro reversible.",
  "True permanently erases the runner — API key, executions, approvals, team memberships. Unrecoverable; must be the only field besides agent_id.":
    "True borra permanentemente el runner: API key, ejecuciones, aprobaciones, membresías de equipo. Irrecuperable; debe ser el único campo además de agent_id.",
  "hard_delete=true accepts no other field — a call mixing edits with the erase is rejected before any request is sent.":
    "hard_delete=true no acepta ningún otro campo: una llamada que mezcle ediciones con el borrado se rechaza antes de enviar cualquier solicitud.",
  "Prefer is_active=false for retirement; hard_delete exists to erase a runner that should never have existed.":
    "Para retirar un runner, prefiere is_active=false; hard_delete existe para borrar un runner que nunca debió existir.",
  "List the runner identities you can administer, with active and paused state. The operator's inventory call — start here for the agent_id other lifecycle tools take.":
    "Enumera las identidades de runner que puedes administrar, con su estado activo y pausado. Es la consulta de inventario del operador: empieza aquí para obtener el agent_id que reciben las demás herramientas del ciclo de vida.",
  "Also return deactivated runners; defaults to active only.":
    "Devuelve también los runners desactivados; de forma predeterminada solo devuelve los activos.",
  "Returns only runners the calling user administers — an empty list can mean no permission, not no runners.":
    "Solo devuelve los runners que administra el usuario que llama; una lista vacía puede significar que no tiene permisos, no que no existan runners.",
  "Never returns API keys, only their prefixes.":
    "Nunca devuelve API keys, solo sus prefijos.",
  "Stop a runner from picking up new cards — the primary runaway containment lever. Use the moment a runner looks stuck in a money-loop.":
    "Impide que un runner tome tarjetas nuevas: es el mecanismo principal para contener una ejecución descontrolada. Úsalo en cuanto un runner parezca atrapado en un money-loop.",
  "UUID of the runner to pause.": "UUID del runner que se pausará.",
  "In-flight work is not killed — the runner finishes its current card and then idles, so spend stops after at most one more card. Pair with cancel_execution to end the running one.":
    "El trabajo en curso no se termina: el runner finaliza su tarjeta actual y después queda inactivo, por lo que el gasto se detiene tras, como máximo, una tarjeta adicional. Combínalo con cancel_execution para terminar la ejecución activa.",
  "Idempotent: pausing an already-paused runner succeeds.":
    "Idempotente: pausar un runner que ya está pausado funciona correctamente.",
  "Rejected for runner-linked API keys — a runner cannot pause itself or its peers; call it with an operator identity.":
    "Se rechaza para API keys vinculadas a runners: un runner no puede pausarse a sí mismo ni pausar a sus pares; llama a la herramienta con una identidad de operador.",
  "Re-enable card pickup for a paused runner. Use once the condition that caused the pause is resolved.":
    "Vuelve a habilitar la toma de tarjetas para un runner pausado. Úsalo cuando se haya resuelto la condición que causó la pausa.",
  "UUID of the runner to resume.": "UUID del runner que se reanudará.",
  "Idempotent: resuming an active runner succeeds and changes nothing.":
    "Idempotente: reanudar un runner que ya está en ejecución funciona y no cambia nada.",
  "Resuming a runner that was paused for overspend restarts the burn — check get_agent_budget_status first.":
    "Reanudar un runner pausado por gasto excesivo reactiva el consumo; consulta primero get_agent_budget_status.",
  "Rejected for runner-linked API keys; call it with an operator identity.":
    "Se rechaza para API keys vinculadas a runners; llama a la herramienta con una identidad de operador.",
  "Ask a running runner to finish its in-flight card and exit, so its supervisor relaunches it on fresh platform config.":
    "Pide a un runner activo que termine su tarjeta en curso y salga, para que su supervisor lo vuelva a iniciar con la configuración actualizada de la plataforma.",
  "UUID of the runner to restart.": "UUID del runner que se reiniciará.",
  "Requires a live WebSocket connection — an offline runner returns 503 rather than queueing the restart for later.":
    "Requiere una conexión WebSocket activa: un runner desconectado devuelve 503 en vez de dejar el reinicio en cola para más tarde.",
  "The platform only asks; bringing the process back is the supervisor's job. On a hand-launched runner this is a stop, not a restart.":
    "La plataforma solo envía la solicitud; volver a levantar el proceso es responsabilidad del supervisor. En un runner iniciado manualmente, esto lo detiene, no lo reinicia.",
  "In-flight work is not killed — the current card finishes first, so the exit can be minutes away.":
    "El trabajo en curso no se termina: primero finaliza la tarjeta actual, por lo que la salida puede tardar varios minutos.",
  "Rejected for runner-linked API keys — a runner restarting itself is a loop an operator cannot interrupt.":
    "Se rechaza para API keys vinculadas a runners: un runner que se reinicia a sí mismo crea un loop que el operador no puede interrumpir.",
  "Refused with 409 while the runner has a card in flight — pause it and let the card finish, or cancel_execution first.":
    "Se rechaza con 409 mientras el runner tenga una tarjeta en curso: páusalo y deja que la tarjeta termine, o usa primero cancel_execution.",
  "Rejected for runner-linked API keys — a runner cannot erase itself or its peers.":
    "Se rechaza para API keys vinculadas a runners: un runner no puede borrarse a sí mismo ni borrar a sus pares.",
  "Check one runner's spend against its budget cap. The per-runner spend audit that pairs with pause_agent when containing a runaway.":
    "Compara el gasto de un runner con su límite de presupuesto. Es la auditoría de gasto por runner que se combina con pause_agent para contener una ejecución descontrolada.",
  "UUID of the runner to check.": "UUID del runner que se comprobará.",
  "Per-runner only. For workspace-wide cost and per-card spend use get_workspace_metrics(view='cost').":
    "Solo por runner. Para consultar el costo de todo el espacio de trabajo y el gasto por tarjeta, usa get_workspace_metrics(view='cost').",
  "A runner with no budget_usd set has no cap to report against — it will never self-limit.":
    "Un runner sin budget_usd configurado no tiene un límite contra el cual informar y nunca se limitará por sí solo.",
  "Mint a new API key for a runner and invalidate the old one. The response to a leaked or compromised runner key.":
    "Emite una API key nueva para un runner e invalida la anterior. Es la respuesta ante una clave de runner filtrada o comprometida.",
  "UUID of the runner whose key is being rotated.":
    "UUID del runner cuya clave se rotará.",
  "The new raw_api_key is shown exactly once in the result — save it immediately; a lost key needs another rotation.":
    "La nueva raw_api_key se muestra exactamente una vez en el resultado; guárdala de inmediato. Una clave perdida exige otra rotación.",
  "The old key stops authenticating the moment this returns, so a runner mid-card fails until reconfigured. Pause it first if the timing matters.":
    "La clave anterior deja de autenticar en cuanto termina la llamada, por lo que un runner a mitad de una tarjeta falla hasta que se reconfigure. Páusalo primero si el momento de la rotación importa.",
  "A card whose execution_count keeps climbing while it stays out of the done column is the money-loop signature — cross-check with list_executions.":
    "Una tarjeta cuyo execution_count sigue aumentando mientras permanece fuera de la columna done es la señal de un money-loop; confírmalo con list_executions.",
  "Falling velocity with a rising reversion_rate means rework, not slowdown; report the pair together.":
    "Una velocidad que cae mientras aumenta reversion_rate indica retrabajo, no una simple desaceleración; informa ambas cifras juntas.",
  "reversion_rate and agent_efficiency_score are null until there is enough history to compute them.":
    "reversion_rate y agent_efficiency_score son null hasta que exista suficiente historial para calcularlos.",
  "Read workspace-wide velocity, quality and runner/card spend in one call; view narrows it to velocity or cost. Use for standup delivery and cost lines.":
    "Consulta en una sola llamada la velocidad, la calidad y el gasto por runner y por tarjeta de todo el espacio de trabajo; view lo limita a velocidad o a costo. Úsalo en las líneas de entrega y de costo del standup.",
  "Workspace slug to read metrics from.":
    "Slug del espacio de trabajo del que se leerán las métricas.",
  "'all' (default) returns velocity, quality and cost; 'velocity' returns velocity + quality only; 'cost' returns spend only.":
    "'all' (valor predeterminado) devuelve velocidad, calidad y costo; 'velocity' devuelve solo velocidad + calidad; 'cost' devuelve solo el gasto.",
  "Workspace-wide only — use get_board_health for one board's velocity and get_agent_budget_status for one runner's spend.":
    "Abarca todo el espacio de trabajo; usa get_board_health para la velocidad de un solo tablero y get_agent_budget_status para el gasto de un solo runner.",
  "cost.agents holds per-runner token and execution counts over 7d/30d; dollar amounts live on cost.cards (total_cost_usd) and depend on model_pricing in workspace config — without it costs read as 0.":
    "cost.agents contiene los recuentos de tokens y ejecuciones por runner en 7d/30d; los importes en dólares están en cost.cards (total_cost_usd) y dependen de que model_pricing esté configurado en el espacio de trabajo; sin ese campo, los costos se muestran como 0.",
  "Report the totals as returned rather than re-deriving them; an unknown view is rejected before any request is made.":
    "Informa los totales tal como se devuelven en lugar de recalcularlos; un valor de view desconocido se rechaza antes de realizar cualquier solicitud.",
  "Clear a tripped cost circuit breaker so runners can pick up work again. Use when next_assignment returns 423 for every runner because spend crossed the threshold.":
    "Restablece un circuit breaker de costos activado para que los runners puedan volver a tomar trabajo. Úsalo cuando next_assignment devuelva 423 para todos los runners porque el gasto superó el umbral.",
  "Acknowledgement, not a mute: it clears the dedupe state, so the next cost signal over the threshold trips the breaker again.":
    "Es un reconocimiento, no un silenciamiento: limpia el estado de deduplicación, por lo que la siguiente señal de costo que supere el umbral vuelve a activar el circuit breaker.",
  "Thresholds and the breaker action are untouched — change those with update_workspace_config's cost_circuit_breaker field.":
    "Los umbrales y la acción del circuit breaker no cambian; modifícalos con el campo cost_circuit_breaker de update_workspace_config.",
  "Admin-gated: a non-admin member gets a 403 straight from the backend.":
    "Requiere permisos de admin: un miembro que no sea admin recibe un 403 directamente del backend.",
  "Runners resume on their next next_assignment poll, not instantly.":
    "Los runners se reanudan en su siguiente sondeo de next_assignment, no de forma instantánea.",
  "Open an execution audit record for a runner's run and get back an execution_id. Call at the start of any agentic workflow you want tracked on the platform.":
    "Abre un registro de ejecución y devuelve execution_id.",
  "Workspace slug where this execution occurs.": "Slug del espacio de la ejecución.",
  "UUID of the runner starting the run (see get_agent_config).":
    "UUID del runner; consulta get_agent_config.",
  "Short action name, e.g. 'standup', 'tdd_implement', 'review_pr'.":
    "Acción corta, por ejemplo 'standup', 'tdd_implement', 'review_pr'.",
  "One-line summary of what the agent was asked to do.": "Resumen de una línea.",
  "Board UUID when the work is board-scoped.": "UUID del tablero si corresponde.",
  "Card UUID being worked — pass it whenever the run is card-scoped.":
    "UUID de la tarjeta; envíalo siempre en trabajo de tarjeta.",
  "External coding-session ID for correlation.": "ID externo de sesión para correlación.",
  "Execution UUID this run is a retry of.": "UUID de la ejecución reintentada.",
  "Pipeline role for this run, e.g. 'implementer', 'reviewer'.":
    "Rol del pipeline, por ejemplo 'implementer' o 'reviewer'.",
  "Full rendered prompt sent to the LLM for this run.": "Prompt renderizado enviado a la LLM.",
  "Save the returned execution_id — log_execution_update and cancel_execution need it.":
    "Guarda execution_id para log_execution_update y cancel_execution.",
  "Passing card_id flips the card to 'actively worked' presence on the board immediately — always bind it for card-scoped runs.":
    "Pasar card_id marca la tarjeta como 'actively worked' de inmediato en el tablero; vincúlalo siempre en ejecuciones con alcance de tarjeta.",
  "Record progress or the outcome of a tracked execution — status, results, cost, errors. Call when a run completes, fails, or reaches a meaningful checkpoint.":
    "Registra progreso o resultado: status, resultados, costo y errores.",
  "UUID of the runner that owns the execution.": "UUID del runner dueño de la ejecución.",
  "The id returned by log_execution_start.": "Id de log_execution_start.",
  "New status — 'completed', 'failed', or 'running'.":
    "Nuevo status: 'completed', 'failed' o 'running'.",
  "What the run accomplished or produced.": "Resultado de la ejecución.",
  "MCP tool names invoked during the run.": "Herramientas MCP invocadas.",
  "Card UUIDs created, updated, or moved.": "UUIDs de tarjetas afectadas.",
  "Error details when status is 'failed'.": "Error si status es 'failed'.",
  "Total number of tool calls made.": "Total de llamadas.",
  "Total input + output tokens consumed.": "Tokens de entrada + salida.",
  "Total cost in USD for this run.": "Costo total en USD.",
  "Wall-clock duration of the run in seconds.": "Duración en segundos.",
  "Non-fatal issues captured during the stage, surfaced in the UI.":
    "Problemas no fatales mostrados en UI.",
  "Partial update: only the fields you pass change — omitted fields keep their values.":
    "Actualización parcial; omisiones se conservan.",
  "ship_warnings render as amber chips in the UI without flipping status to failed — use them for non-fatal issues.":
    "ship_warnings son chips amber sin cambiar a failed.",
  "A late 'failed' write to an already-completed execution keeps status completed (the other fields still apply); failed → completed stays allowed — the runner's close is authoritative.":
    "Un write 'failed' tardío sobre una ejecución ya terminada conserva el status completed, pero los demás campos todavía se aplican; failed → completed sigue permitido y el cierre del runner es autoritativo.",
  "List runner execution history for a workspace, newest first. Use to monitor runs, audit cost and loops, read a card's full pipeline history, or find zombie rows.":
    "Enumera ejecuciones recientes para monitoreo, costos, historial y zombis.",
  "Workspace slug to read executions from.": "Slug del espacio.",
  "Only that runner's executions.": "Solo ejecuciones de ese runner.",
  "Filter: started, running, completed, failed, aborted, skipped — or virtual 'inflight'.":
    "Filtra started, running, completed, failed, aborted, skipped o 'inflight'.",
  "Filter by pipeline role, e.g. 'implementer', 'reviewer'.":
    "Filtra por rol, por ejemplo 'implementer'.",
  "Return that card's pipeline history instead of the workspace page.":
    "Devuelve historial de esa tarjeta.",
  "Max rows (default 20, backend caps at 200).": "Máximo 20 por defecto, 200 máximo.",
  "Rows are heavy — each carries the full input_prompt and tool invocations. Keep limit small unless you need deep history.":
    "Las filas incluyen input_prompt y herramientas; usa límite pequeño.",
  "status='inflight' is virtual: every started/running row not yet completed, unbounded by limit — the zombie-hunting filter to pair with cancel_execution.":
    "status='inflight' es virtual: incluye todas las filas started/running que aún no terminaron, sin quedar limitado por limit. Es el filtro para encontrar ejecuciones zombis que debes combinar con cancel_execution.",
  "card_id switches to server-side card scope: the card's history ignoring limit — but capped at the newest 200 rows, so a runaway loop card can still truncate. status/role/agent_id filter within that window.":
    "card_id cambia al alcance de tarjeta en el servidor: obtiene el historial de la tarjeta ignorando limit, pero lo limita a las 200 filas más recientes, por lo que el historial de una tarjeta en un loop descontrolado aún puede quedar truncado. Los filtros status/role/agent_id se aplican dentro de esa ventana.",
  "Force a stuck 'running' execution to a terminal status, clearing the runner busy-guard. Use when a crashed run wedges the pipeline with 409 agent_busy errors.":
    "Fuerza una ejecución 'running' atascada a status terminal y libera agent_busy.",
  "UUID of the runner that owns the stuck execution.": "UUID del runner.",
  "Execution UUID to force terminal.": "UUID de la ejecución.",
  "Terminal status to set — 'aborted' (default), 'completed', or 'failed'.":
    "Status terminal: 'aborted', 'completed' o 'failed'.",
  "Note recorded as the execution's output_summary.": "Nota como output_summary.",
  "Non-terminal statuses are rejected — they would not clear the busy-guard.":
    "Los status no terminales se rechazan.",
  "Verify the row is a real zombie first (list_executions status='inflight'); cancelling a live run lets the runner reserve new work while the old run keeps going.":
    "Verifica primero que la fila corresponda a un zombi real (list_executions status='inflight'); cancelar una ejecución activa permite que el runner reserve trabajo nuevo mientras la ejecución anterior sigue ejecutándose.",
  "A typo'd execution_id may not 404: when the runner has exactly one in-flight execution, the backend applies the write to that row instead — double-check the id before cancelling.":
    "Un execution_id erróneo puede no devolver 404: cuando el runner tiene exactamente una ejecución in-flight, el backend aplica la escritura a esa fila. Verifica dos veces el id antes de cancelar.",
  "Query the audit trail of who changed what in a workspace or board, newest first. Use to review recent changes with entity-type, action, or free-text filters.":
    "Consulta auditoría de cambios, más reciente primero.",
  "Workspace slug to read activity from.": "Slug del espacio.",
  "Board UUID to scope to one board; omit for workspace-wide.":
    "UUID del tablero; omite para todo el espacio.",
  "Max entries (default 50, backend caps at 100).": "Máximo 50 por defecto, 100 máximo.",
  "Filter: board, column, card, note, resource, definition, channel, git_repo, workspace, member, agent.":
    "Filtra board, column, card, note, resource, definition, channel, git_repo, workspace, member o agent.",
  "Filter: created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed, dependencies_replaced.":
    "Filtra por created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed y dependencies_replaced.",
  "Free-text search across activity summaries.": "Busca texto en resúmenes.",
  "Tracks entity mutations (cards, notes, members...), not runner runs — for execution history use list_executions.":
    "Registra mutaciones, no ejecuciones; usa list_executions.",
  "The response carries agent_id attribution, but this MCP tool does not expose the backend's agent_id filter. entity_type='agent' returns runner lifecycle audit rows; it does not return every action performed by one runner.":
    "La respuesta incluye la atribución agent_id, pero esta herramienta MCP no expone el filtro agent_id del backend. entity_type='agent' devuelve filas de auditoría del ciclo de vida del runner; no devuelve todas las acciones realizadas por un runner.",
  "Report the MCP server's version, full tool surface, this session's allowlist, and backend reachability. Run at session start to rule out tool or version drift.":
    "Informa versión MCP, herramientas, allowlist y conexión al backend.",
  "enabled_tools is what THIS session can actually call — the registered surface intersected with the allowlist (allowlist null = unrestricted).":
    "enabled_tools indica lo que ESTA sesión puede llamar realmente: la intersección entre la superficie registrada y la allowlist; allowlist null significa acceso irrestricto.",
  "allowlist_unknown lists allowlisted names the server doesn't register — a sign of version drift between runner config and deployed server.":
    "allowlist_unknown indica divergencia de versión.",
  "Backend health is best-effort: an unreachable API sets backend.reachable=false instead of failing the call.":
    "Si la API no responde, backend.reachable=false.",
  "Widen THIS session's server tool hand and request client refresh; notification delivery does not prove the client catalog updated.":
    "Amplía la mano de herramientas del servidor de ESTA sesión y solicita actualizar el cliente; enviar la notificación no demuestra que el catálogo del cliente se haya actualizado.",
  "Toolset ids to add: all, default, or any group or category id listed under get_server_info.toolsets.available.":
    "Ids de toolsets a añadir: all, default o cualquier id de grupo o categoría listado en get_server_info.toolsets.available.",
  "Widen-only and idempotent: a repeated call adds nothing and sends no notification. The change is per-process and never persisted — the next session starts from VALARIS_MCP_TOOLSETS again.":
    "Solo amplía y es idempotente: una llamada repetida no añade nada y no envía notificación. El cambio es por proceso y nunca se persiste: la siguiente sesión vuelve a partir de VALARIS_MCP_TOOLSETS.",
  "The runner allowlist (VALARIS_MCP_ALLOWLIST) is a ceiling this tool never lifts, so under a runner launch it is a no-op.":
    "La allowlist del runner (VALARIS_MCP_ALLOWLIST) es un techo que esta herramienta nunca levanta, así que bajo un lanzamiento de runner no tiene efecto.",
  "client_catalog_status is unverified: list_changed_sent and get_server_info confirm server state only. If tools remain missing, apply restart_env to the MCP server startup configuration, restart the server/connection and start a new agent session. Remote HTTP requires the server operator; preserve VALARIS_MCP_ALLOWLIST.":
    "client_catalog_status es unverified: list_changed_sent y get_server_info solo confirman el estado del servidor. Si faltan herramientas, aplica restart_env a la configuración de inicio del servidor MCP, reinicia el servidor/conexión e inicia una nueva sesión del agente. HTTP remoto requiere al operador del servidor; conserva VALARIS_MCP_ALLOWLIST.",
  "Read the workspace's full config: pipeline stages, rework/cooldown knobs, templates, pricing, and cost circuit breaker. Start here before any config edit.":
    "Lee toda la configuración antes de editarla.",
  "The response includes a `version` field — pass it as `expected_version` on update_workspace_config for conflict-safe edits.":
    "La respuesta incluye un campo `version`. Pásalo como `expected_version` a update_workspace_config para editar con protección contra conflictos.",
  "`pipeline_config` is never null in the response: an unconfigured workspace gets the platform-default multi-role pipeline (the read even seeds it onto a stored record whose pipeline is null).":
    "`pipeline_config` nunca es null en la respuesta: un espacio de trabajo sin configurar recibe el pipeline multirrol predeterminado de la plataforma; la lectura incluso puede persistirlo en un registro almacenado cuyo pipeline era null.",
  "Patch workspace config fields: pipeline stages, rework caps, templates, pricing, circuit breaker, role labels. Use to tune how runners process work.":
    "Actualiza etapas, rework, plantillas, precios, circuit breaker y roles.",
  "Per-card rework cap before the scheduler stops re-issuing the card.":
    "Límite de retrabajo por tarjeta.",
  "Hours to wait before re-offering a card after release.":
    "Horas antes de volver a ofrecer una tarjeta.",
  "Template for runner-authored commit messages.": "Plantilla de commits del runner.",
  "Template for runner-authored PR descriptions.": "Plantilla de descripciones de PR.",
  "Per-model $/token overrides; merges over platform defaults.":
    "Overrides de $/token por modelo; se fusionan sobre los valores predeterminados de la plataforma.",
  "The full pipeline doc — `stages` (role, discover, claim, git, llm, on_success) plus scheduling. Replaces the stored doc wholesale.":
    "El documento completo del pipeline: `stages` (role, discover, claim, git, llm, on_success) más la planificación. Reemplaza por completo el documento almacenado.",
  "{enabled, threshold_usd_per_15min, action} with action one of alert, pause, kill_runner.":
    "{enabled, threshold_usd_per_15min, action}, con alert, pause o kill_runner.",
  "Per-role display label overrides, e.g. {\"implementer\": \"Coder\"}.":
    "Labels por rol, por ejemplo {\"implementer\": \"Coder\"}.",
  "Optimistic concurrency: if set, the update is rejected with 409 when the stored config version differs.":
    "Concurrencia optimista; una versión distinta devuelve 409.",
  "Partial PATCH: omitted fields stay unchanged — but `pipeline_config` is replaced wholesale, not deep-merged.":
    "PATCH parcial, pero `pipeline_config` se reemplaza completo.",
  "Pass `expected_version` from the last read to get a 409 instead of silently clobbering a concurrent edit.":
    "Usa `expected_version` para no sobrescribir cambios concurrentes.",
  "The backend validates `pipeline_config` and returns its structured 422 error list on malformed stages; the call requires workspace admin/owner role.":
    "El backend valida `pipeline_config`; errores 422 y rol admin/owner.",
  "Pipeline stages drive the backend scheduler behind next_assignment — changing a role's discover/claim rules changes which cards runners are offered.":
    "Las etapas controlan next_assignment y qué tarjetas reciben los runners.",
  "Passing pipeline_config overwrites the workspace's ENTIRE stored pipeline in place — no history is kept beyond a version counter, and every runner's discover/claim behavior changes on its next poll. Read-modify-write: fetch with get_workspace_config, mutate locally, send back with expected_version (or export_pipeline_bundle first as a backup).":
    "Pasar pipeline_config sobrescribe directamente TODO el pipeline almacenado del espacio de trabajo. No se conserva historial más allá de un contador de versión y el comportamiento discover/claim de cada runner cambia en su siguiente sondeo. Sigue el ciclo de leer, modificar y escribir: obtén la configuración con get_workspace_config, modifícala localmente y devuélvela con expected_version, o crea antes un respaldo con export_pipeline_bundle.",
  "Export a portable bundle of the workspace's pipeline, derived setup contract, and workspace prompts. Use to back up or promote a proven pipeline elsewhere.":
    "Exporta pipeline, contrato derivado y prompts en un bundle portátil.",
  "URL slug identifying the source workspace.": "Slug del espacio de origen.",
  "Only WORKSPACE-scoped prompt configs are included; platform defaults re-seed on the target and are deliberately excluded.":
    "Incluye solo prompts de WORKSPACE; excluye los predeterminados.",
  "`data.expected_pipeline_version` exports as null — fill it in (from the target's current version) only when round-tripping back into the same workspace.":
    "`data.expected_pipeline_version` sale null; complétalo solo al volver al mismo espacio.",
  "Team-scoped prompts are exported by team slug; the import fails with 422 if the target workspace lacks a team with that slug.":
    "Prompts de equipo usan su slug; falta de equipo devuelve 422.",
  "Exports the STORED pipeline, not the effective default get_workspace_config shows — a workspace that never saved its config exports an empty pipeline_config, which import rejects with 400. Save the config once first.":
    "Exporta el pipeline ALMACENADO, no el predeterminado efectivo que muestra get_workspace_config. Un espacio de trabajo que nunca guardó su configuración exporta un pipeline_config vacío, que la importación rechaza con 400. Guarda la configuración una vez antes de exportarla.",
  "Import an exported pipeline bundle into a workspace. Previews by default; applies pipeline + prompts atomically with dry_run=false. Use to clone a proven setup.":
    "Importa un bundle; muestra vista previa y aplica con dry_run=false.",
  "URL slug identifying the TARGET workspace.": "Slug del espacio de DESTINO.",
  "The full bundle envelope exactly as returned by export_pipeline_bundle.":
    "Envelope completo de export_pipeline_bundle.",
  "Defaults to true: return a validation + preview report and write nothing. Set false to apply.":
    "true valida sin escribir; false aplica.",
  "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false. Always inspect the preview first.":
    "`dry_run` es TRUE; revisa la vista previa antes de aplicar.",
  "The version guard lives INSIDE the envelope (`bundle.data.expected_pipeline_version`); there is no top-level expected_version parameter on import. Stale version → 409, only relevant when re-importing into the source workspace.":
    "La protección de versión vive DENTRO del envelope (`bundle.data.expected_pipeline_version`). No existe un parámetro expected_version de nivel superior en la importación. Una versión obsoleta devuelve 409. Este control solo es relevante al volver a importar en el espacio de trabajo de origen.",
  "Envelope schema_version/entity_type mismatch → 400; invalid pipeline → 422. The commit is atomic — a validation failure leaves no partial state.":
    "schema_version/entity_type incorrecto → 400; pipeline inválido → 422; operación atómica.",
  "Re-importing is idempotent: prompts with identical content are skipped, differing content updates in place. Requires workspace admin/owner role.":
    "Reimportar es idempotente: los prompts con contenido idéntico se omiten y los que tienen contenido diferente se actualizan in situ. Requiere el rol admin/owner del espacio de trabajo.",
  "Applying with dry_run=false overwrites the target workspace's ENTIRE pipeline_config and creates/updates its prompt configs in one transaction. Export a backup bundle from the target first.":
    "dry_run=false sobrescribe TODO pipeline_config y prompts; haz backup primero.",
  "List the sensors runners have registered in a workspace. Use before wiring sensors into pipeline stages to see which sensor names are valid.":
    "Enumera sensores informados por runners antes de usarlos en etapas.",
  "The catalog is runner-reported: it stays empty until at least one runner in the workspace has reported a sensor manifest.":
    "El catálogo queda vacío hasta recibir un manifiesto.",
  "On a name conflict across runners, the first reporter wins.":
    "Ante conflicto, gana el primer runner.",
  "This is the catalog `pipeline_config.stages[*].sensors[*].name` is validated against — but only once at least one runner has reported; with an empty catalog, sensor-name validation is skipped and unknown names pass.":
    "Valida `pipeline_config.stages[*].sensors[*].name`; con catálogo vacío no valida.",
  "List prompt configs visible to a workspace — its own plus platform defaults — optionally filtered by team role. Use to see which prompt overrides are in play.":
    "Enumera prompts del espacio y predeterminados, filtrables por rol.",
  "Filter to configs for one team role, e.g. 'orchestrator' or 'reviewer'.":
    "Filtra por rol, por ejemplo 'orchestrator' o 'reviewer'.",
  "Returns workspace-scoped rows PLUS platform-level defaults (no workspace) in one list — check each row's workspace scope before editing.":
    "Devuelve filas del espacio y predeterminadas; verifica el alcance antes de editar.",
  "Each item carries `resolved_content` and wiring warnings computed against the live pipeline config, so you see what agents will actually receive.":
    "Incluye `resolved_content` y avisos según el pipeline activo.",
  "Fetch one prompt config with its resolved content and pipeline wiring warnings. Use to inspect exactly what an agent role will receive at a stage.":
    "Obtén un prompt resuelto y sus avisos de conexión.",
  "Prompt config UUID; a slug also resolves (workspace-scoped).":
    "UUID o slug con alcance de espacio.",
  "`config_id` accepts a UUID or a slug — slug lookup is workspace-scoped and prefers workspace-owned rows over platform defaults.":
    "`config_id` acepta UUID o slug y prefiere filas del espacio.",
  "Create a per-role prompt override for a pipeline stage. Use to customize what an agent role is told at a stage without touching the pipeline config itself.":
    "Crea una sustitución de prompt por rol y etapa.",
  "Display name for the prompt config.": "Nombre visible del prompt.",
  "Slug identifier, unique within its (team, role, stage) scope.":
    "Slug único en (team, role, stage).",
  "Pipeline stage it applies to, e.g. 'implement', 'review', 'plan'.":
    "Etapa, por ejemplo 'implement', 'review' o 'plan'.",
  "The prompt template content.": "Contenido de la plantilla.",
  "Restrict to one agent type: 'coding', 'manager', 'reviewer', 'secretary', or 'improver'.":
    "Tipo: 'coding', 'manager', 'reviewer', 'secretary' o 'improver'.",
  "Restrict to one team role, e.g. 'orchestrator' or 'reviewer'.":
    "Rol, por ejemplo 'orchestrator' o 'reviewer'.",
  "Scope the config to a single team by UUID.": "UUID de equipo para limitar el alcance.",
  "Idempotent: if a config already exists with the same (team, team_role, stage, slug) scope, it is returned unchanged instead of erroring — safe to retry.":
    "Idempotente con el mismo (team, team_role, stage, slug).",
  "Slugs are unique per scope, not globally — several configs can share a slug across different stages or roles.":
    "Los slugs son únicos por alcance, no globales.",
  "Changes reach runners on their next config refresh, not instantly mid-run.":
    "Aplica en la próxima actualización del runner.",
  "Update fields of an existing prompt config; content changes auto-bump its version. Use to iterate on what a role is told at a pipeline stage.":
    "Actualiza un prompt; cambiar content aumenta la versión.",
  "New slug identifier.": "Nuevo slug.",
  "New pipeline stage.": "Nueva etapa.",
  "New prompt template content.": "Nuevo contenido.",
  "New agent type filter.": "Nuevo filtro de tipo.",
  "New team role filter.": "Nuevo filtro de rol.",
  "New team UUID scope.": "Nuevo UUID de equipo.",
  "PATCH semantics: omitted fields stay unchanged.": "PATCH: campos omitidos se conservan.",
  "Updating `content` bumps the stored version automatically; other fields don't.":
    "Cambiar `content` aumenta la versión; otros campos no.",
  "Platform-level (NULL-workspace) rows pass the workspace guard: resolving one by slug or UUID rewrites the shared default for EVERY workspace, and prior content is not retained (only the version counter bumps). Verify the row's workspace scope in list_prompt_configs before updating.":
    "Las filas de nivel de plataforma (NULL-workspace) superan la protección de espacio de trabajo: resolver una por slug o UUID reescribe el predeterminado compartido para TODOS los espacios de trabajo y no conserva el contenido anterior, solo aumenta el contador de versión. Verifica el alcance de espacio de la fila en list_prompt_configs antes de actualizarla.",
  "Delete a prompt config so matching runners fall back to default prompts on their next refresh. Use to retire an override you no longer want.":
    "Elimina una sustitución para volver al prompt predeterminado.",
  "Permanent — there is no undo; recreate with create_prompt_config if needed.":
    "Permanente; recrea con create_prompt_config.",
  "Runners that matched this config fall back to platform/stage defaults on their next config refresh.":
    "Los runners vuelven al predeterminado en su próxima actualización.",
  "Platform-level (NULL-workspace) configs pass the workspace guard: resolving one by slug or UUID hard-deletes the shared default for EVERY workspace. Verify the row's workspace scope in list_prompt_configs before deleting.":
    "Las configuraciones de nivel de plataforma (NULL-workspace) superan la protección de espacio de trabajo: resolver una por slug o UUID elimina de forma permanente el predeterminado compartido para TODOS los espacios de trabajo. Verifica el alcance de espacio de la fila en list_prompt_configs antes de eliminarla.",
  "Initializer": "Inicializador",
  "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.":
    "Inicializa un proyecto completo desde un brief: tablero, columnas, definición, canales, tarjetas iniciales, una nota fijada de decisiones y repositorio git. Los miembros del equipo nombrados en el brief se agregan como miembros del espacio de trabajo, lo que les concede acceso al espacio. Úsalo una sola vez al iniciar un proyecto nuevo en un espacio de trabajo.",
  "Slug of the workspace the new board will live in.": "Slug del espacio del nuevo tablero.",
  "Free-text brief: goals, tech stack, constraints, timeline, team, and repos — everything the agent should extract and scaffold from.":
    "Brief libre con objetivos, stack, restricciones, plazos, equipo y repositorios.",
  "Secretary": "Secretario",
  "Generate a daily standup for one board — progress, stale and overdue cards, bottlenecks — saved as a board note. Run each morning or before a team sync.":
    "Genera un standup diario con progreso, atrasos y bloqueos, guardado como nota.",
  "Slug of the workspace that owns the board.": "Slug del espacio del tablero.",
  "ID of the board to report on.": "ID del tablero.",
  "Audit board hygiene — missing priorities, empty descriptions, overdue or stale cards — into a health score with proposed fixes. Fixes run only after you confirm.":
    "Audita higiene, prioridades, descripciones y atrasos; corrige solo tras confirmar.",
  "ID of the board to health-check.": "ID del tablero que se evaluará.",
  "Summarize every board in a workspace: completion, urgent and overdue counts, stalled boards, plus the top 3 recommended actions. Use for a weekly or executive overview.":
    "Resume todos los tableros y recomienda 3 acciones.",
  "Slug of the workspace to summarize across all of its boards.":
    "Slug del espacio que se resumirá.",
  "Architect": "Arquitecto",
  "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.":
    "Descompone un objetivo general en tarjetas de backlog secuenciadas de 1-3 días cada una. Las tarjetas quedan controladas por una tarjeta de aceptación ACCEPT-. Úsalo al planificar una feature nueva o un bloque de trabajo.",
  "ID of the board where the cards will be created.": "ID del tablero donde crear tarjetas.",
  "The high-level objective to break down into cards.": "Objetivo que se dividirá.",
  "Split one oversized card into smaller, independently deliverable child cards that inherit its labels and priority. Use when a card is too big for 1-3 days of work.":
    "Divide una tarjeta grande en hijas independientes con labels y prioridad heredados.",
  "ID of the board the card lives on.": "ID del tablero de la tarjeta.",
  "ID of the oversized card to split.": "ID de la tarjeta que se dividirá.",
  "Plan a sprint: measure velocity, select backlog cards within capacity, stage them in the sprint column with due dates and owners, and pin a sprint-plan note.":
    "Planifica un sprint con capacidad, fechas, responsables y una nota fijada.",
  "ID of the board to plan the sprint on.": "ID del tablero del sprint.",
  "Coder": "Desarrollador",
  "Claim a card interactively: pick from the backlog-typed column, move it into the active-typed column, and output an implementation brief. Runners use next_assignment.":
    "Toma una tarjeta de backlog, muévela a active y genera un brief. Runners usan next_assignment.",
  "ID of the board to pick up work from.": "ID del tablero del trabajo.",
  "Card to pick up. Omit to auto-select the highest-priority unassigned card in the backlog-typed column (resolved by column_type, never by column name). If no column on the board has a column_type, the prompt first types the columns via update_column rather than guessing by name.":
    "Tarjeta a tomar; si se omite elige la prioritaria sin asignar por column_type y usa update_column si faltan tipos.",
  "Run the full delivery loop for one card: claim it, plan against the codebase, implement with strict TDD, verify, then move it to review with an implementation record.":
    "Ejecuta entrega completa con planificación, TDD, verificación y movimiento a review.",
  "ID of the card to implement.": "ID de la tarjeta a implementar.",
  "Close out a reviewed card: move it to Done, mark it completed, write a completion note, report newly unblocked cards, and suggest the next card to pick up.":
    "Cierra una tarjeta revisada, muévela a Done, escribe nota e informa desbloqueos.",
  "ID of the reviewed card to complete.": "ID de la tarjeta revisada.",
  "List of all workspaces you can access, with slugs and metadata. Read this first to discover the workspace_slug that every other call needs.":
    "Lista espacios accesibles con slugs y metadatos; úsala para descubrir workspace_slug.",
  "Aggregate stats for one workspace: board, card, note, and channel counts plus recent activity. Same data as the get_workspace_summary tool.":
    "Estadísticas de tableros, tarjetas, notas, canales y actividad; igual que get_workspace_summary.",
  "The board's definition document: scope plus structured content (objectives, tech stack, milestones, constraints). Same data as the get_definition tool.":
    "Definición del tablero con alcance, objetivos, stack, hitos y restricciones; igual que get_definition.",
  "Per-board done merge gate: 'inherit' clears the override and uses the workspace enforce_done_merge_gate setting; 'enforced' enables it; 'off' disables it. The gate applies to runner moves into done, not human moves.":
    "Control de merge hacia done por tablero: 'inherit' elimina el override y usa enforce_done_merge_gate del espacio de trabajo; 'enforced' lo activa y 'off' lo desactiva. Se aplica a movimientos de runners hacia done, no a movimientos humanos.",
  "Changing done_merge_gate requires workspace admin or owner. A board with no linked git repo remains exempt because it cannot produce a mergeable PR.":
    "Cambiar done_merge_gate requiere ser admin u owner del espacio de trabajo. Un tablero sin repositorio git vinculado permanece exento porque no puede generar un PR integrable.",
  " tools across ": " herramientas en ",
  " categories — searchable, filterable, and copy-ready. ":
    " categorías: se pueden buscar, filtrar y copiar. ",
  "Loop Templates": "Plantillas de loop",
  "Bind the loop to a loop template — a system slug or a workspace template's row UUID. The board's prompts and tools become the render of that template and are owned by it.":
    'Vincula el loop a una plantilla de loop: un slug de "system" o el UUID de fila de una plantilla del espacio de trabajo. Los prompts y las herramientas del tablero pasan a ser el render de esa plantilla y quedan bajo su propiedad.',
  '"system" (default) or "workspace" — which namespace template_ref lives in.':
    '"system" (predeterminado) o "workspace": en qué espacio de nombres vive template_ref.',
  "Pin the bind to a specific published version. Omit to take the newest.":
    "Fija el vínculo a una versión publicada concreta. Omítelo para tomar la más reciente.",
  "Values for the template's <<SLOT>> placeholders, as {\"SLOT_NAME\": value}. FULL REPLACE. Sent alone (no template_ref) it re-renders the board's existing binding.":
    'Valores para los marcadores <<SLOT>> de la plantilla, como {"SLOT_NAME": value}. REEMPLAZO COMPLETO. Enviado solo (sin template_ref) vuelve a renderizar el vínculo existente del tablero.',
  "True drops the binding and keeps the rendered prompts as plain editable text. Wins over template_ref if both are passed.":
    "True elimina el vínculo y conserva los prompts renderizados como texto editable normal. Tiene prioridad sobre template_ref si se envían ambos.",
  "Optimistic lock for the config PUT — the loop config version you last read. A concurrent edit makes this 409 rather than clobbering.":
    "Bloqueo optimista para el PUT de configuración: la versión de la configuración del loop que leíste por última vez. Una edición concurrente devuelve 409 en lugar de pisar los cambios.",
  "Binding a template makes it own system_prompt/loop_prompt/tools: sending those in the same call is 422, and sending them later on a bound board is 409 (detach first with detach_template=true).":
    "Vincular una plantilla hace que sea dueña de system_prompt/loop_prompt/tools: enviarlos en la misma llamada da 422, y enviarlos después en un tablero vinculado da 409 (desvincula primero con detach_template=true).",
  "slot_values is a FULL REPLACE of the binding's values — read them back with get_board_loop_binding_raw and send the whole object.":
    "slot_values es un REEMPLAZO COMPLETO de los valores del vínculo: léelos con get_board_loop_binding_raw y envía el objeto entero.",
  "Browse the loop template catalog: system templates then workspace ones, as summaries. Prompts and slots live behind get_loop_template.":
    'Explora el catálogo de plantillas de loop: primero las de "system" y luego las del espacio de trabajo, como resúmenes. Los prompts y los slots están detrás de get_loop_template.',
  "Free-text filter over name and slug. Omit for the full catalog.":
    "Filtro de texto libre sobre el nombre y el slug. Omítelo para ver el catálogo completo.",
  '"name" (default), "updated_at", or "boards_using".':
    '"name" (predeterminado), "updated_at" o "boards_using".',
  "True to also list soft-archived workspace templates.":
    "True para listar también las plantillas del espacio de trabajo archivadas de forma reversible.",
  "Entries are summaries on purpose — a catalog that inlined every prompt pair would ship tens of kilobytes per call.":
    "Las entradas son resúmenes a propósito: un catálogo que incluyera cada par de prompts enviaría decenas de kilobytes por llamada.",
  "meta.runner_vars carries the runner's Go-template variable vocabulary, so a prompt editor never has to hardcode it.":
    "meta.runner_vars lleva el vocabulario de variables Go-template del runner, para que un editor de prompts nunca tenga que escribirlo a mano.",
  "Read one loop template. view picks the read: full (default), profile with track record, preview render, fit pre-flight against a board, or lint for repo facts.":
    "Lee una plantilla de loop. view elige la lectura: full (predeterminado), profile con historial, renderizado de preview, pre-verificación fit contra un tablero, o lint para datos del repositorio.",
  '"full" (default), "profile", "preview", "fit" or "lint" — which read this is. Anything else is rejected before a request is made.':
    '"full" (predeterminado), "profile", "preview", "fit" o "lint": qué lectura es esta. Cualquier otro valor se rechaza antes de hacer ninguna petición.',
  "view=\"full\" only: true also resolves a soft-archived workspace template. A board bound before the archive still runs it, so reading that board's loop needs this.":
    'Solo con view="full": true resuelve también una plantilla del espacio de trabajo archivada de forma reversible. Un tablero vinculado antes del archivado sigue ejecutándola, así que leer el loop de ese tablero necesita esto.',
  "UUID (or slug) of a board. Required for view=\"fit\"; optional for view=\"preview\", where the board's autofill values and rails participate in the render.":
    'UUID (o slug) de un tablero. Obligatorio con view="fit"; opcional con view="preview", donde los valores de autofill y los rails del tablero participan en el renderizado.',
  'view="preview" only: false omits the rendered prompt bodies and keeps the findings, slot and rails data.':
    'Solo con view="preview": false omite los cuerpos de prompt renderizados y conserva los hallazgos y los datos de slots y rails.',
  'view="full" returns everything — profile, system/loop prompts, slot specs, rails defaults and tool grants. A ref is a system slug OR a workspace row UUID: the namespaces never mix, and there is no slug@version form.':
    'view="full" devuelve todo: perfil, prompts de sistema y de loop, especificaciones de slots, valores predeterminados de rails y permisos de herramientas. Una ref es un slug de "system" O el UUID de fila del espacio de trabajo: los espacios de nombres nunca se mezclan, y no existe la forma slug@version.',
  'view="profile" is the track record — boards using it, iterations, spend and outcome tallies — that makes "does this loop actually work?" answerable before binding a board. Archived templates are included here.':
    'view="profile" es el historial (tableros que la usan, iteraciones, gasto y recuento de resultados) que permite responder "¿este loop funciona de verdad?" antes de vincular un tablero. Las plantillas archivadas se incluyen aquí.',
  'view="preview" renders the prompts without binding or storing anything. include_prompts defaults to true and returns three full bodies — tens of kilobytes — so an agent already running inside a loop should not call it; false keeps findings, missing_required, used_values, rails and tools.':
    'view="preview" renderiza los prompts sin vincular ni guardar nada. include_prompts es true por defecto y devuelve tres cuerpos completos (decenas de kilobytes), así que un agente que ya se ejecuta dentro de un loop no debería llamarlo; false conserva findings, missing_required, used_values, rails y tools.',
  'view="fit" is a read-only board pre-flight: each check reports ok, missing or warn with its evidence, and carries a fix_id only when apply_loop_template_fixes can close it. autofill proposes slot values derived from the board, so binding never starts from an empty form.':
    'view="fit" es una pre-verificación del tablero de solo lectura: cada comprobación informa ok, missing o warn con su evidencia, y lleva un fix_id solo cuando apply_loop_template_fixes puede cerrarla. autofill propone valores de slot derivados del tablero, así que vincular nunca parte de un formulario vacío.',
  'view="lint" flags repo-specific facts — URLs, org/repo names, commit SHAs, machine paths — left in the kernel prompts that belong in slots before sharing. Hints only, false positives expected: publish and export succeed regardless.':
    'view="lint" señala datos específicos del repositorio (URLs, nombres org/repo, SHAs de commit, rutas de máquina) que quedaron en los prompts del kernel y que deberían ir en slots antes de compartir. Solo son pistas y se esperan falsos positivos: publicar y exportar funcionan igual.',
  'A view-specific param passed outside its view, an unknown view, or view="fit" without board_id is rejected before any request. Archived templates are excluded from view="full" by default, exactly as the REST route excludes them — pass include_archived to read one a board is still bound to.':
    'Un parámetro propio de una vista pasado fuera de ella, una vista desconocida, o view="fit" sin board_id se rechazan antes de cualquier petición. Las plantillas archivadas se excluyen de view="full" por defecto, exactamente como las excluye la ruta REST: pasa include_archived para leer una a la que un tablero sigue vinculado.',
  "A system template slug, or a workspace template's row UUID.":
    'Un slug de plantilla "system", o el UUID de fila de una plantilla del espacio de trabajo.',
  "Create a workspace loop template as a draft (version 0, nothing published). Admin only; runner keys are refused.":
    "Crea una plantilla de loop del espacio de trabajo como borrador (versión 0, nada publicado). Solo admin; las claves de runner se rechazan.",
  "URL-safe identifier, unique within the workspace.":
    "Identificador seguro para URL, único dentro del espacio de trabajo.",
  "Human-readable display name.": "Nombre visible legible para personas.",
  "Prompt/slot/rails body — {system_prompt, loop_prompt, slots, tools, rails_defaults}. Omit to start empty.":
    "Cuerpo de prompts, slots y rails: {system_prompt, loop_prompt, slots, tools, rails_defaults}. Omítelo para empezar vacío.",
  "Presentation identity — {emoji, tagline, tags}. Omit for none.":
    "Identidad de presentación: {emoji, tagline, tags}. Omítelo para no incluir ninguna.",
  "Deliberately NOT idempotent: a repeated slug returns 409 rather than the existing row, so your content is never silently discarded.":
    "Deliberadamente NO idempotente: un slug repetido devuelve 409 en lugar de la fila existente, de modo que tu contenido nunca se descarta en silencio.",
  "Large prompt bodies are better authored in the UI or over REST — MCP transports have garbled multi-kilobyte strings before.":
    "Los cuerpos de prompt grandes es mejor escribirlos en la UI o por REST: los transportes MCP ya han corrompido cadenas de varios kilobytes antes.",
  "Template mutations are admin + runner-caller-banned: a runner editing the prompt that governs it is the escalation this surface refuses.":
    "Las mutaciones de plantillas requieren admin y prohíben a los runners como llamantes: que un runner edite el prompt que lo gobierna es la escalada de privilegios que esta superficie rechaza.",
  "Autosave the draft half of a workspace template. Publishing is a separate step. Admin only; runner keys are refused.":
    "Guarda automáticamente la mitad del borrador de una plantilla del espacio de trabajo. Publicar es un paso aparte. Solo admin; las claves de runner se rechazan.",
  "The workspace template's row UUID (or slug).":
    "El UUID de fila de la plantilla del espacio de trabajo (o su slug).",
  "Full replacement prompt/slot/rails body — not a deep merge.":
    "Cuerpo de prompts, slots y rails de reemplazo completo: no es un merge profundo.",
  "Full replacement presentation identity.":
    "Identidad de presentación de reemplazo completo.",
  "Optimistic lock — the draft_updated_at you last read. A concurrent edit makes this 409 instead of clobbering.":
    "Bloqueo optimista: el draft_updated_at que leíste por última vez. Una edición concurrente devuelve 409 en lugar de pisar los cambios.",
  "content and profile REPLACE their whole object when sent: read the template first and send the full object back, never a fragment.":
    "content y profile REEMPLAZAN todo su objeto cuando se envían: lee primero la plantilla y devuelve el objeto completo, nunca un fragmento.",
  "System templates are code-defined and cannot be edited — duplicate one into the workspace first.":
    'Las plantillas "system" están definidas en el código y no se pueden editar: duplica una en el espacio de trabajo primero.',
  "Passing no field at all returns an error rather than bumping the draft timestamp for nothing.":
    "No pasar ningún campo devuelve un error en lugar de actualizar la marca de tiempo del borrador para nada.",
  "Validate the draft, snapshot it as a new version, and bump the published version. Boards bound to it then see drift.":
    "Valida el borrador, lo guarda como una nueva versión y sube la versión publicada. Los tableros vinculados a ella pasan entonces a ver drift.",
  "Optimistic lock — the version you believe is current.":
    "Bloqueo optimista: la versión que crees que es la actual.",
  "Short changelog line stored with the version (<= 500 chars).":
    "Línea breve de changelog almacenada con la versión (<= 500 caracteres).",
  "A draft that fails validation returns 422 with findings attached, each naming the offending field.":
    "Un borrador que no pasa la validación devuelve 422 con los hallazgos adjuntos, cada uno nombrando el campo problemático.",
  "Publishing does not touch bound boards — they keep their rendered prompts until someone re-renders.":
    "Publicar no toca los tableros vinculados: conservan sus prompts renderizados hasta que alguien vuelva a renderizar.",
  "Fork any template — system or workspace — into a new workspace draft, recording lineage back to the source.":
    'Bifurca cualquier plantilla —de "system" o del espacio de trabajo— en un nuevo borrador del espacio de trabajo, registrando el linaje hasta el origen.',
  "The template to fork — a system slug or a workspace row UUID.":
    'La plantilla a bifurcar: un slug de "system" o el UUID de fila del espacio de trabajo.',
  "Slug for the copy. Omit to let the backend derive a unique one.":
    "Slug para la copia. Omítelo para que el backend derive uno único.",
  "This is how a system template gets customized: system templates are immutable, so editing one means duplicating it first.":
    'Así se personaliza una plantilla "system": las plantillas "system" son inmutables, así que editar una implica duplicarla primero.',
  "Soft-archive a workspace template, or restore it to the listing with archived=false. There is no hard delete.":
    "Archiva de forma reversible una plantilla del espacio de trabajo, o restáurala al listado con archived=false. No hay borrado definitivo.",
  "True to archive (default), false to restore to the listing.":
    "True para archivar (predeterminado), false para restaurar al listado.",
  "Archiving removes it from the catalog listing but keeps it serving boards already bound to it.":
    "Archivar la quita del listado del catálogo pero la mantiene sirviendo a los tableros ya vinculados a ella.",
  "There is no hard delete on purpose — a board bound to a deleted template would render nothing on its next iteration.":
    "No hay borrado definitivo a propósito: un tablero vinculado a una plantilla eliminada no renderizaría nada en su siguiente iteración.",
  "The template's published history, newest first: version number, publish timestamp, and changelog note.":
    "El historial publicado de la plantilla, de más reciente a más antiguo: número de versión, marca de tiempo de publicación y nota de changelog.",
  "Stage a published snapshot as the current draft. It does NOT republish — review, then publish separately.":
    "Prepara una instantánea publicada como el borrador actual. NO vuelve a publicar: revisa y luego publica por separado.",
  "The published version number to stage as the draft.":
    "El número de versión publicada que se preparará como borrador.",
  "Restoring is a draft edit, not a rollback: the published version stays put until you publish the restored draft.":
    "Restaurar es una edición del borrador, no un rollback: la versión publicada se mantiene igual hasta que publiques el borrador restaurado.",
  "Raw view of a board's template binding: template, version, rendered slot values, and drift — the authoring state behind get_board_loop, the effective loop config.":
    "Vista cruda del vínculo de plantilla de un tablero: plantilla, versión, valores de slot renderizados y drift; el estado de autoría detrás de get_board_loop, la configuración efectiva del ciclo.",
  "True to also fetch the unified prompt diff and slot delta between the bound version and the current one.":
    "True para obtener también el diff unificado de prompts y el delta de slots entre la versión vinculada y la actual.",
  'get_board_loop carries only the slim template ref — enough to render "bound to X", not enough to re-render. This is the read that answers "what would I edit?".':
    'get_board_loop solo lleva la ref reducida de la plantilla: suficiente para mostrar "vinculado a X", pero no para volver a renderizar. Esta es la lectura que responde "¿qué editaría?".',
  "Returns 404 not_bound when the board's prompts are raw rather than template-rendered.":
    "Devuelve 404 not_bound cuando los prompts del tablero son texto plano en vez de renderizados desde una plantilla.",
  "include_diff costs a second round-trip and is skipped entirely when the binding reports diff_available: false — a board with no drift has nothing to diff.":
    "include_diff cuesta un segundo viaje de ida y vuelta y se omite por completo cuando el vínculo informa diff_available: false: un tablero sin drift no tiene nada que comparar.",
  "Apply the named setup fixes from a fit report (create a missing column, add a label) and return the freshly recomputed report.":
    "Aplica las correcciones de configuración indicadas en un informe de compatibilidad (crear una columna que falta, añadir una etiqueta) y devuelve el informe recalculado.",
  "The fix_id values from get_loop_template(view='fit'), e.g. \"create_column:done\". Only these are applied — nothing implicit.":
    "Los valores fix_id de get_loop_template(view='fit'), p. ej. \"create_column:done\". Solo se aplican estos: nada implícito.",
  "Admin + human keys only — the backend 403s runner callers, because a loop runner reshaping the board that governs it is a privilege escalation.":
    "Solo claves de admin y humanas: el backend devuelve 403 a los llamantes de tipo runner, porque un runner de loop que remodela el tablero que lo gobierna es una escalada de privilegios.",
  "Idempotent per fix: an already-satisfied requirement returns skipped_already_satisfied, never an error.":
    "Idempotente por corrección: un requisito ya satisfecho devuelve skipped_already_satisfied, nunca un error.",
  "Unknown fix ids are rejected wholesale (422) before anything is applied; a frozen board 409s.":
    "Los ids de corrección desconocidos se rechazan en bloque (422) antes de aplicar nada; un tablero congelado devuelve 409.",
  "Acts on the DRAFT half, like the report it consumes: a board can be prepared for a contract that has not been published yet. A column is inert until something binds to it.":
    "Actúa sobre la mitad BORRADOR, igual que el informe que consume: un tablero puede prepararse para un contrato que todavía no se ha publicado. Una columna es inerte hasta que algo se vincula a ella.",
  "This mutates board structure — it can create columns and labels. Run get_loop_template(view='fit') first and pass only the fix_ids you intend.":
    "Esto muta la estructura del tablero: puede crear columnas y etiquetas. Ejecuta get_loop_template(view='fit') primero y pasa solo los fix_ids que pretendes aplicar.",
  "Export one loop template as a portable envelope — profile, prompts, slots, rails. Feed it to import_loop_template to promote a proven loop elsewhere.":
    "Exporta una plantilla de loop como un sobre portable: perfil, prompts, slots y rails. Pásalo a import_loop_template para promover un loop ya probado en otro sitio.",
  "The URL slug identifying the SOURCE workspace.":
    "El slug de URL que identifica el espacio de trabajo de ORIGEN.",
  "Exports the DRAFT half, so work in progress is shareable — publish first if you mean to share the runnable version.":
    "Exporta la mitad del BORRADOR, así el trabajo en curso se puede compartir: publica primero si quieres compartir la versión ejecutable.",
  "Exporting a SYSTEM template is allowed and marked data.is_system_origin: it is the supported way to fork a shipped loop.":
    "Exportar una plantilla SYSTEM está permitido y se marca con data.is_system_origin: es la forma soportada de bifurcar un loop ya distribuido.",
  "data.leak_findings carries the same repo-fact hints get_loop_template(view='lint') reports, as warnings only — the export always succeeds. _hint counts them.":
    "data.leak_findings lleva las mismas pistas sobre datos del repositorio que informa get_loop_template(view='lint'), solo como advertencias: la exportación siempre funciona. _hint las cuenta.",
  "Member-gated, not admin-gated: anyone who can read the template in the manager can export it.":
    "Restringido a miembros, no a admins: cualquiera que pueda leer la plantilla en el manager puede exportarla.",
  "Import a loop_template envelope as a DRAFT in this workspace. Previews by default; dry_run=false commits. Admin/human keys only — runners get 403.":
    "Importa un sobre loop_template como BORRADOR en este espacio de trabajo. Por defecto solo previsualiza; dry_run=false confirma los cambios. Solo claves de admin o humanas: los runners reciben 403.",
  "The URL slug identifying the TARGET workspace.":
    "El slug de URL que identifica el espacio de trabajo de DESTINO.",
  "The full envelope exactly as returned by export_loop_template.":
    "El sobre completo exactamente como lo devuelve export_loop_template.",
  "Defaults to true: report action, findings and diff_summary, and write nothing. Set false to apply.":
    "Por defecto true: informa action, findings y diff_summary, y no escribe nada. Ponlo en false para aplicar.",
  "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false, which adds template_id.":
    "`dry_run` es TRUE por defecto: no se escribe nada hasta que vuelvas a llamar con dry_run=false, lo que añade template_id.",
  "A commit always lands UNPUBLISHED, so an import can never change what a running board executes; publish_loop_template stays a separate act.":
    "Una confirmación siempre queda SIN PUBLICAR, de modo que una importación nunca puede cambiar lo que ejecuta un tablero en marcha; publish_loop_template sigue siendo un acto aparte.",
  "A matching slug in the target makes this action=updated — the existing DRAFT is overwritten. Check diff_summary in the dry run first.":
    "Un slug coincidente en el destino convierte esto en action=updated: se sobrescribe el BORRADOR existente. Revisa antes diff_summary en la ejecución en seco.",
  "Runner callers are refused with 403 by design: a runner must not import the prompt that governs it. Envelope mismatch → 400; unrenderable template → 422.":
    "Los llamantes de tipo runner se rechazan con 403 por diseño: un runner no debe importar el prompt que lo gobierna. Sobre incompatible → 400; plantilla no renderizable → 422.",
  "Bundles over ~64 KB are better sent to POST /loop-templates/import directly — large JSON bodies through MCP have been seen to garble.":
    "Los paquetes de más de ~64 KB conviene enviarlos directamente a POST /loop-templates/import: se ha visto que los cuerpos JSON grandes se corrompen al pasar por MCP.",
  "With dry_run=false a slug collision OVERWRITES the target workspace's existing draft for that slug. Export a backup bundle from the target first.":
    "Con dry_run=false una colisión de slug SOBRESCRIBE el borrador existente para ese slug en el espacio de trabajo de destino. Exporta antes un paquete de respaldo desde el destino.",
  "Skills": "Skills",
  "List the workspace skill library, or a board's effective skill set, with each skill's declared toolsets. Metadata only — file contents live behind get_skill.":
    "Lista la biblioteca de skills del espacio de trabajo, o el conjunto efectivo de skills de un tablero, con los toolsets declarados de cada skill. Solo metadatos: el contenido de los archivos vive detrás de get_skill.",
  "Board UUID or slug (backend-resolved). When given, returns the board's effective skill set instead of the full workspace library.":
    "UUID o slug del tablero (resuelto por el backend). Si se indica, devuelve el conjunto efectivo de skills del tablero en lugar de la biblioteca completa del espacio de trabajo.",
  "Workspace listings hide archived skills by default; pass true to include them. Ignored when board_id is given.":
    "Los listados del espacio de trabajo ocultan las skills archivadas por defecto; pasa true para incluirlas. Se ignora cuando se indica board_id.",
  "Listings never inline file contents — install a skill by calling get_skill and writing each returned file verbatim into your local skills dir.":
    "Los listados nunca incluyen el contenido de los archivos: instala una skill llamando a get_skill y escribiendo cada archivo devuelto textualmente en tu directorio local de skills.",
  "Fetch a skill version's files verbatim (SKILL.md plus support files) and its declared toolsets. Omitting version resolves the latest published one.":
    "Obtiene textualmente los archivos de una versión de una skill (SKILL.md más archivos de apoyo) y sus toolsets declarados. Si se omite version, se resuelve la última versión publicada.",
  "The skill slug.": "El slug de la skill.",
  "Explicit version number. Omit to fetch the latest published version; pass explicitly to fetch a specific version or a draft.":
    "Número de versión explícito. Omítelo para obtener la última versión publicada; pásalo explícitamente para obtener una versión concreta o un borrador.",
  "Path of a single file to return in full, bypassing the per-file truncation cap.":
    "Ruta de un único archivo que se devuelve completo, omitiendo el límite de truncado por archivo.",
  "Files longer than 6000 chars are truncated in the multi-file response (flagged via _files_truncated) — re-fetch each one in full with file_path.":
    "Los archivos de más de 6000 caracteres se truncan en la respuesta multiarchivo (marcada vía _files_truncated); vuelve a obtener cada uno completo con file_path.",
  "A skill with no published version returns empty files; pass version explicitly to read a draft.":
    "Una skill sin versión publicada devuelve archivos vacíos; pasa version explícitamente para leer un borrador.",
  "Enable or disable a workspace skill on a board, optionally pinning a version. Idempotent — re-binding updates in place.":
    "Habilita o deshabilita una skill del espacio de trabajo en un tablero, con la opción de fijar una versión. Idempotente: volver a vincular actualiza en el lugar.",
  "The board UUID or slug (backend-resolved).": "El UUID o slug del tablero (resuelto por el backend).",
  "The slug of the workspace skill to bind.": "El slug de la skill del espacio de trabajo a vincular.",
  "Whether the skill is active on the board. Omit to leave an existing binding's state unchanged; a newly created binding defaults to enabled.":
    "Si la skill está activa en el tablero. Omítelo para dejar sin cambios el estado de una vinculación existente; una vinculación recién creada queda activa por defecto.",
  "Version number to pin the board to. Omit to leave any existing pin unchanged; an unpinned board tracks the latest published version.":
    "Número de versión al que fijar el tablero. Omítelo para dejar sin cambios cualquier fijación existente; un tablero sin fijar sigue la última versión publicada.",
  "Pass true to remove an existing version pin, returning the board to tracking the latest published version. Mutually exclusive with pinned_version.":
    "Pasa true para quitar una fijación de versión existente y devolver el tablero al seguimiento de la última versión publicada. Es mutuamente excluyente con pinned_version.",
  "Omitting pinned_version leaves an existing pin as-is (PUT semantics of an omitted field) — it does not clear the pin; unpin with clear_pin: true.":
    "Omitir pinned_version deja una fijación existente tal cual (semántica PUT de un campo omitido): no elimina la fijación; para quitarla usa clear_pin: true.",
  "pinned_version and clear_pin together is an error — pin or unpin, not both.":
    "Enviar pinned_version y clear_pin a la vez es un error: fija o quita la fijación, no ambas cosas.",
  "Raw view of a board's skill binding rows, disabled ones included. list_skills(board_id) is the effective set callers actually get.":
    "Vista cruda de las filas de vinculación de skills de un tablero, incluidas las deshabilitadas. list_skills(board_id) es el conjunto efectivo que realmente reciben quienes lo llaman.",
  "Rows are configuration, not what agents get: a disabled binding or one resolving to no published version appears here but never in the board's effective set (list_skills with board_id).":
    "Las filas son configuración, no lo que reciben los agentes: una vinculación deshabilitada, o que no resuelve a ninguna versión publicada, aparece aquí pero nunca en el conjunto efectivo del tablero (list_skills con board_id).",
  "Unbind a skill from a board, deleting the binding row (enabled flag and pin included). Idempotent — removing a missing binding still succeeds.":
    "Desvincula una skill de un tablero y elimina la fila de la vinculación (incluidos el indicador enabled y la fijación). Idempotente: quitar una vinculación inexistente también termina con éxito.",
  "The slug of the bound skill to remove.": "El slug de la skill vinculada que se va a quitar.",
  "Unbind destroys the row's configuration — any version pin is lost. To keep the pin but take the skill out of the effective set, disable it instead via set_skill_binding with enabled: false.":
    "Desvincular destruye la configuración de la fila: se pierde cualquier fijación de versión. Para conservar la fijación pero sacar la skill del conjunto efectivo, deshabilítala con set_skill_binding y enabled: false.",
  "List the built-in skill catalog: platform-curated skills not yet in the workspace library, each with its declared toolsets, ready to activate.":
    "Lista el catálogo integrado de skills: las skills curadas por la plataforma que todavía no están en la biblioteca del espacio de trabajo, cada una con sus toolsets declarados y listas para activarse.",
  "Catalog entries are not workspace skills yet — activate one (activate_catalog_skill) to copy it into the library before it can be bound to boards.":
    "Las entradas del catálogo todavía no son skills del espacio de trabajo: activa una (activate_catalog_skill) para copiarla a la biblioteca antes de poder vincularla a tableros.",
  "Copy a catalog entry into the workspace library as a published v1. Idempotent — re-activation returns the existing copy untouched.":
    "Copia una entrada del catálogo a la biblioteca del espacio de trabajo como una v1 publicada. Idempotente: volver a activarla devuelve la copia existente sin tocarla.",
  "The catalog entry id, from list_skill_catalog.":
    "El id de la entrada del catálogo, obtenido de list_skill_catalog.",
  "Human sessions only: the backend rejects runner-bound callers (API keys linked to a runner identity) with a 403 — activation is a curation decision reserved for people.":
    "Solo para sesiones humanas: el backend rechaza con 403 a quienes llaman con identidad de runner (claves de API vinculadas a un runner), porque la activación es una decisión de curación reservada a las personas.",
  "Propose a new skill (or version) for the workspace library. Lands as a draft pending human approval; idempotent — re-proposing returns the existing pending proposal.":
    "Propone una skill nueva (o una nueva versión de una existente) para la biblioteca del espacio de trabajo. Queda como borrador pendiente de aprobación humana; idempotente: volver a proponer devuelve la propuesta pendiente existente.",
  "The skill slug the proposal creates or versions.":
    "El slug de la skill que la propuesta crea o versiona.",
  'The skill\'s files as [{"path": ..., "content": ...}] — SKILL.md plus any support files, contents sent verbatim.':
    'Los archivos de la skill como [{"path": ..., "content": ...}]: SKILL.md más cualquier archivo de apoyo, con el contenido enviado textualmente.',
  "Display name. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.":
    "Nombre para mostrar. Omítelo para que el backend lo tome del frontmatter de SKILL.md, que es la fuente autoritativa.",
  "Description. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.":
    "Descripción. Omítela para que el backend la tome del frontmatter de SKILL.md, que es la fuente autoritativa.",
  "Board UUID or slug (backend-resolved) to associate the proposal with — e.g. the board whose loop produced it.":
    "UUID o slug del tablero (resuelto por el backend) al que asociar la propuesta, p. ej. el tablero cuyo loop la produjo.",
  "Nothing is published until a human approves — poll get_approval_status with the returned approval_id before relying on the skill.":
    "Nada se publica hasta que un humano lo aprueba: consulta get_approval_status con el approval_id devuelto antes de confiar en la skill.",
  "File contents are sent verbatim on this write path — the 6000-char truncation cap only applies to reads via get_skill.":
    "El contenido de los archivos se envía textualmente en esta ruta de escritura: el límite de truncado de 6000 caracteres solo aplica a lecturas vía get_skill.",
  "Whether loop agents on this board may call propose_skill. Defaults to true (backend-enforced). When false the backend strips propose_skill from the loop's served tool allowlist. Omit to leave unchanged.":
    "Si los agentes de loop de este tablero pueden llamar a propose_skill. Por defecto es true (lo aplica el backend). Cuando es false, el backend elimina propose_skill de la lista de herramientas servida al loop. Omítelo para dejarlo sin cambios.",
} as const;

const ES_MCP_PROMPT_CATALOG = {
  "Prompts are server-authored multi-phase workflow templates. An MCP host (Claude Code, Claude Desktop, a runner) expands a prompt by name and gets back a long instruction block that the LLM then executes as a sequenced plan. The templates do not share one universal phase cadence or confirmation rule: ": "Los prompts son plantillas multifase creadas por el servidor. Un host MCP (Claude Code, Claude Desktop o un runner) expande un prompt por nombre y recibe un bloque de instrucciones que la LLM ejecuta como plan secuenciado. Las plantillas no comparten una cadencia universal ni una sola regla de confirmación: ",
  " explicitly waits for confirmation before applying fixes, while": " espera confirmación explícita antes de aplicar correcciones, mientras que",
  " asks before deleting a parent card. Other prompts can present a plan and then proceed without a second confirmation gate.": " pregunta antes de eliminar una tarjeta padre. Otros prompts pueden presentar un plan y luego continuar sin una segunda confirmación.",
  " prompts total, organized by agent role. ": " prompts, organizados por rol. ",
  "Prompts are organized by agent role. ":
    "Los prompts están organizados por rol de agente. ",
  "Parameters are interpolated into the prompt body at expansion time. The LLM sees the rendered string; parameter names are not visible to it. Invoking a prompt is not a transaction boundary: the host sends rendered prose to the model, and any resulting tool calls still run through normal authentication, authorization, and MCP allowlist checks.": "Los parámetros se interpolan al expandir el prompt. La LLM ve el texto renderizado, no los nombres de los parámetros. Invocar un prompt no crea un límite transaccional: el host envía texto al modelo y cualquier llamada a herramientas sigue pasando por autenticación, autorización y la allowlist de MCP.",
  "The prompts": "Los prompts",
  "Prompt": "Prompt",
  "Role": "Rol",
  "Parameters": "Parámetros",
  "Purpose": "Propósito",
  "Initializer": "Inicializador",
  "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.": "Inicializa un proyecto completo desde un brief: tablero, columnas, definición, canales, tarjetas iniciales, una nota fijada de decisiones y repositorio git. Los miembros del equipo nombrados en el brief se agregan como miembros del espacio de trabajo, lo que les concede acceso al espacio. Úsalo una sola vez al iniciar un proyecto nuevo en un espacio de trabajo.",
  "Secretary": "Secretario",
  "Generate a daily standup for one board — progress, stale and overdue cards, bottlenecks — saved as a board note. Run each morning or before a team sync.": "Genera un standup diario con progreso, atrasos y bloqueos como nota.",
  "Audit board hygiene — missing priorities, empty descriptions, overdue or stale cards — into a health score with proposed fixes. Fixes run only after you confirm.": "Audita la higiene del tablero y propone correcciones, que solo aplica tras confirmar.",
  "Summarize every board in a workspace: completion, urgent and overdue counts, stalled boards, plus the top 3 recommended actions. Use for a weekly or executive overview.": "Resume todos los tableros y las 3 acciones principales.",
  "Architect": "Arquitecto",
  "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.": "Descompone un objetivo en tarjetas de 1-3 días y una tarjeta ACCEPT-.",
  "Split one oversized card into smaller, independently deliverable child cards that inherit its labels and priority. Use when a card is too big for 1-3 days of work.": "Divide una tarjeta grande en hijas independientes.",
  "Plan a sprint: measure velocity, select backlog cards within capacity, stage them in the sprint column with due dates and owners, and pin a sprint-plan note.": "Planifica un sprint con capacidad, fechas, responsables y nota fijada.",
  "Coder": "Desarrollador",
  "Claim a card interactively: pick from the backlog-typed column, move it into the active-typed column, and output an implementation brief. Runners use next_assignment.": "Toma una tarjeta de backlog, la mueve a active y genera un brief; runners usan next_assignment.",
  "Run the full delivery loop for one card: claim it, plan against the codebase, implement with strict TDD, verify, then move it to review with an implementation record.": "Ejecuta entrega completa con TDD y mueve a review.",
  "Close out a reviewed card: move it to Done, mark it completed, write a completion note, report newly unblocked cards, and suggest the next card to pick up.": "Cierra una tarjeta revisada, registra el resultado y los desbloqueos.",
  "How a host invokes them": "Cómo los invoca un host",
  "In Claude Code and Claude Desktop, prompts appear in the slash- command palette. The host fetches the prompt template, interpolates any parameters the user typed, and sends the resulting prose to the model as a user turn. The model then executes it as a plan — no different from the user typing a long, careful instruction by hand.": "En Claude Code y Desktop aparecen como comandos con barra; el host interpola parámetros y envía el plan al modelo.",
  "The Go runner does not expand this MCP prompt catalog during stage assembly. It fetches workspace prompt configurations and pipeline assignments through REST, then gives the spawned coding-agent session its allowed MCP tools. MCP prompts are host-facing templates, separate from the platform's pipeline prompt configurations.": "El runner de Go no expande este catálogo de prompts MCP durante el armado de una etapa. Obtiene las configuraciones de prompts del espacio de trabajo y las asignaciones del pipeline mediante REST, y luego entrega a la sesión del agente de código las herramientas MCP permitidas. Los prompts MCP son plantillas para los hosts, distintas de las configuraciones de prompts del pipeline de la plataforma.",
  "The slash-command name and the MCP handle disagree": "El comando con barra y el handle MCP difieren",
  "The MCP install guide's workflow overview shows prompts with dashed names —": "La guía muestra nombres con guiones —",
  ". The MCP server registers them with underscores — ": ". El servidor registra guiones bajos — ",
  ". A user typing the dashed form into a host that strictly matches registered MCP names will come up empty. Use the underscore handles shown in this catalog; dashed aliases are not registered by the server.": ". Un host que exija coincidencia exacta no encontrará la forma con guiones. Usa los identificadores con guion bajo de este catálogo; el servidor no registra alias con guiones.",
} as const;

const ES_EVENT_TAXONOMY = {
  "Every relevant mutation publishes through the event-bus interface selected by ": "Toda mutación relevante se publica mediante la interfaz del bus de eventos seleccionada por ",
  " delivers only to subscribers in the same process; ": " solo entrega a suscriptores del mismo proceso; ",
  " preserves that local fan-out and adds cross-instance delivery through Postgres LISTEN/NOTIFY. Both feed WebSocket connections and the origin instance's external-webhook subscriber. Events carry a": " conserva esa distribución local y añade entrega entre instancias mediante Postgres LISTEN/NOTIFY. Ambos alimentan las conexiones WebSocket y el suscriptor de webhooks externos de la instancia de origen. Los eventos incluyen un",
  " and a ": " y un ",
  "; subscribers filter by ": "; los suscriptores filtran por ",
  " pattern (": " con el patrón (",
  "The authoritative surface is the ": "La superficie autoritativa es el namespace ",
  " namespace —": " —",
  " emits one of these for every entity mutation it records. The other namespaces carry events the activity fan-out doesn't cover: approvals, executions, runner lifecycle, config changes, cost alerts.": " emite uno por mutación; otros namespaces cubren aprobaciones, ejecuciones, runners, config y costos.",
  "activity.* — primary fan-out": "activity.* — distribución principal",
  "Emitted as ": "Emitido como ",
  ". The payload matches the activity-log row (entity_id, action, actor_id, optional board_id, summary, changes).": ". El payload coincide con activity-log (entity_id, action, actor_id, board_id opcional, summary, changes).",
  "Namespace": "Namespace",
  "Actions emitted": "Acciones emitidas",
  " — lifecycle detail is carried in ": " — el detalle del ciclo de vida se incluye en ",
  "Service-owned event namespaces": "Namespaces de eventos administrados por servicios",
  "Events published directly by their owning services — not activity rows. These carry service-specific payload shapes.": "Eventos directos de sus servicios, con payload específico.",
  "Event": "Evento",
  "Publisher": "Publicador",
  "Key payload fields": "Campos principales",
  " (terminal status)": " (status terminal)",
  "; an in-flight warning, not completion": "; una advertencia durante la ejecución, no una finalización",
  " on activate / deactivate / re- activate": " al activar / desactivar / reactivar",
  " (WS-gated; 503 without an active connection)": " (condicionado a WS; 503 sin conexión)",
  " for restart; ": " para restart; ",
  "for deletion": "para la eliminación",
  " after a loop-state change": " después de un cambio del estado de loop",
  " on the key's first-ever use": " en el primer uso histórico de la clave",
  "; WebSocket delivery is restricted to that user": "; la entrega WebSocket queda restringida a ese usuario",
  "In-app notification channel, after the outer transaction commits": "Canal de notificaciones in-app, después del commit de la transacción externa",
  "; WebSocket delivery is restricted to the recipient": "; la entrega WebSocket queda restringida al destinatario",
  " through": " hasta",
  ", plus outcome fields": ", además de los campos del resultado",
  " on the first stale detection": " al detectar que está obsoleta por primera vez",
  "Queue identity plus ": "Identidad de la cola más ",
  "; latched to emit once per entry": "; con un latch para emitirse una sola vez por entrada",
  " on loop config save, enable / disable, and loop-template bind / re-render / detach": " al guardar la configuración del bucle, al habilitar o deshabilitar y al vincular, volver a renderizar o desvincular un loop template",
  " — deliberately thin (the NOTIFY payload cap); clients refetch rather than read state off the event": " — deliberadamente mínimo (por el límite del payload de NOTIFY); los clientes vuelven a consultar en lugar de leer el estado desde el evento",
  "Agent / team / prompt_config / workspace_config / loop_template services": "Servicios agent / team / prompt_config / workspace_config / loop_template",
  " — plus": " — más",
  " when": " cuando",
  ", whose actions extend beyond created/updated/deleted to": ", cuyas acciones van más allá de created/updated/deleted e incluyen",
  "Deprecated — bridge events (still firing)": "Obsoletos — eventos puente aún activos",
  "Before the ": "Antes de ",
  " fan-out existed, the platform emitted un-namespaced lifecycle events directly. A small number of these still publish in parallel with their ": " existían eventos sin namespace; algunos aún se emiten junto con su ",
  "twin so pre-migration subscribers don't break. New code should not subscribe to these.": "equivalente para compatibilidad. El código nuevo no debe suscribirse.",
  "Replacement": "Reemplazo",
  "Delivery boundaries": "Límites de entrega",
  "The live EventBus and WebSocket surface is broader than the public webhook selector. The ": "La superficie activa de EventBus y WebSocket es más amplia que el selector público de webhooks. El schema ",
  " schema currently exposes the bridge events, the listed ": " expone actualmente los eventos puente, los pares de ",
  " pairs through ": " enumerados hasta ",
  ", and the original approval, execution, agent-status, config, and cost events. It does not expose": ", además de los eventos originales de aprobación, ejecución, estado de agentes, configuración y costos. No expone",
  " or the newer direct events such as": " ni los eventos directos más recientes, como",
  ", or": ", ni",
  ". Those names cannot be selected through the webhook create or update API today.": ". Actualmente estos nombres no se pueden seleccionar mediante la API de creación o actualización de webhooks.",
  "Two additional names, ": "Otros dos nombres, ",
  " and": " y",
  ", coordinate restart discovery between backend workers. The connection manager explicitly suppresses them from client WebSockets. ": ", coordinan el descubrimiento de reinicios entre workers del backend. El gestor de conexiones los excluye explícitamente de los WebSockets de clientes. ",
  " are also filtered per user rather than broadcast to every workspace member.": " también se filtran por usuario en vez de difundirse a todos los miembros del espacio.",
  "A live notification bus is not an audit log": "Un bus de notificaciones en vivo no es un log de auditoría",
  "Both backends provide at-most-once delivery with no replay. The memory backend also stops at the process boundary; Postgres LISTEN/NOTIFY closes that visibility gap but is still not a durable queue. Use the persisted activity, execution, approval, notification, and merge-queue rows as the source of truth, and treat events as prompts to refetch.": "Ambos backends ofrecen entrega como máximo una vez y sin replay. El backend memory además se detiene en el límite del proceso; Postgres LISTEN/NOTIFY cierra esa brecha de visibilidad, pero tampoco es una cola durable. Usa las filas persistidas de actividad, ejecución, aprobación, notificación y cola de merge como fuente de verdad, y trata los eventos como señales para volver a consultar.",
} as const;

const ES_COLUMN_TYPE_SEMANTICS = {
  "A column has two identities. Its ": "Una columna tiene dos identidades. Su ",
  "name": "nombre",
  " is what humans read on the board. Its ": " es visible; su ",
  " is what pipelines and runners match against. Rename a column and nothing else changes. Retype a column and you've rewired part of the pipeline.": " conecta pipelines y runners. Renombrar no cambia el flujo; cambiar el tipo sí.",
  "Five types exist today. The set is closed — operators can't declare new column types the way they can declare new roles. A column can also be untyped (": "Hay cinco tipos cerrados. Una columna también puede no tener tipo (",
  "), in which case pipeline stages with a ": "); entonces una estrategia discover ",
  " discover strategy will simply not see it.": " no la verá.",
  "The types": "Los tipos",
  "column_type": "column_type",
  "Semantic meaning": "Significado semántico",
  "Typical pipeline stages that target it": "Etapas que suelen usarlo",
  "Unstarted work. Usually unassigned, sometimes untriaged. The source of truth for \"what could be done next.\"": "Trabajo sin iniciar, normalmente sin asignar.",
  "Architect stages (": "Etapas de arquitectura (",
  "), triage, decomposition.": "), triage y descomposición.",
  "In-progress work. A runner has claimed a card here (or will). Also the destination of \"start work\" transitions.": "Trabajo activo, tomado por un runner.",
  "Implementer stages (": "Etapas de implementación (",
  "), pickup.": ") y asignación.",
  "Work awaiting evaluation. A reviewer role looks here for cards to pull and verdict on.": "Trabajo pendiente de evaluación.",
  "Reviewer stages, rework mediation, documentator walks.": "Revisión, retrabajo y documentación.",
  "Terminal success. Cards land here after a ship. Documentator stages often sweep this column for post-merge notes.": "Éxito terminal tras entregar.",
  "Documentator, post-ship hooks.": "Documentación y hooks posteriores.",
  "Work that can't progress — missing dependency, external wait, failed sensor. Rarely a destination; usually where a stage moves a card when ": "Trabajo bloqueado por dependencia, espera o sensor; se usa cuando ",
  " fires.": " se activa.",
  "Failure paths, sensor rejections, manual operator moves.": "Fallos, rechazos y movimientos manuales.",
  "The type is the contract, the name is cosmetic": "El tipo es el contrato; el nombre es cosmético",
  "Pipeline ": "Las estrategias ",
  " strategies and": " y acciones",
  " actions reference": " referencian",
  ", never ": ", nunca ",
  ". A column named \"Peer Review\" with type ": ". Una columna \"Peer Review\" de tipo ",
  " and a column named \"Review\" with type ": " y otra \"Review\" de tipo ",
  " are indistinguishable to a pipeline stage. Two columns sharing a type is supported — stages match all of them. A column with no type (": " son iguales para el pipeline. Se admiten tipos repetidos. Una columna sin tipo (",
  ") is invisible to type-matching stages.": ") es invisible.",
  "Practical consequences": "Consecuencias prácticas",
  "You can have multiple ": "Puedes tener varias columnas ",
  " columns (e.g., \"Ideas\" and \"Next Sprint\") and a single architect stage will treat them as one pool.": " y una etapa las tratará como un grupo.",
  "Renaming \"Done\" to \"Shipped\" changes what the board looks like, not what the documentator stage discovers.": "Renombrar \"Done\" a \"Shipped\" no cambia el descubrimiento.",
  "Dropping a column's type to ": "Dejar el tipo como ",
  " removes it from pipeline scope without deleting its cards — useful for staging a column out of rotation.": " la quita del pipeline sin borrar tarjetas.",
  "Adding a new column-type value is a backend change (enum + migration), not a configuration change. The current five cover the kanban idioms we've needed.": "Agregar un tipo requiere cambio de backend, enum y migración.",
} as const;

const ES_CARD_TYPE_AND_PRIORITY = {
  "Two enums on every card affect both visual styling on the board and the order in which discover strategies offer cards to runners. They are cosmetic in isolation and load-bearing in combination —": "Dos enums afectan el estilo y el orden de descubrimiento; juntos son críticos —",
  " in particular drives which card a polling runner sees first.": " determina qué tarjeta ve primero el runner.",
  "Card type": "Tipo de tarjeta",
  "Four values. Each maps to a Tailwind token in": "Cuatro valores, cada uno ligado a un token Tailwind en",
  " — no hex strings in the source. Type does not affect pipeline matching unless a stage filter explicitly references it; it's primarily a visual and human-filter concern.": "; sin hex en el código. Solo afecta filtros explícitos.",
  "card_type": "card_type",
  "Visual": "Visual",
  "Intended use": "Uso previsto",
  "Neutral token — the default.": "Token neutral predeterminado.",
  "The generic unit of work. Anything not obviously a bug, a new feature, or an open issue.": "Unidad genérica de trabajo.",
  "Rose / red-accented token.": "Token rose/rojo.",
  "Regression, defect, broken behavior. Pipelines that run a reproduction-first TDD flow typically filter to this type.": "Regresión o defecto; suele activar TDD desde reproducción.",
  "Emerald / green-accented token.": "Token emerald/verde.",
  "New capability. Usually decomposed by an architect stage before an implementer claims it.": "Nueva capacidad, normalmente descompuesta primero.",
  "Amber-accented token.": "Token amber.",
  "Open question, investigation, ambiguous report. Promoted to": "Pregunta o investigación; pasa a",
  " or ": " o ",
  " once triaged.": " tras triage.",
  "Priority": "Prioridad",
  "Five values, ordered. The ordering matters: discover strategies that return \"highest priority first\" use this enum as their sort key. Ties break on fractional position within the column, so priority acts as the primary key and position acts as the secondary.": "Cinco valores ordenados; prioridad es la clave primaria y la posición fraccionaria es la secundaria.",
  "The API schema and the ": "El esquema de la API y la herramienta ",
  " MCP tool default to": " de MCP usan por defecto",
  ". The create-card dialog defaults to medium and does not currently offer none in its selector, although existing": ". El diálogo de creación usa medium por defecto y actualmente no ofrece none en el selector, aunque las tarjetas existentes con",
  " cards render correctly elsewhere in the UI. Callers that need an explicit unset priority should use the API or MCP surface.": " se muestran correctamente en el resto de la interfaz. Para dejar la prioridad explícitamente sin definir, usa la API o MCP.",
  "priority": "priority",
  "Rank": "Rango",
  "Discover implication": "Efecto en descubrimiento",
  "Highest": "Más alta",
  "Pulled first by priority-ordered discover. Runners will claim an ": "Se toma primero; un card ",
  " card in": " en",
  " before touching a": " precede a uno",
  " card in the same column.": " de la misma columna.",
  "High": "Alta",
  "Second wave. The default for non-trivial work an architect stage creates via ": "Segunda ola; predeterminada para trabajo creado mediante ",
  "Medium (create-dialog default)": "Media (predeterminada en el diálogo de creación)",
  "The browser's create-card dialog preselects this value. API and MCP callers that omit priority create a": "El diálogo del navegador preselecciona este valor. Los clientes de API y MCP que omiten priority crean una tarjeta",
  " card instead.": " en su lugar.",
  "Low": "Baja",
  "Pulled after medium but before unprioritized ": "Se toma después de medium, pero antes de las tarjetas ",
  ". Useful for nice-to-haves when the runner has spare capacity.": ". Es útil para mejoras opcionales cuando el runner tiene capacidad disponible.",
  "Unprioritized (API and MCP default)": "Sin priorizar (predeterminado en API y MCP)",
  "Sorted after ": "Se ordena después de ",
  ". Use this value when priority has not been triaged yet; it is not selectable in the current create-card dialog.": ". Usa este valor cuando la prioridad aún no se haya definido; no se puede seleccionar en el diálogo actual de creación.",
  "Combined effect": "Efecto combinado",
  "A ": "Una estrategia ",
  " discover strategy sorts": " ordena por",
  ", then by fractional position within each bucket. A human dragging a card to the top of a column is effectively saying \"same priority, try me first\"; an operator bumping priority is saying \"jump the line across buckets.\" Both paths reach the same runner; the runner doesn't know or care which one put the card on top.": ", y luego por posición. Arrastrar prioriza dentro del grupo; subir prioridad salta entre grupos.",
} as const;

const ES_API_AUTHENTICATION_MODES = {
  "The backend accepts several auth modes, evaluated in a fixed order: API key, then the signed session cookie (in production), then dev mode (in development), then IAP, then trusted proxy. Whichever signal arrives first wins. This lets a single codebase serve dev laptops, self-hosted boxes with the built-in password login, OIDC or IAP-gated production, and API-key-bearing runners without branching logic at every router.": "El backend evalúa autenticación en orden: API key, cookie firmada, dev mode, IAP y trusted proxy. La primera señal gana y permite desarrollo, self-hosting, OIDC/IAP y runners.",
  "On the proxy-verified tiers (IAP, trusted proxy) users are auto-provisioned on first authenticated request (unless": "En IAP y trusted proxy los usuarios se crean al primer acceso salvo que",
  "). OIDC applies the same provisioning policy during its callback. With local password login, accounts come from the first-run setup screen or from a workspace admin — there is no self-registration.": "). OIDC aplica la misma política durante su callback. Con contraseña local, las cuentas nacen en el setup inicial o las crea un admin; no hay autorregistro.",
  "The modes": "Los modos",
  "Mode": "Modo",
  "When used": "Cuándo se usa",
  "Header(s) expected": "Headers esperados",
  "Notes": "Notas",
  "API key": "API key",
  "Runners, MCP callers, server-to-server integrations. Preferred for any automated caller.": "Runners, MCP e integraciones automatizadas.",
  "Backend matches the key by prefix + hash. The prefix column is stored; the full key is hashed at rest and shown to the user exactly once at creation time.": "El backend compara prefijo + hash; la clave completa se muestra una vez.",
  "Dev mode": "Dev mode",
  "Local development only. Active when ": "Solo desarrollo local. Activo cuando ",
  "and no bearer token is present.": "y no hay un bearer token.",
  "Falls back to ": "Usa ",
  " if the header is absent. This fallback is disabled outside development.": " si falta el header. Este fallback está desactivado fuera de desarrollo.",
  "Local password": "Contraseña local",
  "Browser traffic on self-hosted instances with no identity provider. On by default (": "Navegador self-hosted sin IdP; activo por defecto (",
  "); needs ": "); exige ",
  " to mint sessions.": " para crear sesiones.",
  " verifies an argon2id-hashed password and mints the same signed session cookie as OIDC — the cookie tier does not care how identity was proven. Every failed login is one uniform 401; attempts are throttled per IP and 5 straight failures lock the account for 15 minutes. See": " valida argon2id y emite la misma cookie OIDC. Fallos devuelven 401; hay límite por IP y bloqueo tras 5 fallos. Consulta",
  "local password login": "inicio con contraseña local",
  " below.": " abajo.",
  "OIDC session": "Sesión OIDC",
  "Browser traffic when you point Backplane at your own identity provider. The login affordance is active only when": "Tráfico de navegador cuando Backplane usa tu proveedor de identidad. La opción de login solo está activa cuando",
  ", and": ", y",
  " are all set.": " están definidos.",
  "Minted by ": "Emitida por ",
  " after an authorization-code + PKCE login. Signed with": " tras authorization code + PKCE. Firmada con",
  ", httponly, and valid for": ", httponly y válida por",
  ". Outranks IAP and trusted proxy; an invalid cookie is a rejection, never a fallback to a weaker tier.": ". Prevalece sobre IAP/proxy; cookie inválida se rechaza.",
  "IAP (JWT)": "IAP (JWT)",
  "Production browser traffic behind Google IAP. Active when": "Navegador en producción tras Google IAP; activo cuando",
  " is set.": " está definido.",
  "Backend verifies the JWT against Google's public keys with": "Verifica JWT con claves públicas de Google mediante",
  " and extracts the email claim. A missing or invalid JWT is a 403, not a fallback.": " y extrae el claim de email. Un JWT ausente o inválido devuelve 403, sin fallback.",
  "Trusted proxy (header)": "Trusted proxy (header)",
  "Production behind an authenticating proxy (IAP, oauth2-proxy, Authelia). Opt-in: set ": "Producción tras proxy autenticador; activa con ",
  ". Never automatic.": ". Nunca automática.",
  "No signature to verify, so the header is trusted only because the proxy is the only thing that can set it. Safe only when the backend is unreachable except through that proxy and the proxy strips client-supplied copies. Optionally set": "Sin firma, solo es seguro si el proxy es el único acceso y elimina headers del cliente. Opcionalmente define",
  " and have the proxy inject": " y haz que el proxy inyecte",
  " — requests without the matching value are rejected even if they carry the identity header. With neither this nor ": " — sin coincidencia se rechaza. Sin esto ni ",
  ", production refuses to start.": ", producción no inicia.",
  "Two provisioning knobs apply to verified browser identities (IAP, trusted proxy, and OIDC), not to API keys or dev mode:": "Dos controles se aplican a identidades verificadas de navegador (IAP, trusted proxy y OIDC), no a API keys ni a dev mode:",
  " restricts sign-in to a comma-separated list of email domains, and": " limita dominios y",
  " switches to invite-only. IAP and trusted-proxy requests receive HTTP 403 when the verified email has no existing account. The OIDC callback redirects with HTTP 302 to": " activa el modo solo por invitación. Las solicitudes IAP y trusted proxy reciben HTTP 403 cuando el correo verificado no tiene una cuenta. El callback de OIDC redirige con HTTP 302 a",
  " instead; it does not return a 403 page from the callback. Neither path creates a fresh user row. The domain allowlist also gates the local-auth paths that mint a login-capable account: first-run setup and an admin invite that grants an initial password (a plain, passwordless membership invite is a deliberate act and is not domain-checked). Rejections are logged with reason codes such as ": " en su lugar; el callback no devuelve una página 403. Ninguna ruta crea una fila de usuario. La allowlist de dominios también restringe las rutas de autenticación local que crean una cuenta con login: el setup inicial y una invitación de admin que concede una contraseña inicial (una invitación de membresía sin contraseña es un acto deliberado y no se valida contra el dominio). Los rechazos se registran con códigos de motivo como ",
  " so an auth outage is diagnosable from logs alone.": " para que una caída de autenticación pueda diagnosticarse solo con los logs.",
  "Headers, by example": "Ejemplos de headers",
  "API key — runners and MCP callers": "API key — runners y MCP",
  "Dev mode — local laptop only": "Dev mode — equipo local",
  "IAP JWT — production browser traffic": "IAP JWT — navegador en producción",
  "Local password login": "Inicio con contraseña local",
  "A fresh instance with an empty ": "Una instancia con la tabla ",
  " table serves a first-run setup screen: the first account created there becomes the instance's first user, and the setup route self-closes the moment any user exists (it reopens only if the table is ever empty again — an empty table means nobody can log in anyway). Passwords are stored as argon2id hashes with a 12-character minimum and no composition rules.": " vacía muestra una pantalla de setup inicial: la primera cuenta creada allí se convierte en el primer usuario de la instancia, y la ruta de setup se cierra en cuanto existe cualquier usuario (solo se vuelve a abrir si la tabla vuelve a quedar vacía; una tabla vacía significa que nadie puede iniciar sesión de todos modos). Las contraseñas se almacenan como hashes argon2id, con un mínimo de 12 caracteres y sin reglas de composición.",
  "Brute-force defence is two independent layers: a 10-requests-per-minute per-IP throttle on ": "Defensa en dos capas: 10 solicitudes/minuto por IP en ",
  ", and a DB-backed account lockout — 5 consecutive failures lock the account for 15 minutes. The lockout lives on the ": " y bloqueo DB tras 5 fallos. El bloqueo vive en ",
  " row, so it holds across replicas and restarts, and it expires on its own. On the wire a locked account, a wrong password, and a nonexistent email are all the same 401; operators can tell them apart from log reason codes.": " y persiste en todas las réplicas y los reinicios, y expira por sí solo. En la interfaz de red, una cuenta bloqueada, una contraseña incorrecta y un correo inexistente reciben el mismo 401; los operadores pueden distinguirlos mediante los códigos de motivo en los logs.",
  "Account management runs through workspace membership: a workspace": "La gestión usa membresía: un ",
  "owner or admin": "owner o admin",
  " can add a member by email with an optional initial password (applied only if the account has no password yet), and can generate a temporary password for any member of that workspace — shown exactly once, and it clears an active lockout. That temporary password is the recovery path: there is no SMTP dependency and no email-based reset. Everyone can change their own password from the sidebar, which requires the current password.": " puede agregar un miembro por correo con una contraseña inicial opcional (se aplica solo si la cuenta aún no tiene contraseña) y puede generar una contraseña temporal para cualquier miembro de ese espacio de trabajo; se muestra una sola vez y elimina un bloqueo activo. Esa contraseña temporal es la vía de recuperación: no depende de SMTP ni existe un restablecimiento por correo. Cada persona puede cambiar su propia contraseña desde la barra lateral, para lo cual se requiere la contraseña actual.",
  "Anyone who manages a workspace can create accounts": "Quien gestiona un espacio puede crear cuentas",
  "Instance-level authority is deliberately derived from workspace roles — there is no separate admin flag. The corollary: on an instance with several workspaces owned by different people, each of those owners (and their admins) can create instance-wide accounts and set temporary passwords for their own members. If that is too broad for your deployment, keep workspace ownership narrow. Two more honest notes: changing a password does not invalidate sessions minted earlier (the cookie is stateless), and admin-set passwords are not flagged temporary — nothing forces a rotation on first login.": "La autoridad a nivel de instancia se deriva deliberadamente de los roles del espacio de trabajo: no existe un admin flag separado. Por ello, en una instancia con varios espacios de trabajo con ownership de personas distintas, cada owner y sus admins pueden crear cuentas para toda la instancia y establecer contraseñas temporales para sus propios miembros. Si ese alcance es demasiado amplio, limita estrictamente el ownership de los espacios de trabajo. Además, cambiar una contraseña no invalida las sesiones emitidas antes, porque la cookie no tiene estado, y las contraseñas establecidas por un admin no se marcan como temporales: nada obliga a rotarlas en el primer inicio de sesión.",
  "Signing in with your own identity provider": "Inicio con tu proveedor de identidad",
  "Set ": "Define ",
  " and Backplane runs a backend-driven authorization-code flow with PKCE against any OpenID Connect provider (Keycloak, Authentik, Google, Entra, Okta). Everything else — authorization endpoint, token endpoint, JWKS, logout — is read from the issuer's discovery document, so there are no per-endpoint settings to drift out of sync. Tokens never reach the browser: the callback verifies the ID token server-side and mints a signed session cookie.": " para usar authorization code + PKCE con cualquier OpenID Connect. Los endpoints vienen del discovery; tokens no llegan al navegador.",
  "Register ": "Registra ",
  " as the redirect URI with your provider. ": " como redirect URI. ",
  " is required — without it no session can be signed, and the login button stays hidden.": " es obligatorio para firmar sesiones.",
  "Keycloak — realm 'backplane'": "Keycloak — realm 'backplane'",
  "Google as the identity provider": "Google como proveedor de identidad",
  "An identity provider proves identity, not membership": "Un IdP prueba identidad, no membresía",
  "Every mainstream IdP will authenticate accounts far outside your organization — Google signs in any Gmail user, and a Keycloak realm with self-registration enabled signs in anyone who fills the form. Unless": "Un IdP puede autenticar externos. Salvo que",
  " is set, any successful login auto-provisions a Backplane user. Set the domain allowlist, or run invite-only with ": " esté definido, todo login crea usuario. Usa allowlist o ",
  "WebSocket auth": "Autenticación WebSocket",
  "The workspace WebSocket endpoint (": "El endpoint WebSocket (",
  ") accepts the same API key via ": ") acepta API key mediante ",
  " on the upgrade request. Browser clients are authenticated by whatever authenticates their HTTP traffic — the session cookie (browsers send cookies on the handshake) or the IAP/proxy headers — so there is no extra browser step. A legacy ": " en la solicitud de upgrade. Los clientes de navegador se autentican mediante el mismo mecanismo que autentica su tráfico HTTP: la cookie de sesión, que los navegadores envían durante el handshake, o los headers de IAP/proxy; por eso no necesitan un paso adicional. Todavía se acepta el fallback heredado ",
  " fallback is still accepted for API keys, but the Authorization header is preferred because query strings can land in access logs.": " para las API keys, pero se prefiere el header Authorization porque las query strings pueden quedar registradas en los logs de acceso.",
  "API key material is shown exactly once": "La API key se muestra una vez",
  "When an authenticated user creates an API key, the full": "Cuando un usuario autenticado crea una API key, la cadena completa",
  "string is displayed once in the \"API key created\" dialog and never again. The backend stores only the prefix and a hash. If a key is lost, there is no recovery path — revoke it and mint a new one. Don't share keys over chat, don't commit them to repos, and don't bake them into runner config files that will be checked in. Treat a leaked key as an incident: revoke first, investigate second.": " se muestra una sola vez en el diálogo \"API key created\" y nunca vuelve a mostrarse. El backend almacena solo el prefijo y un hash. Si se pierde una clave, no existe una vía de recuperación: revócala y crea una nueva. No compartas claves por chat, no las incluyas en repositorios ni las incorpores a archivos de configuración del runner que vayan a versionarse. Trata una clave filtrada como un incidente: revoca primero e investiga después.",
} as const;

const ES_ENVIRONMENT_VARIABLES = {
  "Three processes read environment variables directly: the FastAPI backend, the MCP server, and the Go runner (": "Tres procesos leen variables: backend FastAPI, servidor MCP y runner Go (",
  "). None of them require a full environment to start in dev mode — the defaults described below get you a working localhost. These tables cover the supported deployment, authentication, integration, event, MCP, and runner controls in the current code; one-off test variables are not part of this operator contract.": "). En dev funcionan con valores predeterminados. Estas tablas cubren los controles compatibles de despliegue, autenticación, integraciones, eventos, MCP y runner del código actual; las variables exclusivas de pruebas no forman parte de este contrato operativo.",
  "Backend (FastAPI)": "Backend (FastAPI)",
  "Read from ": "Leídas desde ",
  " via": " mediante",
  ". Values come from": ". Valores de",
  " or the process environment; environment wins.": " o del proceso; el entorno prevalece.",
  "Variable": "Variable",
  "Default": "Predeterminado",
  "Purpose": "Propósito",
  "Async SQLAlchemy DSN. Deployed environments point it at their Postgres instance. Must use the asyncpg driver.": "DSN asíncrono de SQLAlchemy. En entornos desplegados debe apuntar a la instancia de Postgres y usar el driver asyncpg.",
  "Gates dev-mode behaviors (swagger exposure, dev-mode auth fallback). Set to ": "Controla Swagger y auth de dev; define ",
  " in deployed environments.": " en entornos desplegados.",
  "Comma-separated allowlist. The frontend Cloud Run URL goes here in production.": "Allowlist separada por comas; incluye URL del frontend.",
  "Activates IAP JWT verification. Takes precedence over": "Activa JWT de IAP y prevalece sobre",
  " when both are set. Prod value is the full backend-service resource path.": " si ambos existen; usa la ruta completa del servicio.",
  "Opt-in to trusting the identity header named by": "Activa confianza en el header indicado por",
  " (default": " (predeterminado",
  "; oauth2-proxy users set ": "; oauth2-proxy usa ",
  "). Only safe behind an authenticating proxy.": "). Solo tras proxy autenticador.",
  "Optional handshake for trusted-proxy mode: when set, requests must also carry ": "Handshake opcional: las solicitudes también deben llevar ",
  " with this value. Configure the proxy to inject it.": " con este valor.",
  "Comma-separated domains for verified IAP, trusted-proxy, and OIDC identities. It also gates local setup and admin-invite paths that create a password-capable account. Empty allows any verified domain; API keys and dev mode are exempt.": "Dominios separados por comas para identidades verificadas de IAP, trusted proxy y OIDC. También restringe el setup local y las invitaciones de admin que crean una cuenta con contraseña. Vacío permite cualquier dominio verificado; las API keys y dev mode quedan exentos.",
  "Create user accounts on first verified sign-in. ": "Crea cuentas en el primer inicio de sesión verificado. ",
  "makes the deployment invite-only: IAP and proxy requests for unknown users get 403, while the OIDC callback redirects with": "hace que el despliegue funcione solo por invitación: las solicitudes IAP y proxy de usuarios desconocidos reciben 403, mientras que el callback de OIDC redirige con",
  ". Neither creates a user row.": ". Ninguna de las dos rutas crea una fila de usuario.",
  "Enables database-backed email and password login. A production instance using local login also needs": "Activa el login con correo y contraseña respaldado por la base de datos. Una instancia de producción con login local también necesita",
  " to mint session cookies.": " para emitir cookies de sesión.",
  "OpenID Connect issuer URL. Empty disables OIDC; discovery supplies the authorization, token, JWKS, and logout endpoints.": "URL del issuer de OpenID Connect. Vacía desactiva OIDC; el discovery aporta los endpoints de autorización, token, JWKS y logout.",
  "Client identifier registered at the OIDC provider. OIDC is exposed to the browser only when this, ": "Identificador de cliente registrado en el proveedor OIDC. OIDC solo se expone al navegador cuando este valor, ",
  ", and ": ", y ",
  " are set.": " están definidos.",
  "Confidential-client secret sent during the authorization-code exchange. Keep it out of committed files.": "Secret del cliente confidencial enviado durante el intercambio de authorization code. No lo incluyas en archivos versionados.",
  "Space-separated scopes requested from the identity provider. The verified ID token must supply an email claim.": "Scopes separados por espacios solicitados al proveedor de identidad. El ID token verificado debe incluir un claim de email.",
  "Lifetime for signed browser sessions created by OIDC and local password login. Sessions are stateless and expire by age.": "Duración de las sesiones firmadas creadas por OIDC y por el login local. No tienen estado y expiran por antigüedad.",
  "Signs login sessions plus OIDC and GitHub OAuth state. A production instance with local auth or OIDC enabled refuses to start when this is empty.": "Firma las sesiones de login y el state de OIDC y GitHub OAuth. Una instancia de producción con autenticación local u OIDC se niega a iniciar si está vacío.",
  "Public browser origin used by login and integration redirects; its scheme also decides whether session cookies are Secure.": "Origen público del navegador usado en redirects de login e integraciones; su esquema también determina si las cookies de sesión son Secure.",
  "Selects ": "Selecciona ",
  " for single-process delivery or": " para entrega en un solo proceso o",
  " for cross-instance delivery over Postgres LISTEN/NOTIFY. ": " para entrega entre instancias mediante Postgres LISTEN/NOTIFY. ",
  " is reserved but not implemented.": " está reservado, pero no implementado.",
  "Enables Tier-1 process caches. Safe on the memory bus only for a genuinely single-instance deployment; the Postgres bus distributes eviction events across instances.": "Activa las cachés de proceso Tier 1. Con el bus memory solo es seguro en un despliegue de una única instancia; el bus Postgres distribuye las invalidaciones entre instancias.",
  "Opt-in anonymous instance telemetry. It sends nothing unless enabled and an endpoint is configured.": "Telemetría anónima de instancia con activación explícita. No envía nada salvo que esté activada y exista un endpoint configurado.",
  "Receiver for opt-in telemetry. Empty keeps telemetry a no-op even when the enable flag is true.": "Receptor de la telemetría opcional. Vacío mantiene la telemetría inactiva incluso si el flag está habilitado.",
  "Operator-facing backend URL baked into exported runner bundles (runner YAML and MCP JSON). Set to the public URL in prod so exports are launch-ready.": "URL pública del backend incluida en bundles YAML/JSON exportados.",
  "Uvicorn bind port. Cloud Run overrides to its injected": "Puerto Uvicorn; Cloud Run inyecta",
  "GCS bucket for resource uploads. Empty falls back to local filesystem at ": "Bucket GCS; vacío usa filesystem en ",
  "Service account email for signed-URL generation. Paired with": "Email de service account para URLs firmadas; junto con",
  "Local-disk path for resource uploads when GCS isn't configured. Persist this directory or volume in self-hosted deployments.": "Ruta de disco local para subir recursos cuando GCS no está configurado. Conserva este directorio o volumen en despliegues self-hosted.",
  "Last-resort provider tokens when a workspace has no matching stored git connection. Each credential is host-checked; there is no cross-provider fallback.": "Tokens de proveedor de último recurso cuando el espacio no tiene una conexión git compatible. Cada credencial se valida contra el host; no hay fallback entre proveedores.",
  "GitHub REST base URL, including GitHub Enterprise deployments.": "URL base de la API REST de GitHub, incluidas instalaciones de GitHub Enterprise.",
  "Allows Git Connections to fall back to the platform token after workspace credentials. Disable it for a strict multi-tenant posture.": "Permite que Git Connections recurra al token de la plataforma después de las credenciales del espacio. Desactívalo para un aislamiento multi-tenant estricto.",
  "Commit identity used by the backend merge worker.": "Identidad de commit usada por el worker de merge del backend.",
  "Age after which board health reports a non-terminal merge-queue entry as stale.": "Antigüedad tras la cual la salud del tablero marca como obsoleta una entrada no terminal de la cola de merge.",
  "Base64-encoded 32-byte Fernet key for encrypting the tokens stored by Git Connections. Empty makes token encryption and decryption fail loudly instead of storing plaintext.": "Clave Fernet de 32 bytes codificada en Base64 para cifrar los tokens almacenados por Git Connections. Vacía hace fallar explícitamente el cifrado y descifrado en vez de almacenar texto plano.",
  "GitHub OAuth App credentials for workspace git integrations. Empty disables the OAuth start endpoint.": "Credenciales de GitHub OAuth App para integraciones git del espacio. Vacías desactivan el endpoint de inicio OAuth.",
  "Seconds between server-sent WebSocket heartbeats. Tune only if you know why.": "Segundos entre heartbeats WebSocket.",
  "Seconds to wait for a client pong before dropping the connection.": "Segundos para esperar pong.",
  "MCP server": "Servidor MCP",
  ". Set these in the MCP server environment. Claude hosts use the": ". Define estas variables en el entorno del servidor MCP. Los hosts de Claude usan el bloque",
  " block; exported runner configs and the runner's isolated Codex config pass the same names.": "; las configuraciones exportadas del runner y la configuración aislada de Codex del runner transmiten los mismos nombres.",
  "Base URL of the Backplane backend. Production is the public backend Cloud Run URL.": "URL base del backend; en producción Cloud Run pública.",
  "Bearer API key (": "API key bearer (",
  "), either personal or linked to a registered agent. When set, all other auth paths are skipped and": "), personal o vinculada a un agente registrado. Cuando está definida, se omiten las demás rutas de autenticación y",
  " is sent. The simplest production config.": "; configuración más simple.",
  "Identity sent in dev-mode auth headers. Ignored when an API key or IAP audience is configured.": "Identidad de dev; ignorada con API key o IAP.",
  "Target audience for Google ADC OIDC token minting. Set when the MCP server is talking to an IAP-gated backend without an API key.": "Audience para tokens OIDC de Google ADC cuando MCP llama a IAP sin API key.",
  "unset": "sin definir",
  "Comma-separated tool ids enforced by the MCP server. The allowlist filters both what the model is shown (tools/list) and what it may call. Unset, empty, or ":
    "IDs de herramientas separados por comas que aplica el servidor MCP. La allowlist filtra tanto lo que se muestra al modelo (tools/list) como lo que puede llamar. Sin definir, vacío o ",
  " means unrestricted;": " significa sin restricciones;",
  " denies every tool. Invalid names fail server startup rather than silently disabling the gate.": " bloquea todas las herramientas. Los nombres inválidos impiden iniciar el servidor en vez de desactivar el control silenciosamente.",
  "Comma-separated toolset ids (group or category ids from the tool catalog) the server lists and serves. Unset or empty means":
    "Ids de toolsets separados por comas (ids de grupo o de categoría del catálogo de herramientas) que el servidor lista y sirve. Sin definir o vacía equivale a",
  ", the interactive hand;":
    ", la mano interactiva;",
  " loads every tool, which is what runner launches pin. Composes with the allowlist as an intersection; unknown ids fail server startup.":
    " carga todas las herramientas, que es lo que fijan los lanzamientos de runners. Se compone con la allowlist como intersección; los ids desconocidos impiden arrancar el servidor.",
  "Switch to ": "Cambia a ",
  " to serve over HTTP instead of stdio.": " para HTTP en vez de stdio.",
  "HTTP transport bind address. Ignored for stdio.": "Dirección HTTP; ignorada en stdio.",
  "HTTP transport port. Ignored for stdio.": "Puerto HTTP; ignorado en stdio.",
  "The Go runner": "El runner Go",
  "The runner's primary config is its YAML file. A handful of env vars override YAML values at startup — useful for container deployments where the YAML is a template and the secrets arrive at runtime.": "Su YAML es principal; algunas env vars lo reemplazan al iniciar.",
  "YAML field it overrides": "Campo YAML reemplazado",
  "Backend URL the runner authenticates against. Same value the MCP server uses.": "URL del backend, igual que MCP.",
  "Bearer key minted for the registered runner. Prefer the env var over committing keys to YAML.": "Clave bearer emitida para el runner registrado. Prefiere la variable de entorno antes que incluir claves en YAML versionado.",
  "Workspace scope for the runner. Required through YAML, a named profile, or this override.": "Ámbito del espacio de trabajo del runner. Es obligatorio mediante YAML, un perfil con nombre o este override.",
  " or ": " o ",
  " force-disables the runner's WebSocket client. Other values do not force-enable it.": " fuerzan la desactivación del cliente WebSocket del runner. Otros valores no lo fuerzan a activarse.",
  "(debug flag)": "(flag de depuración)",
  " disables panic recovery, matching": " desactiva la recuperación ante panic, igual que",
  ". Debug only: a panic terminates the process.": ". Solo para depuración: un panic termina el proceso.",
  "(MCP child identity)": "(identidad del proceso MCP hijo)",
  "Inherited by the spawned MCP server for development-header identity. It is not a runner YAML override and is ignored when the MCP server uses an API key or IAP.": "El servidor MCP iniciado la hereda como identidad del header de desarrollo. No es un override del YAML del runner y se ignora cuando MCP usa API key o IAP.",
  "(not an inherited runner override)": "(no es un override heredado del runner)",
  "The runner deliberately does not read this env var into config and strips an inherited value before spawning": "El runner no lee deliberadamente esta variable en su configuración y elimina cualquier valor heredado antes de iniciar",
  ". To bill API credits, set": ". Para usar créditos de API, define",
  " in YAML; leave it empty for Claude Max / OAuth.": " en YAML; déjalo vacío para Claude Max / OAuth.",
  "The Codex driver also strips an inherited key before spawning": "El driver de Codex también elimina una clave heredada antes de iniciar",
  ". The current runner config has no general YAML field that wires this provider option, so normal runner execution must use ": ". La configuración actual del runner no tiene un campo YAML general que conecte esta opción del proveedor, por lo que la ejecución normal debe usar las credenciales de ",
  " credentials.": ".",
  "API keys don't belong in committed files": "Las API keys no van en archivos versionados",
  "Every env var named ": "Toda env var ",
  " is a secret. The runner's YAML supports ": " es secret. YAML admite ",
  " interpolation precisely so the committed config file can stay checked-in while the key flows in at process start. Don't paste a real key into a committed YAML or MCP config just because \"it's internal.\"": " para inyectar al iniciar; no pegues claves reales en YAML o MCP versionado.",
} as const;

const ES_MCP_TOOLSETS = {
  "Everyday project work: default keeps the interactive catalog compact.":
    "Trabajo diario del proyecto: default mantiene compacto el catálogo interactivo.",
  "Loops and runners:":
    "Bucles y runners:",
  " is for an interactive human connection to prepare and manage loops.":
    " sirve para una conexión humana interactiva que prepara y gestiona bucles.",
  "Everything: all is an explicit opt-in to a larger catalog that may exceed client tool limits.":
    "Todo: all es una elección explícita de un catálogo más grande que puede superar los límites de herramientas del cliente.",
  "Presets are starting selections. Preserve custom toolset compositions and existing credentials. Actual autonomous runner launches use all intersected with their authorized allowlist; do not replace that execution configuration with the interactive loops preset.":
    "Los preajustes son selecciones iniciales. Conserva las composiciones personalizadas de toolsets y las credenciales existentes. Los runners autónomos reales usan all intersectado con su allowlist autorizada; no sustituyas esa configuración de ejecución por el preajuste interactivo de bucles.",
  "Use the exact returned restart_env for recovery: it preserves every enabled group, including custom toolsets. Keep existing credentials and VALARIS_MCP_ALLOWLIST unchanged. The following fresh connection example is for interactive loops; it must not replace a wider recovered selection.":
    "Usa exactamente el restart_env devuelto para la recuperación: conserva todos los grupos habilitados, incluidos los toolsets personalizados. Mantén sin cambios las credenciales existentes y VALARIS_MCP_ALLOWLIST. El siguiente ejemplo de conexión nueva sirve para bucles interactivos; no debe sustituir una selección recuperada más amplia.",
  "Remote MCP service startup environment":
    "Entorno de inicio del servicio MCP remoto",
  "The remote operator applies these values to the actual MCP service startup environment, retains the existing API/authentication configuration, and protects the endpoint behind authenticated access or a trusted private network. MCP_HOST=0.0.0.0 is a bind address, not access control. Local client environment cannot change a remote service.":
    "El operador remoto aplica estos valores al entorno de inicio del servicio MCP real, conserva la configuración existente de API/autenticación y protege el endpoint con acceso autenticado o una red privada de confianza. MCP_HOST=0.0.0.0 es una dirección de escucha, no un control de acceso. El entorno local del cliente no puede cambiar un servicio remoto.",
  "Restart the MCP server/connection, then start a fresh agent session and repeat the read-only native checks. A new chat alone may reuse a stale server or cached catalog. Repeating enable_toolsets cannot force a client refresh. If a tool is still missing, check the running version, startup toolsets and authorized allowlist before changing configuration.":
    "Reinicia el servidor/conexión MCP, abre una sesión nueva del agente y repite las comprobaciones nativas de solo lectura. Un chat nuevo por sí solo puede reutilizar un servidor desactualizado o un catálogo en caché. Repetir enable_toolsets no puede forzar la actualización del cliente. Si sigue faltando una herramienta, revisa la versión en ejecución, los toolsets de inicio y la allowlist autorizada antes de cambiar la configuración.",
  "A toolset is a named slice of the MCP surface. Every group and every category of the tool catalog is one, addressed by its id, and the server lists and serves only the tools in the toolsets you load. A tool that is not listed cannot be called either, so the model never sees a name it may not use.":
    "Un toolset es una porción con nombre de la superficie MCP. Cada grupo y cada categoría del catálogo de herramientas es uno, identificado por su id, y el servidor lista y sirve solo las herramientas de los toolsets que cargas. Una herramienta que no aparece en la lista tampoco se puede llamar, así que el modelo nunca ve un nombre que no puede usar.",
  "A ":
    "Una ",
  "skill":
    "habilidad",
  " declares the toolsets its playbook plays in; that declaration is guidance, and only the loaded toolsets enforce.":
    " declara los toolsets en los que juega su playbook; esa declaración es una guía, y solo los toolsets cargados aplican.",
  "The env contract":
    "El contrato de la variable de entorno",
  " is read once when the MCP server starts. Unset or empty it means ":
    " se lee una sola vez al arrancar el servidor MCP. Sin definir o vacía equivale a ",
  ", the interactive hand described below. ":
    ", la mano interactiva que se describe más abajo. ",
  " loads every tool. Anything else is a comma-separated list of toolset ids; ":
    " carga todas las herramientas. Cualquier otro valor es una lista de ids de toolsets separados por comas; ",
  " may appear in that list and expands to the default hand. Ids are case-sensitive and whitespace around the commas is ignored.":
    " puede aparecer en esa lista y se expande a la mano predeterminada. Los ids distinguen mayúsculas de minúsculas y se ignoran los espacios alrededor de las comas.",
  "Unknown ids fail closed":
    "Los ids desconocidos fallan de forma segura",
  "An id that is not a group id, a category id, ":
    "Un id que no sea un id de grupo, un id de categoría, ",
  ", or":
    " o",
  " stops the server at startup with an error naming the offending ids and the valid ones. A typo never silently disables the gate.":
    " detiene el servidor al arrancar con un error que nombra los ids problemáticos y los válidos. Una errata nunca desactiva el control en silencio.",
  "The default hand":
    "La mano predeterminada",
  "Unless told otherwise the server serves the interactive default hand: the union of these group toolsets minus a short exclusion list, plus a short inclusion list of read-only helpers from the other groups. It currently resolves to ":
    "Salvo que se indique lo contrario, el servidor sirve la mano interactiva predeterminada: la unión de estos toolsets de grupo menos una breve lista de exclusiones, más una breve lista de inclusiones de ayudantes de solo lectura de los otros grupos. Actualmente se resuelve en ",
  " tools.":
    " herramientas.",
  "Groups in the default hand:":
    "Grupos de la mano predeterminada:",
  "Excluded from it, even though their group is loaded:":
    "Excluidas de ella, aunque su grupo esté cargado:",
  "Tool":
    "Herramienta",
  "Why it is excluded":
    "Por qué se excluye",
  // Reason keys mirror mcp-server/src/valaris_mcp/toolsets.py DEFAULT_EXCLUSIONS and DEFAULT_INCLUSIONS verbatim.
  "destroys a board and every card on it":
    "destruye un tablero y todas sus tarjetas",
  "destroys the whole workspace":
    "destruye todo el espacio de trabajo",
  "workspace admin":
    "administración del espacio de trabajo",
  "runner-only pickup path; interactive sessions claim by move_card":
    "ruta de recogida exclusiva de runners; las sesiones interactivas reclaman con move_card",
  "cascade-deletes every card in the column":
    "elimina en cascada todas las tarjetas de la columna",
  "workspace admin, pairs with remove_workspace_member":
    "administración del espacio de trabajo, va en pareja con remove_workspace_member",
  "workspace admin, pairs with freeze_board":
    "administración del espacio de trabajo, va en pareja con freeze_board",
  "read-only; boards are linked to repos":
    "solo lectura; los tableros están vinculados a repositorios",
  "the server instructions tell interactive agents to install the board's skills":
    "las instrucciones del servidor indican a los agentes interactivos que instalen las skills del tablero",
  "read-only reporting used by the standup workflow":
    "informes de solo lectura que usa el flujo de standup",
  "Pulled into it from groups the default hand does not load:":
    "Incorporadas a ella desde grupos que la mano predeterminada no carga:",
  "Why it is included":
    "Por qué se incluye",
  "The other groups are opt-in:":
    "Los demás grupos son opcionales:",
  ". Add them to the list when the session needs workspace setup or runner administration.":
    ". Añádelos a la lista cuando la sesión necesite configurar el espacio de trabajo o administrar runners.",
  "Available toolsets":
    "Toolsets disponibles",
  "One row per toolset. Group ids are slugified from the group titles of the tool catalog; category ids are the catalog's own.":
    "Una fila por toolset. Los ids de grupo se derivan de los títulos de grupo del catálogo de herramientas; los ids de categoría son los del propio catálogo.",
  "Toolset":
    "Toolset",
  "Kind":
    "Tipo",
  "Title":
    "Título",
  "Group":
    "Grupo",
  "Tools":
    "Herramientas",
  "Category":
    "Categoría",
  "Start here":
    "Empieza aquí",
  "Work management":
    "Gestión del trabajo",
  "Knowledge & content":
    "Conocimiento y contenido",
  "Collaboration":
    "Colaboración",
  "Autonomous operations":
    "Operaciones autónomas",
  "Project Context":
    "Contexto del proyecto",
  "Search":
    "Búsqueda",
  "Assignments":
    "Asignaciones",
  "Bulk Operations":
    "Operaciones masivas",
  "Board Health":
    "Salud del tablero",
  "Server Info":
    "Información del servidor",
  "Workspaces":
    "Espacios de trabajo",
  "Boards":
    "Tableros",
  "Columns":
    "Columnas",
  "Cards":
    "Tarjetas",
  "Card Dependencies":
    "Dependencias de tarjetas",
  "Notes":
    "Notas",
  "Definitions":
    "Definiciones",
  "Resources":
    "Recursos",
  "Activity":
    "Actividad",
  "Teams":
    "Equipos",
  "Channels":
    "Canales",
  "Git Repos":
    "Repositorios Git",
  "Webhooks":
    "Webhooks",
  "Agents & Executions":
    "Agentes y ejecuciones",
  "Approvals":
    "Aprobaciones",
  "Merge Queue":
    "Cola de merge",
  "Workspace Config":
    "Configuración del espacio de trabajo",
  "Prompt Configs":
    "Configuraciones de prompts",
  "Loop Templates":
    "Plantillas de loop",
  "Skills":
    "Skills",
  "Deprecated aliases":
    "Alias obsoletos",
  "These names still answer for one more minor version, but they are no longer part of the documented surface and no toolset lists them. Move to the replacement before the release that removes them.":
    "Estos nombres siguen respondiendo durante una versión menor más, pero ya no forman parte de la superficie documentada y ningún toolset los lista. Pasa al reemplazo antes de la versión que los elimina.",
  "Alias":
    "Alias",
  "Replacement":
    "Reemplazo",
  "Removed in":
    "Se elimina en",
  // Replacement keys mirror `deprecated_for` in mcp-server/src/valaris_mcp/catalog.py TOOL_META verbatim.
  "next_assignment (runners) or move_card + add_card_participant (interactive)":
    "next_assignment (runners) o move_card + add_card_participant (interactivo)",
  "update_note(mode='append')":
    "update_note(mode='append')",
  "remove_card_participant(pipeline_role=...)":
    "remove_card_participant(pipeline_role=...)",
  "update_note(mode='section')":
    "update_note(mode='section')",
  "update_agent(hard_delete=True)":
    "update_agent(hard_delete=True)",
  "update_webhook(delete=True)":
    "update_webhook(delete=True)",
  "get_workspace_metrics(view='velocity')":
    "get_workspace_metrics(view='velocity')",
  "get_workspace_metrics(view='cost')":
    "get_workspace_metrics(view='cost')",
  "get_loop_template(view='profile')":
    "get_loop_template(view='profile')",
  "get_loop_template(view='preview')":
    "get_loop_template(view='preview')",
  "get_loop_template(view='fit', board_id=...)":
    "get_loop_template(view='fit', board_id=...)",
  "get_loop_template(view='lint')":
    "get_loop_template(view='lint')",
  "get_board_loop_binding_raw":
    "get_board_loop_binding_raw",
  "list_skill_bindings_raw":
    "list_skill_bindings_raw",
  "Examples":
    "Ejemplos",
  " loads every tool. This is what runner launches pin.":
    " carga todas las herramientas. Es lo que fijan los lanzamientos de runners.",
  " loads the interactive hand, the same as leaving the variable unset.":
    " carga la mano interactiva, igual que dejar la variable sin definir.",
  " loads the interactive hand plus one whole opt-in group.":
    " carga la mano interactiva más un grupo opcional completo.",
  " loads just those two categories, for a session that only edits cards and notes.":
    " carga solo esas dos categorías, para una sesión que únicamente edita tarjetas y notas.",
  "Composition with the allowlist":
    "Composición con la allowlist",
  " and":
    " y",
  " are independent gates, and the served hand is their intersection: a tool must be in a loaded toolset and, when an allowlist is set, on that allowlist to be listed or called. Neither variable can widen what the other narrowed.":
    " son controles independientes, y la mano servida es su intersección: una herramienta debe estar en un toolset cargado y, cuando hay allowlist, también en esa allowlist para listarse o llamarse. Ninguna de las dos variables puede ampliar lo que la otra recortó.",
  "Runners pin ":
    "Los runners fijan ",
  ". The stage allowlist a runner receives from the backend is meant to be the only narrowing, so the runner's generated MCP config always sets ":
    ". La allowlist de etapa que un runner recibe del backend debe ser el único recorte, así que la configuración MCP que genera el runner siempre establece ",
  " to":
    " en",
  "; a default-hand template would clip a stage grant twice.":
    "; una plantilla con la mano predeterminada recortaría dos veces la concesión de la etapa.",
  "Discovery from inside a session":
    "Descubrimiento desde dentro de una sesión",
  " reports which toolsets are loaded, how many tools resolved, what the default hand is, every id that exists, and a hint on how to widen the hand. A denied call to a tool outside the loaded toolsets names the loaded ids in its error, so the model can ask for a wider hand instead of guessing.":
    " informa qué toolsets están cargados, cuántas herramientas se resolvieron, cuál es la mano predeterminada, todos los ids que existen y una pista sobre cómo ampliar la mano. Una llamada denegada a una herramienta fuera de los toolsets cargados nombra los ids cargados en su error, para que el modelo pueda pedir una mano más amplia en vez de adivinar.",
  " picks the initial hand;": " elige la mano inicial;",
  " widens a running session by adding toolsets, and the server then sends":
    " amplía una sesión en marcha añadiendo toolsets, y el servidor envía entonces",
  " to request a client refresh; delivery does not prove the agent received new tools. Widening is one-way and not persisted. If tools remain absent, use the returned restart_env in the MCP server startup configuration, restart the server/connection and start a new agent session. For remote HTTP, the server operator must update that environment. Keep the runner allowlist unchanged.":
    " para solicitar una actualización del cliente; enviarla no demuestra que el agente haya recibido nuevas herramientas. La ampliación es de un solo sentido y no se persiste. Si faltan herramientas, usa el restart_env devuelto en la configuración de inicio del servidor MCP, reinicia el servidor/conexión e inicia una nueva sesión del agente. Con HTTP remoto, el operador del servidor debe actualizar ese entorno. Conserva la allowlist del runner.",
} as const;

export const ES_REFERENCE = {
  "mcp-tool-catalog": {
    "Searchable, filterable, copy-ready. ":
      "Se puede buscar, filtrar y copiar. ",
    "Every tool id follows the ": "Cada id de herramienta sigue la convención ",
    "convention your MCP host uses to invoke it.":
      " que usa tu host MCP para invocarla.",
    ...ES_MCP_TOOL_CATALOG,
  },
  "mcp-toolsets": ES_MCP_TOOLSETS,
  "mcp-prompt-catalog": ES_MCP_PROMPT_CATALOG,
  "event-taxonomy": ES_EVENT_TAXONOMY,
  "column-type-semantics": ES_COLUMN_TYPE_SEMANTICS,
  "card-type-and-priority": ES_CARD_TYPE_AND_PRIORITY,
  "api-authentication-modes": ES_API_AUTHENTICATION_MODES,
  "environment-variables": ES_ENVIRONMENT_VARIABLES,
};
