// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_UNDER_THE_HOOD = {
  "architecture-overview": {
    "Four cooperating surfaces, one monorepo. The backend is the system of record. The frontend is the operator's cockpit. The MCP server is the cross-LLM integration point. The runner is the credentialed process that actually executes LLM work against a card. Every piece of the platform falls into one of those four surfaces, and they all live in the same git tree so cross-surface refactors happen in one PR with one CI run.":
      "Cuatro superficies que colaboran, un solo monorepo. El backend es el sistema de registro. El frontend es la cabina de control del operador. El servidor MCP es el punto de integración entre LLMs. El runner es el proceso con credenciales que ejecuta realmente el trabajo de LLM sobre una tarjeta. Cada componente de la plataforma pertenece a una de esas cuatro superficies y todos viven en el mismo árbol git, de modo que las refactorizaciones transversales ocurren en un solo PR y una sola ejecución de CI.",
    "The four surfaces": "Las cuatro superficies",
    "Read this diagram left-to-right. A human operator clicks the frontend; the frontend talks to the backend over REST and WebSockets; a runner running on an operator's laptop talks to the same backend with the same protocols; the LLM the runner spawns reaches back to the backend through the MCP server. Nothing is circular.":
      "Lee este diagrama de izquierda a derecha. Un operador humano interactúa con el frontend; el frontend se comunica con el backend mediante REST y WebSockets; un runner que se ejecuta en el equipo del operador se comunica con el mismo backend usando los mismos protocolos; y el LLM iniciado por el runner vuelve al backend mediante el servidor MCP. Nada es circular.",
    "Data flow across the four surfaces":
      "Flujo de datos entre las cuatro superficies",
    " selects ": " selecciona ",
    " for local in-process delivery or ": " para entrega local en el proceso o ",
    " for cross-instance fan-out over Postgres LISTEN/NOTIFY. Both adapters feed the same local subscribers; neither is a durable queue or replay log.":
      " para distribución entre instancias mediante Postgres LISTEN/NOTIFY. Ambos adaptadores alimentan a los mismos suscriptores locales; ninguno es una cola durable ni un registro con replay.",
    "Backend pattern: Router → Service → Repository → Model":
      "Patrón del backend: Router → Service → Repository → Model",
    "Most feature endpoints flow through the same four layers. The router parses the request and wires dependencies (workspace resolution, auth). The service owns business logic, authorization beyond membership, idempotency, activity recording, and event publishing. The repository is pure data access over a generic ":
      "La mayoría de los endpoints funcionales atraviesan las mismas cuatro capas. El router interpreta la solicitud y conecta las dependencias, como la resolución del espacio de trabajo y la autenticación. El service concentra la lógica de negocio, la autorización adicional a la membresía, la idempotencia, el registro de actividad y la publicación de eventos. El repository ofrece acceso puro a los datos sobre un ",
    ". The model is SQLAlchemy 2.x with UUID primary keys and timestamp mixins.":
      ". El model usa SQLAlchemy 2.x, claves primarias UUID y mixins de timestamp.",
    "A routine card create is a five-step trace: route handler hits":
      "La creación habitual de una tarjeta recorre cinco pasos: el handler de la ruta llama a",
    " for membership, calls":
      " para comprobar la membresía y llama a",
    ", which computes a fractional position and calls ":
      ", que calcula una posición fraccionaria y llama a ",
    ", which inserts, flushes, and re-fetches with ":
      ", que inserta, ejecuta el flush y vuelve a consultar con ",
    " so the response includes participants. The session auto-commits on the way out. The same pattern holds across the domain routers. Cross-cutting adapters do have explicit exceptions: the WebSocket router resolves users and workspaces during its handshake, and the workspace-config router checks repository linkage while exporting a runner config.":
      " para que la respuesta incluya a los participantes. La sesión hace commit automáticamente al finalizar. El mismo patrón se mantiene en los routers del dominio. Los adaptadores transversales sí tienen excepciones explícitas: el router WebSocket resuelve usuarios y espacios de trabajo durante el handshake, y el router de configuración del espacio comprueba la vinculación del repositorio al exportar una configuración del runner.",
    "One error envelope": "Un único sobre de error",
    "Every error the API returns — domain errors, plain HTTP errors, and request validation — carries the same four-key body, so a client parses one shape and branches on ":
      "Todos los errores que devuelve la API — errores de dominio, errores HTTP simples y validación de peticiones — llevan el mismo cuerpo de cuatro claves, de modo que un cliente parsea una sola forma y ramifica según ",
    " rather than on prose. ":
      " en lugar de según la prosa. ",
    " is the human-readable message,":
      " es el mensaje legible por humanos,",
    " is a stable machine string (":
      " es una cadena estable para máquinas (",
    " holds structured parameters for rendering the message, and ":
      " contiene parámetros estructurados para renderizar el mensaje y ",
    " carries machine-readable extras when the code alone is not enough — or ":
      " transporta extras legibles por máquinas cuando el código por sí solo no basta, o ",
    "The envelope, on a stale config write":
      "El sobre, en una escritura de configuración obsoleta",
    "Validation failures return 422 with":
      "Los fallos de validación devuelven 422 con",
    " and an": " y un array",
    " array of": " con objetos",
    " objects, one per invalid field. Errors raised outside the domain hierarchy are mapped onto the same envelope from the HTTP status, so the shape holds even for framework-level failures. Message prose can change between releases; the codes are the contract.":
      ", uno por cada campo inválido. Los errores lanzados fuera de la jerarquía de dominio se proyectan sobre el mismo sobre a partir del estado HTTP, así que la forma se mantiene incluso en fallos a nivel del framework. La prosa de los mensajes puede cambiar entre versiones; los códigos son el contrato.",
    "Frontend: feature modules, no orphans":
      "Frontend: módulos funcionales, sin elementos huérfanos",
    "The React app lives in ": "La aplicación React se encuentra en ",
    ", with domain code colocated under ":
      ", con el código del dominio ubicado junto bajo ",
    ". A feature adds": ". Cada funcionalidad agrega",
    " only as needed rather than carrying an empty fixed scaffold. Twenty-three modules exist today —":
      " solo cuando los necesita, en lugar de mantener una estructura fija vacía. Hoy existen veintitrés módulos;",
    " is the largest because it owns the pipeline builder and runner overview; ":
      " es el más grande porque contiene el constructor de pipelines y la vista general de runners; ",
    " is next because it owns the board + drag-and-drop + card detail sheet.":
      " le sigue porque contiene el tablero, la función de arrastrar y soltar y el panel de detalles de la tarjeta.",
    "There is no Redux. There is no Zustand for server state. React Query v5 is the uniform substrate. Shared domain query-key factories live in":
      "No hay Redux. No hay Zustand para el estado del servidor. React Query v5 es la base uniforme. Las factorías compartidas de query keys del dominio viven en",
    "; a few composed inbox and local file preview keys stay beside their callers. The AppShell renders the sidebar, topbar, outlet, and the floating ObserverPanel; workspace routing lives in a single":
      "; algunas keys compuestas del inbox y de la vista previa de archivos locales permanecen junto a sus consumidores. AppShell renderiza la barra lateral, la barra superior, el outlet y el ObserverPanel flotante; el enrutamiento del espacio de trabajo vive en un único",
    "MCP: the cross-LLM integration point":
      "MCP: el punto de integración entre LLMs",
    "The Model Context Protocol is an Anthropic-led protocol that lets an LLM host — Claude Code, Claude Desktop, Cursor, Codex CLI, a custom Go runner — discover and call external tools over a negotiated capability surface. The Backplane MCP server wraps the backend REST API and exposes platform operations as MCP tools. Whatever an agent wants to do programmatically against Backplane — list cards, claim one, move it, create a note, request approval — it does via one of the MCP tools (the full tool census, drift-guarded in CI).":
      "Model Context Protocol es un protocolo liderado por Anthropic que permite que un host de LLM, como Claude Code, Claude Desktop, Cursor, Codex CLI o un runner personalizado en Go, descubra y llame herramientas externas mediante una superficie de capacidades negociada. El servidor MCP de Backplane encapsula la API REST del backend y expone las operaciones de la plataforma como herramientas MCP. Todo lo que un agente quiera hacer programáticamente en Backplane, como enumerar tarjetas, tomar una, moverla, crear una nota o solicitar aprobación, lo realiza mediante alguna herramienta MCP; el catálogo completo está protegido contra divergencias en CI.",
    "Interactive hosts such as Claude Code and Codex, plus coding-agent sessions spawned by the Go runner, call the MCP server. Registered workflow prompts use their exact underscore handles, including":
      "Los hosts interactivos, como Claude Code y Codex, y las sesiones de agentes de código iniciadas por el runner de Go llaman al servidor MCP. Los prompts de flujo registrados usan sus identificadores exactos con guion bajo, entre ellos",
    ", and ": ", y ",
    ", and": ", y",
    ". Tools proxy authenticated backend operations; prompts and resources add server-authored context without moving platform authority out of the backend.":
      ". Las herramientas actúan como proxy de operaciones autenticadas del backend; los prompts y recursos agregan contexto creado por el servidor sin sacar la autoridad de la plataforma fuera del backend.",
    "Runner: the credentialed process": "Runner: el proceso con credenciales",
    "The Go runner at ": "El runner de Go ubicado en ",
    " is a single static binary that an operator launches on their own hardware. Each process normally starts from one registered agent's config and bearer key. On startup it authenticates against the backend with":
      " es un único binario estático que un operador inicia en su propio equipo. Cada proceso normalmente parte de la configuración y la clave bearer de un agente registrado. Al iniciar, se autentica en el backend con",
    ", fetches its platform pipeline config, optionally opens a workspace WebSocket, and enters a work loop that ticks every two minutes by default or wakes on matching WS events. Each stage may spawn the selected coding-agent driver —":
      ", obtiene la configuración de pipeline de la plataforma, abre opcionalmente un WebSocket del espacio de trabajo y entra en un ciclo que se ejecuta cada dos minutos por defecto o despierta ante eventos WS coincidentes. Cada etapa puede iniciar el driver de agente de código seleccionado, ya sea",
    " or ": " o ",
    ", including per-stage or tier routing — with a rendered prompt, the MCP tool allowlist, and the workspace context.":
      ", incluido el enrutamiento por etapa o tier, con un prompt renderizado, la allowlist de herramientas MCP y el contexto del espacio de trabajo.",
    "The runner owns git directly: ": "El runner controla git directamente: ",
    " handles clone, checkout, commit, and push, while the configured GitHub or Gitea forge adapter handles pull requests and merge behavior. The coding agent edits files; the runner is the component responsible for the branch lifecycle.":
      " gestiona clone, checkout, commit y push, mientras que el adaptador configurado para GitHub o Gitea gestiona los pull requests y el comportamiento de merge. El agente de código edita los archivos; el runner es el componente responsable del ciclo de vida de la rama.",
    "One monorepo, ecosystem-specific locks": "Un monorepo, locks específicos por ecosistema",
    "All four surfaces live in the same tree. The root and frontend keep separate pnpm lockfiles; Go modules own their own dependencies; Python for the backend and the MCP server is managed via ":
      "Las cuatro superficies viven en el mismo árbol. La raíz y el frontend mantienen lockfiles de pnpm separados; los módulos Go gestionan sus propias dependencias; Python para el backend y el servidor MCP se administra mediante ",
    ". One place to": ". Un único lugar para",
    ". One place to diff across a schema change.":
      ". Un único lugar para comparar los cambios de una modificación del esquema.",
    "Monorepo layout (top two levels)":
      "Estructura del monorepo, en sus dos primeros niveles",
    "Cross-surface refactors ship in one PR":
      "Las refactorizaciones transversales se entregan en un solo PR",
    "A rename that touches a Pydantic schema, a TypeScript interface, a Go struct, and an MCP tool signature is one commit with one CI run because the four surfaces share a tree. The drift guard in":
      "Un cambio de nombre que modifica un esquema de Pydantic, una interfaz de TypeScript, una struct de Go y la firma de una herramienta MCP queda en un solo commit y una sola ejecución de CI porque las cuatro superficies comparten el mismo árbol. El control de divergencias en",
    " AST-parses tool and prompt decorators plus resource URIs, then fails CI when the frontend catalog disagrees. The frontend signature-parity test additionally checks every tool and prompt parameter in declaration order with exact requiredness. The first time you add a parameter and CI flags the reference before you remembered to update it, the monorepo pays for itself.":
      " analiza mediante AST los decoradores de herramientas y prompts, además de las URI de recursos, y hace fallar CI cuando el catálogo del frontend diverge. La prueba de paridad de firmas del frontend también verifica todos los parámetros de herramientas y prompts, su orden de declaración y su obligatoriedad exacta. La primera vez que agregues un parámetro y CI señale la referencia antes de que recuerdes actualizarla, el monorepo habrá demostrado su valor.",
    "The rest of this group walks through the patterns that tie these four surfaces together: the event bus and WebSocket model, fractional indexing, idempotency, platform authority, and the model-agnostic future. None of them are incidental — they're the reason a retry-happy LLM operator doesn't set the platform on fire.":
      "El resto de este grupo presenta los patrones que conectan estas cuatro superficies: el bus de eventos y el modelo WebSocket, la indexación fraccionaria, la idempotencia, la autoridad de la plataforma y el futuro independiente del modelo. Ninguno es accidental; son la razón por la que un operador LLM propenso a reintentar no pone en riesgo la plataforma.",
  },
  "event-bus-and-websocket-model": {
    "Every published mutation fans out through one event-bus interface.":
      "Toda mutación publicada se distribuye mediante una única interfaz de bus de eventos.",
    " keeps delivery in process;": " mantiene la entrega dentro del proceso;",
    " adds cross-instance fan-out via Postgres LISTEN/NOTIFY while preserving the same local subscribers. The backend's WebSocket router translates those into outbound frames for every connection subscribed to a matching pattern. A webhook subscriber drains the same bus for outbound HTTP fan-out. The frontend has a one-line React hook that turns a WS subscription into a React Query cache invalidation. The runner has a WS client that wakes its work loop on any matching event. This is the low-latency path across the four surfaces; the runner still keeps its scheduled poll as a fallback.":
      " añade distribución entre instancias mediante Postgres LISTEN/NOTIFY y conserva los mismos suscriptores locales. El router WebSocket del backend convierte los eventos en frames para cada conexión suscrita. Un suscriptor de webhooks consume el mismo bus para la distribución HTTP. El frontend invalida la caché de React Query mediante un hook y el runner activa su ciclo de trabajo ante eventos coincidentes. Esta es la ruta de baja latencia entre las cuatro superficies; el runner conserva su sondeo programado como respaldo.",
    "The local bus and the Postgres adapter":
      "El bus local y el adaptador de Postgres",
    " lives at": " vive en",
    ". It is a subscribe / publish ring backed by a list of":
      ". Es un circuito de subscribe/publish respaldado por una lista de",
    " tuples. Subscriptions can be workspace-scoped or global. Patterns are shell globs — ":
      " tuplas. Las suscripciones pueden limitarse a un espacio de trabajo o ser globales. Los patrones son globs de shell, como ",
    " — so fine-grained filtering is declarative, not procedural. Publish is fan-out via":
      "; así, el filtrado detallado es declarativo y no procedimental. La publicación se distribuye mediante",
    ". Subscriber errors are logged but never raised back to the publisher. The":
      ". Los errores de los suscriptores se registran, pero nunca se propagan al publicador. La subclase",
    " subclass dispatches locally, sends a NOTIFY on ":
      " distribuye localmente, envía un NOTIFY por ",
    ", and re-injects LISTEN messages from other instances without echoing them back. A single module-level":
      ", y reinyecta los mensajes LISTEN de otras instancias sin volver a emitirlos. Un único singleton",
    " singleton is shared by the direct publishers.":
      " a nivel de módulo se comparte entre los publicadores directos.",
    "activity.{entity}.{action} fan-out":
      "Distribución de activity.{entity}.{action}",
    " is the cross-cutting mutation recorder. Services use it for audited entity mutations. The method writes the activity row to the database, then unconditionally publishes ":
      " es el registrador transversal de mutaciones. Los services lo usan para mutaciones auditadas de entidades. El método escribe el registro de actividad en la base de datos y luego publica siempre ",
    " on the bus — ": " en el bus, por ejemplo ",
    ", and so on. Agent lifecycle now also records ":
      ", entre otros. El ciclo de vida de los agentes ahora también registra ",
    " and": " y",
    ", and ": ", y ",
    ". Adding a new pair needs no per-event constant because the event name derives from the":
      ". Agregar un par nuevo no requiere una constante por evento; los enums ",
    " and ": " y ",
    "enums.": " definen el nombre.",
    "Service-specific events that are not activity-shaped —":
      "Los eventos específicos de un service que no tienen la forma de una actividad, como ",
    " — publish directly from their owning services. Most constants live in":
      ", se publican directamente desde sus services responsables. La mayoría de las constantes viven en",
    "; merge-queue and notification names live beside their publishers.":
      "; los nombres de la cola de merge y de notificaciones viven junto a sus publicadores.",
    "Bridge events: deprecated but still emitting":
      "Eventos de transición: obsoletos, pero todavía se emiten",
    "A small map — ": "Un mapa pequeño, con ",
    " — publishes in parallel with the":
      ", publica en paralelo con el evento equivalente en",
    " twin. These are bridge events kept for backward compatibility. The source is explicitly commented":
      ". Estos eventos de transición se mantienen por compatibilidad con versiones anteriores. El código fuente incluye explícitamente el comentario",
    "\"deprecated, do not extend\"": "\"deprecated, do not extend\"",
    ". New consumers should subscribe to the ":
      ". Los consumidores nuevos deben suscribirse al namespace ",
    " namespace; the bridge is what exists so pre-M-Observability consumers keep working while they migrate. The bridge map in ":
      "; la transición permite que los consumidores anteriores a M-Observability sigan funcionando mientras migran. El mapa de transición en ",
    " is the sunset list — removing it requires confirming no live consumer depends on the old name.":
      " es la lista de desactivación; eliminarlo exige confirmar que ningún consumidor activo depende del nombre anterior.",
    "The WebSocket subscribe protocol": "El protocolo de suscripción WebSocket",
    "A WebSocket client connects to": "Un cliente WebSocket se conecta a",
    " with an API key in ": " con una API key en ",
    ", a signed browser session, or an IAP/trusted-proxy identity. The legacy ":
      ", una sesión firmada del navegador o una identidad IAP/trusted proxy. El fallback heredado ",
    "fallback is still accepted, but the runner uses the header so secrets do not land in access logs. On accept, the connection is registered with the ":
      " sigue aceptándose, pero el runner usa el header para que los secrets no queden en los logs de acceso. Al aceptar, la conexión se registra en el ",
    ", which holds live socket handles and bridges bus events to them. The client then sends":
      ", que mantiene los handles de los sockets activos y les transmite los eventos del bus. Luego, el cliente envía",
    ". The connection manager re-subscribes on every such frame: each pattern becomes one ":
      ". El administrador de conexiones vuelve a suscribirse con cada frame de ese tipo: cada patrón se convierte en una suscripción de ",
    " subscription whose callback serializes the event as JSON and sends it over the socket.":
      " cuyo callback serializa el evento como JSON y lo envía por el socket.",
    "Heartbeats flow both ways. The server sends":
      "Los heartbeats circulan en ambas direcciones. El servidor envía",
    " every": " cada",
    " seconds; runners additionally push ":
      " segundos; además, los runners envían frames ",
    " frames carrying CPU, memory, card counts, and current board to keep the backend's live runner view fresh.":
      " con CPU, memoria, cantidad de tarjetas y tablero actual para mantener actualizada la vista en vivo de runners del backend.",
    "Timing mitigations are load-bearing, not decorative":
      "Las mitigaciones de timing son esenciales, no decorativas",
    "There is no event replay between connect and subscribe. An event published in the window between ":
      "No hay replay de eventos entre la conexión y la suscripción. Un evento publicado en el intervalo entre ",
    " and the first": " y el primer frame",
    " frame is lost to that client. The mitigations for subscribe timing are stacked for a reason. The transport":
      " se pierde para ese cliente. Las mitigaciones del timing de suscripción se superponen por una razón. El transporte",
    ") carries a stale-connection guard that checks ":
      ") incluye una protección contra conexiones obsoletas que comprueba ",
    " on every callback — defence against React StrictMode's double-mount race where the stale socket's ":
      " en cada callback. Esto protege frente a la condición de carrera por montaje doble de React StrictMode, en la que el ",
    " would otherwise flip state belonging to the newer connection. The provider":
      " del socket obsoleto cambiaría un estado perteneciente a la conexión más reciente. El provider",
    ") holds a": ") mantiene un contador de estado ",
    " state counter that invalidates every memoized ":
      " que invalida cada closure memoizada de ",
    " closure when a new service is created, so children subscribing ":
      " cuando se crea un service nuevo, de modo que los componentes secundarios que se suscriben ",
    before: "antes",
    " the provider's effect ran don't hold a null service ref. Subscribe frames are re-sent on reconnect and on every new pattern registration — the server does not remember patterns across connections.":
      " de que se ejecute el efecto del provider no conserven una referencia nula al service. Los frames de suscripción se vuelven a enviar al reconectar y cada vez que se registra un patrón nuevo; el servidor no recuerda patrones entre conexiones.",
    "useDomainSync: the one-line bridge":
      "useDomainSync: el puente de una sola línea",
    "Every React Query hook that wants live sync gets it with a single line. ":
      "Cada hook de React Query que necesita sincronización en vivo la obtiene con una sola línea. ",
    "subscribes to ": "se suscribe a ",
    ", debounces for 250ms by default (to coalesce bursts during a drag operation), and invalidates the query key. No manual subscribe / unsubscribe lifecycle. No cache mutation logic. The WS stream invalidates; React Query refetches; the UI re-renders.":
      ", aplica un debounce predeterminado de 250 ms para agrupar ráfagas durante una operación de arrastre e invalida la query key. No hay un ciclo manual de subscribe/unsubscribe ni lógica de mutación de caché. El flujo WS invalida, React Query vuelve a consultar y la interfaz se renderiza de nuevo.",
    "useDomainSync — shared live-sync hook across the frontend":
      "useDomainSync: hook compartido de sincronización en vivo en el frontend",
    "Optimistic mutations (card move, card create, column reorder) snapshot the cache, mutate locally, rollback on error, and":
      "Las mutaciones optimistas, como mover o crear una tarjeta y reordenar columnas, guardan un snapshot de la caché, modifican el estado localmente, hacen rollback si ocurre un error y usan",
    " on the same key re-confirms or corrects the optimistic state once the backend commits. Two hooks on the same key — one optimistic, one WS-backed — compose cleanly because both fall through to the same React Query key.":
      " sobre la misma clave para volver a confirmar o corregir el estado optimista cuando el backend hace commit. Dos hooks sobre la misma clave, uno optimista y otro respaldado por WS, se combinan sin conflicto porque ambos convergen en la misma clave de React Query.",
    "The runner uses the same bus": "El runner usa el mismo bus",
    "The Go runner connects to the same WebSocket endpoint with its API key and subscribes to ":
      "El runner de Go se conecta al mismo endpoint WebSocket con su clave de API y se suscribe a ",
    ", and": ", y",
    ", plus ": ", además de ",
    ". Any matching event wakes": ". Cualquier evento coincidente activa",
    ", short-circuiting the default two-minute poll interval. Approval waits are implemented as a subscribe-and-block on a specific approval ID — the runner does not poll for decisions, it sleeps on the WS event and wakes on":
      ", interrumpiendo el intervalo de polling predeterminado de dos minutos. La espera de aprobaciones se implementa como una suscripción con bloqueo sobre un ID de aprobación específico; el runner no consulta decisiones, espera el evento WS y se activa con",
    "The runner drops any event whose ":
      "El runner descarta cualquier evento cuyo ",
    " or": " o",
    " matches itself, to avoid self-trigger loops. The exception is ":
      " coincida consigo mismo, para evitar ciclos de autoactivación. La excepción es ",
    ", which carries ": ", que contiene ",
    " and is the one event a runner should act on only when addressed specifically.":
      " y es el único evento sobre el que un runner debe actuar solo cuando está dirigido específicamente a él.",
    "Cross-instance delivery is not durable delivery":
      "La entrega entre instancias no es una entrega durable",
    "The memory backend is correct only for one instance: a publish reaches local subscribers and nowhere else. The Postgres backend closes that multi-instance visibility gap with LISTEN/NOTIFY, including automatic LISTEN reconnects and thin payloads above Postgres's notification size limit. It is still at-most-once and has no replay. A process failure, full receive queue, or NOTIFY outage can drop cross-instance delivery; local delivery has already happened. Webhooks intentionally ignore remote copies so only the originating instance sends external HTTP. Durable or financially consequential workflows need persisted state, not this notification bus.":
      "El backend memory solo es correcto para una instancia: una publicación llega a los suscriptores locales y a ningún otro lugar. Postgres cierra esa brecha con LISTEN/NOTIFY, reconexión automática y payloads reducidos cuando se supera el límite de notificación. Sigue siendo entrega como máximo una vez y sin replay. Una falla de proceso, una cola llena o una caída de NOTIFY puede perder la entrega entre instancias; la entrega local ya ocurrió. Los webhooks ignoran intencionalmente las copias remotas para que solo la instancia de origen envíe HTTP externo. Los flujos durables o con consecuencias financieras necesitan estado persistido, no este bus.",
    "The event taxonomy itself is documented at":
      "La taxonomía de eventos está documentada en",
    " with every live event, its publishers, its subscribers, and its payload shape. Adding a new event is a three-step process — pick an ":
      " con cada evento activo, sus publicadores, sus suscriptores y la forma de su payload. Agregar un evento nuevo requiere tres pasos: elegir un nombre ",
    " name if the mutation is CRUD-shaped, otherwise define a constant in":
      " si la mutación tiene forma CRUD; de lo contrario, definir una constante en",
    ", publish it from the owning service, and register a frontend consumer. The taxonomy doc is the single authoritative reference for what's on the wire.":
      ", publicarla desde el service responsable y registrar un consumidor en el frontend. El documento de taxonomía es la única referencia oficial de lo que circula por la red.",
  },
  "fractional-indexing": {
    "Columns and cards do not use an integer ":
      "Las columnas y las tarjetas no usan una columna entera ",
    " column. They use a ": " para ordenar. Usan una ",
    ". A new item gets": ". Un elemento nuevo recibe",
    ". Moves compute the midpoint between neighbors. Reordering a card never touches any other row's position — the drag-drop-commit is one ":
      ". Los movimientos calculan el punto medio entre los elementos vecinos. Reordenar una tarjeta nunca modifica la posición de otra fila; la operación de arrastrar, soltar y confirmar se reduce a un solo ",
    " on one row, regardless of how many cards sit above or below.":
      " sobre una sola fila, sin importar cuántas tarjetas haya arriba o abajo.",
    "The algorithm is trivial. The payoff is not: no O(N) reorder updates, no integer renumbering, no write contention when two users drag simultaneously, no drift when an optimistic update collides with a WebSocket-delivered event from another client. The frontend computes positions; the backend just stores the float.":
      "El algoritmo es trivial, pero el beneficio no: no hay actualizaciones O(N) para reordenar, renumeración de enteros, contención de escritura cuando dos personas arrastran al mismo tiempo ni divergencias cuando una actualización optimista coincide con un evento enviado por WebSocket desde otro cliente. El frontend calcula las posiciones; el backend solo almacena el valor de punto flotante.",
    "Why this beats integer renumbering":
      "Por qué esto supera la renumeración de enteros",
    "The naive alternative is a monotonically-increasing integer per column, re-numbered whenever a card moves into position":
      "La alternativa ingenua es usar un entero creciente por columna y volver a numerarlo cada vez que una tarjeta se mueve a la posición",
    ". That implementation has three failure modes. The first is write amplification — dropping a card to the top of a column with 50 cards rewrites 51 rows. The second is lock contention — two concurrent drags in the same column serialize into a ladder of ":
      ". Esa implementación tiene tres modos de falla. El primero es la amplificación de escritura: soltar una tarjeta en la parte superior de una columna con 50 tarjetas reescribe 51 filas. El segundo es la contención de locks: dos movimientos simultáneos en la misma columna se serializan en una secuencia de instrucciones ",
    " statements because each one needs row locks on every card after the insertion point. The third is the ugliest: with optimistic updates, the client's provisional ordering and the server's canonical ordering diverge during the race window, and reconciliation requires either a transactional snapshot or a cache-patch protocol that every consumer has to respect.":
      ", porque cada uno necesita bloquear las filas de todas las tarjetas posteriores al punto de inserción. El tercero es el más problemático: con actualizaciones optimistas, el orden provisional del cliente y el orden canónico del servidor divergen durante la ventana de carrera, y la reconciliación exige un snapshot transaccional o un protocolo de actualización de caché que todos los consumidores deben respetar.",
    "Fractional indexing makes all three disappear. A move is one row, one write. Concurrent moves commute — two operators dropping two different cards at two different midpoints do not touch each other's positions. Optimistic updates reconcile for free because the client's computed midpoint is the same value the server persists, so the WebSocket confirmation is a no-op rather than a patch.":
      "La indexación fraccionaria elimina los tres problemas. Un movimiento representa una fila y una escritura. Los movimientos simultáneos conmutan: dos operadores que sueltan tarjetas diferentes en puntos medios distintos no modifican las posiciones del otro. Las actualizaciones optimistas se reconcilian sin costo adicional porque el punto medio calculado por el cliente es el mismo valor que conserva el servidor, de modo que la confirmación por WebSocket es un no-op y no un patch.",
    "The algorithm": "El algoritmo",
    "Six lines of pure math, living at":
      "Seis líneas de matemática pura, ubicadas en",
    " on the frontend and mirrored at ":
      " en el frontend y reproducidas en ",
    " on the backend for the new-item case. New items go to":
      " en el backend para el caso de un elemento nuevo. Los elementos nuevos reciben ",
    " so sequential appends give numerically spaced positions. Moves take the midpoint of the neighbors on either side of the drop target.":
      " para que las inserciones secuenciales produzcan posiciones numéricamente espaciadas. Los movimientos usan el punto medio entre los elementos vecinos a ambos lados del destino.",
    "calculatePosition — the whole algorithm":
      "calculatePosition: el algoritmo completo",
    "The backend has one short-circuit worth knowing about: when a move's new position is within 1.0 of the current position, the service treats it as a no-op. This matters because":
      "El backend tiene un atajo que conviene conocer: cuando la nueva posición de un movimiento queda a menos de 1.0 de la posición actual, el service lo trata como un no-op. Esto importa porque",
    " occasionally re-fires the move event on drag-end when the pointer has barely moved, and the short-circuit prevents that from thrashing the bus with a meaningless":
      " a veces vuelve a emitir el evento de movimiento al terminar el arrastre cuando el puntero apenas se desplazó, y el atajo evita saturar el bus con un evento",
    " event.": " sin significado.",
    "Where it lives in the code": "Dónde vive en el código",
    "The ": "La columna ",
    " column is a ": " es de tipo ",
    " on both the ": " tanto en los models ",
    " and ": " como ",
    " models. The backend never recomputes positions — it accepts whatever float the client sends, validated against the column's existing positions to ensure it isn't a duplicate within a two-decimal tolerance. Fractional columns need the same treatment: column reordering in the board detail uses the same ":
      ". El backend nunca vuelve a calcular las posiciones: acepta el valor de punto flotante que envía el cliente y lo valida frente a las posiciones existentes en la columna para comprobar que no sea un duplicado dentro de una tolerancia de dos decimales. Las columnas fraccionarias requieren el mismo tratamiento: el reordenamiento de columnas en el detalle del tablero usa el mismo helper ",
    "helper against a column-scoped neighbor pair.":
      " con un par de elementos vecinos limitado a la columna.",
    "Drop-target detection on the frontend uses a three-stage fallback chain from ":
      "La detección del destino en el frontend usa una cadena de fallback de tres etapas: primero ",
    " first, then": ", luego ",
    ", then ": " y finalmente ",
    "restricted to columns. The fallback chain exists because the single-detector shortcuts miss edge cases when a card is dragged over a mostly-empty column (pointer is inside the column but not inside any card's rect). Pairing the fallback chain with fractional indexing gives the UI a feel that is indistinguishable from a desktop kanban app even when two operators are dragging in the same column at the same time.":
      " restringido a las columnas. La cadena de fallback existe porque los atajos con un único detector omiten casos límite cuando una tarjeta se arrastra sobre una columna casi vacía, con el puntero dentro de la columna pero fuera del rectángulo de cualquier tarjeta. Combinar esta cadena con la indexación fraccionaria hace que la interfaz responda como una aplicación kanban de escritorio incluso cuando dos operadores arrastran tarjetas en la misma columna al mismo tiempo.",
    "The worst-case precision story": "El peor caso de precisión",
    "IEEE-754 double-precision floats have finite precision. Every midpoint halves the gap between neighbors. In theory, repeatedly dropping a card between two adjacent cards produces a sequence of positions that trend toward a single representable float, after which the midpoint equals one of the neighbors and the tie-break is arbitrary.":
      "Los valores de punto flotante IEEE-754 de doble precisión tienen precisión finita. Cada punto medio reduce a la mitad la distancia entre los elementos vecinos. En teoría, soltar repetidamente una tarjeta entre dos tarjetas adyacentes produce una secuencia de posiciones que converge hacia un único valor representable; después, el punto medio se iguala a uno de los vecinos y el desempate se vuelve arbitrario.",
    "In practice, the exponent range gives you on the order of 2":
      "En la práctica, el rango del exponente ofrece cerca de 2",
    "bits of mantissa, which is many more bisections than any realistic kanban workload will perform between the same two cards. We have not seen a precision collision in production and the instrumentation that would catch one — a unique constraint per column on the position column — does not exist today. The mitigation, if we ever needed one, is a column-scoped rebalance that rewrites every position as ":
      "bits de mantisa, muchas más bisecciones de las que cualquier carga kanban realista realizará entre las mismas dos tarjetas. No hemos observado una colisión de precisión en producción, y la instrumentación que la detectaría, una restricción única por columna sobre la columna de posición, no existe hoy. La mitigación, si alguna vez fuera necesaria, sería un rebalanceo limitado a la columna que reescriba cada posición como ",
    " once precision has meaningfully degraded. That code does not exist yet because the degradation does not exist yet.":
      " cuando la precisión se haya degradado de forma significativa. Ese código todavía no existe porque esa degradación todavía no ha ocurrido.",
    "Fractional indexing is not rebalance-free forever":
      "La indexación fraccionaria no evita el rebalanceo para siempre",
    "The algorithm is not a perpetual-motion machine. It spreads the amortized cost of reordering across many operations instead of doing one expensive renumber up front, and the constant factors make it feel free — but the worst case is real. A workload that repeatedly drops a card into the same gap will eventually run out of float precision and need a rebalance pass. We have not built that pass because we have not needed it. If you find yourself looking at identical":
      "El algoritmo no es una máquina de movimiento perpetuo. Distribuye el costo amortizado del reordenamiento entre muchas operaciones en lugar de hacer una renumeración costosa desde el principio, y los factores constantes hacen que parezca gratuito; sin embargo, el peor caso es real. Una carga que suelta repetidamente una tarjeta en el mismo espacio terminará agotando la precisión de punto flotante y necesitará un proceso de rebalanceo. No lo hemos creado porque no ha sido necesario. Si encuentras valores ",
    " values on two different cards in the same column, that is the signal.":
      " idénticos en dos tarjetas distintas de la misma columna, esa es la señal.",
    "Fractional indexing is one of those design choices that is load bearing in a way that only becomes obvious when you try to imagine the integer-ordered version. Two operators moving cards on the same board at the same time with optimistic updates and real-time WS reconciliation would not survive the naive approach. The six-line function in ":
      "La indexación fraccionaria es una de esas decisiones de diseño esenciales cuyo valor solo resulta evidente al imaginar la versión ordenada con enteros. Dos operadores moviendo tarjetas en el mismo tablero al mismo tiempo, con actualizaciones optimistas y reconciliación WS en tiempo real, no funcionarían de manera confiable con el enfoque ingenuo. La función de seis líneas en ",
    " is what makes the kanban surface tolerate concurrent human and runner drag-drop traffic without gymnastics at any other layer.":
      " es lo que permite que la superficie kanban tolere acciones simultáneas de arrastrar y soltar realizadas por personas y runners sin exigir soluciones complejas en ninguna otra capa.",
  },
  idempotency: {
    "Create and add endpoints return the existing entity on duplicate instead of raising ":
      "Los endpoints de creación e incorporación devuelven la entidad existente cuando hay un duplicado, en lugar de generar ",
    ". This is a correctness invariant, not a nicety. LLM retries, multi-role pipeline ticks, and frontend double-clicks all depend on it. An \"already exists\" result is a success, not an error — the requested end state is reached, regardless of how many times the request arrived.":
      ". Esta es una garantía de corrección, no una cortesía. Los reintentos de los LLMs, los ciclos de pipelines con varios roles y los dobles clics en el frontend dependen de ella. Un resultado de \"ya existe\" es un éxito, no un error: se alcanzó el estado final solicitado, sin importar cuántas veces llegó la solicitud.",
    "This principle is one of the things the platform gets asked about most by engineers who haven't spent time inside the system. It looks like a REST convention violation. It is not. When the primary operator of your API is a retry-happy LLM that will re-issue a request on any transient failure — network timeout, rate limit, partial response truncation — a 409 on the second call costs a tick and a token bill with no added information. The request succeeded the first time. The only correct behavior is to acknowledge the successful state.":
      "Este principio es uno de los temas que más consultan los ingenieros que todavía no conocen el sistema. Puede parecer una infracción de las convenciones REST. No lo es. Cuando el operador principal de tu API es un LLM propenso a repetir una solicitud ante cualquier falla transitoria, como un timeout de red, un rate limit o una respuesta parcialmente truncada, un 409 en la segunda llamada consume un ciclo y genera un costo de tokens sin aportar información. La solicitud funcionó la primera vez. El único comportamiento correcto es reconocer el estado exitoso.",
    "The pattern": "El patrón",
    "Every idempotent create in the service layer follows the same shape. Check for the existing entity by its business-unique key. If present, return it. Otherwise create, return the new row. One round-trip to the database in the hit case, two in the miss case. No 409 branch, no retry coordination needed at the caller.":
      "Cada creación idempotente en la capa de service sigue la misma estructura. Busca la entidad existente mediante su clave de negocio única. Si existe, devuélvela. De lo contrario, créala y devuelve el registro nuevo. Un viaje de ida y vuelta a la base de datos cuando se encuentra y dos cuando no. No hay una rama para 409 ni se necesita coordinar reintentos en el cliente.",
    "The idempotent-create pattern, canonical shape":
      "La estructura canónica del patrón de creación idempotente",
    "Where the pattern is applied": "Dónde se aplica el patrón",
    "Every mutation where \"this already exists\" can be spelled as success gets the idempotent treatment. The list is specific, not aspirational:":
      "Cada mutación en la que \"esto ya existe\" puede interpretarse como éxito recibe un tratamiento idempotente. La lista es concreta, no aspiracional:",
    "Workspace create.": "Creación de un espacio de trabajo.",
    " — idempotent on slug for members of the existing workspace, who get it back unchanged. A non-member colliding on a taken slug gets an opaque 409 that leaks no workspace metadata.":
      ": idempotente respecto del slug para los miembros del espacio de trabajo existente, que lo reciben de vuelta sin cambios. Quien no es miembro y colisiona con un slug ocupado recibe un 409 opaco que no filtra ningún metadato del espacio de trabajo.",
    "Board create.": "Creación de un tablero.",
    " — idempotent on": ": idempotente respecto de ",
    "Card create via slug.": "Creación de una tarjeta mediante slug.",
    " Cards posted with an explicit slug reconcile against the existing row if present.":
      " Las tarjetas enviadas con un slug explícito se reconcilian con el registro existente, si lo hay.",
    "Add participant.": "Incorporación de un participante.",
    " — returns the card unchanged if the user is already a participant in that role.":
      ": devuelve la tarjeta sin cambios si el usuario ya participa con ese rol.",
    "Add workspace member.": "Incorporación de un miembro al espacio de trabajo.",
    " — returns the existing membership on duplicate.":
      ": devuelve la membresía existente cuando hay un duplicado.",
    "Create team.": "Creación de un equipo.",
    " — idempotent on slug within the workspace.":
      ": idempotente respecto del slug dentro del espacio de trabajo.",
    "Add team member.": "Incorporación de un miembro al equipo.",
    " Repeating an add overwrites the role list rather than conflicting.":
      " Repetir la incorporación reemplaza la lista de roles en lugar de generar un conflicto.",
    "Create prompt config.": "Creación de una configuración de prompt.",
    " — idempotent on the full scope tuple":
      ": idempotente respecto de la tupla completa de alcance ",
    "Agent registration.": "Registro de un agente.",
    ". Also reactivates soft-deleted runners.":
      ". También reactiva runners eliminados de forma lógica.",
    "Where it is deliberately not idempotent":
      "Dónde no es idempotente de forma intencional",
    "Three mutations refuse the idempotent treatment because the second caller is reporting a visible race that should fail loudly, not quietly.":
      "Tres mutaciones no reciben tratamiento idempotente porque la segunda llamada informa una condición de carrera visible que debe fallar de manera explícita, no silenciosa.",
    "Claim card.": "Tomar una tarjeta.",
    " issues": " ejecuta ",
    ", refuses the claim if a hero participant already exists, returns":
      ", rechaza la toma si ya existe un participante hero y devuelve ",
    ". A second claim is two runners racing for the same card — the loser needs to know it lost, not silently believe it won.":
      ". Una segunda toma representa a dos runners compitiendo por la misma tarjeta; quien pierde debe saberlo, no creer silenciosamente que ganó.",
    "Hero reassign via add_participant.":
      "Reasignación del responsable principal mediante add_participant.",
    " Adding a non-hero participant to a card with an existing hero is fine. Adding a ":
      " Se puede agregar un participante que no sea hero a una tarjeta que ya tenga uno. Agregar otro ",
    hero: "responsable principal",
    " to a card that already has a different hero returns ":
      " a una tarjeta que ya tiene otro responsable principal devuelve ",
    ". Silently re-hosting the card would break every downstream consumer reading ":
      ". Cambiar silenciosamente al responsable de la tarjeta rompería todos los consumidores posteriores que leen ",
    "Approval decide.": "Decisión de aprobación.",
    " — re-deciding a non-pending approval returns 409. The terminal state transitions":
      ": volver a decidir una aprobación que no está pendiente devuelve 409. Las transiciones a estados finales ",
    ") are one-way. A second decision means two humans both thought they were the decider and one of them needs to see the original verdict.":
      ") son unidireccionales. Una segunda decisión significa que dos personas creían tener la responsabilidad de decidir, y una de ellas debe ver el veredicto original.",
    "The incident that anchored the rule":
      "El incidente que estableció la regla",
    "The idempotency principle has a specific origin: ST#3. A reviewer role was getting ":
      "El principio de idempotencia tiene un origen concreto: ST#3. Un rol de revisor recibía ",
    " on re-adding itself as a card participant from a subsequent pipeline tick. Each 409 ate a tick. Across a full smoke run, the reviewer burned tokens to repeatedly rediscover that it was already on the card. The fix was not \"add better retry logic at the caller\" — the caller is an LLM, it already retries. The fix was \"return the existing participant with a 200.\" Three hundred lines of runner-side retry coordination dissolved.":
      " al volver a incorporarse como participante de una tarjeta en un ciclo posterior del pipeline. Cada 409 consumía un ciclo. Durante un smoke test completo, el revisor gastaba tokens redescubriendo una y otra vez que ya estaba en la tarjeta. La solución no fue \"agregar una lógica de reintentos mejor en el cliente\"; el cliente es un LLM y ya reintenta. La solución fue \"devolver el participante existente con un 200\". Trescientas líneas de coordinación de reintentos en el runner dejaron de ser necesarias.",
    "Every idempotent endpoint since ST#3 has been written with that incident in mind. When a design review asks \"should this 409 or return the existing row?\" the answer is almost always the latter, and when it is the former — claim, hero reassign, approval decide — the reason is articulated in the service method's docstring.":
      "Desde ST#3, cada endpoint idempotente se escribe teniendo presente ese incidente. Cuando una revisión de diseño pregunta \"¿esto debe devolver 409 o el registro existente?\", la respuesta casi siempre es la segunda opción. Cuando es la primera, en los casos de toma, reasignación del hero o decisión de aprobación, la razón se explica en la docstring del método del service.",
    "A few stragglers are on cleanup":
      "Algunos casos pendientes están en proceso de limpieza",
    "Not every mutation the platform ships today honors the rule. Audit findings surface the occasional service path that still raises 409 when the caller would be better served by the existing row. ":
      "No todas las mutaciones que ofrece hoy la plataforma respetan la regla. Las auditorías a veces detectan un flujo de service que todavía genera 409 cuando sería mejor devolver al cliente el registro existente. ",
    " on the MCP side, specifically, does a pre-GET to detect duplicates rather than leaning on the backend contract — which is deliberately member-scoped: a member retrying a taken slug gets the existing workspace back, while a stranger gets an opaque 409 so slug collisions cannot harvest workspace metadata. Every new endpoint review includes the \"is this idempotent, or is there a principled reason it isn't?\" question on the checklist. Ask us how we know.":
      " en el lado MCP, en particular, hace un pre-GET para detectar duplicados en lugar de apoyarse en el contrato del backend, que es deliberadamente por membresía: un miembro que reintenta un slug ocupado recibe de vuelta el espacio de trabajo existente, mientras que un desconocido recibe un 409 opaco para que las colisiones de slug no sirvan para cosechar metadatos de espacios de trabajo. Cada revisión de un endpoint nuevo incluye en su checklist la pregunta \"¿esto es idempotente o existe una razón fundamentada para que no lo sea?\". Lo sabemos por experiencia.",
    "What this buys you": "Qué aporta esta regla",
    "The observable effect of this rule is that an LLM retry loop does not compound. When a runner re-issues the same":
      "El efecto observable de esta regla es que un ciclo de reintentos de un LLM no se multiplica. Cuando un runner repite la misma operación ",
    " from four pipeline stages — because each stage independently decides it needs to be on the card — the cost is four cheap 200s instead of three 409s followed by bespoke error handling. When the frontend double-posts a card create because a user double-clicked the button, the second post returns the first card's row and the UI renders a single card rather than an error toast. When a webhook redelivery fires the same":
      " desde cuatro etapas del pipeline, porque cada una decide de forma independiente que debe participar en la tarjeta, el costo es de cuatro respuestas 200 económicas en lugar de tres respuestas 409 seguidas de un manejo de errores específico. Cuando el frontend envía dos veces la creación de una tarjeta porque una persona hizo doble clic en el botón, el segundo envío devuelve el registro de la primera tarjeta y la interfaz muestra una sola tarjeta en lugar de una notificación de error. Cuando la reentrega de un webhook activa dos veces la misma operación ",
    " twice, the team exists exactly once.":
      ", el equipo existe exactamente una vez.",
    "None of these are large individually. Multiplied across every mutation an agentic platform executes, they are the difference between a system that tolerates its operators and one that fights them.":
      "Ninguno de estos casos es grande por sí solo. Multiplicados por cada mutación que ejecuta una plataforma de agentes, marcan la diferencia entre un sistema que tolera a sus operadores y uno que lucha contra ellos.",
  },
  "platform-authority-principle": {
    "The backend is the single source of truth for pipeline shape and prompts. The runner fetches both at startup and refuses to start when the backend hasn't authored them. The runner does not carry a compiled-in default pipeline that runs when the platform is silent. The platform owns identity and behavior; the runner owns execution.":
      "El backend es la única fuente de verdad para la estructura del pipeline y los prompts. El runner obtiene ambos al iniciar y se niega a hacerlo cuando el backend no los ha definido. El runner no incluye un pipeline predeterminado compilado que se ejecute cuando la plataforma no entrega una configuración. La plataforma controla la identidad y el comportamiento; el runner controla la ejecución.",
    "This is the hardest principle to appreciate from outside the system, because it looks like an overreaction. \"Why not just let the runner default to a sensible pipeline if the platform returns nothing?\" That question has a specific answer grounded in a specific incident, and it is worth stating it plainly: defaults at the client level hide platform bugs. Defaults at the platform level are legitimate. The distinction is load-bearing.":
      "Este es el principio más difícil de comprender desde fuera del sistema porque puede parecer una reacción exagerada. \"¿Por qué no dejar que el runner use un pipeline predeterminado razonable si la plataforma no devuelve nada?\" La pregunta tiene una respuesta concreta basada en un incidente específico y conviene expresarla con claridad: los valores predeterminados en el cliente ocultan bugs de la plataforma. Los valores predeterminados en la plataforma son legítimos. La diferencia es esencial.",
    "What this means in practice": "Qué significa esto en la práctica",
    "On every boot, the Go runner calls":
      "En cada inicio, el runner de Go llama a ",
    ". The response is expected to carry a non-empty ":
      ". Se espera que la respuesta incluya un ",
    " with a non-empty ": " no vacío, con un array ",
    " array. If either is missing, the runner logs a clear error and exits — it does not fall back to a built-in pipeline, it does not pick a reasonable default, it refuses to operate. On every tick, the runner re-fetches the config and re-applies platform authority: roles whose prompts have been removed are dropped from the live scheduler without a restart. Authoring a new prompt in the UI restores the role on the next refresh.":
      " no vacío. Si falta cualquiera de los dos, el runner registra un error claro y se cierra: no recurre a un pipeline incorporado, no elige un valor predeterminado razonable, se niega a operar. En cada ciclo, el runner vuelve a obtener la configuración y reaplica la autoridad de la plataforma; los roles cuyos prompts se eliminaron salen del planificador activo sin reiniciar. Crear un prompt nuevo en la interfaz restaura el rol en la siguiente actualización.",
    "Prompts follow the same rule. Every stage declares its prompt source from the platform's prompt registry, synthesis layer, or an operator-authored override. The runner prefers":
      "Los prompts siguen la misma regla. Cada etapa declara la fuente de su prompt desde el registro de prompts de la plataforma, la capa de síntesis o un reemplazo creado por el operador. El runner prioriza ",
    " (backend-assembled, with the post-process imperative spliced in) over raw":
      ", ensamblado por el backend con la instrucción obligatoria de posproceso insertada, en lugar de ",
    " — so operator edits on synthesized placeholders retain the platform-owned imperative text. A stage with no prompt in the cache returns":
      " sin procesar. Así, las ediciones del operador sobre contenidos sintetizados conservan el texto obligatorio controlado por la plataforma. Una etapa sin prompt en la caché devuelve ",
    " rather than executing against a compiled-in template.":
      " en lugar de ejecutarse con un template compilado.",
    "The ST#8 anchor incident": "El incidente de referencia ST#8",
    "The principle has an origin. ST#8 silently shipped a three-role hardcoded pipeline over a five-role platform pipeline. The backend was configured correctly. The runner ignored it, because the runner carried a compiled-in default that won the race when the authoritative fetch was slower than the first tick of the scheduler. Operators saw the three-role behavior and assumed the platform was misconfigured. The platform was not misconfigured. The runner was.":
      "El principio tiene un origen. En ST#8 se ejecutó silenciosamente un pipeline fijo de tres roles en lugar del pipeline de cinco roles definido en la plataforma. El backend estaba configurado correctamente. El runner lo ignoró porque incluía un valor predeterminado compilado que ganó la carrera cuando la obtención de la configuración oficial fue más lenta que el primer ciclo del planificador. Los operadores vieron el comportamiento de tres roles y supusieron que la plataforma estaba mal configurada. La plataforma no lo estaba. El runner sí.",
    "The fix was not \"add better defaults.\" The fix was \"refuse to operate on stale authority.\" The runner now blocks startup on the platform config, and the scheduler re-applies platform authority every tick. The compiled-in defaults that won ST#8 are being removed one by one. The principle is what the fix crystallized: defaults and fallbacks are legitimate at the platform level; they are a bug at the client level.":
      "La solución no fue \"agregar mejores valores predeterminados\". Fue \"negarse a operar con una autoridad desactualizada\". Ahora el runner bloquea el inicio hasta recibir la configuración de la plataforma y el planificador reaplica la autoridad de la plataforma en cada ciclo. Los valores predeterminados compilados que prevalecieron en ST#8 se están eliminando uno por uno. La solución consolidó el principio: los valores predeterminados y fallbacks son legítimos en la plataforma; en el cliente son un bug.",
    "The refuse-to-start check in Loop.New":
      "La comprobación que impide el inicio en Loop.New",
    "What the principle buys for extensibility":
      "Qué aporta el principio a la extensibilidad",
    "Because the runner does not have a compiled-in picture of what roles exist, an operator can author a role named":
      "Como el runner no tiene una representación compilada de los roles que existen, un operador puede crear un rol llamado ",
    " in the UI and the runner picks it up on the next poll without a single Go file changing. If the operator removes a role, the scheduler drops it without a restart. The 2026-04-18 runner-launch walkthrough confirmed this end-to-end: a custom ":
      " en la interfaz y el runner lo incorpora en la siguiente consulta sin cambiar un solo archivo de Go. Si el operador elimina un rol, el planificador lo retira sin reiniciar. El recorrido de inicio del runner del 18 de abril de 2026 confirmó este comportamiento de extremo a extremo: un rol personalizado ",
    " role ran through the full pipeline lifecycle, never having existed in the runner binary's type system.":
      " recorrió todo el ciclo de vida del pipeline sin haber existido nunca en el sistema de tipos del binario del runner.",
    "The corollary is that extensibility is not a separate feature. It is a consequence of the runner being thin. Every time the runner gains a hardcoded notion of what a role means — what column type to target, what git action to take, what post-process kind to run — that is a regression against extensibility, and it's a regression against platform authority, and they are the same thing.":
      "La consecuencia es que la extensibilidad no es una función separada. Es el resultado de que el runner sea ligero. Cada vez que el runner incorpora una idea fija de lo que significa un rol, como qué tipo de columna usar, qué acción git ejecutar o qué tipo de posproceso aplicar, se produce una regresión contra la extensibilidad y contra la autoridad de la plataforma. Ambas son la misma cosa.",
    "What is still left to clean up": "Qué queda por limpiar",
    "The principle is articulated and the runtime hot path is clean. A handful of residual hardcoded fallbacks survive in the Go runner and violate the principle in spirit, even though they do not fire on the critical path:":
      "El principio está definido y el camino crítico del runtime está limpio. Algunos fallbacks fijos todavía sobreviven en el runner de Go y contradicen el principio, aunque no se activen en el camino crítico:",
    "Column-type string fallbacks":
      "Fallbacks de cadenas de tipos de columna",
    " and ": " y ",
    " each carry a handful of hardcoded column-type strings (":
      " todavía contienen algunas cadenas fijas de tipos de columna, como ",
    ") used when the corresponding ": ", que se usan cuando el campo ",
    " field is empty. Operator mistakes that omit the field land on a legacy default instead of surfacing the omission.":
      " correspondiente está vacío. Los errores del operador que omiten ese campo recurren a un valor predeterminado heredado en lugar de mostrar la omisión.",
    " in validation paths": " en los flujos de validación",
    "still carries a full hardcoded three-role default. It is dead on the runtime hot path (the boot check refuses to start without a platform config), but":
      "todavía contiene un valor predeterminado fijo completo de tres roles. No se usa en el camino crítico del runtime, porque la comprobación de inicio se niega a operar sin una configuración de la plataforma, pero ",
    " still references it for validation — so validation output can disagree with refusal-to-start behavior. This is the cleanup that would close the principle loop.":
      " todavía lo referencia para la validación. Por eso, el resultado de la validación puede diferir del comportamiento que impide el inicio. Esta limpieza cerraría el ciclo del principio.",
    "Role literals in execution logging":
      "Literales de rol en el registro de ejecuciones",
    " is literally hardcoded at two call sites on the hero path, so every hero-driven execution records":
      " está literalmente fijado en dos puntos de llamada del flujo de hero, de modo que cada ejecución impulsada por el hero registra ",
    " even when a custom researcher or planner drove it. Purely a reporting bug — the execution ran correctly, the execution row misattributes.":
      " incluso cuando la condujo un rol personalizado de investigador o planificador. Es solo un bug de registro: la ejecución ocurrió correctamente, pero el registro la atribuye mal.",
    "Scheduling and git defaults":
      "Valores predeterminados de planificación y git",
    " that historically leaked operator-set values the platform should own — backoff seconds, ":
      " que históricamente dejaban escapar valores definidos por el operador que debería controlar la plataforma, como segundos de backoff, ",
    ", commit-message templates, branch prefixes. Recent refactors tightened most of these by leaving the runner-side field empty and treating any non-zero platform value as authoritative; a couple of shadow defaults still exist and are tracked for removal.":
      ", templates de mensajes de commit y prefijos de rama. Refactorizaciones recientes corrigieron la mayoría de estos casos al dejar vacío el campo del runner y tratar como oficial cualquier valor distinto de cero de la plataforma; todavía existen algunos valores predeterminados ocultos que están previstos para eliminarse.",
    "Residual fallbacks are maintenance liability, not runtime bugs":
      "Los fallbacks residuales son una carga de mantenimiento, no bugs del runtime",
    "None of the residuals above fire on the runtime hot path. The runner will refuse to start without a platform pipeline. The scheduler will drop a role whose prompt has disappeared. The compiled-in three-role default is reachable only from validation paths that ultimately get overridden by the boot check. The concern is maintenance: every shadow default is a place where the code has two opinions about what should happen, and when the platform evolves, keeping them in sync is continuous work that should instead be zero work. The fix is to delete the shadows outright, which we are doing one batch at a time rather than all at once because each deletion reads against several tests.":
      "Ninguno de los casos anteriores se activa en el camino crítico del runtime. El runner se negará a iniciar sin un pipeline de la plataforma. El planificador retirará un rol cuyo prompt haya desaparecido. El valor predeterminado compilado de tres roles solo es accesible desde flujos de validación que finalmente quedan anulados por la comprobación de inicio. El problema es de mantenimiento: cada valor predeterminado oculto es un lugar donde el código tiene dos opiniones sobre lo que debe ocurrir y, cuando la plataforma evoluciona, mantenerlas sincronizadas exige un trabajo continuo que debería ser inexistente. La solución es eliminar esos valores por completo, algo que hacemos por lotes y no de una sola vez porque cada eliminación afecta varias pruebas.",
    "The final cleanup is tied to the LLM abstraction milestone":
      "La limpieza final está vinculada al hito de abstracción de LLM",
    "The residual fallbacks cluster around two themes: role-specific behavior and model-specific behavior. Both of those themes are exactly what the LLM abstraction milestone dissolves. Once per-role provider and model are first-class platform config, the pre-abstraction heuristics that currently justify some of the Go hardcodes (the self-review guard, the hero-path role literal, the reviewer-specific branch logic) become unnecessary. The cleanup is scheduled to ride in with that milestone rather than land as its own sprint. Tracked in":
      "Los fallbacks residuales se concentran en dos temas: el comportamiento específico de roles y el comportamiento específico de modelos. El hito de abstracción de LLM elimina precisamente ambos. Cuando el proveedor y el modelo por rol sean configuraciones de primera clase de la plataforma, las heurísticas anteriores a la abstracción que hoy justifican algunos valores fijos en Go, como la protección contra autorrevisión, el literal de rol en el flujo de hero y la lógica de rama específica del revisor, dejarán de ser necesarias. La limpieza está prevista junto con ese hito y no como un sprint separado. Registrado en ",
    "The principle is short to state. The discipline is long to maintain. Every design review asks whether the proposed change adds a client-side fallback, and if so, why the platform is the wrong place for it. The answer is usually \"the platform is the right place for it.\" The answer is never \"defaults at both layers are fine.\"":
      "El principio es breve de enunciar, pero la disciplina requiere mantenimiento continuo. Cada revisión de diseño pregunta si el cambio propuesto agrega un fallback en el cliente y, si es así, por qué la plataforma sería el lugar equivocado. La respuesta suele ser \"la plataforma es el lugar correcto\". La respuesta nunca es \"los valores predeterminados en ambas capas están bien\".",
  },
  "model-agnostic-roles": {
    "The north star is per-role ":
      "La dirección declarada es tener, para cada rol, ",
    " and": " y ",
    ". Implementer on Sonnet for speed and cost. Reviewer on GPT-5 because a different model is a different reviewer. Documentator on Gemini because its context window fits a whole codebase. All three roles driven by the same runner, against the same card, from the same pipeline config. This is the declared target and it is on the backlog, not on trunk.":
      ". Implementador en Sonnet por velocidad y costo. Revisor en GPT-5 porque un modelo diferente es un revisor diferente. Responsable de documentación en Gemini porque su ventana de contexto admite una base de código completa. Los tres roles son ejecutados por el mismo runner, sobre la misma tarjeta y desde la misma configuración de pipeline. Ese es el objetivo declarado y está en el backlog, no en trunk.",
    "This page documents what is wired today, what the target shape looks like, and what it will take to get there. It is one of the few pages in this documentation where a future state is load bearing enough to deserve its own section — everything on the platform flows through the LLM runner, and the runner being model-locked today bounds what the platform can ship tomorrow.":
      "Esta página documenta qué está implementado hoy, cómo es la estructura objetivo y qué hará falta para alcanzarla. Es una de las pocas páginas de esta documentación donde un estado futuro es tan importante que merece una sección propia: todo en la plataforma pasa por el runner de LLM, y el hecho de que hoy esté limitado a un modelo restringe lo que la plataforma podrá entregar mañana.",
    "Why role independence implies model independence":
      "Por qué la independencia de roles implica independencia de modelos",
    "Role extensibility without model extensibility is a half-answer. An operator can declare a ":
      "La extensibilidad de roles sin extensibilidad de modelos es una respuesta incompleta. Un operador puede declarar un rol ",
    " role and the platform will dispatch cards to it — the runtime hot path and the prompt synthesis both handle arbitrary roles. What the operator cannot do today is say \"the security auditor runs on a different model than the implementer.\" The auditor inherits the runner's single LLM config. Every role routes through the same Claude CLI subprocess against the same model string, and":
      " y la plataforma le enviará tarjetas; tanto el camino crítico del runtime como la síntesis de prompts admiten roles arbitrarios. Lo que el operador no puede hacer hoy es decir \"el auditor de seguridad usa un modelo distinto del implementador\". El auditor hereda la única configuración de LLM del runner. Todos los roles pasan por el mismo subproceso de Claude CLI con la misma cadena de modelo, y ",
    " is keyed by pipeline": " usa como clave la ",
    phase: "fase",
    ", not ": ", no el ",
    role: "rol",
    " — the runner can vary which model it uses for ":
      ". El runner puede variar el modelo que usa en ",
    " versus": " frente a ",
    ", but not which model a custom":
      ", pero no el modelo que usa un rol personalizado de ",
    analyst: "analista",
    " uses at the same phase.": " en la misma fase.",
    "The practical consequences are immediate. You cannot run a mixed-provider quorum reviewer. You cannot send the cost-sensitive drafting role to a cheap model and the precision-sensitive review role to an expensive one. You cannot experiment with \"does GPT-5 review Sonnet's output better than Opus reviews Sonnet's output\" without standing up two runners. The data model supports the distinction in principle; the runtime does not implement it yet.":
      "Las consecuencias prácticas son inmediatas. No puedes ejecutar una revisión por quórum con varios proveedores. No puedes enviar el rol de redacción sensible al costo a un modelo económico y el rol de revisión sensible a la precisión a uno costoso. Tampoco puedes experimentar con \"¿GPT-5 revisa mejor la salida de Sonnet que Opus?\" sin iniciar dos runners. El modelo de datos admite la distinción en principio; el runtime todavía no la implementa.",
    "What is wired today": "Qué está implementado hoy",
    "A single ": "Un único ",
    " lives on the runner's YAML at": " vive en el YAML del runner en ",
    ". It carries a provider string, a default model, optional per-phase overrides, and credentials. All routes flow through":
      ". Contiene una cadena de proveedor, un modelo predeterminado, reemplazos opcionales por fase y credenciales. Todos los flujos pasan por ",
    ", which spawns": ", que inicia ",
    " as a subprocess. The": " como subproceso. La variable de entorno ",
    " environment variable is deliberately stripped from the subprocess so Claude Code Max (OAuth/subscription) wins unless the operator sets an explicit key in config.":
      " se elimina deliberadamente del subproceso para priorizar Claude Code Max, mediante OAuth o suscripción, salvo que el operador defina una clave explícita en la configuración.",
    "The pipeline config DSL has ":
      "La DSL de configuración del pipeline ya tiene bloques ",
    " blocks per stage already — they declare the stage name, the tools allowlist, the post-process kind, and the directives. What they do ":
      " por etapa. Declaran el nombre de la etapa, la allowlist de herramientas, el tipo de posproceso y las directivas. Lo que ",
    not: "no ",
    "declare today is a provider or a model. The fields are not in the schema. Adding them is a schema change; making them take effect is the rest of the work.":
      "declaran hoy es un proveedor o un modelo. Los campos no están en el esquema. Agregarlos requiere un cambio de esquema; hacer que tengan efecto constituye el resto del trabajo.",
    "The target shape": "La estructura objetivo",
    "Per-role, per-stage ": "Configuración ",
    " configuration on the pipeline config itself. Credentials stored at the workspace level and resolved by the runner at stage dispatch time. A provider abstraction in Go that dispatches to Anthropic, OpenAI, or Google from the same call site without the runner caring which it lands on. Prompt caching normalized across providers. Tool-call normalization so an MCP tool behaves the same whether the model underneath speaks Anthropic's tool-use format or OpenAI's function-call format.":
      " por rol y por etapa en la propia configuración del pipeline. Credenciales almacenadas a nivel del espacio de trabajo y resueltas por el runner al enviar la etapa. Una abstracción de proveedores en Go que envíe a Anthropic, OpenAI o Google desde el mismo punto de llamada sin que el runner necesite conocer el destino. Caché de prompts normalizada entre proveedores. Normalización de llamadas a herramientas para que una herramienta MCP se comporte igual si el modelo subyacente usa el formato tool-use de Anthropic o function-call de OpenAI.",
    "The target pipeline_config llm block (not yet wired)":
      "El bloque llm objetivo de pipeline_config, todavía no implementado",
    "What it will take": "Qué hará falta",
    "The work breaks into five threads. None are individually hard. Together they are the LLM abstraction milestone.":
      "El trabajo se divide en cinco líneas. Ninguna es difícil por sí sola. Juntas forman el hito de abstracción de LLM.",
    "Credential storage at the workspace level.":
      "Almacenamiento de credenciales a nivel del espacio de trabajo.",
    " A workspace can hold references to Anthropic, OpenAI, and Google credentials, encrypted at rest. The runner resolves the ":
      " Un espacio de trabajo puede almacenar referencias a credenciales de Anthropic, OpenAI y Google, cifradas en reposo. El runner resuelve ",
    " on stage dispatch. Per-role credentials compose with workspace budgets for per-provider spend tracking.":
      " al enviar la etapa. Las credenciales por rol se combinan con los presupuestos del espacio de trabajo para seguir el gasto por proveedor.",
    "Provider interface in Go.": "Interfaz de proveedor en Go.",
    " A": " Una interfaz ",
    " interface with implementations for Anthropic CLI, Anthropic SDK, OpenAI, and Google Generative AI. The runner dispatches to the right one based on the stage's ":
      " con implementaciones para Anthropic CLI, Anthropic SDK, OpenAI y Google Generative AI. El runner elige la adecuada según el ",
    ". The existing Claude CLI path becomes one provider among several.":
      " de la etapa. El flujo existente de Claude CLI se convierte en un proveedor entre varios.",
    "Prompt caching normalization.": "Normalización de la caché de prompts.",
    " Anthropic's ephemeral-cache-control blocks and OpenAI's prompt-caching semantics do not map one-to-one. The runner needs a cache abstraction that accepts the platform's prompt parts and emits provider-appropriate cache controls.":
      " Los bloques ephemeral-cache-control de Anthropic y la semántica de caché de prompts de OpenAI no tienen una correspondencia directa. El runner necesita una abstracción de caché que reciba las partes del prompt definidas por la plataforma y genere controles adecuados para cada proveedor.",
    "Tool-call format normalization.":
      "Normalización del formato de llamadas a herramientas.",
    " The MCP server speaks the tool-call protocol every major host supports, but the subprocess-level formats differ. Whatever wrapper the Go runner uses has to translate the provider's tool-use frames into MCP calls transparently.":
      " El servidor MCP usa el protocolo de llamadas a herramientas que admiten todos los hosts principales, pero los formatos a nivel de subproceso difieren. El wrapper que use el runner de Go debe traducir de forma transparente los frames tool-use del proveedor a llamadas MCP.",
    "Self-review guard removal.":
      "Eliminación de la protección contra autorrevisión.",
    " The hardcoded": " La comprobación fija ",
    " check in the runner that prevents a runner from reviewing its own work is a pre-abstraction heuristic. Once models can differ per role, \"this runner reviewed its own work\" is no longer a concern — the reviewer is a different model with a different persona, and the same physical process being involved stops mattering.":
      " del runner, que impide que un runner revise su propio trabajo, es una heurística anterior a la abstracción. Cuando los modelos puedan variar por rol, \"este runner revisó su propio trabajo\" dejará de ser una preocupación: el revisor será un modelo diferente con un perfil diferente, y dejará de importar que participe el mismo proceso físico.",
    "Why this isn't already done": "Por qué todavía no está listo",
    "Two reasons. The first is that single-provider operation has been the short path to proving everything else. Role extensibility, prompt synthesis, platform authority, pipeline DSL, post-process imperatives — all of these had to land and stabilize before the multi-provider story was worth the churn. The second is that prompt caching is a meaningful part of what keeps runner costs tractable, and building the caching layer for one provider well is easier than building it for three provisionally.":
      "Hay dos razones. La primera es que operar con un único proveedor fue la vía más corta para validar todo lo demás. La extensibilidad de roles, la síntesis de prompts, la autoridad de la plataforma, la DSL de pipelines y las instrucciones obligatorias de posproceso debían implementarse y estabilizarse antes de que valiera la pena introducir varios proveedores. La segunda es que la caché de prompts es una parte importante de lo que mantiene manejables los costos del runner, y construir bien la capa de caché para un proveedor es más sencillo que construirla de forma provisional para tres.",
    "Neither reason survives indefinitely. The single-provider scaffolding has stabilized — the runtime hot path is clean, the extensibility story is proven in production with custom roles, the audit findings cluster at the boundaries rather than the core. Prompt caching is well enough understood across providers that the normalization layer is a week of work, not a quarter. The LLM abstraction milestone is the next major unit of work rather than the year-out horizon it was when the platform first started.":
      "Ninguna de las dos razones seguirá siendo válida indefinidamente. La base para un solo proveedor se estabilizó: el camino crítico del runtime está limpio, la extensibilidad se comprobó en producción con roles personalizados y los hallazgos de auditoría se concentran en los límites, no en el núcleo. La caché de prompts se comprende lo suficiente entre proveedores como para que la capa de normalización represente una semana de trabajo y no un trimestre. El hito de abstracción de LLM es la próxima gran unidad de trabajo, no el horizonte de un año que era cuando comenzó la plataforma.",
    "The declared north star, explicitly not yet shipped":
      "La dirección declarada, explícitamente todavía no entregada",
    "Per-role model selection is the single largest declared-but- unshipped item on the platform roadmap. The scoping document lives at":
      "La selección de modelo por rol es el mayor elemento declarado pero aún no entregado del roadmap de la plataforma. El documento de alcance se encuentra en ",
    ". The feedback memo at": ". El memorando de comentarios en ",
    "captures the principle: role extensibility without model extensibility is a half-answer. We are taking that seriously rather than quietly. If you are reading this page because you wanted to send your reviewer role to GPT-5 and your implementer to Sonnet — that is the feature we know we owe you. It is not here yet.":
      "recoge el principio: la extensibilidad de roles sin extensibilidad de modelos es una respuesta incompleta. Lo estamos tomando en serio y con transparencia. Si lees esta página porque querías enviar el rol de revisor a GPT-5 y el de implementador a Sonnet, esa es la función que sabemos que debemos ofrecer. Todavía no está disponible.",
    "Every other page in this group documents something that works. This one documents something that should. The distinction is worth the page. When someone asks \"can Backplane run a mixed-model pipeline?\" the honest answer today is no, and the principled answer tomorrow is yes, and the work between here and there is the explicit subject of a scheduled milestone rather than something you have to guess at. That is the kind of honesty documentation is for.":
      "Todas las demás páginas de este grupo documentan algo que funciona. Esta documenta algo que debería funcionar. La diferencia merece una página. Cuando alguien pregunta \"¿Backplane puede ejecutar un pipeline con varios modelos?\", la respuesta honesta hoy es no y la respuesta fundamentada para mañana es sí. El trabajo entre ambos puntos es el tema explícito de un hito planificado, no algo que debas adivinar. Para este tipo de transparencia existe la documentación.",
  },
};
