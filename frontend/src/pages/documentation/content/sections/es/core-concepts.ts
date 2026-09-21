// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_CORE_CONCEPTS = {
  "workspaces-boards-columns-cards": {
    "Backplane nests four containers: a ":
      "Backplane organiza cuatro contenedores en niveles: un ",
    workspace: "espacio de trabajo",
    " holds": " contiene ",
    boards: "tableros",
    ", each board holds ": ", cada tablero contiene ",
    columns: "columnas",
    ", and each column holds ": " y cada columna contiene ",
    cards: "tarjetas",
    ". Every URL in the app starts with ":
      ". Todas las URLs de la aplicación comienzan con ",
    " — the workspace slug is the tenancy boundary. If you don't have a workspace, you don't have anything.":
      ": el slug del espacio de trabajo es el límite de tenancy. Sin un espacio de trabajo, no hay nada.",
    Workspace: "Espacio de trabajo",
    "The workspace is the top-level tenancy unit. It owns boards, members, channels, teams, pipeline config, budgets, API keys, approvals, and activity history. Membership carries one of four roles —":
      "El espacio de trabajo es la unidad principal de tenancy. Contiene tableros, miembros, canales, equipos, configuración de pipeline, presupuestos, claves de API, aprobaciones e historial de actividad. Cada membresía tiene uno de cuatro niveles de acceso: ",
    " — and access to every feature endpoint resolves through a single dependency that checks the slug against the caller's membership.":
      ". El acceso a todos los endpoints funcionales se resuelve mediante una única dependencia que comprueba el slug frente a la membresía de quien hace la llamada.",
    "With ": "Con ",
    ", verified IAP, trusted-proxy, and OIDC callback identities can be provisioned automatically. Local authentication instead uses first-run or administrator-created accounts and does not provide public self-registration. Workspaces themselves are created on demand from the landing page by an authenticated user.":
      ", las identidades verificadas mediante IAP, proxy de confianza y callback de OIDC pueden aprovisionarse automáticamente. La autenticación local utiliza cuentas de primera ejecución o creadas por administradores y no ofrece autorregistro público. Los espacios de trabajo se crean bajo demanda desde la página de inicio por un usuario autenticado.",
    Board: "Tablero",
    "A board is a kanban project. It owns an ordered list of columns and, transitively, every card in those columns. Eight tabs hang off a board: kanban, definitions, resources, notes, history, timeline, git, and alerts. The kanban tab is where drag-and-drop happens; definitions, files, and notes preserve project context; History is the durable event feed; Timeline replays board state; Git binds repositories; and Alerts holds board-scoped rules.":
      "Un tablero es un proyecto kanban. Contiene una lista ordenada de columnas y, por extensión, todas las tarjetas de esas columnas. Del tablero dependen ocho pestañas: kanban, definiciones, recursos, notas, historial, línea de tiempo, git y alertas. La acción de arrastrar y soltar ocurre en kanban; definiciones, archivos y notas conservan el contexto del proyecto; Historial es el flujo duradero de eventos; Línea de tiempo reproduce el estado del tablero; Git vincula repositorios; y Alertas contiene reglas del tablero.",
    "Cards carry a denormalized ": "Las tarjetas contienen un ",
    " alongside their": " desnormalizado además de su ",
    ". It's redundant — you could walk from card to column to board — but it lets board-level queries skip the join.":
      ". Es información redundante, porque se podría recorrer la relación desde la tarjeta hasta la columna y el tablero, pero permite que las consultas a nivel de tablero eviten ese join.",
    "Resources have two navigation scopes. The sidebar's Resources page opens the workspace collection; the board's Resources tab passes that board ID to the same file browser. A frozen board makes its scoped resource view read-only without freezing workspace-wide resources.":
      "Los recursos tienen dos ámbitos de navegación. La página Recursos de la barra lateral abre la colección del espacio de trabajo; la pestaña Recursos de un tablero pasa el ID de ese tablero al mismo explorador de archivos. Un tablero congelado deja su vista de recursos en modo de solo lectura sin congelar los recursos de todo el espacio de trabajo.",
    Column: "Columna",
    "Columns have a human-facing ": "Las columnas tienen un ",
    name: "nombre",
    " and a semantic": " visible para las personas y un ",
    column_type: "column_type",
    ". The types are": ". Los tipos son ",
    ", and ": " y ",
    ". Pipeline stages reference the type, never the name — so a column named \"Review\" and a column named \"Peer Review\" behave identically if they share the":
      ". Las etapas del pipeline hacen referencia al tipo, nunca al nombre. Por eso, una columna llamada \"Review\" y otra llamada \"Peer Review\" se comportan igual si comparten el tipo ",
    " type. The type is what runners match against when discovering work; the name is what humans read on the board.":
      ". El tipo es lo que los runners comparan al buscar trabajo; el nombre es lo que las personas leen en el tablero.",
    "Renaming a column is cosmetic. Retyping it changes behavior.":
      "Cambiar el nombre de una columna es un ajuste cosmético. Cambiar su tipo modifica el comportamiento.",
    "Operators sometimes rename \"Backlog\" to \"Intake\" or \"Triage\" expecting the pipeline to notice. It won't. Runners find cards by column type. If you want the backlog-discovery stage to stop matching that column, change the type — not the name. Ask us how we know.":
      "A veces los operadores cambian el nombre de \"Backlog\" a \"Intake\" o \"Triage\" esperando que el pipeline detecte el cambio. No lo hará. Los runners encuentran tarjetas por el tipo de columna. Si quieres que la etapa de descubrimiento del backlog deje de coincidir con esa columna, cambia el tipo, no el nombre. Pregúntanos cómo lo sabemos.",
    Card: "Tarjeta",
    "Cards are the unit of work. Each has a title, a rich-text description, a ":
      "Las tarjetas son la unidad de trabajo. Cada una tiene un título, una descripción con formato, un ",
    "), a priority, string labels, a status, an optional due date, and a list of":
      "), una prioridad, etiquetas de texto, un estado, una fecha límite opcional y una lista de ",
    participants: "participantes",
    ". A participant is a user or runner attached to the card in one of four roles: ":
      ". Un participante es un usuario o runner vinculado a la tarjeta con uno de cuatro roles: ",
    " (the primary executor), ": " (el responsable principal), ",
    ", or": " u ",
    ". The one-hero-per-card rule lives in the claim service, not as a database constraint — the hero is how runners coordinate \"I've got this one.\"":
      ". La regla de un único hero por tarjeta vive en el servicio de toma, no como una restricción de la base de datos. El hero es la forma en que los runners coordinan el mensaje \"esta tarjeta es mía\".",
    "Fractional positions": "Posiciones fraccionarias",
    "Columns and cards use ": "Las columnas y las tarjetas usan posiciones ",
    " positions instead of integer ordering. A new item gets ":
      " en lugar de un orden basado en números enteros. Un elemento nuevo recibe ",
    "; a move computes the midpoint between its new neighbors. No O(N) reorder updates, no index rebuilds, no races when two users drag at the same time. The frontend computes positions; the backend just stores the number. See":
      "; un movimiento calcula el punto medio entre sus nuevos vecinos. No hay actualizaciones O(N) para reordenar, reconstrucciones de índices ni condiciones de carrera cuando dos personas arrastran elementos al mismo tiempo. El frontend calcula las posiciones; el backend solo almacena el número. Consulta ",
    "Fractional Indexing": "Indexación fraccionaria",
    "under Under the Hood for the full story.":
      " en Funcionamiento interno para ver la explicación completa.",
  },
  runners: {
    "A ": "Un ",
    Runner: "Runner",
    " is the credentialed Go process an operator starts on a laptop, VM, container, or Kubernetes pod. It authenticates with one runner API key, resolves its workspace identity, sends heartbeats, and asks the platform for authoritative configuration. Git, provider CLI, and MCP execution stay on the runner host; the Backplane backend coordinates state and records the audit trail.":
      " es el proceso Go con credenciales que un operador inicia en un computador portátil, una VM, un contenedor o un pod de Kubernetes. Se autentica con una clave de API de runner, resuelve su identidad y espacio de trabajo, envía heartbeats y solicita la configuración autoritativa de la plataforma. Git, el CLI del proveedor y la ejecución de MCP permanecen en el host del runner; el backend de Backplane coordina el estado y registra el rastro de auditoría.",
    "Executable modes": "Modos ejecutables",
    "A bare interactive launch opens the setup wizard. Automation should pass ":
      "Un inicio interactivo sin argumentos abre el asistente de configuración. La automatización debe pasar ",
    " and choose one of these explicit modes:":
      " y elegir uno de estos modos explícitos:",
    "Pipeline mode.": "Modo pipeline.",
    " The default when neither": " Es el modo predeterminado cuando no está presente",
    " nor ": " ni ",
    " is present. It polls for claimable cards and executes the platform-authored pipeline.":
      ". Consulta tarjetas disponibles para tomar y ejecuta el pipeline creado en la plataforma.",
    "Doctor.": "Diagnóstico.",
    " performs read-only diagnostics and never starts an agent session or spends model budget. Add ":
      " ejecuta diagnósticos de solo lectura y nunca inicia una sesión de agente ni consume presupuesto del modelo. Agrega ",
    " only when you explicitly want supported local repairs.":
      " solo cuando quieras aplicar explícitamente reparaciones locales compatibles.",
    "Discovery.": "Descubrimiento.",
    " runs one MCP capability discovery pass and exits.":
      " ejecuta una pasada de descubrimiento de capacidades MCP y termina.",
    "Loop mode.": "Modo Loop.",
    " works one board continuously. ": " trabaja continuamente sobre un tablero. ",
    " selects that board explicitly; otherwise the runner requires one unambiguous configured or platform-bound board.":
      " selecciona ese tablero explícitamente; de lo contrario, el runner requiere un único tablero no ambiguo configurado o vinculado por la plataforma.",
    " is a loop-only runtime override. When present, it takes precedence over ":
      " es un override de ejecución exclusivo de Loop. Cuando está presente, prevalece sobre ",
    " in YAML. The remaining operational flags include ":
      " en YAML. Los demás flags operativos incluyen ",
    ", and": " y",
    "What every working mode validates": "Qué valida cada modo operativo",
    "Load and validate the local YAML file and environment overrides.":
      "Cargar y validar el archivo YAML local y los overrides del entorno.",
    "Authenticate, resolve the workspace and runner identity, and start heartbeat reporting.":
      "Autenticar, resolver el espacio de trabajo y la identidad del runner, e iniciar el envío de heartbeats.",
    "Validate the selected provider CLI and the MCP configuration before accepting work.":
      "Validar el CLI del proveedor elegido y la configuración MCP antes de aceptar trabajo.",
    "Fetch platform-authored pipeline or board-loop configuration for the selected mode. Missing or ambiguous authority is a startup error, not a signal to invent a local fallback.":
      "Obtener la configuración del pipeline o del Loop del tablero creada en la plataforma para el modo seleccionado. La falta o ambigüedad de autoridad es un error de inicio, no una señal para inventar un fallback local.",
    "Validated host configuration": "Configuración validada del host",
    "The host file contains connectivity, provider, MCP, and filesystem concerns. Pipeline stages, prompts, and board-loop policy remain platform-owned. At minimum, set an API key, a workspace slug, the MCP config path, and a safe git base directory.":
      "El archivo del host contiene aspectos de conectividad, proveedor, MCP y sistema de archivos. Las etapas del pipeline, los prompts y la política de Loop del tablero siguen siendo propiedad de la plataforma. Como mínimo, define una clave de API, el slug del espacio de trabajo, la ruta de configuración de MCP y un directorio base seguro para git.",
    "runner.yaml — required foundations":
      "runner.yaml: fundamentos obligatorios",
    "git.base_dir must be outside every Git worktree":
      "git.base_dir debe estar fuera de cualquier worktree de Git",
    "The runner resolves relative paths and ":
      "El runner resuelve las rutas relativas y ",
    ", converts the result to an absolute path, and refuses a directory nested inside an existing worktree. Give each runner a dedicated parent directory for the repositories and worktrees it creates.":
      ", convierte el resultado en una ruta absoluta y rechaza cualquier directorio contenido en un worktree existente. Asigna a cada runner un directorio padre exclusivo para los repositorios y worktrees que crea.",
    " and ": " y ",
    " are built-in provider names. Additional providers can be declared under":
      " son nombres de proveedores integrados. Se pueden declarar proveedores adicionales en",
    ", and model tiers can route work without hard-coding a model into every stage. Use the bundled":
      ", y los tiers de modelos permiten enrutar trabajo sin fijar un modelo en cada etapa. Usa el archivo incluido ",
    " as the complete field reference rather than copying an abbreviated example forward.":
      " como referencia completa de campos, en lugar de seguir copiando un ejemplo abreviado.",
    "The API still calls runners agents": "La API todavía llama agents a los runners",
    "The product term is ": "El término del producto es ",
    ", while database models, API routes, and MCP tools retain the older ":
      ", mientras que los modelos de base de datos, las rutas de API y las herramientas MCP conservan el vocabulario anterior ",
    " vocabulary. For example, ": ". Por ejemplo, ",
    " resolves the runner identity. This is deliberate compatibility, not a second kind of executor.":
      " resuelve la identidad del runner. Es una compatibilidad deliberada, no un segundo tipo de ejecutor.",
  },
  "agent-teams": {
    "An ": "Un ",
    "agent team": "equipo de agentes",
    " is the membership graph that pairs runners with roles inside a workspace. A runner on its own is just a credential. A role on its own is just a string in a pipeline config. The team is the thing that says \"this runner plays these roles on this board.\" Without it, the runner has no mandate to pick up work.":
      " es el grafo de membresías que vincula runners con roles dentro de un espacio de trabajo. Un runner por sí solo es solo una credencial. Un rol por sí solo es solo una cadena en la configuración de un pipeline. El equipo es lo que establece que \"este runner ejecuta estos roles en este tablero\". Sin él, el runner no tiene autorización para tomar trabajo.",
    Shape: "Estructura",
    "A team lives in a workspace and is optionally scoped to a single board. It has a slug (unique within the workspace), an":
      "Un equipo pertenece a un espacio de trabajo y puede, de forma opcional, limitarse a un solo tablero. Tiene un slug, único dentro del espacio de trabajo, un campo ",
    " flag, and zero or more ": " y cero o más ",
    members: "miembros",
    ". Each member is a ": ". Cada miembro es un par ",
    " pair carrying a list of role strings — the pipeline personas this runner is authorized to execute for this team.":
      " que contiene una lista de cadenas de roles, es decir, los perfiles del pipeline que ese runner está autorizado a ejecutar para el equipo.",
    "Team slugs are unique per workspace and creation is idempotent: a repeat create returns the existing team instead of a 409. Adding a member is idempotent too — if the runner is already on the team, its role list is overwritten, not conflicted.":
      "Los slugs de equipo son únicos por espacio de trabajo y la creación es idempotente: repetirla devuelve el equipo existente en lugar de un 409. Agregar un miembro también es idempotente; si el runner ya pertenece al equipo, su lista de roles se reemplaza en lugar de producir un conflicto.",
    "Unique roles": "Roles exclusivos",
    "A role declared ": "Un rol declarado como ",
    " in ": " en ",
    "may only be staffed by one member on a team. The three legacy roles —":
      "solo puede ser ocupado por un miembro del equipo. Los tres roles heredados, ",
    " — are grandfathered into uniqueness by the backend canonicalization pass. Custom roles default to non-unique unless the operator sets the flag. This prevents two runners racing to claim the same card under the same role; it does not prevent two runners playing different roles on the same card.":
      ", conservan su exclusividad mediante el proceso de canonicalización del backend. Los roles personalizados no son exclusivos por defecto, salvo que el operador active el campo. Esto evita que dos runners compitan por tomar la misma tarjeta con el mismo rol; no impide que dos runners desempeñen roles distintos en la misma tarjeta.",
    "Creating a team over MCP": "Crear un equipo mediante MCP",
    "Most operators create teams through the Teams section of the Runners tab, but MCP is the cleaner path when scripting a bootstrap. The call is idempotent on ":
      "La mayoría de los operadores crea equipos desde la sección Equipos de la pestaña Runners, pero MCP es la vía más directa al automatizar una inicialización. La llamada es idempotente respecto de ",
    ", so a repeat returns the existing team.":
      ", por lo que repetirla devuelve el equipo existente.",
    "Create a team, then add a runner to it":
      "Crea un equipo y luego agrega un runner",
    "Runner vs team": "Runner y equipo",
    "A runner is a credential and a process identity; it exists workspace-independently at the platform level (with an":
      "Un runner es una credencial y una identidad de proceso; existe a nivel de plataforma con independencia de un espacio de trabajo, con una lista ",
    " list gating where it may work). A team is per-workspace and scopes which roles that runner is allowed to play there. The runner's effective roles on a given workspace come from the intersection of team membership and the pipeline's stage roles — so adding a role to ":
      " que limita dónde puede trabajar. Un equipo pertenece a cada espacio de trabajo y delimita qué roles puede desempeñar allí ese runner. Los roles efectivos del runner en un espacio de trabajo surgen de la intersección entre la membresía del equipo y los roles de las etapas del pipeline. Por eso, agregar un rol a ",
    " does nothing until a team member carries that role string.":
      " no tiene efecto hasta que un miembro del equipo incluya esa cadena de rol.",
    "Multi-team runners exist in the schema, not in the UI":
      "Los runners en varios equipos existen en el esquema, no en la interfaz",
    "The data model supports one runner belonging to multiple teams. The backend helper ":
      "El modelo de datos permite que un runner pertenezca a varios equipos. El helper del backend ",
    " returns the": " devuelve el ",
    first: "primer",
    " active team an agent is in, and the UI treats the relationship as 1:1. A runner that's a member of two teams will only ever pick up work from the first one today. The simplification will lift when multi-team runners become a real use case. Don't plan around it until it does.":
      " equipo activo al que pertenece un agente, y la interfaz trata la relación como 1:1. Hoy, un runner que sea miembro de dos equipos solo tomará trabajo del primero. Esta simplificación se eliminará cuando los runners en varios equipos se conviertan en un caso de uso real. No bases tus planes en esa capacidad hasta entonces.",
    "Team membership vs card participant":
      "Membresía del equipo y participante de la tarjeta",
    "These sound similar and are not the same. ":
      "Estos conceptos parecen similares, pero no son iguales. ",
    "Team membership": "Membresía del equipo",
    "is a long-lived authorization — \"this runner may play role X here.\"":
      "es una autorización de larga duración: \"este runner puede desempeñar el rol X aquí\". ",
    Participant: "Participante",
    " is per-card — \"this runner is the hero on card 42.\" Runners claim cards by adding themselves as a hero participant at execution time; team membership is what let them even consider claiming.":
      " se define por tarjeta: \"este runner es el hero de la tarjeta 42\". Los runners toman tarjetas al agregarse como participante hero durante la ejecución; la membresía del equipo es lo que les permite siquiera considerar tomarlas.",
  },
  "roles-and-pipelines": {
    "A ": "Un ",
    role: "rol",
    " is a pipeline persona — a free-form string like ":
      " es un perfil del pipeline, representado por una cadena libre como ",
    " or ": " o ",
    " or": " o ",
    ". A ": ". Un ",
    pipeline: "pipeline",
    " is the ordered shape of work: which roles run, in what order, against what columns, under what conditions. Both live in ":
      " es la estructura ordenada del trabajo: qué roles se ejecutan, en qué orden, sobre qué columnas y bajo qué condiciones. Ambos se definen en ",
    " on the workspace. This is where a platform stops being a kanban app and starts being an agentic system.":
      " dentro del espacio de trabajo. Aquí es donde una plataforma deja de ser una aplicación kanban y se convierte en un sistema de agentes.",
    Roles: "Roles",
    "Backplane ships with five default roles, each with hand-written prompt templates in the registry:":
      "Backplane incluye cinco roles predeterminados, cada uno con templates de prompts escritos manualmente en el registro:",
    " — claims unassigned or rework cards, implements code, requests approval for destructive operations.":
      " — toma tarjetas sin asignar o que requieren retrabajo, implementa código y solicita aprobación para operaciones destructivas.",
    " — checks out the PR branch, emits structured approve / request-changes decisions.":
      " — hace checkout de la rama del PR y emite decisiones estructuradas de aprobación o solicitud de cambios.",
    " — updates docs after merge, adds the":
      " — actualiza la documentación después del merge y agrega la etiqueta ",
    " label.": ".",
    " — investigates a card topic and produces a board note.":
      " — investiga el tema de una tarjeta y produce una nota en el tablero.",
    " — writes a single plan note for the existing card; the lifecycle saves its findings.":
      " — escribe una sola nota de plan para la tarjeta existente; el ciclo de vida guarda sus hallazgos.",
    "These are not an enum. ": "Estos roles no son un enum. ",
    " is a string — operators declare any role they want and the platform picks it up end-to-end. The 2026-04-18 walkthrough defined a custom":
      " es una cadena: los operadores declaran cualquier rol que necesiten y la plataforma lo incorpora de extremo a extremo. El recorrido del 18 de abril de 2026 definió un rol personalizado ",
    " role and ran it to completion without a single line of platform code changing. The scheduler, the prompt synthesis layer, and the runner's generic strategy all handle arbitrary role names natively.":
      " y lo ejecutó hasta completarlo sin cambiar una sola línea de código de la plataforma. El planificador, la capa de síntesis de prompts y la estrategia genérica del runner admiten nombres de roles arbitrarios de forma nativa.",
    "Pipeline shape": "Estructura del pipeline",
    "A pipeline is a version number, an array of stages, and a scheduling block. Each stage declares who runs it, how it finds cards, how it claims, what git it sets up, what LLM config it uses, what sensors gate it, and what to do on success or failure.":
      "Un pipeline se compone de un número de versión, un array de etapas y un bloque de planificación. Cada etapa declara quién la ejecuta, cómo encuentra tarjetas, cómo las toma, qué configuración de git prepara, qué configuración de LLM usa, qué sensores condicionan su avance y qué debe hacer si tiene éxito o falla.",
    "pipeline_config shape — the full DSL":
      "Estructura de pipeline_config: la DSL completa",
    "Multiple stages per role": "Varias etapas por rol",
    "One role commonly owns several stages. The default orchestrator is wired across four: ":
      "Es habitual que un rol tenga varias etapas. El orquestador predeterminado está configurado en cuatro: ",
    " for fresh cards,": " para tarjetas nuevas, ",
    " for cards that just cleared an approval gate, ":
      " para tarjetas que acaban de superar un punto de aprobación, ",
    " for turning reviewer feedback into an action plan, and ":
      " para convertir los comentarios del revisor en un plan de acción y ",
    " for applying that plan. The scheduler picks one stage per tick; which one depends on the discover strategy's filter matching an available card.":
      " para aplicar ese plan. El planificador elige una etapa por ciclo; la elección depende de que el filtro de la estrategia de descubrimiento coincida con una tarjeta disponible.",
    "Stages are cheap. Reach for a new stage before a new role.":
      "Las etapas tienen un costo bajo. Antes de crear un rol nuevo, considera agregar una etapa.",
    "If the same runner needs to behave differently in two situations — first pass versus rework, pre-approval versus post-approval — author a second stage under the same role rather than inventing a new role. The scheduler handles the fanout; prompts are keyed on":
      "Si el mismo runner debe comportarse de manera diferente en dos situaciones, como la primera ejecución frente al retrabajo o antes y después de una aprobación, crea una segunda etapa bajo el mismo rol en lugar de inventar uno nuevo. El planificador gestiona la distribución; los prompts se identifican mediante ",
    "; the runner's identity stays clean. Four stages under ":
      "; la identidad del runner se mantiene clara. Cuatro etapas bajo ",
    " is the shipped default, not an anti-pattern.":
      " son la configuración predeterminada que se entrega, no un antipatrón.",
    Scheduling: "Planificación",
    "The ": "El campo ",
    " is either ": " puede ser ",
    ". In ": ". En el modo ",
    " mode the runner walks ": ", el runner recorre ",
    " left-to-right and picks the first stage with work; idle stages go on a 4-minute cooldown so they don't get polled every tick. In ":
      " de izquierda a derecha y elige la primera etapa con trabajo; las etapas inactivas entran en un período de espera de 4 minutos para que no se consulten en cada ciclo. En el modo ",
    " mode it rotates through the list, skipping any stage currently cooling. Scheduling is re-evaluated every tick against live platform config — add a role via the UI and the runner picks it up on the next poll, no restart.":
      ", rota por la lista y omite cualquier etapa que esté en período de espera. La planificación se vuelve a evaluar en cada ciclo frente a la configuración activa de la plataforma: agrega un rol desde la interfaz y el runner lo reconocerá en la siguiente consulta, sin reiniciarse.",
  },
  prompts: {
    "A ": "Un ",
    prompt: "prompt",
    " is the LLM instruction for a specific":
      " es la instrucción para el LLM asociada a un par específico ",
    " pair, optionally scoped to a team. It's the text the runner renders and passes to ":
      ", que puede limitarse a un equipo. Es el texto que el runner renderiza y envía a ",
    " each time it executes that stage. Prompts are where the platform's opinion about how each role should think actually lives.":
      " cada vez que ejecuta esa etapa. En los prompts reside realmente la visión de la plataforma sobre cómo debe razonar cada rol.",
    "Three layers": "Tres capas",
    "Prompts resolve through three cooperating layers on the backend:":
      "Los prompts se resuelven mediante tres capas que colaboran en el backend:",
    "Registry.": "Registro.",
    " Hand-written platform defaults for the 21 known ":
      " Valores predeterminados de la plataforma escritos manualmente para los 21 pares conocidos ",
    " pairs covering the five shipped roles. These ship with the backend.":
      ", que cubren los cinco roles incluidos. Estos valores se distribuyen con el backend.",
    "Synthesis.": "Síntesis.",
    " For any ": " Para cualquier par ",
    " that appears in the live pipeline but isn't in the registry, a minimal placeholder is generated from a shared template. Custom roles are never second-class — the UI always has something to author against.":
      " que aparezca en el pipeline activo pero no esté en el registro, se genera un contenido mínimo a partir de un template compartido. Los roles personalizados nunca se tratan como secundarios: la interfaz siempre ofrece una base sobre la cual crear el contenido.",
    "Overrides.": "Reemplazos.",
    " Operator-authored": " Registros ",
    " rows, scoped to": " creados por el operador, con alcance en ",
    ". An override replaces the body from layer 1 or 2 for that scope.":
      ". Un reemplazo sustituye el cuerpo proveniente de la capa 1 o 2 para ese alcance.",
    "Runners pull their prompt cache at startup and refresh it every tick. Edit a prompt in the UI and the change takes effect on the next refresh without a runner restart.":
      "Los runners cargan la caché de prompts al iniciar y la actualizan en cada ciclo. Edita un prompt en la interfaz y el cambio entrará en vigor en la siguiente actualización sin reiniciar el runner.",
    "The post-process imperative (the load-bearing idea)":
      "La instrucción obligatoria de posproceso, la idea esencial",
    "This is the single most operator-valuable design choice in the platform. Every stage declares a ":
      "Esta es la decisión de diseño más valiosa de la plataforma para el operador. Cada etapa declara una ",
    " from a dropdown: ": " en una lista desplegable: ",
    ", or ": " o ",
    ". The backend splices the correct tool-call instruction into the prompt body automatically — the operator never has to remember to write \"Step N: call ":
      ". El backend inserta automáticamente en el cuerpo del prompt la instrucción correcta para llamar a la herramienta; el operador nunca necesita recordar escribir \"Paso N: llamar a ",
    "\" by hand.": "\" manualmente.",
    "The runner prefers the backend-assembled ":
      "El runner da prioridad a ",
    "over the raw ": " ensamblado por el backend en lugar de ",
    ", so edits on a synthesized prompt body retain the imperative. A custom ":
      " sin procesar, por lo que las ediciones en el cuerpo de un prompt sintetizado conservan la instrucción obligatoria. Un rol personalizado ",
    " role that the operator authored in the UI will call":
      " creado por el operador en la interfaz llamará a ",
    " correctly, because the imperative was spliced in, not typed.":
      " correctamente, porque la instrucción obligatoria fue insertada y no escrita a mano.",
    "Template variables": "Variables del template",
    "Prompt bodies are Go ": "Los cuerpos de los prompts usan la sintaxis Go ",
    " source. The runner renders them with a context object carrying workspace and card identifiers plus stage-specific fields like review history and the project directives pulled from the board definition.":
      ". El runner los renderiza con un objeto de contexto que contiene identificadores del espacio de trabajo y la tarjeta, además de campos específicos de la etapa, como el historial de revisión y las directivas del proyecto obtenidas de la definición del tablero.",
    "Minimal prompt template for a custom researcher role":
      "Template mínimo de prompt para un rol personalizado de investigador",
    "The ": "La estructura ",
    " framing is not decoration. Sonnet-class models treat tool-call results as optional reference and will skip directives they read as background prose. Code-fetched context fetched by the runner and injected into a clearly-labeled mandatory section has measurably better compliance than \"please consider the following\" framings.":
      " no es decorativa. Los modelos de la clase Sonnet tratan los resultados de llamadas a herramientas como referencias opcionales e ignoran directivas que interpretan como texto de contexto. El contexto que el runner obtiene mediante código e inserta en una sección obligatoria claramente identificada produce un cumplimiento considerablemente mayor que formulaciones como \"ten en cuenta lo siguiente\".",
    "The prompt editor is a textarea today":
      "Hoy el editor de prompts es un área de texto",
    "No syntax highlighting, no variable lint, no live preview, no template-inheritance visualization. It's a text box and a Save button. Operators have flagged this often — the MCP server is the path of least resistance for authoring real prompts today, not the UI. An upgrade is on the backlog. Meanwhile, ":
      "No hay resaltado de sintaxis, validación de variables, vista previa en vivo ni visualización de la herencia de templates. Solo hay un cuadro de texto y un botón Guardar. Los operadores han señalado esta limitación con frecuencia; hoy el servidor MCP es la vía más directa para crear prompts reales, no la interfaz. Hay una mejora pendiente en el backlog. Mientras tanto, ",
    "typo'd as ": " escrito por error como ",
    " renders as empty string, not an error, so proofread.":
      " se renderiza como una cadena vacía, no como un error. Por eso, revisa el texto con atención.",
  },
  approvals: {
    ", and ":
      " y ",
    "One category exists specifically for the skills flywheel:":
      "Hay una categoría que existe específicamente para el volante de las habilidades:",
    " starts at a base score of 60, so an agent-proposed ":
      " parte de una puntuación base de 60, de modo que una ",
    "skill":
      "habilidad",
    " can never auto-approve. Publishing what future agent sessions are taught is always a human decision.":
      " propuesta por un agente nunca puede aprobarse automáticamente. Publicar lo que se enseña a las sesiones de agente futuras es siempre una decisión humana.",
    "An ": "Una ",
    approval: "aprobación",
    " gates a destructive or high-risk operation. An agent describes the intended action and payload, the backend records a scored request, and either policy or a human decides whether execution may continue. The durable approval record is part of the audit trail.":
      " controla una operación destructiva o de alto riesgo. Un agente describe la acción y el payload previstos, el backend registra una solicitud puntuada y una política o una persona decide si la ejecución puede continuar. El registro duradero de la aprobación forma parte del rastro de auditoría.",
    "Categories and scoring": "Categorías y puntuación",
    "The supported categories are ": "Las categorías compatibles son ",
    ", and": " y",
    ". Each starts from a category base score; payload details such as item count, target environment, destructive schema work, privileged roles, or protected branches can raise or lower the result.":
      ". Cada una parte de una puntuación base por categoría; los detalles del payload, como cantidad de elementos, entorno de destino, cambios destructivos de esquema, roles privilegiados o ramas protegidas, pueden aumentar o reducir el resultado.",
    "A risk score less than or equal to ": "Una puntuación de riesgo menor o igual que ",
    " is auto-approved. Higher scores create a ":
      " se aprueba automáticamente. Las puntuaciones superiores crean una decisión ",
    " decision for a human. The current ":
      " para una persona. El valor actual de ",
    " is a backend constant, not a workspace setting.":
      " es una constante del backend, no un ajuste del espacio de trabajo.",
    "Park, continue, and resume": "Estacionar, continuar y reanudar",
    "A pending approval does not make the runner wait inside an expensive agent session. The runner checkpoints the work in progress, adds the durable ":
      "Una aprobación pendiente no obliga al runner a esperar dentro de una sesión de agente costosa. El runner guarda un checkpoint del trabajo en curso, agrega la etiqueta duradera ",
    " label, parks that card, and continues with other cards. The label survives a runner restart even though the in-memory provider resume token does not.":
      ", estaciona esa tarjeta y continúa con otras tarjetas. La etiqueta sobrevive al reinicio del runner, aunque el token de reanudación del proveedor guardado en memoria no.",
    "Approval WebSocket events wake the runner for a near-immediate check; HTTP reads remain the canonical state check and fallback on every poll cycle. An approved request resumes the parked work when its session token is still available. A pending request or a temporary fetch error stays parked instead of being treated as failure.":
      "Los eventos WebSocket de aprobación despiertan al runner para una comprobación casi inmediata; las lecturas HTTP siguen siendo la comprobación canónica del estado y el fallback en cada ciclo de consulta. Una solicitud aprobada reanuda el trabajo estacionado cuando su token de sesión sigue disponible. Una solicitud pendiente o un error temporal de lectura permanece estacionado en vez de tratarse como fallo.",
    "The approvals page separates discovery from the decision dialog and keeps completed decisions readable.":
      "La página de aprobaciones separa el descubrimiento del diálogo de decisión y mantiene legibles las decisiones completadas.",
    "Decision states": "Estados de decisión",
    "The data model exposes ": "El modelo de datos expone ",
    ". New requests receive an ": ". Las solicitudes nuevas reciben una marca ",
    "timestamp as age metadata. No current job changes the status automatically at that time, and the timestamp does not prevent a late human decision. If a request does have expired status, the runner leaves its card parked for explicit human recovery instead of treating it as a retry or failed stage.":
      " como metadata de antigüedad. Ningún proceso actual cambia el estado automáticamente en ese momento, y la marca no impide una decisión humana tardía. Si una solicitud tiene estado expired, el runner deja la tarjeta estacionada para una recuperación humana explícita en vez de tratarla como reintento o etapa fallida.",
    "Approval wait is durable, provider continuation is not":
      "La espera de aprobación es duradera; la continuación del proveedor no",
    "After a runner restart, the ": "Después de reiniciar un runner, la etiqueta ",
    " label still prevents accidental re-execution, but the provider resume token is gone by design. An operator must decide the request and deliberately retrigger or unpark the card as appropriate.":
      " sigue evitando una reejecución accidental, pero el token de reanudación del proveedor se pierde por diseño. Un operador debe decidir la solicitud y volver a activar o sacar la tarjeta del estado estacionado de forma deliberada, según corresponda.",
    "Rejection is terminal": "El rechazo es terminal",
    "A rejection is not a retry signal. The runner marks the approval path as terminal and routes the card to its blocked failure outcome instead of asking again in a loop. The decision remains in history; recovery is a new, deliberate execution after the underlying concern is resolved.":
      "Un rechazo no es una señal de reintento. El runner marca la ruta de aprobación como terminal y dirige la tarjeta al resultado bloqueado de fallo, en lugar de volver a preguntar en un loop. La decisión permanece en el historial; la recuperación consiste en una ejecución nueva y deliberada después de resolver el problema subyacente.",
  },
  "loop-mode": {
    "Completion attempts freeze their input context. Editors warn when active work uses a note, definition, prompt or configuration. Policy preview and save enforce the same 128 KiB mandatory-context limit; the separate 256 KiB execution limit also includes the role prompt and evidence. A rejected result records changed inputs when available. Retry completion preserves the candidate and starts a fresh attempt; Recheck completion context can release an older stale attempt immediately while leaving an unchanged active lease intact.": "Los intentos de finalización congelan su contexto de entrada. Los editores advierten cuando un trabajo activo utiliza una nota, definición, prompt o configuración. La vista previa y el guardado de la política aplican el mismo límite de 128 KiB de contexto obligatorio; el límite separado de ejecución de 256 KiB también incluye el prompt del rol y la evidencia. Un resultado rechazado registra las entradas modificadas cuando están disponibles. Reintentar la finalización conserva el candidato e inicia un nuevo intento; Revisar el contexto de finalización permite liberar inmediatamente un intento obsoleto anterior sin alterar una reserva activa cuyo contexto no cambió.",
    "Restarting a runner reports pending review, merge, validation and accepted work with its next action. Doctor inspects this state without claiming work, retrying attempts or enabling the loop. A card in a Blocked column can still need a separate source-work decision after a setup problem is repaired; completion review and validation remain independent of that column.": "Al reiniciar un runner se informa del trabajo pendiente de revisión, merge, validación y del trabajo aceptado, junto con la siguiente acción. Doctor inspecciona este estado sin asignar trabajo, reintentar intentos ni habilitar el bucle. Una tarjeta en una columna Bloqueada puede requerir una decisión adicional sobre el trabajo de implementación tras corregir un problema de configuración; la revisión y validación de finalización siguen siendo independientes de esa columna.",
    "Pipeline mode uses next_assignment for atomic reservation. Loop mode follows the configured prompt for scoped search_cards, dependency checks and move_card, with no atomic reservation. completion_query is a stop condition, not a selection filter.": "El modo pipeline usa next_assignment para reservar de forma atómica. El modo loop sigue el prompt configurado para search_cards con alcance definido, comprobaciones de dependencias y move_card, sin reserva atómica. completion_query es una condición de parada, no un filtro de selección.",
    "completion_policy selects the landing actor, independent source review, forge checks, exact merged-commit validation, evidence-only approval, dependency release at accepted or Done, and automatic or manual completion. A board policy replaces the workspace policy as a whole; null inherits. With no effective policy, legacy enforce_done_merge_gate behavior remains. Only a human workspace administrator may change policy or select evidence_only mode.": "completion_policy selecciona quién fusiona, la revisión independiente del código, las comprobaciones del forge, la validación del commit fusionado exacto, la aprobación de evidencia, la liberación de dependencias en accepted o Done y la finalización automática o manual. La política del tablero sustituye por completo la del espacio de trabajo; null hereda. Sin política efectiva se mantiene enforce_done_merge_gate. Solo un administrador humano puede cambiar la política o seleccionar evidence_only.",
    "Under an explicit policy, submit_completion_candidate records the real open PR and source execution before landing. Independent source review and validation of the frozen merge SHA are separate phases. get_completion_status shows current acceptance and failures; retry_completion schedules a fresh attempt. Later main advancement does not invalidate that exact accepted SHA. Evidence-only candidates require source SHA, artifact digests and named checks. Report blocked_on_human when a human decision is required; never invent a PR or bypass acceptance.": "Con una política explícita, submit_completion_candidate registra el PR abierto real y la ejecución de origen antes de fusionar. La revisión independiente del código y la validación del SHA de fusión fijo son fases distintas. get_completion_status muestra la aceptación y los fallos actuales; retry_completion programa otro intento. El avance posterior de main no invalida ese SHA aceptado. Los candidatos de evidencia requieren SHA de origen, hashes de artefactos y comprobaciones identificadas. Informa blocked_on_human cuando haga falta una decisión humana; nunca inventes un PR ni omitas la aceptación.",

    "Choose a model for this run": "Elegir un modelo para esta ejecución",
    "In the runner's loop setup, keep Follow board settings or choose Choose a model for this run. Select the coding agent and enter the exact model ID accepted by its CLI and your account. The review shows the board request and your selection, even when the board pins a concrete model.": "En la configuración del bucle del runner, conserva Follow board settings o elige Choose a model for this run. Selecciona el agente de programación e introduce el ID exacto del modelo que aceptan su CLI y tu cuenta. La revisión muestra lo que solicita el tablero y tu selección, incluso cuando el tablero fija un modelo concreto.",
    "Use a custom model for one loop process": "Usar un modelo personalizado para un proceso de bucle",
    "Both flags are required for a non-interactive loop launch. The choice lasts for this process, including later iterations and keep-alive resumption. It does not change the board or saved profile defaults. Restart without the choice to follow board settings again. Board prompts, tools, budgets and stop conditions still apply.": "Ambos parámetros son obligatorios para iniciar un bucle sin interacción. La selección dura durante este proceso, incluidas las iteraciones posteriores y la reanudación con keep-alive. No cambia el tablero ni los valores predeterminados del perfil guardado. Reinicia sin la selección para volver a seguir la configuración del tablero. Las instrucciones, herramientas, presupuestos y condiciones de parada del tablero siguen vigentes.",
    "Use a concrete model ID rather than a tier alias. Startup checks the selected agent binary, not model access for your account. If the CLI rejects the model, the session fails without substituting another model. Execution records show the effective provider and model. Pipeline stages and subagents launched by the coding agent keep their own model selection.": "Usa un ID de modelo concreto en lugar de un alias de nivel. El inicio comprueba el ejecutable del agente seleccionado, no el acceso al modelo de tu cuenta. Si la CLI rechaza el modelo, la sesión falla sin sustituirlo por otro. Los registros de ejecución muestran el proveedor y el modelo efectivos. Las etapas del pipeline y los subagentes iniciados por el agente de programación conservan su propia selección de modelo.",
    "Skills in a loop":
      "Habilidades en un bucle",
    "A loop session receives the board's bound":
      "Una sesión del bucle recibe las",
    "skills":
      "habilidades",
    " without any pipeline step: the runner re-fetches the board's effective skill set at the top of every iteration and materializes it into the working tree before the session starts. Bind, pin, or publish mid-run and the next iteration picks up the change — the same live-instrument property as the prompt. Unbinding stops updates but does not yet remove the already-materialized files from the loop working directory: materialization only ever adds, so a removed skill's directory lingers until that cleanup ships.":
      " vinculadas del tablero sin ningún paso de pipeline: el runner vuelve a consultar el conjunto efectivo de habilidades del tablero al comienzo de cada iteración y lo materializa en el árbol de trabajo antes de que empiece la sesión. Vincula, fija o publica en plena ejecución y la siguiente iteración recoge el cambio: la misma propiedad de instrumento en vivo que el prompt. Desvincular detiene las actualizaciones pero todavía no elimina los archivos ya materializados del directorio de trabajo del loop: la materialización solo añade, así que el directorio de una habilidad eliminada persiste hasta que se implemente esa limpieza.",
    "The traffic also flows the other way. With":
      "El tráfico también fluye en sentido contrario. Con",
    " — on by default in the loop config — a session that proved out a durable method can distill it into a proposed skill via ":
      " (activado de manera predeterminada en la configuración del bucle), una sesión que haya validado un método duradero puede destilarlo en una habilidad propuesta mediante ",
    ". Nothing publishes on its own: the proposal waits in the approvals queue for a human, and only approval makes it part of what future iterations are taught.":
      ". Nada se publica por sí solo: la propuesta espera en la cola de aprobaciones a una persona, y solo la aprobación la convierte en parte de lo que se enseña a las iteraciones futuras.",
    "Loop mode": "Modo bucle",
    " points a single agent session at a board and lets it work the backlog unattended, one card per iteration. Where a pipeline run is a runner playing configured roles against cards the scheduler hands it, a loop is one prompt executed over and over — each iteration a fresh session with no memory of the last one, re-reading the board to decide what to do next.":
      " dirige una única sesión de agente a un tablero y le permite trabajar en el backlog sin supervisión, una tarjeta por iteración. Mientras una ejecución de pipeline consiste en un runner que desempeña roles configurados sobre las tarjetas que le entrega el scheduler, un bucle ejecuta el mismo prompt una y otra vez. Cada iteración es una sesión nueva, sin memoria de la anterior, que vuelve a leer el tablero para decidir qué hacer.",
    "That amnesia is the design, not a limitation. The board is the loop's only durable memory: run-log notes, card descriptions, and the board definition are what one iteration leaves for the next. Anything an iteration learns but does not write down is gone when its session ends.":
      "Esa falta de memoria es parte del diseño, no una limitación. El tablero es la única memoria duradera del bucle: las notas del registro de ejecución, las descripciones de las tarjetas y la definición del tablero son lo que una iteración deja para la siguiente. Todo lo que una iteración aprende y no registra desaparece al terminar la sesión.",
    "The tuning loop": "El ciclo de ajuste",
    "The runner re-fetches the board's loop config at the top of":
      "El runner vuelve a consultar la configuración del bucle del tablero al comienzo de",
    every: "cada",
    " iteration. That single property turns the loop into a live instrument — you edit the prompt mid-run and the next iteration picks it up with no restart and no redeploy.":
      " iteración. Esa propiedad convierte el bucle en un instrumento en vivo: puedes editar el prompt durante la ejecución y la siguiente iteración lo usará sin reiniciar ni volver a desplegar.",
    "An iteration writes a run-log note on the board.":
      "Una iteración escribe una nota de registro de ejecución en el tablero.",
    "You read it and fold the lesson into ":
      "La lees e incorporas lo aprendido en ",
    " — one": " con una sola",
    " call; every operator field is editable.":
      "; todos los campos del operador son editables.",
    "The next iteration runs the new method.":
      "La siguiente iteración ejecuta el método actualizado.",
    "Treat the prompt as versioned method, the board's notes as the loop's memory, and the config as the only knob you need mid-run. The most valuable thing an iteration produces is often not its diff but its report of what the prompt got wrong.":
      "Trata el prompt como un método versionado, las notas del tablero como la memoria del bucle y la configuración como el único control que necesitas durante la ejecución. A menudo, lo más valioso que produce una iteración no es su diff, sino su informe sobre lo que el prompt entendió mal.",
    "Operator config fields": "Campos de configuración del operador",
    "The board's Loop dialog is the human control surface. It keeps the enable switch disabled until the first valid save, requires a non-empty loop prompt before enabling, warns before discarding unsaved edits, and explains structured disabled reasons. Templates can fill the prompt and tool allowlist with an overwrite confirmation; prompt-variable chips, provider and model controls, the Tool picker, recent telemetry, the paginated iteration log, and stop transitions are available in the same dialog.":
      "El diálogo Loop del tablero es la superficie de control para las personas. Mantiene deshabilitado el interruptor de activación hasta el primer guardado válido, exige un prompt de Loop no vacío antes de habilitar, avisa antes de descartar cambios sin guardar y explica motivos estructurados de desactivación. Las plantillas pueden completar el prompt y la lista de herramientas permitidas con confirmación de reemplazo; los chips de variables del prompt, controles de proveedor y modelo, selector de herramientas, telemetría reciente, registro paginado de iteraciones y transiciones de detención están disponibles en el mismo diálogo.",
    "Saving config and changing state are separate operations. The dialog saves the operator-owned fields below, while its switch enables or disables the saved loop. The ":
      "Guardar la configuración y cambiar el estado son operaciones separadas. El diálogo guarda los siguientes campos propiedad del operador, mientras que su interruptor habilita o deshabilita el Loop guardado. La herramienta ",
    " MCP tool covers the same policy surface for agents; omitted fields retain their current values, and the runner re-fetches changes on its next cycle.":
      " de MCP cubre la misma superficie de políticas para los agentes; los campos omitidos conservan sus valores actuales y el runner vuelve a obtener los cambios en su siguiente ciclo.",
    "Core execution fields: ": "Campos principales de ejecución: ",
    ", and": " y",
    "Time and money rails: ": "Límites de tiempo y dinero: ",
    "Failure and human-block rails: ": "Límites de fallos y bloqueos humanos: ",
    "and ": "y ",
    " (default) or": " (predeterminado) o",
    ". Under ": ". Con ",
    " the runner pre-flights readiness each cycle and idles for free when nothing is actionable. Use ":
      " el runner comprueba la disponibilidad antes de cada ciclo y espera sin costo cuando no hay nada accionable. Usa ",
    " for loops whose prompt does non-card work, such as triage or documentation sweeps.":
      " para bucles cuyo prompt realiza trabajo que no depende de tarjetas, como triage o revisiones de documentación.",
    ". A person lands the PR, the loop agent lands its own with plain git, or the platform merge queue lands it — the last is the per-board opt-in for autonomous landing. See the posture matrix below.":
      ". Una persona aterriza el PR, el agente del bucle aterriza el suyo con git plano, o lo aterriza la cola de merge de la plataforma: esta última es la habilitación por tablero para el aterrizaje autónomo. Consulta la matriz de posturas más adelante.",
    ". What the merge executor requires before landing this board's queued PRs. Resolved live per tick, so flipping it unsticks already-queued entries without re-enqueueing. Fail-closed: an unrecognized policy behaves as ":
      ". Define lo que exige el ejecutor de merge antes de integrar los PR en cola de este tablero. Se resuelve en vivo en cada ciclo, por lo que cambiarlo desbloquea entradas ya encoladas sin volver a encolarlas. Ante una política desconocida, falla de forma segura y se comporta como ",
    " — server-owned, stamped on every disabled→enabled transition. It defines the budget window, which makes":
      " pertenece al servidor y se registra en cada transición de desactivado a activado. Define la ventana de presupuesto, por lo que",
    "re-enabling the loop your budget reset lever":
      "volver a activar el bucle es el mecanismo para reiniciar el presupuesto",
    ". Config edits while enabled preserve it.":
      ". Las ediciones de configuración mientras está activo lo conservan.",
    "budget_epoch is not writable": "budget_epoch no se puede modificar",
    "Like ": "Al igual que ",
    " and ": " y ",
    ", it is set by the server. A save that carries it back is rejected. To reset the spend window, disable the loop and enable it again.":
      ", lo establece el servidor. Se rechaza cualquier guardado que lo envíe de vuelta. Para reiniciar la ventana de gasto, desactiva el bucle y vuelve a activarlo.",
    "Parking — the readiness, reconcile, wake chain":
      "Espera: la cadena de disponibilidad, reconciliación y reactivación",
    "A loop whose cards are all blocked used to burn a full session discovering it had nothing to do. Under the default":
      "Antes, un bucle con todas sus tarjetas bloqueadas consumía una sesión completa solo para descubrir que no había nada que hacer. Con el valor predeterminado",
    " it does not:": " esto ya no ocurre:",
    "Readiness.": "Disponibilidad.",
    " Before spending anything, the runner asks the backend what is actionable right now — how many cards are workable, blocked, or waiting on a merge.":
      " Antes de gastar, el runner consulta al backend qué es accionable en ese momento: cuántas tarjetas se pueden trabajar, están bloqueadas o esperan un merge.",
    "Reconcile.": "Reconciliación.",
    " The merged-PR reconciler moves cards whose PRs have landed into Done, which is what unblocks their dependents. It runs on merge events and on a periodic poll.":
      " El reconciliador de PR fusionados mueve a Done las tarjetas cuyos PR ya se integraron, lo que desbloquea sus dependencias. Se ejecuta con eventos de merge y mediante una consulta periódica.",
    "Wake.": "Reactivación.",
    " When reconciliation makes something workable, the next cycle starts a real iteration. Until then the loop idles at zero cost, logging its parked state with blocked and awaiting-merge counts each cycle.":
      " Cuando la reconciliación vuelve accionable algún trabajo, el siguiente ciclo inicia una iteración real. Hasta entonces, el bucle espera sin costo y registra en cada ciclo cuántas tarjetas están bloqueadas o esperando un merge.",
    "So a parked loop is healthy and cheap, not stuck. The way to tell the difference is the parked log line and the readiness endpoint — both report what the runner currently sees.":
      "Por eso, un bucle en espera está sano y no genera costo; no está atascado. La línea de log del estado en espera y el endpoint de disponibilidad permiten distinguirlo, ya que ambos informan lo que el runner ve en ese momento.",
    "Disabled, parked, and keep-alive": "Deshabilitado, estacionado y keep-alive",
    "These states answer different questions. ": "Estos estados responden preguntas diferentes. ",
    " means the loop is enabled but has no actionable work under its starvation policy. It remains eligible to work and waits at zero session spend. By contrast, ":
      " significa que el Loop está habilitado, pero no tiene trabajo accionable según su política de inactividad. Sigue disponible para trabajar y espera sin gasto de sesión. En cambio, ",
    " means the board loop is disabled but the runner was configured to stay resident with":
      " significa que el Loop del tablero está deshabilitado, pero el runner se configuró para permanecer residente mediante",
    " or the explicit": " o el flag explícito",
    " flag. It starts no agent session while disabled.":
      ". No inicia ninguna sesión de agente mientras está deshabilitado.",
    "A resident runner wakes on ": "Un runner residente se despierta con ",
    " through the workspace WebSocket when possible and falls back to checking at most once per minute. That socket is a wake channel only: control Loop with":
      " mediante el WebSocket del espacio de trabajo cuando es posible y, como fallback, comprueba el estado como máximo una vez por minuto. Ese socket solo es un canal de activación: controla Loop con ",
    ", not ": ", no con ",
    " or": " ni",
    ". If an older backend rejects": ". Si un backend anterior rechaza ",
    ", the runner reports the compatible": ", el runner informa el heartbeat compatible ",
    " heartbeat instead. Re-enabling creates a new budget epoch and starts fresh budget accounting.":
      " en su lugar. Volver a habilitar crea una nueva época de presupuesto y reinicia su contabilidad.",
    "Keep-alive does not bypass stop conditions":
      "Keep-alive no evita las condiciones de detención",
    "Keep-alive changes only what happens after an operator disables the board loop. The safety rails still exit the process when a run reaches its budget, iteration ceiling, completion query, or another terminal guard. Use a process supervisor if those exits should be restarted.":
      "Keep-alive solo cambia lo que ocurre después de que un operador deshabilita el Loop del tablero. Los límites de seguridad igualmente terminan el proceso cuando una ejecución alcanza su presupuesto, máximo de iteraciones, consulta de finalización u otra condición terminal. Usa un supervisor de procesos si esas salidas deben reiniciarse.",
    "Autonomy posture": "Postura de autonomía",
    "Two questions define how much rope the loop has: who merges the pull requests, and what has to be green first.":
      "Dos preguntas definen el grado de autonomía del bucle: quién fusiona los pull requests y qué debe estar en verde antes.",
    "Human landing (default)": "Integración humana (predeterminada)",
    "PRs land when a person merges them on the forge. The reconciler still moves the card to Done, so the board stays accurate without anyone touching it. While work is blocked behind those merges the loop parks at zero cost and wakes when a merge unblocks dependencies. This posture needs nothing extra and works on any plan.":
      "Los PR se integran cuando una persona los fusiona en el forge. El reconciliador mueve igualmente la tarjeta a Done, por lo que el tablero se mantiene actualizado sin intervención adicional. Mientras el trabajo espera esos merges, el bucle queda en espera sin costo y se reactiva cuando un merge desbloquea dependencias. Esta postura no necesita configuración adicional y funciona con cualquier plan.",
    "Merge-queue landing (opt-in)": "Integración mediante cola de merge (opcional)",
    "A board admin sets ": "Una persona administradora del tablero configura ",
    " and adds the enqueue tool to the loop's allowlist. Loop agents then hand finished PRs to the platform's merge executor, which rebases and lands them subject to":
      " y añade la herramienta de encolado a la lista permitida del bucle. Los agentes entregan los PR terminados al ejecutor de merge de la plataforma, que hace rebase y los integra de acuerdo con",
    ". A loop rarely parks under this posture because it lands its own green PRs. An agent enqueue on a board without the opt-in is rejected server-side.":
      ". Con esta postura, el bucle rara vez queda en espera porque integra sus propios PR en verde. El servidor rechaza el intento de un agente de encolar en un tablero que no lo haya habilitado.",
    "Self-merge landing (prompt-directed)":
      "Aterrizaje self-merge (dirigido por el prompt)",
    " is the honest name for what a prompt saying \"merge it yourself\" already does: the loop agent merges its own branch and moves its own card, with no reviewed PR by construction. The platform grants nothing here, but the board's done-merge gate would block every Done move under it — so a":
      " es el nombre honesto de lo que ya hace un prompt que dice \"haz el merge tú mismo\": el agente del bucle fusiona su propia rama y mueve su propia tarjeta, sin ningún PR revisado por construcción. La plataforma no concede nada aquí, pero la compuerta de Hecho del tablero bloquearía cada movimiento a Hecho bajo este aterrizaje, así que un guardado",
    "human":
      "humano",
    " save that chooses this landing relaxes the gate for that board in the same request. The dialog surfaces the trade as a notice you can decline, an explicitly enforced board is never softened implicitly, and moving the landing off ":
      " que elige este aterrizaje relaja la compuerta de ese tablero en la misma petición. El diálogo muestra el intercambio como un aviso que puedes rechazar, un tablero cuya compuerta se impuso explícitamente nunca se suaviza de forma implícita, y al mover el aterrizaje fuera de ",
    " re-arms the gate automatically. Agent-key saves never relax anything: a landing an agent stored does not count as consent, and an explicit relax from an agent key is refused.":
      " la compuerta se reactiva automáticamente. Los guardados con clave de agente nunca relajan nada: un aterrizaje guardado por un agente no cuenta como consentimiento, y una relajación explícita desde una clave de agente se rechaza.",
    "Every posture reports lifetime cost from provider reports or runner estimates, alongside spending and remaining allowance for the current budget epoch. Restarting preserves the epoch; disabling and re-enabling starts a new one. Session dollar settings are advisory unless the provider and billing mode support enforcement; subscription sessions do not have an enforced dollar cap. Missing required spending history stops execution. The early budget warning and shell deny floor still apply.":
      "Todas las posturas muestran el costo total reportado por los proveedores o estimado por el runner, junto con el gasto y el importe restante del período de presupuesto actual. Reiniciar conserva el período; desactivar y volver a activar inicia uno nuevo. Los importes por sesión son orientativos salvo que el proveedor y la modalidad de facturación permitan aplicarlos; las sesiones por suscripción no tienen un límite monetario exigible. Si falta el historial de gastos requerido, la ejecución se detiene. Se mantienen la alerta temprana de presupuesto y las prohibiciones mínimas del shell.",
    "Forge CI is desirable, never a dependency":
      "La CI del forge es deseable, pero nunca una dependencia",
    "Some repositories cannot run forge CI at all — a free-plan organization where Actions are unavailable, for instance. Rather than making those boards second-class, ":
      "Algunos repositorios no pueden ejecutar CI en el forge, por ejemplo una organización de plan gratuito sin Actions disponibles. Para no relegar esos tableros, ",
    " skips the CI read entirely and lets the board's review flow be the quality gate. We would rather you land work with an honest gate than pretend a red-or-absent CI signal is green.":
      " omite por completo la consulta de CI y deja que el flujo de revisión del tablero sea la barrera de calidad. Es preferible integrar trabajo con una barrera real que fingir que una señal de CI roja o inexistente está en verde.",
    "Authoring cards for a loop": "Diseño de tarjetas para un bucle",
    "Shared-file conflicts between parallel cards are structural, not incidental. Any two cards that append to the same status section, register into the same map, or edit the same barrel export":
      "Los conflictos de archivos compartidos entre tarjetas paralelas son estructurales, no accidentales. Dos tarjetas que agregan contenido a la misma sección de estado, se registran en el mismo mapa o editan el mismo barrel export",
    will: "van a",
    " conflict when their PRs land. Author them so the collision never exists:":
      " entrar en conflicto cuando se integren sus PR. Diseña las tarjetas para evitar esa colisión desde el principio:",
    "Prefer ": "Prefiere ",
    "per-card registration files": "archivos de registro por tarjeta",
    " plus a generated or union registry over one file every card edits.":
      " junto con un registro generado o combinado, en lugar de un archivo que todas las tarjetas editan.",
    "append-only logs": "logs de solo anexado",
    " over in-place status tables — two appends merge cleanly, two edits of the same row do not.":
      " en lugar de tablas de estado editadas in situ. Dos anexos se fusionan limpiamente; dos cambios sobre la misma fila, no.",
    "File ": "Crea ",
    "explicit integration cards": "tarjetas de integración explícitas",
    " for union merges, with dependency edges on the cards they integrate. Do not leave the last parallel card to implicitly merge everything.":
      " para las fusiones de unión, con dependencias hacia las tarjetas que integran. No dejes que la última tarjeta paralela tenga que fusionar todo de forma implícita.",
    "When a card needs an earlier card's unmerged interfaces, copy those interface files verbatim into its branch. They are identical at merge time and rebase away cleanly — which beats stacking branches.":
      "Cuando una tarjeta necesita interfaces aún no fusionadas de una tarjeta anterior, copia esos archivos de interfaz literalmente en su rama. Serán idénticos al momento del merge y desaparecerán limpiamente durante el rebase, lo que es preferible a apilar ramas.",
    "Write the general rule into the card, not the note":
      "Escribe la regla general en la tarjeta, no en la nota",
    "When an iteration hits a non-obvious constraint, have it write the rule into the affected card's description as an as-built block. The next iteration reads cards it is about to work; it may never read a note filed under a different card.":
      "Cuando una iteración encuentre una restricción poco evidente, haz que escriba la regla en la descripción de la tarjeta afectada como un bloque as-built. La siguiente iteración lee las tarjetas que va a trabajar, pero puede que nunca lea una nota registrada bajo otra tarjeta.",
    "Knowing why it stopped": "Saber por qué se detuvo",
    "A loop should never spin on a state it cannot change. Instruct the prompt to disable the loop with a one-line reason whenever the objective is complete or a human decision is genuinely required — that reason is the first thing you see when you come back to the board.":
      "Un bucle nunca debe seguir ejecutándose sobre un estado que no puede cambiar. Indica en el prompt que desactive el bucle con un motivo de una línea cuando el objetivo esté cumplido o se necesite realmente una decisión humana. Ese motivo será lo primero que verás al volver al tablero.",
    "Prompt fragment — disable with a reason":
      "Fragmento de prompt: desactivar con un motivo",
    "The rails write machine-readable reasons of their own when they stop a loop — budget exhausted, iteration ceiling reached, too many consecutive failures — so a stopped loop always explains itself in the same place.":
      "Los límites registran motivos legibles por máquina cuando detienen un bucle, como presupuesto agotado, máximo de iteraciones alcanzado o demasiados fallos consecutivos. Así, un bucle detenido siempre explica la causa en el mismo lugar.",
    "Which component owns what": "Qué componente es responsable de cada función",
    "A recurring diagnosis mistake is looking for a loop feature in the wrong binary. Before concluding a build is stale, check who owns the feature:":
      "Un error frecuente de diagnóstico es buscar una función del bucle en el binario equivocado. Antes de concluir que una build está desactualizada, comprueba qué componente es responsable:",
    Backend: "Backend",
    " and": " y",
    " enforcement, the merge queue worker, the merged-PR reconciler, readiness and history endpoints, and workspace git credentials. The runner never reads the first two.":
      " aplican las políticas, junto con el worker de la cola de merge, el reconciliador de PR fusionados, los endpoints de disponibilidad e historial y las credenciales git del espacio de trabajo. El runner nunca lee los dos primeros valores.",
    "MCP server": "Servidor MCP",
    " — the tools themselves. The runner passes tool ":
      " contiene las herramientas. El runner pasa los ",
    names: "nombres",
    " through to the agent allowlist verbatim.":
      " de las herramientas literalmente a la lista permitida del agente.",
    Runner: "Runner",
    " — parking, budget caps, iteration continuity, and the outcome schema. It stores nothing; it reads":
      " gestiona la espera, los límites de presupuesto, la continuidad de iteraciones y el schema de resultados. No almacena nada; lee",
    " from the platform each iteration.": " desde la plataforma en cada iteración.",
    "Backend features arrive with deploys. When a runner meets an endpoint that is not there yet, it treats the feature as unsupported and degrades gracefully rather than failing the iteration.":
      "Las funciones del backend llegan con los despliegues. Cuando un runner encuentra un endpoint que todavía no existe, trata la función como no compatible y se degrada de forma controlada en lugar de hacer fallar la iteración.",
    Templates: "Plantillas",
    "Most loops should not start from a blank prompt. A ":
      "La mayoría de los bucles no deberían empezar con un prompt en blanco. Un ",
    "loop template": "loop template",
    " carries the prompts, the tool allowlist, and sensible rails, with the run-specific parts left as named ":
      " incluye los prompts, la lista de herramientas permitidas y límites razonables, y deja las partes propias de cada ejecución como ",
    slots: "slots",
    " you fill in. The maintained starting point is ":
      " con nombre que tú completas. El punto de partida que mantenemos es ",
    "Coding Loop v2": "Coding Loop v2",
    "Templates live in the Runner console under ":
      "Las plantillas están en la consola del Runner, en ",
    ". Pick one, run ": ". Elige una, ejecuta ",
    fit: "fit",
    " against your board to see what the template expects that the board does not yet have, fill the slots (each carries help text explaining what a good value looks like), preview the fully rendered prompts, and save. Prompts are rendered at save time and stored as ordinary loop config, so the runner reads exactly what it always read — and enabling the loop stays a separate, deliberate act.":
      " sobre tu tablero para ver qué espera la plantilla que el tablero todavía no tiene, completa los slots (cada uno trae un texto de ayuda que explica cómo es un buen valor), previsualiza los prompts ya renderizados y guarda. Los prompts se renderizan al guardar y se almacenan como configuración normal del bucle, así que el runner lee exactamente lo mismo de siempre, y habilitar el bucle sigue siendo un acto aparte y deliberado.",
    "A bound board refuses hand edits to its prompts rather than silently overwriting them on the next render; detach it first if you want raw text. Each iteration a bound board runs is stamped with the template it came from, which is what gives a template a track record.":
      "Un tablero vinculado rechaza las ediciones manuales de sus prompts en lugar de sobrescribirlas en silencio en el siguiente renderizado; desvincúlalo primero si quieres editar el texto directamente. Cada iteración que ejecuta un tablero vinculado queda marcada con la plantilla de la que proviene, y eso es lo que le da a una plantilla un historial de resultados.",
    "The catalog behind that page is":
      "El catálogo detrás de esa página es",
    ". It lists system templates first — code-defined, versioned with the app, so an upgrade is what updates them — then templates authored in your workspace. Entries are summaries; prompts, slots, and tool grants live behind the per-template fetch. Retired system lineages disappear from the catalog but their slugs still resolve, so a board bound to one reports drift instead of breaking.":
      ". Enumera primero las plantillas de sistema — definidas en código y versionadas con la aplicación, de modo que lo que las actualiza es un upgrade — y luego las plantillas creadas en tu espacio de trabajo. Las entradas son resúmenes; los prompts, los slots y los permisos de herramientas viven detrás de la consulta por plantilla. Los linajes de sistema retirados desaparecen del catálogo, pero sus slugs siguen resolviéndose, así que un tablero vinculado a uno informa drift en lugar de romperse.",
    "The full operator playbook — templates and slots, forge sharp edges, and credential troubleshooting — lives at":
      "El playbook completo del operador, con plantillas y slots, particularidades del forge y resolución de problemas de credenciales, se encuentra en",
    " in the Backplane repository, with the contract of record in ":
      " dentro del repositorio de Backplane, y el contrato de referencia está en ",
  },
  skills: {
    "propose_skill requires a runner-bound key. An interactive AI using a human key receives 403; prepare its bundle for an authorized human workspace admin to create a draft and publish in the workspace Skills Library. There is no MCP draft-authoring tool. Runner proposals still require human approval before publication.": "propose_skill requiere una clave vinculada a un runner. Una IA interactiva con clave humana recibe 403; prepara su paquete para que un administrador humano autorizado del espacio de trabajo cree un borrador y lo publique en la biblioteca de Skills del espacio de trabajo. No hay una herramienta MCP para crear borradores. Las propuestas de runners siguen requiriendo aprobación humana antes de publicarse.",

    "A ":
      "Una ",
    "skill":
      "habilidad",
    " is a versioned bundle of procedural knowledge — a method, a checklist, a set of conventions — that boards teach to the agents working on them. Each bundle is a ":
      " es un paquete versionado de conocimiento procedimental (un método, una lista de verificación, un conjunto de convenciones) que los tableros enseñan a los agentes que trabajan en ellos. Cada paquete consta de un manifiesto ",
    "manifest plus optional text support files. The manifest opens with YAML frontmatter whose ":
      "más archivos de apoyo de texto opcionales. El manifiesto comienza con un frontmatter YAML cuyos campos ",
    " and ":
      " y ",
    "A minimal SKILL.md":
      "Un SKILL.md mínimo",
    "Library and catalog":
      "Biblioteca y catálogo",
    "Skills live in the ":
      "Las habilidades viven en la ",
    "workspace library":
      "biblioteca del espacio de trabajo",
    ". They get there three ways: a human authors one on the Skills page, a human activates one from the built-in ":
      ". Llegan allí de tres maneras: una persona redacta una en la página de Habilidades, una persona activa una desde el ",
    "catalog":
      "catálogo",
    " of platform-curated skills, or an agent proposes one and a human approves it. Activation copies the catalog entry into the library as an independent published v1 — from that moment it is workspace content, versioned like any other skill, with no link back to the catalog entry it came from.":
      " integrado de habilidades curadas por la plataforma, o un agente propone una y una persona la aprueba. La activación copia la entrada del catálogo a la biblioteca como una v1 publicada e independiente: desde ese momento es contenido del espacio de trabajo, versionado como cualquier otra habilidad y sin vínculo con la entrada del catálogo de la que proviene.",
    "Retiring a skill is a ":
      "Retirar una habilidad es un ",
    "soft archive":
      "archivado suave",
    ", never a delete. An archived skill keeps serving the boards already bound to it — a working pipeline does not change behavior because someone tidied the library — but it blocks new bindings and new proposals until unarchived.":
      ", nunca una eliminación. Una habilidad archivada sigue sirviéndose a los tableros que ya estaban vinculados a ella (un pipeline en funcionamiento no cambia de comportamiento porque alguien ordenó la biblioteca), pero bloquea nuevas vinculaciones y nuevas propuestas hasta que se desarchiva.",
    "Versions and bindings":
      "Versiones y vinculaciones",
    "Versions are integers, each carrying a content hash over the bundle's files. A published version is immutable: fixing a typo means publishing the next version, and the hash is what lets you prove byte-for-byte which method an agent was given. Drafts and pending proposals exist alongside published versions but are never served.":
      "Las versiones son números enteros y cada una lleva un hash del contenido de los archivos del paquete. Una versión publicada es inmutable: corregir una errata significa publicar la versión siguiente, y el hash es lo que permite demostrar byte a byte qué método recibió un agente. Los borradores y las propuestas pendientes existen junto a las versiones publicadas, pero nunca se sirven.",
    "A board's relationship to a skill is deliberately tri-state:":
      "La relación de un tablero con una habilidad tiene deliberadamente tres estados:",
    "unbound":
      "sin vincular",
    " — the default, the skill does not reach the board; ":
      " (el valor predeterminado: la habilidad no llega al tablero); ",
    "bound but disabled":
      "vinculada pero deshabilitada",
    " — the binding and its configuration are kept, nothing is served; and":
      " (la vinculación y su configuración se conservan, pero no se sirve nada); y",
    "bound and enabled":
      "vinculada y habilitada",
    ". An enabled binding may pin a specific version; an unpinned binding tracks the latest published version automatically.":
      ". Una vinculación habilitada puede fijar una versión específica; una vinculación sin fijar sigue automáticamente la última versión publicada.",
    "The board's ":
      "El ",
    "effective set":
      "conjunto efectivo",
    " — what agents actually receive — resolves from three rules: enabled bindings only; the pinned version when pinned, otherwise the latest published version; and a binding whose skill has nothing published yet (draft-only) simply drops out.":
      " del tablero, es decir, lo que los agentes reciben realmente, se resuelve con tres reglas: solo vinculaciones habilitadas; la versión fijada cuando existe una fijación y, si no, la última versión publicada; y una vinculación cuya habilidad todavía no tiene nada publicado (solo borradores) simplemente queda fuera.",
    "How skills reach agents":
      "Cómo llegan las habilidades a los agentes",
    "The runner ":
      "El runner ",
    "pre-materializes":
      "pre-materializa",
    " the board's effective set into the working tree before the LLM launches, at each coding agent's own discovery path —":
      " el conjunto efectivo del tablero en el árbol de trabajo antes de que se inicie el LLM, en la ruta de descubrimiento propia de cada agente de código:",
    " for Claude Code,":
      " para Claude Code y",
    " for Codex. Files are written verbatim; the agent finds them the way it finds any project-local skill. Nothing is spliced into a prompt, and the runner has no opinion about what a skill says.":
      " para Codex. Los archivos se escriben textualmente; el agente los encuentra igual que encuentra cualquier habilidad local del proyecto. Nada se inserta en un prompt, y el runner no tiene opinión sobre lo que dice una habilidad.",
    "In a pipeline, that copy happens in the ":
      "En un pipeline, esa copia ocurre en el paso de ciclo de vida ",
    "lifecycle step — after ":
      ", después de ",
    ", because it needs the clone, and before the ":
      ", porque necesita el clon, y antes del paso ",
    " step, because the agent must see the files at launch. In":
      ", porque el agente debe ver los archivos al iniciarse. En el",
    "loop mode":
      "modo bucle",
    " no step is needed: the effective set is re-fetched at the top of every iteration, so a newly bound skill or version change is live on the next iteration with no restart. One asymmetry to know: unbinding a skill mid-run stops its updates but leaves the already-materialized files in the loop working directory — materialization only ever adds today.":
      " no se necesita ningún paso: el conjunto efectivo se vuelve a consultar al comienzo de cada iteración, así que una habilidad recién vinculada o un cambio de versión queda activo en la siguiente iteración sin reiniciar nada. Una asimetría que conviene conocer: desvincular una habilidad en plena ejecución detiene sus actualizaciones pero deja los archivos ya materializados en el directorio de trabajo del loop — hoy la materialización solo añade.",
    "Stored pipelines predating skills need the step added":
      "Los pipelines guardados antes de las habilidades necesitan que se agregue el paso",
    "A pipeline config saved before the skills registry existed has no":
      "Una configuración de pipeline guardada antes de que existiera el registro de habilidades no tiene ningún paso",
    " step, and the platform does not inject one. Bind all the skills you want — nothing materializes until you add the step to each role's lifecycle in the":
      " y la plataforma no inyecta uno. Vincula todas las habilidades que quieras: nada se materializa hasta que agregues el paso al ciclo de vida de cada rol en el",
    "pipeline builder":
      "constructor de pipelines",
    "Materialized skills never land in diffs or PRs. The runner appends the skills directory to ":
      "Las habilidades materializadas nunca terminan en diffs ni en PRs. El runner agrega el directorio de habilidades a ",
    " before writing the first file, refuses to overwrite any path the repository already tracks, and removes exactly the directories it wrote during cleanup — a skill leaking into a commit would put workspace content into a customer PR.":
      " antes de escribir el primer archivo, se niega a sobrescribir cualquier ruta que el repositorio ya rastree y elimina exactamente los directorios que escribió durante la limpieza: una habilidad que se filtrara en un commit pondría contenido del espacio de trabajo en el PR de un cliente.",
    "Interactive and MCP-connected agents skip materialization entirely:":
      "Los agentes interactivos y conectados por MCP se saltan la materialización por completo:",
    " returns the workspace library — or, with a board id, that board's effective set — and ":
      " devuelve la biblioteca del espacio de trabajo (o, con un id de tablero, el conjunto efectivo de ese tablero) y ",
    "returns full file contents.":
      "devuelve el contenido completo de los archivos.",
    " are authoritative for the skill's identity, and whose":
      " son la fuente autoritativa de la identidad de la habilidad, y cuyo",
    " names the hand the skill plays in — the toolset ids its guidance assumes are loaded; the body is plain markdown, the same open convention coding agents already discover in project directories. The platform stores every file verbatim — it never parses, rewrites, or summarizes a skill body.":
      " nombra la mano en la que juega la habilidad: los ids de toolsets que su guía asume cargados; el cuerpo es markdown plano, la misma convención abierta que los agentes de código ya descubren en los directorios de proyecto. La plataforma almacena cada archivo textualmente: nunca analiza, reescribe ni resume el cuerpo de una habilidad.",
    "Toolsets enforce, skills guide":
      "Los toolsets aplican, las habilidades guían",
    "No client can scope an MCP listing from a skill. A skill's":
      "Ningún cliente puede acotar un listado MCP a partir de una habilidad. El",
    " is a pre-approval hint some agents honour; it never removes a tool from what the server lists. The toolset is what the server lists and allows: ":
      " de una habilidad es una pista de preaprobación que algunos agentes respetan; nunca quita una herramienta de lo que el servidor lista. El toolset es lo que el servidor lista y permite: ",
    "decides the hand, and a tool outside it cannot be listed or called — see the ":
      "decide la mano, y una herramienta fuera de ella no puede listarse ni llamarse; consulta la referencia de ",
    "MCP Toolsets":
      "Toolsets MCP",
    "reference.":
      ".",
    "A skill declares the hand it plays in. ":
      "Una habilidad declara la mano en la que juega. ",
    " in the frontmatter names the toolset ids the playbook was written for, so a reader — and the platform — can tell whether the guidance and the session's hand agree. The platform warns in two places: the library flags a playbook that names tools outside its declared toolsets, and the board settings flag a bound skill whose toolsets the board's loop grant does not cover. Neither warning changes what is served.":
      " en el frontmatter nombra los ids de toolsets para los que se escribió el playbook, de modo que un lector, y la plataforma, pueden saber si la guía y la mano de la sesión coinciden. La plataforma avisa en dos lugares: la biblioteca marca un playbook que nombra herramientas fuera de sus toolsets declarados, y los ajustes del tablero marcan una habilidad vinculada cuyos toolsets la concesión del bucle del tablero no cubre. Ningún aviso cambia lo que se sirve.",
    "The runner never parses ":
      "El runner nunca analiza ",
    ". It materializes the files verbatim; the declaration is validated when a version is stored and read from SKILL.md whenever the skill is served, shown to people, never enforced on an agent.":
      ". Materializa los archivos textualmente; la declaración se valida al guardar una versión y se lee de SKILL.md cada vez que se sirve la habilidad, se muestra a las personas y nunca se impone a un agente.",
    "The self-improvement loop":
      "El bucle de automejora",
    "Skills are the platform's mechanism for compounding what agents learn. The loop runs like this: a runner-bound agent works a card and, along the way, works out something durable — a debugging method that actually found the bug, a migration recipe that survived review, a convention the codebase enforces the hard way. Instead of letting that die with the session, the agent distills the method into a bundle and calls":
      "Las habilidades son el mecanismo de la plataforma para capitalizar lo que los agentes aprenden. El bucle funciona así: un agente vinculado a un runner trabaja en una tarjeta y, por el camino, descubre algo duradero: un método de depuración que de verdad encontró el bug, una receta de migración que sobrevivió a la revisión, una convención que el código impone por las malas. En lugar de dejar que eso muera con la sesión, el agente destila el método en un paquete y llama a",
    "The proposal opens a scored request in the":
      "La propuesta abre una solicitud puntuada en la",
    "approvals queue":
      "cola de aprobaciones",
    " under the":
      " bajo la categoría",
    " category, base risk 60 — far above the auto-approve threshold, by design, because skill content steers every future agent session that receives it. It can never auto-approve. A human reads the actual proposed files, and approving is the act that publishes the version. From then on, every future run on every board bound to that skill receives the distilled method. Rejecting keeps the currently published version — or nothing — in place.":
      ", con riesgo base 60, muy por encima del umbral de aprobación automática, y por diseño: el contenido de una habilidad dirige cada sesión de agente futura que la reciba. Nunca puede aprobarse automáticamente. Una persona lee los archivos propuestos reales, y aprobar es el acto que publica la versión. A partir de entonces, cada ejecución futura en cada tablero vinculado a esa habilidad recibe el método destilado. Rechazar deja en su lugar la versión publicada actual, o ninguna.",
    "Agents propose; humans decide what is published.":
      "Los agentes proponen; las personas deciden qué se publica.",
    " That split is the whole design: the flywheel spins as fast as agents learn, but the knowledge that steers future sessions only changes with a human's name on the decision.":
      " Esa separación es todo el diseño: el volante gira tan rápido como aprenden los agentes, pero el conocimiento que dirige las sesiones futuras solo cambia con el nombre de una persona en la decisión.",
    "Loops opt in per board: ":
      "Los bucles se suman tablero por tablero: ",
    " in the board's loop config — on by default — exposes the proposal tool to loop sessions. Switch it off for boards whose loops should consume skills but never suggest new ones.":
      " en la configuración del bucle del tablero (activado de manera predeterminada) expone la herramienta de propuestas a las sesiones del bucle. Desactívalo en los tableros cuyos bucles deban consumir habilidades pero nunca sugerir nuevas.",
    "Tell the prompt what qualifies as a skill":
      "Dile al prompt qué califica como habilidad",
    "The proposals worth approving are methodologies — reusable procedure that would help a different agent on a different card next month. If your loop prompt asks for skill proposals, say what does not qualify: status updates, card-specific context, and anything the board definition already covers belong on the board, not in the library.":
      "Las propuestas que vale la pena aprobar son metodologías: procedimiento reutilizable que ayudaría a otro agente en otra tarjeta el mes que viene. Si tu prompt de bucle pide propuestas de habilidades, di qué no califica: las actualizaciones de estado, el contexto específico de una tarjeta y todo lo que la definición del tablero ya cubre pertenecen al tablero, no a la biblioteca.",
    "Scope and roadmap":
      "Alcance y hoja de ruta",
    "Skills are ":
      "Hoy las habilidades son paquetes ",
    "text-only":
      "de solo texto",
    " bundles today, with hard limits: at most 32 files, 64 KiB per file, 512 KiB per bundle. No binaries and no executable bit — every file materializes as a plain":
      ", con límites estrictos: como máximo 32 archivos, 64 KiB por archivo y 512 KiB por paquete. Sin binarios y sin bit de ejecución: cada archivo se materializa como un archivo normal con modo",
    " file. A skill that ships a helper script must therefore instruct the agent to invoke it through an interpreter —":
      ". Por eso, una habilidad que incluya un script auxiliar debe indicar al agente que lo invoque a través de un intérprete:",
    ", never":
      ", nunca",
    "Text-only is a real constraint, not a footnote":
      "Solo texto es una restricción real, no una nota al pie",
    "A methodology that depends on a reference image, a binary fixture, or a large dataset cannot ship as a skill yet. The limits are deliberate: a skill is meant to be a method an agent reads, not an artifact pipeline — and every byte of it is reviewed by a human before it publishes, which only works while bundles stay small and readable.":
      "Una metodología que dependa de una imagen de referencia, un fixture binario o un conjunto de datos grande todavía no puede publicarse como habilidad. Los límites son deliberados: una habilidad está pensada como un método que un agente lee, no como un pipeline de artefactos, y una persona revisa cada uno de sus bytes antes de publicarla, lo cual solo funciona mientras los paquetes sigan siendo pequeños y legibles.",
    "Richer ingest is on the roadmap":
      "Una ingesta más rica está en la hoja de ruta",
    "Binary assets referenced as media rather than inlined, and per-file modes so a bundled script can be executable, are both on the roadmap. Until then, the interpreter-invocation convention above is the supported path.":
      "Los recursos binarios referenciados como medios en lugar de incrustados, y los modos por archivo para que un script incluido pueda ser ejecutable, están ambos en la hoja de ruta. Hasta entonces, la convención de invocación mediante intérprete descrita arriba es la vía admitida.",
  },
};
