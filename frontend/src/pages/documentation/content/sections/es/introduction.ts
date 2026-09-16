// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_INTRODUCTION = {
  "what-backplane-is": {
    "Backplane is four things that turn out to be one thing: a context-management system for LLM agents, a project-management suite, a coordination platform for teams and agents working the same board, and a workflow automation engine built on pipelines and loops. Agents lose their memory between sessions; Backplane is where the memory lives — boards, cards, notes, definitions, and a full activity history that any agent can read back in a single call.":
      "Backplane son cuatro cosas que terminan siendo una sola: un sistema de gestión de contexto para agentes LLM, una suite de gestión de proyectos, una plataforma de coordinación para equipos y agentes que trabajan sobre el mismo tablero, y un motor de automatización de flujos de trabajo construido sobre pipelines y loops. Los agentes pierden la memoria entre sesiones; Backplane es donde vive esa memoria: tableros, tarjetas, notas, definiciones y un historial completo de actividad que cualquier agente puede releer en una sola llamada.",
    "Humans shape the system — they define pipelines, author prompts, set budgets, approve risky actions. Agents do the work, whether that is an autonomous runner claiming cards inside a separate Git branch or a coding session you are driving yourself. The platform arbitrates: it stores the canonical pipeline shape, moves cards through columns, records every execution and its cost, coordinates approvals, and broadcasts everything to observers in real time.":
      "Las personas moldean el sistema: definen pipelines, crean prompts, establecen presupuestos y aprueban acciones de riesgo. Los agentes hacen el trabajo, ya sea un runner autónomo que toma tarjetas dentro de una rama de Git separada o una sesión de programación que conducís vos. La plataforma arbitra: almacena la estructura canónica del pipeline, mueve tarjetas entre columnas, registra cada ejecución y su costo, coordina aprobaciones y transmite todo a los observadores en tiempo real.",
    "The players": "Los participantes",
    "Three kinds of actors share a workspace. ":
      "Tres tipos de participantes comparten un espacio de trabajo. ",
    Operators: "Operadores",
    " are humans with UI access; they configure pipelines, write prompts, and approve high-risk actions. ":
      " son personas con acceso a la interfaz; configuran pipelines, escriben prompts y aprueban acciones de alto riesgo. ",
    Runners: "Runners",
    " are credentialed processes that execute roles on cards they claim — in practice, each runner today is a Claude CLI invocation wrapped in a Go client that knows how to speak MCP. ":
      " son procesos con credenciales que ejecutan roles en las tarjetas que toman. En la práctica, hoy cada runner es una invocación de Claude CLI encapsulada en un cliente de Go que sabe comunicarse mediante MCP. ",
    Observers: "Observadores",
    " are anyone watching the activity stream: a teammate following a live run, a dashboard aggregating cost, a webhook forwarding events to Slack.":
      " son todas las personas o sistemas que siguen el flujo de actividad: alguien del equipo que observa una ejecución en vivo, un dashboard que consolida costos o un webhook que reenvía eventos a Slack.",
    "Kanban board with a live pipeline run in progress":
      "Tablero kanban con una ejecución de pipeline en curso",
    "The board view is the operator's primary surface — every runner action lands here as a card movement or note.":
      "La vista del tablero es la superficie principal del operador: cada acción de un runner aparece aquí como un movimiento de tarjeta o una nota.",
    "Kanban board titled 'Platform Polish' at the top.":
      "Tablero kanban con el título 'Platform Polish' en la parte superior.",
    "Five columns: Backlog (3 cards), Ready (2), In Progress (1), Review (1), Done (4).":
      "Cinco columnas: Backlog (3 tarjetas), Ready (2), In Progress (1), Review (1), Done (4).",
    "The In Progress card is titled 'Wire useDomainSync for activity fan-out' and shows a green runner avatar plus a 'claimed 2m ago' timestamp.":
      "La tarjeta de In Progress se titula 'Wire useDomainSync for activity fan-out' y muestra el avatar verde de un runner junto con la marca de tiempo 'tomada hace 2 min'.",
    "A toast in the bottom-right reads 'claude-sonnet-4 opened PR #214'.":
      "Una notificación en la esquina inferior derecha dice 'claude-sonnet-4 abrió el PR #214'.",
    "Sidebar shows Documentation highlighted as the current page would appear for a first-time reader.":
      "La barra lateral muestra Documentación resaltada, tal como vería la página actual una persona que llega por primera vez.",
    "What the platform coordinates": "Qué coordina la plataforma",
    "A kanban app built for human users can assume the page occasionally refreshes. Backplane can't. The primary operators are LLMs that retry on every error, work concurrently across pipeline stages, read fields by name from tool responses, and pay for every token. Those four properties reshape every layer:":
      "Una aplicación kanban creada para personas puede suponer que la página se actualiza de vez en cuando. Backplane no puede hacerlo. Sus operadores principales son LLMs que reintentan ante cada error, trabajan de forma concurrente en distintas etapas del pipeline, leen los campos por su nombre en las respuestas de las herramientas y pagan por cada token. Esas cuatro características transforman todas las capas:",
    "Idempotent mutations.": "Mutaciones idempotentes.",
    " Every create/add endpoint returns the existing entity if it already exists, never a 409. This is why ":
      " Cada endpoint de creación o incorporación devuelve la entidad existente si ya existe, nunca un 409. Por eso ",
    " is safe to call from four pipeline stages in a row.":
      " se puede invocar de forma segura desde cuatro etapas consecutivas del pipeline.",
    "WebSocket-first event bus.": "Bus de eventos basado en WebSocket.",
    " Any mutation fans out on the workspace bus so every observer — UI, dashboard, other runner — stays coherent without polling.":
      " Toda mutación se propaga por el bus del espacio de trabajo para que cada observador, ya sea la interfaz, un dashboard u otro runner, se mantenga sincronizado sin polling.",
    "Composite MCP tools.": "Herramientas MCP compuestas.",
    " collapses what would be five REST calls into one round-trip. The agent pays once.":
      " reúne lo que serían cinco llamadas REST en un solo viaje de ida y vuelta. El agente paga una sola vez.",
    "Schema as contract.": "El esquema como contrato.",
    " Runners read tool responses by field name, so drift between the database, the API schema, and the MCP docstring is a real bug — not cosmetic.":
      " Los runners leen las respuestas de las herramientas por el nombre de los campos. Por eso, cualquier divergencia entre la base de datos, el esquema de la API y la docstring de MCP es un bug real, no un detalle cosmético.",
    "The agents table is still called 'agents'":
      "La tabla de agentes todavía se llama 'agents'",
    "We renamed the concept to ": "Cambiamos el nombre del concepto a ",
    Runner: "Runner",
    " in the UI in April 2026. The database table, SQLAlchemy model, API routes, and MCP tool names all stayed as ":
      " en la interfaz en abril de 2026. La tabla de la base de datos, el modelo de SQLAlchemy, las rutas de la API y los nombres de las herramientas MCP se mantuvieron como ",
    ". This is deliberate — breaking every integration for a cosmetic win isn't worth it. If you see":
      ". Esto es intencional: no vale la pena romper todas las integraciones por una mejora meramente cosmética. Si encuentras",
    " in the MCP catalog, that's a runner. Ask us how we know.":
      " en el catálogo MCP, se trata de un runner. Pregúntanos cómo lo sabemos.",
    "A minimal pipeline, in the shape you'll configure":
      "Un pipeline mínimo, con la estructura que configurarás",
    "Every workspace has a ": "Cada espacio de trabajo tiene una ",
    " — a declarative description of the stages a card moves through, what role executes at each stage, what column types trigger it, and what sensors veto or gate the work. Here's the smallest one that does something real: a single implementer role that picks up cards from the ":
      ": una descripción declarativa de las etapas que recorre una tarjeta, el rol que se ejecuta en cada etapa, los tipos de columna que la activan y los sensores que vetan o condicionan el trabajo. Este es el ejemplo más pequeño que hace algo real: un único rol de implementador que toma tarjetas de la columna ",
    Ready: "Ready",
    "column and moves them to ": " y las mueve a ",
    Review: "Review",
    " when done.": " al terminar.",
    "Minimal pipeline_config — one implementer stage":
      "pipeline_config mínimo: una etapa de implementador",
    "Backplane is not autonomous by default, and not model-locked":
      "Backplane no es autónomo por defecto, y no está limitado a un modelo",
    "Runners execute pipelines you configured — they don't invent objectives and they stop at the approval gates you defined. Model routing today goes through Claude via the ":
      "Los runners ejecutan los pipelines que configuraste: no inventan objetivos y se detienen en los puntos de aprobación que definiste. Hoy el enrutamiento de modelos pasa por Claude mediante el subproceso de CLI ",
    " CLI subprocess; per-role provider selection is the declared north star and the plumbing is partial.":
      "; la selección de proveedor por rol es la dirección declarada del producto y su infraestructura todavía está incompleta.",
    "From here, the rest of the documentation walks you through the core concepts (workspaces, runners, roles, prompts, approvals), a hands-on getting-started path, and the configuration surfaces where operators actually shape runner behavior.":
      "A partir de aquí, el resto de la documentación presenta los conceptos principales, como espacios de trabajo, runners, roles, prompts y aprobaciones; un recorrido práctico de primeros pasos; y las áreas de configuración donde los operadores definen realmente el comportamiento de los runners.",
  },
  "what-it-is-not": {
    "The previous page described what Backplane is. This one draws the fence. Operators arriving with expectations shaped by other tools — autonomous agent frameworks, general-purpose task platforms, one-model-forever wrappers — deserve to know up front what this platform does not try to be. Bounded expectations prevent the specific disappointment of asking a tool to do something it was never designed to do.":
      "La página anterior explicó qué es Backplane. Esta establece sus límites. Los operadores que llegan con expectativas formadas por otras herramientas, como frameworks de agentes autónomos, plataformas de tareas de propósito general o wrappers ligados para siempre a un único modelo, merecen saber desde el principio qué no intenta ser esta plataforma. Tener expectativas claras evita la frustración de pedirle a una herramienta algo para lo que nunca fue diseñada.",
    "Not autonomous": "No es autónomo",
    "Runners execute pipelines that operators configure. They don't invent their own objectives, they don't pick new tasks outside the ones you've defined, and they stop at the approval gates you declared. If a card requires a destructive action — a deletion, a deployment, a schema change — the runner pauses and asks a human. Autonomy stops where your configuration stops.":
      "Los runners ejecutan pipelines configurados por los operadores. No inventan sus propios objetivos, no eligen tareas nuevas fuera de las que definiste y se detienen en los puntos de aprobación que declaraste. Si una tarjeta requiere una acción destructiva, como una eliminación, un deployment o un cambio de esquema, el runner se detiene y consulta a una persona. La autonomía termina donde termina tu configuración.",
    "Backplane is not an autonomous agent platform":
      "Backplane no es una plataforma de agentes autónomos",
    "Runners are not goal-seeking. They claim cards from columns you've set up, execute the role and stage defined in your pipeline config, and report back. If you leave the pipeline empty, nothing happens. If you leave the board empty, nothing happens. The operator remains the source of direction.":
      "Los runners no buscan objetivos por cuenta propia. Toman tarjetas de las columnas que configuraste, ejecutan el rol y la etapa definidos en la configuración del pipeline y reportan el resultado. Si dejas el pipeline vacío, no ocurre nada. Si dejas el tablero vacío, no ocurre nada. El operador sigue siendo la fuente de dirección.",
    "Not domain-locked, but opinionated":
      "No está limitado a un dominio, pero sí es opinado",
    "Backplane is opinionated about shape, not about domain. The primitives — boards, cards, roles, prompts, approvals, notes — organize any work an LLM agent can be pointed at: an autonomous coding loop, a plain kanban board your team runs by hand, an MCP-assisted session where you drive and the agent keeps the board honest, or the renovation you're project-managing on a Sunday. Role configs are yours to write; nothing in them assumes a compiler.":
      "Backplane es opinado respecto de la forma, no del dominio. Los componentes básicos, tableros, tarjetas, roles, prompts, aprobaciones y notas, organizan cualquier trabajo al que se pueda apuntar un agente LLM: un loop de programación autónomo, un tablero kanban común que tu equipo maneja a mano, una sesión asistida por MCP donde vos conducís y el agente mantiene el tablero al día, o la refacción que estás coordinando un domingo. Las configuraciones de rol las escribís vos; nada en ellas supone un compilador.",
    "What is tuned for software is the git-coupled machinery: the merge queue, PR-overlap sensors, and the done-merge gate only mean something on a board with a repo linked. Boards without a repo simply skip them.":
      "Lo que sí está ajustado al software es la maquinaria acoplada a git: la cola de merge, los sensores de superposición de PRs y el control de merge al cerrar solo tienen sentido en un tablero con un repositorio vinculado. Los tableros sin repositorio simplemente los omiten.",
    "Not a hosted agent, and not a chat wrapper":
      "No es un agente alojado ni un envoltorio de chat",
    "Backplane does not run your agent for you. You bring the agent — a runner process, a Claude Code session, any MCP client — and Backplane gives it a place to keep state, take direction, and be watched. If you want a turnkey hosted agent that thinks up its own work, that is a different product.":
      "Backplane no ejecuta tu agente por vos. Vos traés el agente, ya sea un proceso runner, una sesión de Claude Code o cualquier cliente MCP, y Backplane le da un lugar donde conservar estado, recibir dirección y ser observado. Si lo que querés es un agente alojado llave en mano que invente su propio trabajo, ese es otro producto.",
    "Not model-locked — but not model-free either":
      "No está limitado a un modelo, pero tampoco es independiente de ellos",
    "Today most stages route through Claude via the ":
      "Hoy la mayoría de las etapas se enrutan a Claude mediante el subproceso de CLI ",
    " CLI subprocess. Per-role provider and model configuration — implementer on Sonnet, reviewer on GPT-5, documentator on Gemini, all from the same runner — is the declared north star. The scoping document exists. The plumbing is partial. The platform is not structurally locked to one vendor, but the day you can route each role to its own model is still ahead, tracked under the LLM abstraction milestone.":
      ". La configuración de proveedor y modelo por rol, con el implementador en Sonnet, el revisor en GPT-5 y el responsable de documentación en Gemini, todos desde el mismo runner, es la dirección declarada del producto. El documento de alcance existe. La infraestructura está incompleta. La plataforma no está estructuralmente ligada a un solo proveedor, pero todavía falta para poder enrutar cada rol a su propio modelo; ese trabajo se sigue en el hito de abstracción de LLM.",
    "Not yet per-role LLM selection":
      "La selección de LLM por rol todavía no está disponible",
    "The ": "El campo ",
    " field exists and accepts provider and model hints. The runner today passes them to Claude CLI regardless. Wiring alternative providers end-to-end is the next big structural work stream, not a configuration flag you can flip today.":
      " existe y acepta indicaciones de proveedor y modelo. Hoy el runner las envía a Claude CLI de todos modos. Integrar proveedores alternativos de extremo a extremo es la próxima gran línea de trabajo estructural, no una opción de configuración que puedas activar hoy.",
    "Not a replacement for developer judgement":
      "No reemplaza el criterio de quienes desarrollan",
    "Approval gates, review cycles, and the human-authored pipeline config are where judgement lives. The runner executes; the operator decides what executing looks like. If a pipeline ships a bug, the pipeline is wrong — not the runner. If a reviewer role rubber-stamps everything, the prompt or the model selection is wrong. The platform gives you the levers; pulling them is still your job.":
      "Los puntos de aprobación, los ciclos de revisión y la configuración del pipeline creada por personas son donde reside el criterio. El runner ejecuta; el operador decide cómo debe ser la ejecución. Si un pipeline entrega un bug, el pipeline está mal, no el runner. Si un rol de revisor aprueba todo sin criterio, el problema está en el prompt o en la selección del modelo. La plataforma ofrece los controles; usarlos sigue siendo tu responsabilidad.",
    "So what is it, then?": "Entonces, ¿qué es?",
    "A coordination layer for LLM runners doing real engineering work on real git repositories, with the controls operators need to keep the work honest. The previous section — What Backplane Is — covers the shape of that in more detail. Between the two pages you should have a useful mental model before you start clicking.":
      "Una capa de coordinación para runners de LLM que realizan trabajo de ingeniería real sobre repositorios git reales, con los controles que los operadores necesitan para mantener el proceso íntegro. La sección anterior, Qué es Backplane, explica esta estructura con más detalle. Entre ambas páginas deberías tener un modelo mental útil antes de comenzar a navegar.",
  },
  "quick-tour": {
    "Five minutes, one pass through the core loop. This tour follows a single card from the moment it lands on a board to the moment a runner ships a PR for it. No deep dives — each stop points at the dedicated section where you'll find the full treatment.":
      "Cinco minutos y un recorrido por el ciclo principal. Este tour sigue una sola tarjeta desde que llega a un tablero hasta que un runner entrega un PR para ella. Sin profundizar: cada parada señala la sección dedicada donde encontrarás la explicación completa.",
    "Workspace and board": "Espacio de trabajo y tablero",
    "Every URL in the platform lives under a workspace slug:":
      "Todas las URLs de la plataforma se encuentran bajo el slug de un espacio de trabajo:",
    ". Inside a workspace you have boards, members, teams, a pipeline config, budgets, and activity history. Inside a board you have columns, cards, definitions, resources, notes, git repos, and alerts. The board view is where operators spend most of their day.":
      ". Dentro de un espacio de trabajo hay tableros, miembros, equipos, una configuración de pipeline, presupuestos e historial de actividad. Dentro de un tablero hay columnas, tarjetas, definiciones, recursos, notas, repositorios git y alertas. La vista del tablero es donde los operadores pasan la mayor parte del día.",
    "Kanban board with five columns and several cards":
      "Tablero kanban con cinco columnas y varias tarjetas",
    "The board is the operator's primary surface. Column types — not column names — drive pipeline behavior.":
      "El tablero es la superficie principal del operador. Los tipos de columna, no sus nombres, determinan el comportamiento del pipeline.",
    "Page header reads 'Platform Polish'.":
      "El encabezado de la página muestra 'Platform Polish'.",
    "Five columns in order: 'Backlog' (4 cards), 'Ready' (2 cards), 'In Progress' (1 card), 'Review' (1 card), 'Done' (6 cards).":
      "Cinco columnas en este orden: 'Backlog' (4 tarjetas), 'Ready' (2 tarjetas), 'In Progress' (1 tarjeta), 'Review' (1 tarjeta), 'Done' (6 tarjetas).",
    "Each card shows a title, a priority badge ('high', 'medium', or 'low'), and one or two participant avatars.":
      "Cada tarjeta muestra un título, una etiqueta de prioridad ('high', 'medium' o 'low') y uno o dos avatares de participantes.",
    "Top-right shows a 'Create card' button and a filter bar with 'Type', 'Priority', 'Assignee', 'Search'.":
      "En la esquina superior derecha aparecen el botón 'Crear tarjeta' y una barra de filtros con 'Tipo', 'Prioridad', 'Responsable' y 'Buscar'.",
    "Left sidebar highlights the 'Boards' entry as active.":
      "La barra lateral izquierda resalta la opción 'Tableros' como activa.",
    "A card enters the pipeline": "Una tarjeta entra en el pipeline",
    "Someone — a human operator or an architect runner following the":
      "Alguien, ya sea un operador humano o un runner arquitecto que sigue el prompt",
    " prompt — creates a card in the Backlog column. The card has a title, a type (":
      ", crea una tarjeta en la columna Backlog. La tarjeta tiene un título, un tipo (",
    "), a priority, a description, and optionally labels, a due date, and participants. Nothing happens yet. Backlog cards are waiting for a scheduler to notice them.":
      "), una prioridad, una descripción y, opcionalmente, etiquetas, una fecha límite y participantes. Todavía no ocurre nada. Las tarjetas del Backlog esperan que un planificador las detecte.",
    "A runner claims": "Un runner toma una tarjeta",
    "A runner polls the backend (via WebSocket, not HTTP interval) for work matching its team membership. Each runner executes one stage per tick. The backend answers: \"claim card X for stage Y.\" The claim is atomic: the card's ":
      "Un runner consulta el backend, mediante WebSocket y no a intervalos HTTP, para buscar trabajo que coincida con su pertenencia a un equipo. Cada runner ejecuta una etapa por ciclo. El backend responde: \"tomar la tarjeta X para la etapa Y\". La operación de toma es atómica: el espacio de participante ",
    hero: "hero",
    " participant slot is filled in a single transaction. Two runners racing for the same card lose one cleanly; the loser backs off and the winner moves the card into the next column — typically ":
      " de la tarjeta se completa en una sola transacción. Si dos runners compiten por la misma tarjeta, uno pierde de forma segura; el perdedor retrocede y el ganador mueve la tarjeta a la siguiente columna, normalmente ",
    "In Progress": "En curso",
    "Runner overview with KPI strip and runner table":
      "Vista general de runners con una franja de KPIs y una tabla de runners",
    "The runner overview shows who is working on what, what it cost, and how long it took.":
      "La vista general de runners muestra quién trabaja en cada elemento, cuánto costó y cuánto tiempo tomó.",
    "KPI strip across the top reads 'Runners: 4', 'Success rate: 96%', 'Avg duration: 2m 14s', 'Total spend: $47.22'.":
      "La franja de KPIs en la parte superior muestra 'Runners: 4', 'Tasa de éxito: 96%', 'Duración promedio: 2 min 14 s' y 'Gasto total: $47.22'.",
    "Runner table below lists four rows. The top row shows 'claude-sonnet-implementer' with status 'active' and current card 'Wire useDomainSync'.":
      "La tabla de runners contiene cuatro filas. La primera muestra 'claude-sonnet-implementer' con estado 'active' y la tarjeta actual 'Wire useDomainSync'.",
    "Right panel titled 'Pending approvals' shows one pending approval with category 'bulk_change'.":
      "El panel derecho, titulado 'Aprobaciones pendientes', muestra una aprobación pendiente de la categoría 'bulk_change'.",
    "Bottom strip titled 'Execution timeline' shows colored bars per role across the last hour.":
      "La franja inferior, titulada 'Línea de tiempo de ejecuciones', muestra barras de colores por rol durante la última hora.",
    "The stage executes": "La etapa se ejecuta",
    "The runner assembles a prompt — board definition, pinned notes, card description, prior review findings, platform-spliced post-process imperatives — and invokes Claude CLI. If the board binds":
      "El runner arma un prompt con la definición del tablero, las notas fijadas, la descripción de la tarjeta, los hallazgos de revisiones anteriores y las instrucciones de posproceso insertadas por la plataforma, e invoca Claude CLI. Si el tablero tiene vinculadas ",
    skills: "habilidades",
    " — versioned procedural playbooks from the workspace library — the runner materializes them into the working tree first, so the agent discovers them like project files. Every tool call the LLM makes goes through the Backplane MCP server, which routes it back to the backend. Every mutation publishes an ":
      " (manuales de procedimiento versionados de la biblioteca del espacio de trabajo), el runner las materializa primero en el árbol de trabajo, de modo que el agente las descubre como si fueran archivos del proyecto. Cada llamada a una herramienta que realiza el LLM pasa por el servidor MCP de Backplane, que la envía de vuelta al backend. Cada mutación publica un evento ",
    " event on the WebSocket bus. Observers see the work happen live: cards move, comments appear, tokens and cost accumulate on the execution row.":
      " en el bus de WebSocket. Los observadores ven el trabajo en vivo: las tarjetas se mueven, aparecen comentarios y los tokens y el costo se acumulan en el registro de ejecución.",
    "Watch the Observer panel during your first run":
      "Observa el panel del observador durante tu primera ejecución",
    "The floating Observer panel (admin-only, draggable, remembers its position) streams every card, agent, execution, and approval event in real time. The first time you run a pipeline end-to-end, open it. You will see more about what the platform is doing in thirty seconds of scrolling events than in any diagram we could draw for you.":
      "El panel flotante del observador, disponible solo para administradores, arrastrable y capaz de recordar su posición, transmite en tiempo real todos los eventos de tarjetas, agentes, ejecuciones y aprobaciones. Ábrelo la primera vez que ejecutes un pipeline de extremo a extremo. En treinta segundos recorriendo eventos entenderás mejor lo que hace la plataforma que con cualquier diagrama que pudiéramos dibujar.",
    "Approval, if the stage demands one":
      "Aprobación, si la etapa la exige",
    "If the stage declares an approval gate — say, because the work category is ":
      "Si la etapa declara un punto de aprobación, por ejemplo porque la categoría del trabajo es ",
    " or the risk score crosses the auto-approve threshold — the runner pauses and emits a":
      " o porque la puntuación de riesgo supera el umbral de aprobación automática, el runner se detiene y emite una llamada a la herramienta ",
    " tool call. The backend creates a pending approval; a human sees it in the ":
      ". El backend crea una aprobación pendiente; una persona la ve en la cola de ",
    Approvals: "Aprobaciones",
    " queue and decides. The runner is subscribed to ":
      " y decide. El runner está suscrito a ",
    " on the WS bus, so the moment the decision lands the runner wakes and continues. No polling, no wasted ticks.":
      " en el bus de WS, por lo que se activa y continúa en cuanto llega la decisión. Sin polling y sin ciclos desperdiciados.",
    "Approval dialog showing a pending bulk-change approval":
      "Diálogo de aprobación que muestra un cambio masivo pendiente",
    "Approvals show the action description and payload the runner requested — enough context to decide without reopening the card.":
      "Las aprobaciones muestran la descripción de la acción y el payload solicitado por el runner, con suficiente contexto para decidir sin volver a abrir la tarjeta.",
    "Dialog titled 'Approve bulk card deletion'.":
      "Diálogo titulado 'Aprobar eliminación masiva de tarjetas'.",
    "Category badge reads 'bulk_change' in amber.":
      "La etiqueta de categoría muestra 'bulk_change' en ámbar.",
    "Risk score strip reads '0.72 / 1.00'.":
      "La franja de puntuación de riesgo muestra '0.72 / 1.00'.",
    "Action description paragraph reads 'Delete 8 stale cards from the Backlog column older than 90 days'.":
      "El párrafo de descripción de la acción dice 'Eliminar 8 tarjetas inactivas de la columna Backlog con más de 90 días'.",
    "Payload JSON block shows the card IDs to be deleted.":
      "El bloque de payload JSON muestra los IDs de las tarjetas que se eliminarán.",
    "Two buttons at the bottom: 'Approve' (primary) and 'Reject' (outline).":
      "Dos botones en la parte inferior: 'Aprobar' (principal) y 'Rechazar' (contorno).",
    "Ship and repeat": "Entrega y repite",
    "The runner pushes the branch, opens a PR, moves the card into the column configured in the stage's ":
      "El runner hace push de la rama, abre un PR y mueve la tarjeta a la columna configurada en la acción ",
    " action (typically ": " de la etapa, normalmente ",
    Review: "Review",
    " for an implement stage, ": " para una etapa de implementación y ",
    Done: "Done",
    " for a reviewer stage), records the execution's cost and duration, and enters its next tick. The next stage in the pipeline — a reviewer role, a documentator role, a custom role you defined — picks the card up from its new column and the loop continues.":
      " para una etapa de revisión, registra el costo y la duración de la ejecución y entra en su siguiente ciclo. La próxima etapa del pipeline, ya sea un rol de revisor, de responsable de documentación o un rol personalizado que definiste, toma la tarjeta de su nueva columna y el ciclo continúa.",
    "That's the shape. The rest of this documentation walks each piece in depth — what the pipeline builder accepts, how to author prompts, how to register a runner, how to read the runner overview, and where to look when a card gets stuck.":
      "Esa es la estructura. El resto de esta documentación explica cada parte en profundidad: qué acepta el constructor de pipelines, cómo crear prompts, cómo registrar un runner, cómo leer la vista general de runners y dónde buscar cuando una tarjeta queda bloqueada.",
  },
};
