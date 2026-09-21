// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_GETTING_STARTED = {
  "creating-your-first-workspace": {
    "After login, the root route shows the workspace picker. It lists every workspace your account can access and offers Create workspace. The global language switcher currently offers English, Spanish, and Brazilian Portuguese.":
      "Después de iniciar sesión, la ruta raíz muestra el selector de espacios de trabajo. Enumera todos los espacios a los que puede acceder tu cuenta y ofrece la acción Crear espacio de trabajo. El selector global de idioma incluye actualmente inglés, español y portugués de Brasil.",
    "Name and slug": "Nombre y slug",
    "The create dialog asks for a human-readable name and a URL slug. Keep the slug short, lowercase, and hyphenated because it appears in routes such as /acme-ops/boards, /acme-ops/runner, and /acme-ops/settings.":
      "El diálogo de creación solicita un nombre legible y un slug para la URL. Mantén el slug breve, en minúsculas y separado con guiones porque aparece en rutas como /acme-ops/boards, /acme-ops/runner y /acme-ops/settings.",
    "The workspace slug is immutable": "El slug del espacio de trabajo es inmutable",
    "Workspace updates can change the display name, but the current API has no slug rename operation. Links, webhooks, and runner scope depend on that identifier, so choose it as a permanent value.":
      "Las actualizaciones del espacio de trabajo pueden cambiar el nombre visible, pero la API actual no tiene una operación para renombrar el slug. Los enlaces, webhooks y el alcance de los runners dependen de ese identificador; elígelo como un valor permanente.",
    "The creator becomes an owner": "La persona que lo crea se convierte en owner",
    "The creating account is added as the first owner. Workspace roles are owner, admin, member, and viewer, ordered from highest to lowest authority. Owners and admins perform workspace management; only an owner can grant or manage the owner role. Viewers are read-only.":
      "La cuenta creadora se añade como primer owner. Los roles del espacio de trabajo son owner, admin, member y viewer, ordenados de mayor a menor autoridad. Los owners y admins gestionan el espacio; solo un owner puede conceder o administrar el rol owner. Los viewers tienen acceso de solo lectura.",
    "Add people later from /{slug}/members. Give each person the least privilege they need, and keep at least one reachable owner account for membership and destructive workspace decisions.":
      "Añade personas más adelante desde /{slug}/members. Concede a cada una el privilegio mínimo que necesite y conserva al menos una cuenta owner accesible para gestionar miembros y decisiones destructivas del espacio de trabajo.",
    "The first workspace dashboard": "El primer dashboard del espacio de trabajo",
    "Successful creation routes to /{slug}. The welcome checklist guides you through creating a board, adding a project definition and notes, inviting the team, opening a channel, and connecting git. The runner link appears separately when the workspace is ready for automation.":
      "Si la creación se completa correctamente, se te dirige a /{slug}. La lista de bienvenida te guía para crear un tablero, añadir una definición del proyecto y notas, invitar al equipo, abrir un canal y conectar git. El enlace al runner aparece por separado cuando el espacio de trabajo está listo para la automatización.",
    "For a personal evaluation, create the board next. For a team pilot, add collaborators early so the board, notes, and decisions are shared from the start.":
      "Para una evaluación personal, crea el tablero a continuación. Para un piloto de equipo, incorpora pronto a los colaboradores para compartir desde el inicio el tablero, las notas y las decisiones.",
    "Once activity exists, the dashboard shows an activity trend panel with a 7-day and a 30-day view. The payload always carries the full 30 days, so switching ranges never costs a request. Hover the sparkline to read a per-day breakout — date plus event count — with a marker on the plotted point; the same readout is keyboard-reachable (focus the chart, then arrow keys, Home, End; Escape dismisses) and announced to screen readers. On touch screens the chart stays a plain trend line.":
      "Cuando ya existe actividad, el dashboard muestra un panel de tendencia de actividad con vistas de 7 y de 30 días. La respuesta siempre trae los 30 días completos, así que cambiar de rango nunca cuesta una petición. Pasa el cursor sobre la sparkline para leer el desglose por día — fecha más recuento de eventos — con un marcador sobre el punto trazado; la misma lectura es accesible con teclado (enfoca el gráfico y usa las flechas, Home y End; Escape la cierra) y se anuncia a los lectores de pantalla. En pantallas táctiles el gráfico permanece como una simple línea de tendencia.",
  },
  "your-first-board-and-card": {
    "A board is the project surface where people and runners coordinate. It contains typed columns and cards, plus definitions, resources, notes, history, timeline replay, git integration, and alerts.":
      "Un tablero es la superficie del proyecto donde se coordinan personas y runners. Contiene columnas tipadas y tarjetas, además de definiciones, recursos, notas, historial, reproducción de la línea de tiempo, integración con git y alertas.",
    "Create the board": "Crea el tablero",
    "Open /{slug}/boards and choose Create board. The current dialog asks for a name and an optional description; it does not ask for board tags. After creation, Backplane opens the kanban view.":
      "Abre /{slug}/boards y elige Crear tablero. El diálogo actual solicita un nombre y una descripción opcional; no solicita tags del tablero. Después de crearlo, Backplane abre la vista kanban.",
    "A new board is not empty. It receives four default columns: To Do with type backlog, In Progress with type active, Blocked with type blocked, and Done with type done. You may rename or reconfigure them later, but pipeline discovery reads column type rather than the visible title.":
      "Un tablero nuevo no está vacío. Recibe cuatro columnas predeterminadas: Por hacer, de tipo backlog; En curso, de tipo active; Bloqueado, de tipo blocked; y Completado, de tipo done. Puedes renombrarlas o reconfigurarlas después, pero el descubrimiento del pipeline lee el tipo de columna y no el título visible.",
    "The board header exposes eight tabs: kanban, definitions, resources, notes, history, timeline, git, and alerts. Timeline is a replay and inspection surface; history is the activity record.":
      "El encabezado del tablero muestra ocho pestañas: kanban, definiciones, recursos, notas, historial, línea de tiempo, git y alertas. La línea de tiempo permite reproducir e inspeccionar; el historial es el registro de actividad.",
    "Create the first card": "Crea la primera tarjeta",
    "Use Add card at the bottom of a column. Title is the only required field. The dialog also exposes an optional description, card type, priority, target column, due date, status, labels, and participants. Creation defaults to type task and priority medium.":
      "Usa Añadir tarjeta al pie de una columna. El título es el único campo obligatorio. El diálogo también ofrece descripción opcional, tipo de tarjeta, prioridad, columna de destino, fecha límite, estado, etiquetas y participantes. La creación usa de forma predeterminada el tipo task y la prioridad medium.",
    "The supported card types are task, issue, feature, and bug. The UI offers low, medium, high, and urgent priorities; the stored model also supports none. See the internal":
      "Los tipos de tarjeta admitidos son task, issue, feature y bug. La interfaz ofrece las prioridades low, medium, high y urgent; el modelo almacenado también admite none. Consulta la referencia interna",
    "Card Type and Priority": "Tipo y prioridad de tarjeta",
    "reference before building automation around those values.":
      "antes de crear automatizaciones basadas en esos valores.",
    "Markdown, Mermaid, and notes": "Markdown, Mermaid y notas",
    "Card descriptions and workspace notes use the shared rich-text editor. Pasting plain text that looks like Markdown converts headings, lists, links, and other supported structure; pasted HTML takes precedence. Pasting inside a code block remains literal.":
      "Las descripciones de tarjetas y las notas del espacio de trabajo usan el editor de texto enriquecido compartido. Al pegar texto plano con apariencia de Markdown se convierten encabezados, listas, enlaces y otras estructuras compatibles; el HTML pegado tiene prioridad. El contenido pegado dentro de un bloque de código permanece literal.",
    "The editor can insert a Mermaid code block and render the diagram in place. Use it for compact flows or architecture context that belongs with the work. The note editor also offers Export .md. Card descriptions do not currently expose that Markdown export action.":
      "El editor puede insertar un bloque de código Mermaid y renderizar el diagrama en el mismo lugar. Úsalo para flujos compactos o contexto de arquitectura asociado al trabajo. El editor de notas también ofrece Exportar .md. Las descripciones de tarjetas no muestran actualmente esa acción de exportación a Markdown.",
    "The same export exists over the API: fetching a workspace or board note with ":
      "La misma exportación existe en la API: obtener una nota de espacio de trabajo o de tablero con ",
    " returns its content serialized to Markdown instead of the default raw editor JSON. The conversion is a read-time projection of the stored document — nothing is mutated — so scripts and agents can pull notes as plain Markdown without touching the editor.":
      " devuelve su contenido serializado a Markdown en lugar del JSON crudo del editor, que es el valor por defecto. La conversión es una proyección en tiempo de lectura del documento almacenado — no se muta nada —, así que scripts y agentes pueden extraer notas como Markdown plano sin tocar el editor.",
    "Diagrams render under Mermaid's ":
      "Los diagramas se renderizan con el nivel de seguridad ",
    " security level: the produced SVG is sanitized and click bindings are disabled. Any":
      " de Mermaid: el SVG producido se sanea y los vínculos de clic quedan deshabilitados. Toda directiva",
    " directive embedded in the diagram source is stripped before rendering, because an embedded directive outranks the app's own configuration — without the strip, note content could relax that security level itself. A pasted diagram is drawn, not trusted.":
      " incrustada en el código fuente del diagrama se elimina antes de renderizar, porque una directiva incrustada prevalece sobre la configuración de la propia aplicación; sin esa limpieza, el contenido de una nota podría relajar ese nivel de seguridad por sí solo. Un diagrama pegado se dibuja, no se confía en él.",
    "A useful card still needs an executable brief": "Una tarjeta útil sigue necesitando un brief ejecutable",
    "Rich formatting does not replace scope. State the goal, constraints, relevant files or resources, acceptance criteria, and what must not be changed. A runner receives the card description as working context.":
      "El formato enriquecido no reemplaza el alcance. Indica el objetivo, las restricciones, los archivos o recursos relevantes, los criterios de aceptación y aquello que no debe modificarse. Un runner recibe la descripción de la tarjeta como contexto de trabajo.",
    "Continue in the card detail sheet": "Continúa en el panel de detalle de la tarjeta",
    "Open a card to edit its description and metadata, manage labels and participants, link notes, record dependencies, or explain why work is stuck. The board remains the scanning and movement surface; the detail sheet is where the durable implementation context belongs.":
      "Abre una tarjeta para editar su descripción y metadatos, gestionar etiquetas y participantes, enlazar notas, registrar dependencias o explicar por qué el trabajo está bloqueado. El tablero sigue siendo la superficie para revisar y mover; el panel de detalle contiene el contexto duradero de implementación.",
    "Validate persistence before adding automation": "Valida la persistencia antes de añadir automatización",
    "Create a card with a Markdown list and a Mermaid block, reload the board, reopen the card, and export a related note as .md. This verifies the editor, database, and board route before a runner enters the loop.":
      "Crea una tarjeta con una lista Markdown y un bloque Mermaid, recarga el tablero, vuelve a abrir la tarjeta y exporta una nota relacionada como .md. Así verificas el editor, la base de datos y la ruta del tablero antes de que un runner entre en el ciclo.",
  },
  "installing-the-mcp-server": {
    "For every preset, resolve an authorized workspace from established context after whoami. If unresolved, call list_workspaces and use a returned slug. If the choice is ambiguous, ask the user to confirm. If no authorized workspace exists, report that limitation and stop workspace checks. Never invent a slug.":
      "Para cada preajuste, resuelve un espacio de trabajo autorizado a partir del contexto establecido después de whoami. Si no se puede resolver, llama a list_workspaces y usa un slug devuelto. Si la elección es ambigua, pide al usuario que la confirme. Si no existe ningún espacio de trabajo autorizado, informa de esa limitación y detén las comprobaciones del espacio. Nunca inventes un slug.",
    "Identity and workspace resolution":
      "Identidad y resolución del espacio de trabajo",
    "Everyday project work (default): call list_boards in that workspace, then get_project_context with an existing returned board ID. Replace the placeholders below with those authorized values. If no boards exist, report the successful empty list and skip the project-context call.":
      "Trabajo diario del proyecto (default): llama a list_boards en ese espacio y después a get_project_context con el ID de un tablero existente devuelto. Sustituye los marcadores siguientes por esos valores autorizados. Si no hay tableros, informa de la lista vacía obtenida correctamente y omite la llamada de contexto del proyecto.",
    "Everyday project read checks":
      "Comprobaciones de lectura del trabajo diario",
    "Loops and runners: use the loop checks below with the interactive loops preset. Everything combines the everyday and loops checks as representative read checks; they do not verify every tool. Do not expect the default preset to expose all loop tools.":
      "Bucles y runners: usa las comprobaciones de bucles siguientes con el preajuste interactivo de bucles. Todo combina las comprobaciones diarias y de bucles como lecturas representativas; no verifican todas las herramientas. No esperes que el preajuste default exponga todas las herramientas de bucles.",
    "Loop read checks":
      "Comprobaciones de lectura de bucles",
    "The package commands install the released package. An unpublished candidate requires its reviewed source checkout or wheel; use the exact candidate commit when it is accessible. A released package install does not validate an unpublished candidate.":
      "Los comandos del paquete instalan la versión publicada. Un candidato sin publicar requiere su checkout de código revisado o su wheel; usa el commit exacto del candidato cuando sea accesible. Instalar un paquete publicado no valida un candidato sin publicar.",
    "Everyday project work: default keeps the interactive catalog compact.":
      "Trabajo diario del proyecto: default mantiene compacto el catálogo interactivo.",
    "Loops and runners: default,autonomous-operations is for an interactive human connection to prepare and manage loops.":
      "Bucles y runners: default,autonomous-operations sirve para una conexión humana interactiva que prepara y gestiona bucles.",
    "Everything: all is an explicit opt-in to a larger catalog that may exceed client tool limits.":
      "Todo: all es una elección explícita de un catálogo más grande que puede superar los límites de herramientas del cliente.",
    "Presets are starting selections. Preserve custom toolset compositions and existing credentials. Actual autonomous runner launches use all intersected with their authorized allowlist; do not replace that execution configuration with the interactive loops preset.":
      "Los preajustes son selecciones iniciales. Conserva las composiciones personalizadas de toolsets y las credenciales existentes. Los runners autónomos reales usan all intersectado con su allowlist autorizada; no sustituyas esa configuración de ejecución por el preajuste interactivo de bucles.",
    "A local stdio MCP process can use a remote Backplane API through VALARIS_API_URL. The example configures that local process. For remote MCP HTTP, the operator sets the environment at the actual MCP service startup and restarts it. Client environment cannot configure a remote MCP service.":
      "Un proceso MCP local por stdio puede usar una API remota de Backplane mediante VALARIS_API_URL. El ejemplo configura ese proceso local. Para MCP remoto por HTTP, el operador establece el entorno al iniciar el servicio MCP real y lo reinicia. El entorno del cliente no puede configurar un servicio MCP remoto.",
    "Restart the MCP server/connection after changing startup configuration, then start a fresh agent session. Inspect the current native tool schema before calling. Run whoami to confirm identity; authentication or API-key activity does not verify the selected tools. get_server_info reports server-enabled tools, while list_changed_sent only reports notification delivery. Neither proves native client availability.":
      "Reinicia el servidor/conexión MCP tras cambiar la configuración de inicio y abre una sesión nueva del agente. Revisa el esquema actual de la herramienta nativa antes de llamarla. Ejecuta whoami para confirmar la identidad; la autenticación o la actividad de la clave API no verifica las herramientas seleccionadas. get_server_info informa de las herramientas habilitadas en el servidor, mientras que list_changed_sent solo indica la entrega de la notificación. Ninguno demuestra disponibilidad nativa en el cliente.",
    "For loops, replace your-workspace with the selected authorized workspace. list_agents takes no workspace_slug and lists agents visible to your credentials. Empty successful lists count as callable. Inspect propose_skill presence without invoking it. Do not register runners, bind or start loops, propose skills, or mutate boards to verify setup.":
      "Para bucles, sustituye your-workspace por el espacio de trabajo autorizado seleccionado. list_agents no acepta workspace_slug y enumera los agentes visibles para tus credenciales. Las listas vacías obtenidas correctamente cuentan como llamadas disponibles. Revisa la presencia de propose_skill sin invocarla. No registres runners, vincules o inicies bucles, propongas skills ni modifiques tableros para verificar la configuración.",
    "Missing tool: compare the selected toolsets with get_server_info and the client catalog. Check the running server version and its schema. Preserve VALARIS_MCP_ALLOWLIST; only an authorized operator can change a grant. If the server enables the tool but the client lacks it, follow catalog recovery.":
      "Herramienta ausente: compara los toolsets seleccionados con get_server_info y el catálogo del cliente. Revisa la versión del servidor en ejecución y su esquema. Conserva VALARIS_MCP_ALLOWLIST; solo un operador autorizado puede cambiar un permiso. Si el servidor habilita la herramienta pero el cliente no la tiene, sigue la recuperación del catálogo.",
    "401: check or replace the API key. 403: confirm authorized workspace membership and permissions with the operator; widening toolsets does not grant access.":
      "401: revisa o sustituye la clave API. 403: confirma con el operador la pertenencia al espacio de trabajo autorizado y los permisos; ampliar toolsets no concede acceso.",
    "Network error: check the API origin, connectivity and protected remote endpoint. Process-start failure: check uvx availability and host config syntax. Version or schema mismatch: use a compatible reviewed server artifact and repeat the read-only checks after restart.":
      "Error de red: revisa el origen de la API, la conectividad y el endpoint remoto protegido. Fallo al iniciar el proceso: revisa la disponibilidad de uvx y la sintaxis de la configuración del host. Versión o esquema incompatible: usa un artefacto de servidor revisado y compatible y repite las comprobaciones de solo lectura tras reiniciar.",
    "Catalog recovery and remote operator setup":
      "Recuperación del catálogo y configuración del operador remoto",
    "backplane-mcp exposes Backplane operations and guided prompts to any MCP-aware agent host. Install it on each machine that needs platform access and give each client its own revocable API key.":
      "backplane-mcp expone las operaciones de Backplane y prompts guiados a cualquier host de agentes compatible con MCP. Instálalo en cada máquina que necesite acceso a la plataforma y asigna a cada cliente su propia API key revocable.",
    "Install or run the package": "Instala o ejecuta el paquete",
    "Run the published package with uvx": "Ejecuta el paquete publicado con uvx",
    "Install into the active virtual environment": "Instálalo en el entorno virtual activo",
    "The package exports backplane-mcp and the compatible valaris-mcp alias. To test a reviewed source revision, include the commit in the Git URL; an unqualified branch is not a pin.":
      "El paquete exporta backplane-mcp y el alias compatible valaris-mcp. Para probar una revisión de código examinada, incluye el commit en la URL de Git; una rama sin calificar no constituye un pin.",
    "Run an exact source revision": "Ejecuta una revisión exacta del código",
    "Configure the MCP host": "Configura el host MCP",
    "Claude Desktop uses claude_desktop_config.json. Claude Code supports a project-scoped .mcp.json file and the claude mcp add command. Legacy user-level configuration paths are not the current repository guidance. Other hosts use the same command, arguments, and environment values in their own MCP configuration format.":
      "Claude Desktop usa claude_desktop_config.json. Claude Code admite un archivo .mcp.json dentro del proyecto y el comando claude mcp add. Las rutas antiguas de configuración a nivel de usuario no forman parte de la guía actual del repositorio. Otros hosts usan el mismo comando, argumentos y valores de entorno dentro de su propio formato de configuración MCP.",
    "Project .mcp.json or desktop MCP block": "Archivo .mcp.json del proyecto o bloque MCP de escritorio",
    "VALARIS_API_URL is the Backplane origin without a trailing /api. The client appends API paths itself. Production Compose on the same machine is http://localhost:8080; direct backend development is commonly http://localhost:8000.":
      "VALARIS_API_URL es el origen de Backplane sin /api al final. El cliente añade por sí mismo las rutas de la API. Compose de producción en la misma máquina usa http://localhost:8080; el desarrollo directo del backend suele usar http://localhost:8000.",
    "VALARIS_API_KEY is a personal vlr_ key sent as Authorization: Bearer on every request. Create it from the account menu under API Keys; the plaintext is shown once.":
      "VALARIS_API_KEY es una clave personal con prefijo vlr_ que se envía como Authorization: Bearer en cada solicitud. Créala en Claves de API dentro del menú de la cuenta; el valor en texto plano se muestra una sola vez.",
    "Treat the client configuration as a secret": "Trata la configuración del cliente como un secreto",
    "A literal API key in JSON grants the same workspace access as its owner. Keep the file out of git, restrict filesystem access, and rotate the key if it is copied into logs or shared material.":
      "Una API key literal dentro de JSON concede el mismo acceso a espacios de trabajo que tiene su titular. Mantén el archivo fuera de git, restringe el acceso en el sistema de archivos y rota la clave si se copia en logs o material compartido.",
    "Verify the connection": "Verifica la conexión",
    "Use the exact prompt identifiers": "Usa los identificadores exactos de los prompts",
    "The MCP server currently registers ten prompts:": "El servidor MCP registra actualmente diez prompts:",
    "init_project initializes a project from a brief.": "init_project inicializa un proyecto a partir de un brief.",
    "standup, triage, and status summarize and organize work.": "standup, triage y status resumen y organizan el trabajo.",
    "plan_work, decompose_card, and sprint turn objectives into sequenced board work.":
      "plan_work, decompose_card y sprint convierten objetivos en trabajo secuenciado dentro del tablero.",
    "pickup, implement, and ship guide the coding delivery loop.":
      "pickup, implement y ship guían el ciclo de entrega de código.",
    "These underscore names are the registered MCP IDs. Use the identifier shown by your host rather than translating it or replacing underscores with dashes.":
      "Estos nombres con guion bajo son los IDs registrados en MCP. Usa el identificador que muestre tu host en lugar de traducirlo o reemplazar los guiones bajos por guiones.",
  },
  "registering-a-runner": {
    "A runner is the credentialed process that claims and executes eligible cards. The Launch runner wizard creates its identity and key, binds pipeline roles, exports configuration, and explains how to start the binary on your own machine.":
      "Un runner es el proceso con credenciales que asume y ejecuta tarjetas elegibles. El asistente Lanzar runner crea su identidad y clave, vincula roles del pipeline, exporta la configuración y explica cómo iniciar el binario en tu propia máquina.",
    "Open the four-step wizard": "Abre el asistente de cuatro pasos",
    "In /{slug}/runner, open the Runners tab and choose Create runner. The progress strip is Identity, Roles, Config, and Launch. The Config step requires at least one board in the workspace because the exported MCP scope and runner settings are board-aware.":
      "En /{slug}/runner, abre la pestaña Runners y elige Crear runner. La barra de progreso contiene Identidad, Roles, Configuración y Lanzamiento. El paso Configuración requiere al menos un tablero en el espacio de trabajo porque el alcance MCP y los ajustes exportados del runner dependen del tablero.",
    "Identity and one-time key": "Identidad y clave de una sola visualización",
    "Enter a name and optional description. The runner is created in the current workspace. Creation returns a vlr_ API key once; Backplane stores its hash rather than recoverable plaintext.":
      "Introduce un nombre y una descripción opcional. El runner se crea en el espacio de trabajo actual. La creación devuelve una vez una API key con prefijo vlr_; Backplane almacena su hash, no un texto plano recuperable.",
    "Copy the API key before leaving the step": "Copia la API key antes de salir del paso",
    "If the plaintext is lost, rotate the runner key. Rotation preserves the runner identity, role bindings, budget, and execution history, but the previous key stops working immediately.":
      "Si pierdes el texto plano, rota la clave del runner. La rotación conserva la identidad, los vínculos de roles, el presupuesto y el historial de ejecuciones, pero la clave anterior deja de funcionar inmediatamente.",
    "Bind only the roles this process may execute": "Vincula solo los roles que este proceso puede ejecutar",
    "Choose from roles declared by the workspace pipeline. The wizard adds the runner through team membership and can create the Default runners team when needed. Skipping roles is allowed for configuration work, but a runner without an effective pipeline role cannot claim a stage.":
      "Elige entre los roles declarados por el pipeline del espacio de trabajo. El asistente añade el runner mediante una membresía de equipo y puede crear el equipo Default runners cuando sea necesario. Se permite omitir roles durante la configuración, pero un runner sin un rol efectivo del pipeline no puede asumir una etapa.",
    "Role bindings remain editable": "Los vínculos de roles siguen siendo editables",
    "Change roles later from the runner detail and team controls. A binding authorizes a role; it does not repair a missing pipeline, prompt, board repository, or coding-agent prerequisite.":
      "Cambia los roles más adelante desde el detalle del runner y los controles de equipo. Un vínculo autoriza un rol; no corrige un pipeline, prompt, repositorio del tablero o prerrequisito del agente de código que falten.",
    "Download the board-aware configuration": "Descarga la configuración vinculada al tablero",
    "Select a board when the workspace has several. The agent-scoped Config bundle contains runner-{name}.yaml and mcp-config-{name}.json, with paths already pointing at each other. The separate mcp-config.json download is board-scoped for agent clients that do not need the runner YAML.":
      "Selecciona un tablero cuando el espacio de trabajo tenga varios. El paquete Config con alcance de agente contiene runner-{name}.yaml y mcp-config-{name}.json, cuyas rutas ya se apuntan entre sí. La descarga independiente mcp-config.json tiene alcance de tablero para clientes de agentes que no necesitan el YAML del runner.",
    "The bundle does not embed the raw API key. Both generated files use the $":
      "El paquete no incorpora la API key sin procesar. Ambos archivos generados usan el marcador $",
    "{VALARIS_API_KEY}": "{VALARIS_API_KEY}",
    " placeholder, so the process must receive that environment variable at launch. The bundle is safer to store than a plaintext key, but it still reveals internal URLs and scope and should not be published casually.":
      "; por tanto, el proceso debe recibir esa variable de entorno al iniciarse. El paquete es más seguro de almacenar que una clave en texto plano, pero revela URLs internas y alcance, y no debe publicarse sin cuidado.",
    "Use the exported filename explicitly": "Usa explícitamente el nombre de archivo exportado",
    "Bare interactive startup discovers runner.yaml and mcp-config.json in its supported locations. It does not auto-discover the exported runner-{name}.yaml filename. Use -config for the downloaded bundle, from the directory that contains both exported files.":
      "El inicio interactivo sin parámetros descubre runner.yaml y mcp-config.json en sus ubicaciones compatibles. No descubre automáticamente el archivo exportado runner-{name}.yaml. Usa -config para el paquete descargado desde el directorio que contiene ambos archivos exportados.",
    "Launch the downloaded bundle": "Inicia el paquete descargado",
    "On success, the runner authenticates, resolves its identity, downloads the platform pipeline, connects its event channel, and starts the work loop. The Runners tab should then report it connected.":
      "Si funciona, el runner se autentica, resuelve su identidad, descarga el pipeline de la plataforma, conecta su canal de eventos e inicia el ciclo de trabajo. La pestaña Runners debe mostrarlo entonces como conectado.",
    "Rotate and re-download together": "Rota y vuelve a descargar en conjunto",
    "Rotate API Key from the runner detail when a key is lost or exposed. Copy the new value once, re-download the updated bundle, update every host that used the old key, and restart those processes with the new key. Test the new key before removing your secure recovery notes.":
      "Usa Rotar API key desde el detalle del runner cuando una clave se pierda o quede expuesta. Copia una vez el valor nuevo, vuelve a descargar el paquete actualizado, actualiza todos los hosts que usaban la clave anterior y reinicia esos procesos con la clave nueva. Prueba la nueva clave antes de eliminar tus notas seguras de recuperación.",
    "Run doctor before the first work loop": "Ejecuta doctor antes del primer ciclo de trabajo",
    "The next page uses -doctor with the explicit config filename. That read-only preflight catches missing CLIs, credentials, MCP config, repository access, scope, and backend connectivity before a card is claimed.":
      "La página siguiente usa -doctor con el nombre explícito del archivo de configuración. Esa comprobación de solo lectura detecta CLIs, credenciales, configuración MCP, acceso al repositorio, alcance o conectividad con el backend que falten antes de asumir una tarjeta.",
  },
  "your-first-pipeline-run": {
    "This walkthrough proves a configured runner can authenticate, accept platform authority, claim eligible work, and report the result. The exact card movements, git actions, approvals, and pull-request behavior come from your saved lifecycle; they are not unconditional defaults.":
      "Este recorrido demuestra que un runner configurado puede autenticarse, aceptar la autoridad de la plataforma, asumir trabajo elegible e informar el resultado. Los movimientos exactos de tarjetas, las acciones de git, las aprobaciones y el comportamiento de los pull requests proceden del ciclo de vida guardado; no son valores predeterminados incondicionales.",
    "1. Obtain the published runner": "1. Obtén el runner publicado",
    "Version 0.8.5 is published as checksummed macOS, Linux, and Windows binaries for arm64 and amd64. Select the filename for your host; this example is macOS arm64.":
      "La versión 0.8.5 se publica como binarios de macOS, Linux y Windows para arm64 y amd64, con checksum. Selecciona el nombre de archivo para tu host; este ejemplo corresponde a macOS arm64.",
    "Download and verify the macOS arm64 binary": "Descarga y verifica el binario para macOS arm64",
    "Download and verify the Windows amd64 binary": "Descarga y verifica el binario para Windows amd64",
    "A public container is also available at ghcr.io/valaris-studio/backplane-runner:0.8.5. A container deployment must mount both runner YAML and MCP JSON at the paths referenced by the YAML; the single-mount Compose profile does not do that completely.":
      "También hay un contenedor público en ghcr.io/valaris-studio/backplane-runner:0.8.5. Un despliegue en contenedor debe montar tanto el YAML del runner como el JSON de MCP en las rutas indicadas por el YAML; el perfil de Compose con un solo montaje no lo hace por completo.",
    "Pull the published container image": "Descarga la imagen publicada del contenedor",
    "2. Prepare the exported bundle": "2. Prepara el paquete exportado",
    "Download the runner-scoped bundle from the Launch runner wizard or the runner detail. Keep runner-laptop-seba.yaml beside mcp-config-laptop-seba.json. The YAML points at its sibling and both use $":
      "Descarga el paquete con alcance de runner desde el asistente Lanzar runner o desde el detalle del runner. Mantén runner-laptop-seba.yaml junto a mcp-config-laptop-seba.json. El YAML apunta a su archivo hermano y ambos usan $",
    "{VALARIS_API_KEY}": "{VALARIS_API_KEY}",
    " rather than embedding the one-time key.": " en lugar de incorporar la clave de una sola visualización.",
    "Confirm the chosen board, backend URL, workspace slug, work directory, LLM provider, and MCP path. The host also needs git, the selected coding-agent CLI, its authentication, and forge credentials when the lifecycle performs repository work.":
      "Confirma el tablero elegido, la URL del backend, el slug del espacio de trabajo, el directorio de trabajo, el proveedor LLM y la ruta MCP. El host también necesita git, la CLI del agente de código elegida, su autenticación y las credenciales del forge cuando el ciclo de vida realice trabajo en el repositorio.",
    "3. Run doctor with the same config": "3. Ejecuta doctor con la misma configuración",
    "Resolve the key and run the read-only preflight": "Resuelve la clave y ejecuta la comprobación de solo lectura",
    "Replace ./backplane-runner with the downloaded versioned filename when you have not renamed it. Doctor checks local tools, credential sources, backend reachability, runner identity and budget, MCP configuration, and work-directory safety without claiming a card or spending model budget. Fix failures before starting the loop.":
      "Reemplaza ./backplane-runner por el nombre versionado del archivo descargado si no lo has renombrado. Doctor comprueba herramientas locales, fuentes de credenciales, acceso al backend, identidad y presupuesto del runner, configuración MCP y seguridad del directorio de trabajo sin asumir una tarjeta ni gastar presupuesto del modelo. Corrige los fallos antes de iniciar el ciclo.",
    "4. Verify platform-side prerequisites": "4. Verifica los prerrequisitos de la plataforma",
    "The runner must belong to a team. An empty team role list means all pipeline roles; a non-empty list limits it to that subset. With no team binding, the platform cannot return a runnable pipeline config.":
      "El runner debe pertenecer a un equipo. Una lista vacía de roles del equipo significa todos los roles del pipeline; una lista no vacía lo restringe a ese subconjunto. Sin un vínculo de equipo, la plataforma no puede devolver una configuración de pipeline ejecutable.",
    "The pipeline needs at least one stage, effective roles, and authored prompts. The runner refuses startup when the returned authority is incomplete.":
      "El pipeline necesita al menos una etapa, roles efectivos y prompts redactados. El runner se niega a iniciar cuando la autoridad devuelta está incompleta.",
    "The board needs a card in the column type discovered by a stage. If that lifecycle performs git work, the board also needs a usable repository and matching forge credentials.":
      "El tablero necesita una tarjeta en el tipo de columna que descubre una etapa. Si ese ciclo de vida realiza trabajo con git, el tablero también necesita un repositorio utilizable y credenciales compatibles del forge.",
    "5. Start the work loop": "5. Inicia el ciclo de trabajo",
    "Launch with the exported filename": "Inicia con el nombre de archivo exportado",
    "Healthy startup includes authenticated, agent identity resolved, llm providers ready, either single-role mode or multi-role mode, websocket connected, and work loop starting. The runner polls once immediately on startup; it does not wait for the first scheduled interval. Later work can wake through WebSocket events, with HTTP polling as fallback.":
      "Un inicio saludable incluye authenticated, agent identity resolved, llm providers ready, single-role mode o multi-role mode, websocket connected y work loop starting. El runner consulta una vez inmediatamente al iniciarse; no espera el primer intervalo programado. El trabajo posterior puede activarse mediante eventos WebSocket, con consultas HTTP como alternativa.",
    "6. Observe an eligible card": "6. Observa una tarjeta elegible",
    "Create or move one well-scoped card into the first stage's discover column type. Watch stdout, the card detail, runner activity, execution history, and the Observer Panel. The Observer currently covers card, column, agent, execution, approval, and activity event namespaces.":
      "Crea o mueve una tarjeta bien delimitada al tipo de columna de descubrimiento de la primera etapa. Observa stdout, el detalle de la tarjeta, la actividad del runner, el historial de ejecuciones y el Panel del observador. El observador cubre actualmente los espacios de nombres de eventos card, column, agent, execution, approval y activity.",
    "Eligibility and movement are lifecycle decisions": "La elegibilidad y el movimiento son decisiones del ciclo de vida",
    "The backend next-assignment endpoint applies column, role, scope, and gate rules before a claim is returned. After execution, configured lifecycle actions determine commits, pushes, pull requests, and card movement. A successful model invocation alone does not promise any one of those outcomes.":
      "El endpoint next-assignment del backend aplica reglas de columna, rol, alcance y gates antes de devolver una asignación. Después de la ejecución, las acciones configuradas del ciclo de vida determinan commits, pushes, pull requests y movimientos de tarjetas. Una invocación correcta del modelo por sí sola no garantiza ninguno de esos resultados.",
    "7. Decide an approval only when requested": "7. Decide una aprobación solo cuando se solicite",
    "An approval appears only when the active lifecycle stage enables it and the execution requests an approval category. Review the payload in /{slug}/approvals and approve or reject it. Do not assume every git push or schema change automatically pauses; that policy belongs to the saved pipeline configuration.":
      "Una aprobación aparece únicamente cuando la etapa activa del ciclo de vida la habilita y la ejecución solicita una categoría de aprobación. Revisa el payload en /{slug}/approvals y apruébalo o recházalo. No supongas que cada git push o cambio de esquema se detiene automáticamente; esa política pertenece a la configuración guardada del pipeline.",
    "8. Confirm the configured end state": "8. Confirma el estado final configurado",
    "Verify the execution record, card column and status, activity events, and any expected branch or pull request against the lifecycle you saved. If those expectations differ, preserve the logs and use the troubleshooting page instead of manually forcing the card forward.":
      "Contrasta el registro de ejecución, la columna y el estado de la tarjeta, los eventos de actividad y cualquier rama o pull request esperado con el ciclo de vida que guardaste. Si no coinciden, conserva los logs y usa la página de solución de problemas en lugar de forzar manualmente el avance de la tarjeta.",
    "Stop with SIGINT. The runner enters a graceful drain for up to 60 seconds before exit. Restart it with the same explicit config and confirm it authenticates and returns to the work loop without regenerating identity or configuration.":
      "Detén el proceso con SIGINT. El runner entra en un drenaje controlado de hasta 60 segundos antes de salir. Reinícialo con la misma configuración explícita y confirma que se autentique y vuelva al ciclo de trabajo sin regenerar la identidad ni la configuración.",
    "Keep the first run deliberately small": "Mantén deliberadamente pequeña la primera ejecución",
    "Use one reversible card and acceptance criteria you can inspect. The goal is to validate distribution, configuration, authority, execution, and evidence before entrusting a larger backlog.":
      "Usa una tarjeta reversible y criterios de aceptación que puedas inspeccionar. El objetivo es validar la distribución, la configuración, la autoridad, la ejecución y la evidencia antes de confiar un backlog mayor.",
  },
  "troubleshooting-your-first-run": {
    "Diagnose from evidence in the runner terminal, backend logs, execution history, and activity feed. Avoid moving a card manually until you know whether it was never eligible, never claimed, or failed after claim.":
      "Diagnostica a partir de la evidencia del terminal del runner, los logs del backend, el historial de ejecuciones y el feed de actividad. Evita mover manualmente una tarjeta hasta saber si nunca fue elegible, nunca se asignó o falló después de la asignación.",
    "Run doctor against the exported config first": "Ejecuta primero doctor contra la configuración exportada",
    "The generated runner filename is not auto-discovered. Use the same environment and explicit file that the work loop will use.":
      "El nombre generado del archivo del runner no se descubre automáticamente. Usa el mismo entorno y el mismo archivo explícito que usará el ciclo de trabajo.",
    "Read-only first-run preflight": "Comprobación inicial de solo lectura",
    "The runner refuses platform authority": "El runner rechaza la autoridad de la plataforma",
    "A startup error about a missing pipeline config, stages, or roles means the backend did not return executable authority. Confirm the runner is bound to a workspace team, the pipeline is saved and non-empty, and at least one effective role remains. With no team binding the runner does not receive a pipeline; an empty role list on an existing membership means all pipeline roles.":
      "Un error de inicio sobre una configuración de pipeline, etapas o roles ausentes significa que el backend no devolvió autoridad ejecutable. Confirma que el runner esté vinculado a un equipo del espacio de trabajo, que el pipeline esté guardado y no esté vacío y que quede al menos un rol efectivo. Sin vínculo de equipo, el runner no recibe un pipeline; una lista de roles vacía en una membresía existente significa todos los roles del pipeline.",
    "The configured workspace or board is rejected": "Se rechaza el espacio de trabajo o tablero configurado",
    "A runner cannot quietly claim outside its allowed workspace. If the exported workspace or board no longer matches its server-side scope, authentication or configuration validation reports the mismatch. Re-export for the intended board or correct the runner scope in the UI; do not reuse a bundle from another workspace.":
      "Un runner no puede asumir trabajo silenciosamente fuera de su espacio autorizado. Si el espacio o tablero exportado ya no coincide con su alcance en el servidor, la autenticación o la validación de configuración informa la diferencia. Vuelve a exportar para el tablero previsto o corrige el alcance del runner en la interfaz; no reutilices un paquete de otro espacio de trabajo.",
    "Cards remain unclaimed": "Las tarjetas permanecen sin asignar",
    "Compare the card's column type, not its visible column name, with the stage discover column type.":
      "Compara el tipo de columna de la tarjeta, no el nombre visible de la columna, con el tipo de columna de descubrimiento de la etapa.",
    "Confirm the runner's effective team roles include the stage role. A non-empty membership list is a restriction; an empty list grants all pipeline roles.":
      "Confirma que los roles efectivos del equipo del runner incluyan el rol de la etapa. Una lista de membresía no vacía es una restricción; una lista vacía concede todos los roles del pipeline.",
    "Check budget, dependencies, gates, existing claims, and any board or repository requirements reported by next-assignment.":
      "Comprueba el presupuesto, las dependencias, los gates, las asignaciones existentes y cualquier requisito del tablero o repositorio informado por next-assignment.",
    "Inspect health_config_errors. When an effective role has no required prompt, platform-authority validation drops that role before claims; the card remains unclaimed rather than entering an awaiting-prompt state.":
      "Inspecciona health_config_errors. Cuando un rol efectivo no tiene un prompt obligatorio, la validación de autoridad de la plataforma descarta ese rol antes de las asignaciones; la tarjeta permanece sin asignar en lugar de entrar en un estado de espera de prompt.",
    "The backend appends missing lifecycle roles to scheduling priority during validation, so manually editing priority order is not the normal fix for a newly added role. Repair the reported pipeline or role error instead.":
      "El backend añade durante la validación los roles del ciclo de vida que falten a la prioridad de planificación; por ello, editar manualmente el orden de prioridad no es la corrección habitual para un rol nuevo. Corrige el error informado del pipeline o del rol.",
    "The coding-agent process exits": "El proceso del agente de código termina",
    "Verify the provider selected by the runner config. claude-cli requires the Claude CLI and its login or configured token; codex-cli requires the Codex CLI and its own authentication. The runner intentionally removes an inherited ANTHROPIC_API_KEY before launching Claude when its provider contract selects subscription or explicit configured auth, so a random parent-shell key is not a reliable fallback.":
      "Verifica el proveedor seleccionado por la configuración del runner. claude-cli requiere la CLI de Claude y su inicio de sesión o token configurado; codex-cli requiere la CLI de Codex y su propia autenticación. El runner elimina intencionalmente una ANTHROPIC_API_KEY heredada antes de iniciar Claude cuando el contrato del proveedor selecciona suscripción o autenticación configurada explícitamente; por eso, una clave casual del shell padre no es una alternativa fiable.",
    "Loop launch verifies the selected MCP configuration and required completion tools before model invocation. Local provider diagnostics report the executable, installation and version, and check recognized runtime dependencies. These diagnostics do not verify account or model access. Use the complete provider installation when a bundled inspection companion is missing. The TUI confirms providers required by the board independently from the source-model override and saves them with the selected profile.":
      "El inicio del bucle verifica la configuración MCP seleccionada y las herramientas de finalización necesarias antes de invocar el modelo. Los diagnósticos locales del proveedor muestran el ejecutable, la instalación y la versión, y comprueban las dependencias de ejecución reconocidas. Estos diagnósticos no verifican el acceso a la cuenta ni al modelo. Usa la instalación completa del proveedor si falta un ejecutable auxiliar de inspección incluido. La TUI confirma los proveedores requeridos por el tablero independientemente de la selección temporal del modelo de implementación y los guarda con el perfil seleccionado.",
    "A claimed card stops progressing": "Una tarjeta asignada deja de avanzar",
    "Open its execution record before changing the column. Look for model exit status, timeout, approval state, git clone or forge errors, budget rejection, and the lifecycle action that was expected to move the card. Missing prompt configuration is normally caught before claim, so do not diagnose every stalled card as a prompt gap.":
      "Abre su registro de ejecución antes de cambiar la columna. Busca el estado de salida del modelo, timeouts, estado de aprobación, errores de clonación git o del forge, rechazo por presupuesto y la acción del ciclo de vida que debía mover la tarjeta. La configuración de prompts ausente se suele detectar antes de la asignación; no diagnostiques cada tarjeta detenida como una carencia de prompt.",
    "Events are delayed": "Los eventos llegan con retraso",
    "If the WebSocket cannot connect through a firewall or proxy, the runner can continue with HTTP polling at its configured interval. Startup also polls once immediately. Persistent delay after a healthy connection needs timestamps from stdout and the activity feed, not an assumption that the first interval has not elapsed.":
      "Si el WebSocket no puede conectarse a través de un firewall o proxy, el runner puede continuar con consultas HTTP en el intervalo configurado. Durante el inicio también consulta una vez inmediatamente. Un retraso persistente después de una conexión saludable requiere marcas temporales de stdout y del feed de actividad, no la suposición de que aún no transcurre el primer intervalo.",
    "Collect a useful failure report": "Recopila un informe de fallo útil",
    "Record the runner version, config filename, workspace and board IDs, failing stage and role, doctor result, relevant sanitized runner and backend log lines, execution ID, and timestamps. Never include the vlr_ key, provider tokens, cookies, or full secret-bearing config.":
      "Registra la versión del runner, el nombre del archivo de configuración, los IDs del espacio de trabajo y tablero, la etapa y el rol que fallaron, el resultado de doctor, las líneas relevantes y sanitizadas de los logs del runner y backend, el ID de ejecución y las marcas temporales. Nunca incluyas la clave vlr_, tokens de proveedores, cookies ni la configuración completa con secretos.",
    "The Observer Panel and /{slug}/history provide the event trail. Continue with Debugging a Stuck Card under Operating the Platform when the first-run checks pass but the execution still diverges from the saved lifecycle.":
      "El Panel del observador y /{slug}/history proporcionan el rastro de eventos. Continúa con Depuración de una tarjeta bloqueada, dentro de Operar la plataforma, cuando las comprobaciones iniciales funcionen pero la ejecución aún difiera del ciclo de vida guardado.",
  },
} as const;
