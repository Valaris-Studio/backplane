// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_OPERATING = {
  "reading-the-runner-overview": {
    "The Runner Console at ": "La Consola de runners en ",
    " has four tabs:": " tiene cuatro pestañas:",
    Overview: "Vista general",
    Pipeline: "Pipeline",
    Runners: "Runners",
    ", and": " y",
    Activity: "Actividad",
    ". Overview is deliberately health-first. It summarizes active-runner metrics, configuration warnings, pending approvals, and execution analytics; runner management and teams live in Runners, while the execution feed lives in Activity.":
      ". Vista general se centra deliberadamente en la salud del sistema. Resume métricas de runners activos, alertas de configuración, aprobaciones pendientes y analítica de ejecuciones; la gestión de runners y equipos vive en Runners, y el flujo de ejecuciones vive en Actividad.",
    "Overview is a health summary. Its metric cards link to the tabs that own the detail.":
      "Vista general es un resumen de salud. Sus tarjetas de métricas enlazan a las pestañas que contienen el detalle.",
    "The five headline metrics": "Las cinco métricas principales",
    "Total runners": "Total de runners",
    " is the count returned by the active-runner metrics query. Inactive runners are excluded from this Overview request. Clicking the card opens the Runners tab.":
      " es la cantidad que devuelve la consulta de métricas de runners activos. Esta solicitud de Vista general excluye los runners inactivos. Al hacer clic en la tarjeta se abre la pestaña Runners.",
    "Success rate": "Tasa de éxito",
    " is completed executions divided by total executions across the returned runners. The denominator is the full execution count exposed by each runner metric, so it is not limited to completed plus failed outcomes.":
      " corresponde a las ejecuciones completadas divididas por las ejecuciones totales de los runners devueltos. El denominador es el recuento completo que expone cada métrica de runner, por lo que no se limita a resultados completados y fallidos.",
    "Average duration": "Duración promedio",
    " is the arithmetic mean of each active runner's reported average duration. It is therefore an unweighted mean across runners, not one global average over all execution rows.":
      " es la media aritmética de la duración promedio informada por cada runner activo. Por tanto, es una media no ponderada entre runners, no un promedio global de todas las ejecuciones.",
    "Total tokens": "Tokens totales",
    " and ": " y ",
    "Total cost": "Costo total",
    " sum the cumulative values returned for all active runners. Overview does not expose a selectable time window for these five cards. The four execution-oriented cards link to Activity.":
      " suman los valores acumulados devueltos para todos los runners activos. Vista general no ofrece una ventana temporal seleccionable para estas cinco tarjetas. Las cuatro tarjetas asociadas a ejecuciones enlazan a Actividad.",
    "Warnings, approvals, and analytics": "Alertas, aprobaciones y analítica",
    "A zero-runner hint directs setup to the Runners tab. If any active runner reports ":
      "Si no hay runners, una indicación dirige la configuración a la pestaña Runners. Si algún runner activo informa ",
    ", a destructive-colored alert links to the same tab so the configuration can be inspected. Pending approvals are listed next, with a direct path to the approval queue.":
      ", una alerta de color crítico enlaza a la misma pestaña para revisar la configuración. A continuación se muestran las aprobaciones pendientes, con acceso directo a su cola.",
    "The lazy-loaded Analytics dashboard adds success and rework rates, average cost per card, average duration, execution totals, daily successes and failures for the latest 30 data points, and a role or action distribution. Those analytics are server-derived and are not the same aggregation as the five runner cards above.":
      "El dashboard de analítica con carga diferida agrega tasas de éxito y retrabajo, costo promedio por tarjeta, duración promedio, totales de ejecuciones, éxitos y fallos diarios para los últimos 30 puntos de datos, y distribución por rol o acción. Esas métricas se calculan en el servidor y no usan la misma agregación que las cinco tarjetas anteriores.",
    "Use the owning tab for diagnosis": "Usa la pestaña responsable para el diagnóstico",
    "Overview no longer embeds the runner table, team roster, or execution timeline. Open ":
      "Vista general ya no incorpora la tabla de runners, la lista del equipo ni la línea de tiempo de ejecuciones. Abre ",
    " for liveness, inactive runners, teams, launch configuration, and reported config errors. Open ":
      " para revisar liveness, runners inactivos, equipos, configuración de inicio y errores de configuración informados. Abre ",
    "for individual execution history and links to execution detail.":
      "para consultar el historial de ejecuciones individuales y sus enlaces al detalle.",
  },
  "debugging-a-stuck-card": {
    "Open the card detail sheet before guessing why work stopped. Its Stuck Reasons panel derives operator-facing signals from the current column, participants, recent card executions, latest review decision, skipped prompt stages, and live pipeline configuration. Done cards suppress the panel because they are already terminal.":
      "Abre el panel de detalle de la tarjeta antes de adivinar por qué se detuvo el trabajo. El panel Razones del bloqueo obtiene señales para el operador a partir de la columna actual, los participantes, las ejecuciones recientes de la tarjeta, la última decisión de revisión, las etapas omitidas por falta de prompt y la configuración vigente del pipeline. Las tarjetas terminadas ocultan el panel porque ya son terminales.",
    "Stuck reasons are evidence to investigate, not a second scheduler.":
      "Las razones del bloqueo son evidencia para investigar, no un segundo scheduler.",
    "The six current reasons": "Las seis razones actuales",
    "Blocked column.": "Columna bloqueada.",
    " The current column has": " La columna actual tiene",
    "; discovery skips it until an operator moves the card to a non-blocked column.":
      "; el descubrimiento la omite hasta que un operador mueve la tarjeta a una columna no bloqueada.",
    "No hero assigned.": "Sin hero asignado.",
    " No participant has role": " Ningún participante tiene el rol",
    ", and at least one visible pipeline stage claims as a hero. Pipelines that use only another participant role do not get this false warning.":
      ", y al menos una etapa visible del pipeline toma tarjetas como hero. Los pipelines que solo usan otro rol de participante no reciben esta alerta incorrecta.",
    "Awaiting prompt.": "A la espera de un prompt.",
    " One or more distinct": " Uno o más pares distintos",
    " pairs produced a skipped execution for this card. Author the missing prompt and let a later tick try again.":
      " produjeron una ejecución omitida para esta tarjeta. Crea el prompt faltante y permite que un tick posterior vuelva a intentarlo.",
    "Changes requested.": "Cambios solicitados.",
    " The latest parsed review decision is ": " La última decisión de revisión interpretada es ",
    "; rework and a newer approval are needed.":
      "; se necesita retrabajo y una aprobación posterior.",
    "Recent failures.": "Fallos recientes.",
    " At least two card executions failed during the last 24 hours. Inspect their execution errors before retrying a deterministic failure.":
      " Al menos dos ejecuciones de la tarjeta fallaron durante las últimas 24 horas. Revisa sus errores antes de volver a intentar un fallo determinista.",
    "Stale card.": "Tarjeta obsoleta.",
    " This fallback appears only when no more specific reason applies, the card has not changed for at least seven days, and no execution touched it recently.":
      " Esta razón de respaldo aparece solo cuando no aplica otra más específica, la tarjeta no ha cambiado durante al menos siete días y ninguna ejecución la ha tocado recientemente.",
    "Follow the owning surfaces": "Sigue las superficies responsables",
    "Use the board's ": "Usa la pestaña ",
    History: "Historial",
    " tab for mutations and its": " del tablero para las mutaciones y su pestaña",
    Timeline: "Línea de tiempo",
    " tab when replaying board state will clarify the sequence.":
      " cuando reproducir el estado del tablero ayude a aclarar la secuencia.",
    "Open the Runner Console's ": "Abre la pestaña ",
    Runners: "Runners",
    " tab for last heartbeat, liveness, inactive state, and ":
      " de la Consola de runners para revisar el último heartbeat, liveness, el estado inactivo y ",
    "Open its ": "Abre su pestaña ",
    Activity: "Actividad",
    " tab for the execution feed, then follow an execution into status, error, tool, duration, token, and cost detail.":
      " para consultar el flujo de ejecuciones y luego entrar al detalle de estado, error, herramienta, duración, tokens y costo.",
    "For a skipped prompt, use the card sheet's ": "Para un prompt omitido, usa el enlace ",
    "Author prompt": "Crear prompt",
    " link; it opens Pipeline with the relevant role and stage in the URL.":
      " del panel de tarjeta; abre Pipeline con el rol y la etapa correspondientes en la URL.",
    "A skipped execution means the runner respected platform authority":
      "Una ejecución omitida significa que el runner respetó la autoridad de la plataforma",
    "The pause icon on a kanban card and the Awaiting prompt reason are not proof that the runner is broken. They record that the runner found the card but did not receive authored prompt content for that role and stage. Fix the prompt in Pipeline, then verify the next execution in Activity.":
      "El icono de pausa de una tarjeta kanban y la razón A la espera de un prompt no demuestran que el runner esté averiado. Registran que el runner encontró la tarjeta, pero no recibió contenido de prompt para ese rol y esa etapa. Corrige el prompt en Pipeline y verifica la siguiente ejecución en Actividad.",
  },
  "the-observer-panel": {
    "The observer is the eye icon in the top bar. Click it and a sheet slides in from the right streaming WebSocket events live. It is mounted once per workspace session — as soon as you have a ":
      "El observador es el icono de ojo de la barra superior. Haz clic y se abrirá desde la derecha un panel que transmite eventos WebSocket en vivo. Se monta una vez por sesión del espacio de trabajo: en cuanto la URL contiene un ",
    " in the URL, the icon is there — and the icon badges an unread count while the sheet is closed, capped visually at ":
      ", el icono aparece y muestra una insignia con la cantidad de eventos sin leer mientras el panel está cerrado, limitada visualmente a ",
    ". It used to be a free-floating draggable window whose x/y lived in ":
      ". Antes era una ventana flotante y arrastrable cuyas coordenadas x/y se guardaban en ",
    "; that is gone, and the stale":
      "; eso ya no existe y la entrada obsoleta ",
    " entry is evicted on mount.": " se elimina al montar el componente.",
    "The panel is the fastest way to answer 'did the backend actually fire that event' without opening DevTools.":
      "El panel es la forma más rápida de responder '¿el backend realmente emitió ese evento?' sin abrir DevTools.",
    "What streams through it": "Qué se transmite por el panel",
    "The panel subscribes to ": "El panel se suscribe a ",
    " and buffers the whole bus — the most recent 1000 events — but, with no chip selected, shows only four agentic namespaces by default:":
      " y almacena en un búfer todo el bus, hasta los 1000 eventos más recientes, pero sin ningún chip seleccionado muestra solo cuatro namespaces agénticos por defecto:",
    ", and": " y ",
    ". Everything else the bus carries is one chip away: an ":
      ". Todo lo demás que transporta el bus queda disponible mediante un único chip, ",
    Other: "Otros",
    " chip appears as soon as non-agentic traffic lands, so a namespace nobody enumerated in advance is still diagnosable here rather than invisible platform-wide.":
      ", que aparece en cuanto llega tráfico no relacionado con agentes. Así, un namespace no enumerado previamente sigue siendo diagnosticable aquí en lugar de quedar invisible en toda la plataforma.",
    "The namespace chips are toggleable and additive. ":
      "Los chips de namespace pueden activarse, desactivarse y combinarse. ",
    All: "Todos",
    "clears the selected filters and returns to the default four-namespace view; it does not change the panel into an unfiltered whole-bus view. The search box narrows the list by event type or ":
      "borra los filtros seleccionados y vuelve a la vista predeterminada de cuatro namespaces; no convierte el panel en una vista sin filtrar de todo el bus. El campo de búsqueda reduce la lista por tipo de evento o por subcadena de ",
    "substring, and the counter beside it reads ":
      "y el contador adyacente muestra ",
    "shown of buffered": "mostrados de los almacenados",
    "against the cap. Selecting a row expands its raw JSON payload. Pause freezes the list at its current state without unsubscribing, so you can inspect a frame without events scrolling off — events arriving while paused are dropped, not queued. Clear empties the buffer without touching the subscription.":
      "respecto del límite. Al seleccionar una fila se expande su payload JSON raw. Pausar congela la lista en su estado actual sin cancelar la suscripción, para que puedas inspeccionar un momento sin que los eventos desaparezcan al desplazarse; los eventos que llegan durante la pausa se descartan, no se ponen en cola. Borrar vacía el búfer sin modificar la suscripción.",
    "The buffer is in-memory and live-only: nothing is persisted and a reload starts empty. The stored audit trail is ":
      "El búfer solo existe en memoria y en tiempo real: nada se conserva y, al recargar, comienza vacío. El rastro de auditoría almacenado se encuentra en ",
    ", which is a different surface answering a different question.":
      ", una superficie distinta que responde una pregunta diferente.",
    "When to reach for it": "Cuándo usarlo",
    "Three situations where it earns its keep:":
      "Resulta especialmente útil en tres situaciones:",
    "Verifying a mutation actually broadcast. If you changed a card and the board didn't update in another tab, first question is \"did the event fire at all?\" The panel answers that in under a second.":
      "Verificar que una mutación se haya transmitido. Si cambiaste una tarjeta y el tablero no se actualizó en otra pestaña, la primera pregunta es si el evento llegó a emitirse. El panel responde en menos de un segundo.",
    "Tracing a pipeline run end-to-end. Watch the":
      "Rastrear una ejecución del pipeline de extremo a extremo. Observa cómo se alinea en tiempo real la secuencia",
    " sequence line up in real time.": ".",
    "Spotting noisy subscribers. If the panel shows the same event repeating, someone is publishing in a loop.":
      "Detectar suscriptores ruidosos. Si el panel muestra el mismo evento repetido, alguien lo está publicando en un loop.",
    "Keep it open during smoke tests":
      "Mantenlo abierto durante los smoke tests",
    "When you are walking through a new pipeline or a fresh runner, open the sheet on your second monitor and leave it open. Every click in the app should produce a visible event, and any click that doesn't is interesting. It turns \"did that work?\" into \"I can see it worked\" — faster than tailing server logs, and available to anyone on the team without shell access.":
      "Cuando recorras un pipeline nuevo o un runner recién configurado, abre el panel en tu segundo monitor y déjalo abierto. Cada clic en la aplicación debería producir un evento visible; cualquier clic que no lo haga merece atención. Convierte la pregunta \"¿funcionó?\" en la certeza \"puedo ver que funcionó\", más rápido que seguir los logs del servidor y disponible para cualquier integrante del equipo sin acceso a una shell.",
    "Admin-only, deliberately": "Solo para administradores, deliberadamente",
    "The panel is mounted for every user but gated behind":
      "El panel se monta para todos los usuarios, pero está protegido por ",
    ". Non-admins get no trigger icon at all — not a placeholder, nothing. And the client gate is only the UX half: the events socket rejects observer-grade subscription patterns from non-admins server-side, so hand-opening it gains nothing. This is on purpose — the bus carries actor IDs, payloads, and change JSON for every mutation in the workspace, which is a perfectly reasonable audit surface for an admin and a mildly uncomfortable privacy surface for a regular member. If we ever need a member-safe observer view, it will be a separate, filtered feed. Until then: admin gate.":
      ". Los usuarios que no son administradores no ven ningún icono para abrirlo: ni un placeholder ni nada. Además, la restricción del cliente cubre solo la parte de UX; el socket de eventos rechaza desde el servidor los patrones de suscripción propios del observador cuando provienen de usuarios no administradores, por lo que abrirlo manualmente no sirve de nada. Es intencional: el bus contiene IDs de actores, payloads y JSON de cambios para cada mutación del espacio de trabajo, una superficie de auditoría razonable para un administrador, pero incómoda desde el punto de vista de privacidad para un miembro normal. Si alguna vez se necesita una vista segura para miembros, será un flujo independiente y filtrado. Hasta entonces, acceso exclusivo para administradores.",
  },
  "activity-history-and-audit-logs": {
    "Recorded platform mutations write durable ": "Las mutaciones registradas de la plataforma escriben filas duraderas de ",
    " rows and publish live bus events. Workspace History at":
      " y publican eventos en vivo en el bus. El Historial del espacio de trabajo en",
    " spans the workspace; a board's History tab scopes the same feed to that board. The stored feed is the source to use for audit questions after a live WebSocket event has passed.":
      " abarca todo el espacio de trabajo; la pestaña Historial de un tablero limita el mismo flujo a ese tablero. El flujo almacenado es la fuente que se debe usar para preguntas de auditoría después de que haya pasado un evento WebSocket en vivo.",
    "History uses server-side filters and bounded infinite scrolling rather than loading the workspace into the browser.":
      "Historial usa filtros del lado del servidor y desplazamiento infinito acotado, en vez de cargar el espacio de trabajo completo en el navegador.",
    "Filtering and pagination": "Filtrado y paginación",
    "Entity type, action, and search are sent as server-side query parameters. Search is debounced by 300 milliseconds. Each request asks for 50 rows using a ":
      "El tipo de entidad, la acción y la búsqueda se envían como parámetros de consulta del servidor. La búsqueda usa un debounce de 300 milisegundos. Cada solicitud pide 50 filas mediante un cursor de marca de tiempo ",
    " timestamp cursor, and the client retains at most three pages at once. The current History controls do not offer person or time-window selectors.":
      ", y el cliente conserva como máximo tres páginas a la vez. Los controles actuales de Historial no ofrecen selectores de persona ni de ventana temporal.",
    "Board History also keeps its live subscription strictly scoped to the active board. Incoming events invalidate or extend the visible feed; older rows continue through the same bounded cursor path.":
      "El Historial del tablero también mantiene su suscripción en vivo estrictamente limitada al tablero activo. Los eventos entrantes invalidan o amplían el flujo visible; las filas anteriores continúan por la misma ruta acotada de cursor.",
    "What a stored row carries": "Qué contiene una fila almacenada",
    "Identity and ordering fields include ": "Los campos de identidad y orden incluyen ",
    ", optional ": ", el campo opcional ",
    ", optional": ", el campo opcional ",
    ", and": " y",
    ". Display data includes a structured": ". Los datos de presentación incluyen un ",
    " plus ": " estructurado junto con ",
    ", with legacy": ", con el campo heredado ",
    " as fallback. ": " como respaldo. ",
    ", and ": " y ",
    " preserve the structured detail needed by audit views and replay. A":
      " conservan el detalle estructurado que necesitan las vistas de auditoría y la reproducción. Un marcador ",
    " marker identifies API-key activity in the feed.":
      " identifica en el flujo la actividad realizada con una clave de API.",
    "Representative card-move activity": "Actividad representativa de movimiento de tarjeta",
    "Timeline replay": "Reproducción de la línea de tiempo",
    "History answers who did what; Timeline reconstructs how the board changed. Open the board route shown below from its Timeline tab or the History link. The frontend requests up to 5000 events, receives them in ascending order with a current-board baseline, and replays snapshots in the browser with transport controls and a scrubber.":
      "Historial responde quién hizo qué; Línea de tiempo reconstruye cómo cambió el tablero. Abre la ruta que se muestra abajo desde la pestaña Línea de tiempo o el enlace de Historial. El frontend solicita hasta 5000 eventos, los recibe en orden ascendente con una línea base del tablero actual y reproduce snapshots en el navegador con controles de transporte y un scrubber.",
    "Board replay route": "Ruta de reproducción del tablero",
    "Replay is deliberately bounded": "La reproducción está acotada deliberadamente",
    "The timeline endpoint defaults to 500 rows and enforces a hard cap of 5000. Its response marks ":
      "El endpoint de línea de tiempo usa 500 filas por defecto y aplica un límite estricto de 5000. Su respuesta marca ",
    " when more history exists. A truncated replay is useful evidence, but it is not proof that the visible first event was the board's original state.":
      " cuando existe más historial. Una reproducción truncada aporta evidencia útil, pero no demuestra que el primer evento visible fuera el estado original del tablero.",
    "Durable rows and live events are related, not identical":
      "Las filas duraderas y los eventos en vivo están relacionados, pero no son idénticos",
    "Recording activity publishes a namespaced live event for that entity and action, plus a small compatibility bridge for selected legacy card and column events. The live payload contains the mutation context used for immediate UI updates; the database row adds durable identifiers, ordering, and timestamps. Use History or Timeline when exact replay matters instead of treating the observer buffer as storage.":
      "Registrar actividad publica un evento en vivo con namespace para esa entidad y acción, además de un pequeño puente de compatibilidad para determinados eventos heredados de tarjetas y columnas. El payload en vivo contiene el contexto de la mutación usado para actualizar la interfaz de inmediato; la fila de la base de datos agrega identificadores duraderos, orden y marcas de tiempo. Usa Historial o Línea de tiempo cuando importe una reproducción exacta, en vez de tratar el búfer del observador como almacenamiento.",
  },
  "webhooks-and-external-notifications": {
    "A webhook sends selected workspace events to an external endpoint. Each active registration contains a delivery URL, a list of exact event names, and an HMAC secret. When one of those exact names is emitted, the backend makes one signed POST. There is no wildcard subscription matching and no webhook management screen in the current frontend.":
      "Un webhook envía eventos seleccionados del espacio de trabajo a un endpoint externo. Cada registro activo contiene una URL de entrega, una lista de nombres exactos de eventos y un secreto HMAC. Cuando se emite uno de esos nombres exactos, el backend realiza un único POST firmado. No existe coincidencia de suscripciones mediante comodines ni una pantalla para administrar webhooks en el frontend actual.",
    "Manage registrations through MCP": "Administrar registros mediante MCP",
    "The complete management surface is ": "La superficie completa de administración incluye ",
    ", and ": " y ",
    ". Create requires URL, event list, and secret. List can filter by active state; get exposes delivery health but never returns the secret. Update changes only supplied fields, replaces the entire event list when":
      ". La creación requiere URL, lista de eventos y secreto. La lista puede filtrar por estado activo; la lectura expone la salud de entrega, pero nunca devuelve el secreto. La actualización cambia solo los campos suministrados y reemplaza la lista completa de eventos cuando",
    " is present, rotates the secret, and can pause or resume with ":
      " está presente, rota el secreto y permite pausar o reanudar con ",
    ". Passing ":
      ". Pasar ",
    " to":
      " a",
    " removes the registration for good: it accepts no other field, and an already-missing registration is treated as a converged result.":
      " elimina el registro de forma definitiva: no acepta ningún otro campo y un registro ya inexistente se trata como un resultado convergente.",
    "Current webhook mutation routes check workspace membership but set no minimum role. An owner, admin, member, or viewer can create, update, or delete a registration. Treat this as current behavior, not as an administrative authorization guarantee.":
      "Las rutas actuales que modifican webhooks verifican la pertenencia al espacio de trabajo, pero no exigen un rol mínimo. Propietarios, administradores, miembros y lectores pueden crear, actualizar o eliminar un registro. Este es el comportamiento actual, no una garantía de autorización reservada a administradores.",
    "Outside development, the URL must use HTTPS. Registration and URL updates resolve the host and reject loopback, private, link-local, reserved, multicast, and other non-global addresses. An unresolved host may still be registered and will fail later at delivery time.":
      "Fuera de desarrollo, la URL debe usar HTTPS. El registro y las actualizaciones de URL resuelven el host y rechazan direcciones loopback, privadas, link-local, reservadas, multicast y otras no globales. Un host que no se resuelve puede registrarse, pero fallará posteriormente durante la entrega.",
    "The signing secret is recoverable server-side":
      "El secreto de firma se puede recuperar en el servidor",
    " never returns the secret, but the backend must store it in recoverable form to calculate each HMAC. It is not an irreversibly hashed credential. Restrict database access, rotate the secret with ":
      " nunca devuelve el secreto, pero el backend debe almacenarlo de forma recuperable para calcular cada HMAC. No es una credencial con hash irreversible. Restringe el acceso a la base de datos y rota el secreto con ",
    ", and update the receiver at the same time.":
      ", y actualiza el receptor al mismo tiempo.",
    "Supported exact event names": "Nombres exactos de eventos compatibles",
    "Use values from the backend's ": "Usa valores del enum ",
    " enum. Activity subscriptions cover the exact entity and action pairs below; direct service events cover approvals, executions, runner status, config, and cost thresholds. Bare card and column bridge names remain only for backward compatibility, so new integrations should choose the activity names.":
      " del backend. Las suscripciones de actividad abarcan los pares exactos de entidad y acción que aparecen abajo; los eventos directos de servicios cubren aprobaciones, ejecuciones, estado de runners, configuración y umbrales de costo. Los nombres puente simples de tarjetas y columnas se mantienen solo por compatibilidad, por lo que las integraciones nuevas deben elegir los nombres de actividad.",
    "Current webhook event vocabulary": "Vocabulario actual de eventos de webhook",
    "Signed delivery and health": "Entrega firmada y salud",
    "The backend serializes one JSON body containing ": "El backend serializa un cuerpo JSON que contiene ",
    ", a UTC": ", una marca UTC ",
    ". It signs the exact raw body with HMAC-SHA256 and sends the digest as":
      ". Firma el cuerpo raw exacto con HMAC-SHA256 y envía el digest como",
    ". The request also includes ": ". La solicitud también incluye ",
    ". Receivers must verify the raw body before parsing it; re-serializing JSON can change the signed bytes.":
      ". Los receptores deben verificar el cuerpo raw antes de interpretarlo; volver a serializar JSON puede cambiar los bytes firmados.",
    "Signed webhook request": "Solicitud de webhook firmada",
    "Delivery has a 5-second client timeout. Any HTTP status below 400 counts as success, resets ":
      "La entrega tiene un timeout de cliente de 5 segundos. Cualquier estado HTTP inferior a 400 cuenta como éxito, reinicia ",
    " to zero, and updates": " a cero y actualiza",
    ". A timeout, network error, or status 400 and above increments ":
      ". Un timeout, un error de red o un estado 400 o superior incrementa ",
    ". After 10 consecutive failures, the backend automatically sets ":
      ". Después de 10 fallos consecutivos, el backend establece automáticamente ",
    " to false. Inspect these fields with ": " en false. Revisa estos campos con ",
    " or": " o",
    ", then use ": " y luego usa ",
    " to resume after correcting the receiver.":
      " para reanudar después de corregir el receptor.",
    "No retry queue, outbox, or dead-letter store":
      "Sin cola de reintentos, outbox ni almacenamiento dead-letter",
    "Each matching event gets one delivery attempt. Failed attempts are not replayed, so webhook notifications are not a durable integration log. For critical synchronization, reconcile against Activity History and treat webhook delivery as the low-latency signal.":
      "Cada evento coincidente recibe un intento de entrega. Los intentos fallidos no se reproducen, por lo que las notificaciones de webhook no son un registro de integración duradero. Para una sincronización crítica, reconcilia con el Historial de actividad y trata la entrega del webhook como una señal de baja latencia.",
    "Registration-time URL checks are not a complete network sandbox":
      "Las comprobaciones de URL al registrar no forman un sandbox de red completo",
    "The write-time guard reduces server-side request forgery risk, but it does not eliminate DNS rebinding or redirect-to-internal behavior at delivery time. Only register receivers you control and keep the signing secret scoped to that integration.":
      "La protección al escribir reduce el riesgo de falsificación de solicitudes del lado del servidor, pero no elimina el DNS rebinding ni las redirecciones a redes internas durante la entrega. Registra solo receptores que controles y limita el secreto de firma a esa integración.",
  },
  "rollback-and-recovery-playbook": {
    "Two classes of recovery matter once you're running this in production:":
      "Una vez que el sistema está en producción, importan dos tipos de recuperación:",
    "revert a bad deploy": "revertir un deployment defectuoso",
    " and ": " y ",
    "recover data from the database":
      "recuperar datos de la base de datos",
    ". How you do either depends on how you're hosting Backplane — a docker-compose host, a managed container platform, bare VMs behind a load balancer. The mechanics below are the general shape; where a specific platform's commands are shown, they're one example, not the only path.":
      ". La forma de hacerlo depende de cómo alojes Backplane: un host con docker-compose, una plataforma administrada de contenedores o VMs detrás de un balanceador de carga. Los mecanismos siguientes muestran la estructura general; cuando se incluyen comandos de una plataforma específica, son un ejemplo, no el único camino.",
    "Reverting a bad deploy": "Revertir un deployment defectuoso",
    "The backend and frontend are ordinary containers built from the images in this repo (see ":
      "El backend y el frontend son contenedores comunes creados a partir de las imágenes de este repositorio (consulta ",
    "). \"Rolling back\" means running the previous image again, not rebuilding or reverting code:":
      "). Hacer \"rollback\" significa volver a ejecutar la imagen anterior, no recompilar ni revertir código:",
    "docker compose:": "docker compose:",
    " re-tag or re-pull the last known-good image and ":
      " vuelve a etiquetar o descargar la última imagen válida conocida y ejecuta ",
    " to recreate the affected service. If you're building locally,":
      " para recrear el servicio afectado. Si estás compilando localmente, usa",
    " the last-good commit and rebuild.":
      " con el último commit válido y vuelve a compilar.",
    "Any platform with revision/rollout history":
      "Cualquier plataforma con historial de revisiones o rollout",
    "(Kubernetes, Cloud Run, Nomad, ECS, …): use that platform's native rollback — shifting traffic or redeploying a pinned image tag — rather than rebuilding from source. Keeping the last few images around is what makes this fast.":
      "(Kubernetes, Cloud Run, Nomad, ECS, entre otras): usa el rollback nativo de la plataforma, ya sea reasignando tráfico o volviendo a desplegar un tag de imagen fijo, en lugar de recompilar desde el código fuente. Conservar las últimas imágenes permite hacerlo rápidamente.",
    "On Google Cloud Run — the maintainer's own deployment target":
      "En Google Cloud Run, el destino de deployment del mantenedor",
    "On Cloud Run specifically, this is effective in seconds — traffic re-assignment, not a rebuild, and no cold-start penalty on an already-warm revision. The same \"keep the old thing running, just stop sending traffic to the new thing\" principle applies whatever you're running on.":
      "En Cloud Run, este cambio tarda segundos: reasigna tráfico, no recompila, y una revisión ya activa no sufre la penalización de un cold start. El mismo principio, \"mantener lo anterior en ejecución y dejar de enviar tráfico a lo nuevo\", se aplica en cualquier plataforma.",
    "Database recovery": "Recuperación de la base de datos",
    "Backplane runs on Postgres (16, in the provided docker-compose setup). This app has no built-in backup/restore tooling of its own — recovery is whatever backup strategy you've put in front of your Postgres instance: ":
      "Backplane se ejecuta sobre Postgres, versión 16 en la configuración docker-compose incluida. La aplicación no incorpora herramientas propias de backup y restauración: la recuperación depende de la estrategia que hayas configurado para la instancia de Postgres, como ",
    " on a schedule, volume snapshots, or a managed Postgres provider's point-in-time recovery (PITR) if you're using one.":
      " programado, snapshots de volumen o recuperación a un punto en el tiempo (PITR) de un proveedor administrado de Postgres.",
    "Whichever mechanism you use, the same rule holds: recovery should be an out-of-place restore to a new instance or database, validated separately, then promoted. Never restore in-place over a live production database — if the restore is wrong, you want the broken original still there.":
      "Sin importar el mecanismo, se aplica la misma regla: restaura fuera de lugar en una instancia o base de datos nueva, valídala por separado y luego promuévela. Nunca restaures en el mismo lugar sobre una base de datos de producción activa; si la restauración falla, querrás conservar el original defectuoso.",
    "On Google Cloud SQL — the maintainer's own deployment target":
      "En Google Cloud SQL, el destino de deployment del mantenedor",
    "Verify DATABASE_URL before any Alembic invocation":
      "Verifica DATABASE_URL antes de invocar Alembic",
    "If your Postgres instance hosts more than one database — this app plus anything else you run alongside it — Alembic obeys whatever URL":
      "Si tu instancia de Postgres aloja más de una base de datos, esta aplicación y cualquier otro sistema, Alembic utiliza la URL que",
    " hands it, and ": " le entrega, y ",
    "it will happily migrate the wrong database":
      "migrará sin reparos la base de datos equivocada",
    " if the env is pointing there. Before any ":
      " si el entorno apunta a ella. Antes de cualquier ",
    ", an Alembic downgrade, or a manual SQL session, print the resolved URL and confirm the database name is the one you think it is. Two minutes of paranoia here beats an afternoon of cleanup.":
      ", downgrade de Alembic o sesión SQL manual, imprime la URL resuelta y confirma que el nombre de la base de datos sea el esperado. Dos minutos de cautela evitan una tarde de limpieza.",
    "Database migrations do not roll back — they are superseded":
      "Las migraciones de base de datos no se revierten: se reemplazan",
    "Rolling deploys (any platform that replaces instances gradually rather than all-at-once) mean for a brief window ":
      "Los rolling deployments, en cualquier plataforma que reemplace instancias gradualmente en lugar de hacerlo de una sola vez, implican que durante un breve período se ejecuten ",
    both: "tanto",
    " old and new application code run against the new schema. That is the whole reason migrations must be forward-compatible (add nullable columns, never drop read-live columns, never rename — see Migration Safety in the project's own developer docs).":
      " el código anterior como el nuevo sobre el esquema nuevo. Por eso las migraciones deben ser compatibles hacia adelante: agregar columnas nullable, nunca eliminar columnas que aún se leen y nunca renombrar. Consulta la sección Seguridad de migraciones en la documentación de desarrollo del proyecto.",
    "The corollary: you cannot fix a broken migration by editing the landed revision. Once a migration has been applied to production, it is a historical fact. A fix is a ":
      "La consecuencia es que no puedes corregir una migración defectuosa editando la revisión ya aplicada. Una vez que una migración llega a producción, se convierte en un hecho histórico. La corrección debe ser una migración ",
    new: "nueva",
    " migration that supersedes the old one — add the correction, bump the revision, deploy forward. Never run an Alembic downgrade in production. Never edit a committed migration file and redeploy. Never drop a column in the same release that stops reading it; that is a two-deploy dance, always.":
      " que reemplace la anterior: agrega la corrección, incrementa la revisión y despliega hacia adelante. Nunca ejecutes un downgrade de Alembic en producción. Nunca edites un archivo de migración ya incluido en un commit para volver a desplegarlo. Nunca elimines una columna en la misma versión que deja de leerla; siempre requiere dos deployments.",
  },
};
