// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_CONFIGURATION = {
  "pipeline-builder": {
    "A workspace's ": "El ",
    " is the platform-owned contract that tells a Runner which roles exist, which ordered steps each role executes, and how work is scheduled. The current builder exposes one shared lifecycle draft through three views: Graph, Tree, and the legacy Form. Switching views does not create a second config or discard unsaved edits.": " es el contrato controlado por la plataforma que indica al Runner qué roles existen, qué pasos ordenados ejecuta cada rol y cómo se planifica el trabajo. El constructor actual muestra un único borrador de ciclo de vida compartido en tres vistas: Graph, Tree y el Form heredado. Cambiar de vista no crea otra configuración ni descarta los cambios sin guardar.",
    "Graph is the default operational view. Advanced opens Tree by default; the legacy Form remains available as an escape hatch while Tree earns trust. All three views read and save through": "Graph es la vista operativa predeterminada. Advanced abre Tree de forma predeterminada; el Form heredado sigue disponible como alternativa mientras Tree gana confianza. Las tres vistas leen y guardan mediante",
    ", so they serialize the same": ", por lo que serializan las mismas",
    " arrays back to the backend.": " y las envían al backend.",
    "Graph, Tree, and the legacy Form are three editors over one lifecycle draft, not three pipeline formats.": "Graph, Tree y el Form heredado son tres editores de un mismo borrador de ciclo de vida, no tres formatos de pipeline.",
    "The lifecycle is the canonical path": "El ciclo de vida es la ruta canónica",
    "Each stage has a free-form, pipeline-unique ": "Cada etapa tiene un ",
    " and an ordered ": " de formato libre y único en el pipeline, y una lista ",
    " list. Every step has a role-local, unique ": " ordenada. Cada paso tiene un ",
    ", a closed-set ": " único dentro del rol, un ",
    ", optional": " de conjunto cerrado, ",
    ", and routing through ": " opcionales y rutas mediante ",
    ", or ": " o ",
    ". Step names are the graph addresses: every routing target must name another step in the same role.": ". Los nombres de los pasos son las direcciones del gráfico: cada destino de enrutamiento debe identificar otro paso del mismo rol.",
    "A lifecycle-backed reviewer stage": "Una etapa de revisión basada en el ciclo de vida",
    "Lifecycle and legacy fields are not two active paths": "El ciclo de vida y los campos heredados no son dos rutas activas",
    "When lifecycle is non-empty, the Runner executes the lifecycle walker and ignores the legacy flat ": "Cuando lifecycle no está vacío, el Runner ejecuta el recorrido del ciclo de vida e ignora durante la ejecución los bloques planos heredados ",
    ", and ": " y ",
    " blocks at runtime. When lifecycle is empty, the Runner uses those flat blocks for backward compatibility with older persisted configs. New pipelines should express execution in ": ". Cuando lifecycle está vacío, el Runner usa esos bloques planos por compatibilidad con configuraciones persistidas antiguas. Los pipelines nuevos deben expresar la ejecución en ",
    "What each view is for": "Para qué sirve cada vista",
    "Graph": "Graph",
    " is the primary visual surface. It shows Runner lanes, roles, step routing, branch decisions, terminals, and health findings. It can edit the same draft in place.": " es la superficie visual principal. Muestra carriles de runners, roles, rutas entre pasos, decisiones de ramas, terminales y hallazgos de estado. Permite editar el mismo borrador sin cambiar de contexto.",
    "Tree": "Tree",
    " is the default Advanced editor. It expands configuration, scheduling, roles, steps, and property groups while keeping the lifecycle hierarchy visible.": " es el editor Advanced predeterminado. Despliega la configuración, la planificación, los roles, los pasos y los grupos de propiedades sin ocultar la jerarquía del ciclo de vida.",
    "legacy Form": "Form heredado",
    " is the nested lifecycle form kept as a secondary fallback. It does not switch execution back to the flat legacy stage model.": " es el formulario anidado del ciclo de vida que se conserva como alternativa secundaria. No devuelve la ejecución al modelo plano de etapas heredado.",
    "Routing and validation": "Enrutamiento y validación",
    "A step may use ": "Un paso puede usar ",
    " for an unconditional edge or": " para una conexión incondicional o ",
    " for decision-dependent edges, but not both.": " para conexiones que dependen de una decisión, pero no ambos.",
    " is a separate error edge. The client catches duplicate step names, dangling targets, and the": " es una conexión de error independiente. El cliente detecta nombres de pasos duplicados, destinos inexistentes y el conflicto entre ",
    "-plus-": " y ",
    " conflict before save; the backend validates the complete pipeline against the lifecycle-kind registry.": " antes de guardar; el backend valida el pipeline completo contra el registro de tipos de ciclo de vida.",
    "The closed kind catalog includes discovery, claims, git setup, skills setup, LLM and sensor work, labels and notes, explicit branches, PR operations, MCP calls, role wake-ups, card movement, shipping, and terminal steps. The builder fetches that catalog from": "El catálogo cerrado de tipos incluye descubrimiento, asignación, preparación de git, preparación de habilidades, trabajo de LLM y sensores, etiquetas y notas, ramas explícitas, operaciones de PR, llamadas MCP, activación de roles, movimiento de tarjetas, entrega y pasos terminales. El constructor obtiene ese catálogo desde",
    "One of those kinds is easy to miss on older boards:":
      "Uno de esos tipos pasa desapercibido con facilidad en tableros antiguos:",
    " materializes the board's bound":
      " materializa las ",
    skills: "habilidades",
    " into the working tree before the LLM launches. A stored pipeline saved before the skills registry existed does not gain the step retroactively — add it after":
      " vinculadas al tablero en el árbol de trabajo antes de que se inicie el LLM. Un pipeline guardado antes de que existiera el registro de habilidades no incorpora el paso de forma retroactiva: agrégalo después de",
    " in each role that should receive skills, or nothing materializes.":
      " en cada rol que deba recibir habilidades, o no se materializará nada.",
    "; adding a new runtime kind requires backend, frontend, and Runner parity.": "; agregar un nuevo tipo de ejecución exige paridad entre backend, frontend y Runner.",
    "Scheduling": "Planificación",
    " names every role the scheduler may select. ": " enumera todos los roles que puede seleccionar el planificador. ",
    " chooses the first role with claimable work; ": " elige el primer rol con trabajo asignable; ",
    " advances across roles and skips those in idle cooldown. Scheduling chooses which role runs next. The role's lifecycle decides what that role does.": " avanza entre los roles y omite los que están en pausa por inactividad. La planificación decide qué rol se ejecuta a continuación. El ciclo de vida del rol determina qué hace ese rol.",
    "Saving and conflicts": "Guardado y conflictos",
    "Saves use optimistic concurrency through": "El guardado usa concurrencia optimista mediante",
    ". A stale save returns 409 and leaves the local draft intact. The conflict banner can reload the server version or deliberately overwrite it with the current draft; there is no automatic three-way merge.": ". Un guardado obsoleto devuelve 409 y conserva intacto el borrador local. El aviso de conflicto permite recargar la versión del servidor o sobrescribirla deliberadamente con el borrador actual; no existe un merge automático de tres vías.",
    "The builder is not a separate pipeline authority": "El constructor no es una autoridad independiente del pipeline",
    "The UI does not keep a private pipeline copy and the Runner does not prefer local defaults. A successful save updates the platform's": "La interfaz no conserva una copia privada del pipeline y el Runner no prioriza valores locales predeterminados. Un guardado correcto actualiza el",
    "; the Runner fetches that platform-owned value. The same config can also be read or updated through MCP.": " de la plataforma; el Runner obtiene ese valor controlado por la plataforma. La misma configuración también puede leerse o actualizarse mediante MCP.",
    "The legacy Form is intentionally still reachable": "El Form heredado sigue disponible de forma intencional",
    "Tree is the default Advanced editor, but the older nested form remains available and its selection persists locally. That is a migration aid, not a second schema. Both surfaces serialize through the same draft and save path.": "Tree es el editor Advanced predeterminado, pero el formulario anidado anterior sigue disponible y su selección se conserva localmente. Es una ayuda para la migración, no un segundo esquema. Ambas superficies serializan el mismo borrador y usan la misma ruta de guardado."
  },
  "prompt-authoring-guide": {
    "A runner's LLM prompt is the contract between your pipeline intent and the model's output. The platform resolves a prompt in three layers, stamps a post-process imperative on it based on the stage's":
      "El prompt de LLM de un runner es el contrato entre la intención del pipeline y la salida del modelo. La plataforma resuelve cada prompt en tres capas, le agrega una instrucción imperativa de posproceso según el",
    ", and renders the Go template against the card context before the model sees a single token. Everything in this page describes that flow.":
      " de la etapa y renderiza la plantilla de Go con el contexto de la tarjeta antes de que el modelo vea un solo token. Todo lo descrito en esta página corresponde a ese flujo.",
    "Three layers": "Tres capas",
    "When a stage's LLM phase fires, the agent resolves the template for the ":
      "Cuando se activa la fase LLM de una etapa, el agente resuelve la plantilla para el par ",
    " pair through a three-layer lookup.":
      " mediante una búsqueda en tres capas.",
    "Registry.": "Registro.",
    " The platform seeds a library of default prompts on first workspace access (see":
      " La plataforma inicializa una biblioteca de prompts predeterminados al acceder por primera vez al espacio de trabajo (consulta",
    "). This covers the seeded personas — implementer, reviewer, documentator, researcher, planner.":
      "). Esto cubre las personas iniciales: implementador, revisor, responsable de documentación, investigador y planificador.",
    "Synthesis.": "Síntesis.",
    " For a ": " Para un par ",
    " pair that isn't in the registry, the platform synthesizes a minimal template with the canonical variables and the post-process imperative. Custom roles start here.":
      " que no esté en el registro, la plataforma sintetiza una plantilla mínima con las variables canónicas y la instrucción de posproceso. Los roles personalizados parten desde aquí.",
    "Override.": "Anulación.",
    " An operator-authored row in":
      " Una fila creada por un operador en",
    " scoped to": " con alcance de",
    " wins over both. This is where you shape behavior for a specific workspace.":
      " prevalece sobre las dos capas anteriores. Aquí se define el comportamiento de un espacio de trabajo específico.",
    "The Go agent also carries hardcoded fallbacks for the seeded personas so a fresh runner can tick before the platform's cache has warmed. This is a resilience net, not an escape hatch — platform authority means the override in ":
      "El agente de Go también incluye fallbacks hardcodeados para las personas iniciales, de modo que un runner nuevo pueda ejecutar un ciclo antes de que la caché de la plataforma esté preparada. Es una medida de resiliencia, no una vía de escape: el principio de autoridad de la plataforma establece que la anulación en ",
    " is the source of truth in any case of disagreement.":
      " es la fuente de verdad ante cualquier discrepancia.",
    "The editor shows the raw template; the preview shows what the runner will send after variable substitution and imperative splicing.":
      "El editor muestra la plantilla sin procesar; la vista previa muestra lo que enviará el runner después de sustituir variables e insertar la instrucción imperativa.",
    "Template variables": "Variables de plantilla",
    "Templates are rendered with Go's ":
      "Las plantillas se renderizan con la sintaxis ",
    " syntax against a context struct assembled by the agent. The canonical variables available in every template:":
      " de Go y una estructura de contexto armada por el agente. Estas son las variables canónicas disponibles en todas las plantillas:",
    " — the UUID of the claimed card.":
      ": el UUID de la tarjeta tomada.",
    " and ": " y ",
    " — the card's display fields.":
      ": los campos visibles de la tarjeta.",
    " — board definition coding standards plus pinned notes, injected when":
      ": los estándares de programación de la definición del tablero, junto con las notas fijadas; se inyecta cuando",
    ". Empty otherwise.": ". En los demás casos queda vacío.",
    " — prior review notes on the card, newest-first. Usually empty on the first tick, populated on rework.":
      ": notas de revisiones anteriores de la tarjeta, comenzando por la más reciente. Normalmente está vacío en el primer ciclo y se completa durante el retrabajo.",
    " — a structured plan field, populated only when a planner stage ran upstream.":
      ": un campo de plan estructurado que solo se completa si anteriormente se ejecutó una etapa de planificación.",
    "Minimal reviewer template using the standard variables":
      "Plantilla mínima de revisor con las variables estándar",
    "The template body stops there. The post-process imperative — the line that tells the model how to format its output — is not something you write into the template. The engine appends it.":
      "El cuerpo de la plantilla termina ahí. La instrucción imperativa de posproceso, es decir, la línea que indica al modelo cómo dar formato a su salida, no se escribe dentro de la plantilla: el motor la agrega.",
    "Post-process imperatives": "Instrucciones imperativas de posproceso",
    "This is the section that saves you from six weeks of prompt debugging.":
      "Esta sección puede ahorrarte seis semanas de depuración de prompts.",
    "The stage's ": "El ",
    " picks which imperative gets spliced onto the end of the rendered template before it reaches the model. The four kinds map to four imperatives:":
      " de la etapa determina qué instrucción se inserta al final de la plantilla renderizada antes de llegar al modelo. Los cuatro tipos corresponden a cuatro instrucciones:",
    " — \"Make the changes directly in the working tree. Do not return code in your response.\" The engine then commits and pushes.":
      " — \"Make the changes directly in the working tree. Do not return code in your response.\" Después, el motor hace commit y push.",
    " — \"Emit a single JSON object with a":
      " — \"Emit a single JSON object with a ",
    " field. Do not write code. Do not create notes.\" The decision string indexes into":
      " field. Do not write code. Do not create notes.\" La cadena de decisión selecciona una entrada de",
    " — \"Emit structured markdown findings. The platform will attach them to the card as a review note.\" No git.":
      " — \"Emit structured markdown findings. The platform will attach them to the card as a review note.\" Sin git.",
    " — \"Use the available MCP tools to create or update cards. The platform records the summary only.\" No git, no note.":
      " — \"Use the available MCP tools to create or update cards. The platform records the summary only.\" Sin git ni nota.",
    "Picking the kind is the single most important design choice in the stage. A reviewer with ":
      "Elegir el tipo es la decisión de diseño más importante de la etapa. Un revisor con ",
    " will try to edit code instead of producing a decision. An implementer with":
      " intentará editar código en lugar de producir una decisión. Un implementador con",
    " will emit JSON and never commit. If your runs consistently drift from what you wanted, check the kind before you rewrite the template.":
      " emitirá JSON y nunca hará commit. Si tus ejecuciones se alejan sistemáticamente del resultado esperado, comprueba el tipo antes de reescribir la plantilla.",
    "Do not hand-write the imperative into your template":
      "No escribas manualmente la instrucción imperativa en la plantilla",
    "The engine always splices the imperative. If you also write it into the template body, the model gets two imperatives — one from you and one auto-appended — which fight each other in subtle ways. Keep the template to the task description and the variables. Let the kind switch do its job.":
      "El motor siempre inserta la instrucción imperativa. Si también la escribes en el cuerpo de la plantilla, el modelo recibe dos instrucciones, una tuya y otra agregada automáticamente, que pueden contradecirse de formas sutiles. Limita la plantilla a la descripción de la tarea y las variables. Deja que el selector de tipo haga su trabajo.",
    "Override scope": "Alcance de una anulación",
    "An override in ": "Una anulación en ",
    " is keyed by a five-tuple:": " se identifica mediante una tupla de cinco elementos:",
    ". Workspace and role scope the \"who\"; stage scopes the \"when\" (which ticking phase); team scopes to an agent team when you want a subset of runners to use a variant. The ":
      ". El espacio de trabajo y el rol delimitan \"quién\"; la etapa delimita \"cuándo\", es decir, en qué fase del ciclo; y el equipo limita el uso a un equipo de agentes cuando se desea que solo un subconjunto de runners utilice una variante. El ",
    " is the friendly-ID for a specific prompt revision — you can keep multiple variants named":
      " es el identificador legible de una revisión específica del prompt: puedes conservar varias variantes llamadas",
    " and switch between them without losing the others.":
      " y alternar entre ellas sin perder las demás.",
    "Resolution walks most-specific to least-specific. A prompt authored for a specific team beats a workspace-wide one; a workspace-wide override beats the registry default; the registry default beats the synthesized placeholder.":
      "La resolución avanza desde lo más específico hasta lo más general. Un prompt creado para un equipo concreto prevalece sobre uno de todo el espacio de trabajo; una anulación del espacio de trabajo prevalece sobre el valor predeterminado del registro; y este último prevalece sobre la plantilla sintetizada.",
    "The editor is a plain textarea today":
      "Actualmente, el editor es un área de texto simple",
    "The prompt editor renders a plain ":
      "El editor de prompts muestra un ",
    " with no syntax highlighting, no template-variable autocomplete, no preview of the spliced imperative, and no diff-against-default. You can paste a five-paragraph prompt into it and it will accept. Whether the runner uses it correctly is between you and the model. A richer editor is on the roadmap; in the meantime, draft complex prompts in your editor of choice and paste the final.":
      " sin resaltado de sintaxis, autocompletado de variables de plantilla, vista previa de la instrucción insertada ni comparación con el valor predeterminado. Puedes pegar un prompt de cinco párrafos y lo aceptará. Que el runner lo use correctamente dependerá de ti y del modelo. Está previsto crear un editor más completo; mientras tanto, redacta los prompts complejos en el editor que prefieras y pega la versión final.",
    "MCP is the path of least resistance for authoring":
      "MCP es el camino más directo para crear prompts",
    "The MCP server exposes ": "El servidor MCP expone las herramientas ",
    " and": " y",
    " tools. When you're iterating on a prompt from an agent client (Claude Desktop, Cursor, your own MCP consumer), calling those tools is faster than the UI — no context-switch, no copy-paste, and the tool response shows you the resolved prompt after substitution. The UI exists for the case where you don't have an MCP client connected to the workspace.":
      ". Al iterar sobre un prompt desde un cliente de agente, como Claude Desktop, Cursor o un consumidor MCP propio, invocar estas herramientas es más rápido que usar la interfaz: no hay cambio de contexto ni copiar y pegar, y la respuesta muestra el prompt resuelto después de sustituir las variables. La interfaz cubre el caso en que no tienes un cliente MCP conectado al espacio de trabajo.",
  },
  "custom-roles": {
    "The design principle is blunt: any role with any rules and any prompts must be user-expressible end-to-end. If the platform only supports a closed set of roles, it's a software-delivery tool pretending to be extensible. The pipeline builder, the prompt registry, and the engine's post-process dispatch were built so that adding a":
      "El principio de diseño es tajante: el usuario debe poder expresar de extremo a extremo cualquier rol con cualquier conjunto de reglas y prompts. Si la plataforma solo admite un conjunto cerrado de roles, es una herramienta de entrega de software que finge ser extensible. El constructor de pipelines, el registro de prompts y el despacho de posproceso del motor se diseñaron para que agregar un",
    ", a ": ", un ",
    ", or a Spanish": " o un ",
    " is a config change, not a code change.":
      " en español sea un cambio de configuración, no de código.",
    "This page describes the three things that make that true: free-form role strings on stages, per-stage uniqueness flags, and automatic prompt synthesis for any role the registry hasn't heard of.":
      "Esta página describe los tres elementos que lo hacen posible: cadenas de rol de formato libre en las etapas, indicadores de unicidad por etapa y síntesis automática de prompts para cualquier rol que el registro aún no conozca.",
    "Declare a custom role": "Declarar un rol personalizado",
    "A stage's ": "El campo ",
    " field is a free-form string. There is no enum, no registration step, no \"role catalog\" to update. Paste the stage into your ":
      " de una etapa es una cadena de formato libre. No hay un enum, un paso de registro ni un \"catálogo de roles\" que actualizar. Pega la etapa en tu ",
    ", wire the discover and LLM fields like any seeded role, and the next agent heartbeat starts ticking it.":
      ", conecta los campos de descubrimiento y LLM como en cualquier rol inicial y el siguiente heartbeat del agente comenzará a ejecutarla.",
    "A custom security-auditor stage":
      "Una etapa personalizada de auditoría de seguridad",
    "The role string flows everywhere: it's the scheduler priority entry, the participant role stamped on the card, the filter key for":
      "La cadena del rol se propaga a todo el sistema: es la entrada de prioridad del planificador, el rol de participante registrado en la tarjeta, la clave de filtro de",
    ", and the partition key the prompt registry looks up.":
      " y la clave de partición que consulta el registro de prompts.",
    "Uniqueness flag": "Indicador de unicidad",
    "Every stage carries an implicit uniqueness contract — one":
      "Cada etapa contiene un contrato implícito de unicidad: un",
    " per card — and an optional per-stage":
      " por tarjeta, además de un indicador opcional por etapa",
    ". When ": ". Cuando ",
    " is true, a single agent at a time can hold the participant slot for that role on a given card; other agents skip the card until the holder releases or completes. When false (the default for custom roles), multiple agents can claim the same card in that role concurrently — useful for helper-style roles where parallelism helps and conflict is unlikely.":
      " es true, un solo agente a la vez puede ocupar el espacio de participante de ese rol en una tarjeta; los demás agentes la omiten hasta que quien lo ocupa la libere o termine. Cuando es false, el valor predeterminado para roles personalizados, varios agentes pueden tomar simultáneamente la misma tarjeta con ese rol. Esto resulta útil para roles de colaboración donde el paralelismo ayuda y los conflictos son poco probables.",
    "The seeded personas set uniqueness conservatively: orchestrator is":
      "Las personas iniciales configuran la unicidad de forma conservadora: orchestrator es",
    " and therefore unique by construction; reviewer is":
      " y, por lo tanto, es único por definición; reviewer usa",
    " so two reviewers don't race on the same PR; documentator is not unique. For a custom role, start with the default and turn uniqueness on if you observe races.":
      " para evitar que dos revisores compitan por el mismo PR; documentator no es único. Para un rol personalizado, comienza con el valor predeterminado y activa la unicidad si observas condiciones de carrera.",
    "priority_order must list every role you declare":
      "priority_order debe incluir todos los roles declarados",
    "Scheduling reads the full set of role strings from":
      "La planificación lee el conjunto completo de cadenas de rol desde",
    " and compares them against": " y las compara con",
    ". A role that isn't in": ". Un rol que no esté en",
    " never gets offered a tick — the validator emits ":
      " nunca recibe un ciclo de trabajo. El validador emite ",
    " only for the inverse case (an entry with no matching stage). Adding a stage without also adding its role to the order list is silent starvation.":
      " solo para el caso inverso, cuando existe una entrada sin una etapa correspondiente. Agregar una etapa sin incorporar también su rol a la lista de orden provoca una espera indefinida y silenciosa.",
    "Synthesis — custom roles are never second-class":
      "Síntesis: los roles personalizados nunca son de segunda categoría",
    "When a stage's ": "Cuando el par ",
    " pair isn't in the prompt registry, the platform doesn't fail — it synthesizes a minimal placeholder template. The placeholder contains the canonical template variables (":
      " de una etapa no está en el registro de prompts, la plataforma no falla: sintetiza una plantilla mínima provisional. Esta contiene las variables canónicas de plantilla (",
    ") and the post-process imperative inferred from ":
      ") y la instrucción de posproceso inferida de ",
    ". The custom role ticks immediately with sensible defaults, and you edit the prompt through the normal authoring flow when you want to refine behavior.":
      ". El rol personalizado comienza a ejecutarse de inmediato con valores predeterminados razonables, y puedes editar el prompt mediante el flujo normal de creación cuando quieras ajustar su comportamiento.",
    "The \"Prompts\" page in the workspace config surface lists every":
      "La página \"Prompts\" del área de configuración del espacio de trabajo muestra cada par",
    " pair the platform has seen — seeded, synthesized, or overridden — with a status badge so you can tell at a glance which are running against scaffolding and which have been shaped by an operator. Synthesis is a starting line, not a ceiling.":
      " que la plataforma ha visto, ya sea inicial, sintetizado o anulado, junto con una insignia de estado para distinguir de un vistazo cuáles funcionan con una estructura provisional y cuáles fueron configurados por un operador. La síntesis es el punto de partida, no un límite.",
    "The 2026-04-18 walkthrough defined 'Secretario' and it ran":
      "El recorrido del 18-04-2026 definió 'Secretario' y funcionó",
    "Part of the end-to-end runner-launch walkthrough added a":
      "Como parte del recorrido de lanzamiento de un runner de extremo a extremo, se agregó un rol",
    " role (a Spanish-named note-taking persona) with ":
      ", una persona para tomar notas cuyo nombre estaba en español, con ",
    ", no git, and a minimal prompt. It ticked successfully on the second heartbeat after the pipeline save, produced a review note, and moved the card to Done without a code change anywhere in the stack. Eleven other bugs surfaced that day — but the extensibility contract held.":
      ", sin git y con un prompt mínimo. Se ejecutó correctamente en el segundo heartbeat después de guardar el pipeline, produjo una nota de revisión y movió la tarjeta a Completado sin cambiar código en ningún punto del stack. Ese día aparecieron otros once bugs, pero el contrato de extensibilidad se mantuvo.",
    "What still gates you": "Limitaciones pendientes",
    "Custom roles are first-class on the pipeline side. A few things on the runtime side are not yet:":
      "Los roles personalizados son elementos de primera clase en el pipeline. Algunos aspectos del runtime todavía no lo son:",
    "Per-role LLM provider/model.": "Proveedor y modelo de LLM por rol.",
    " Every role runs against whatever model the agent binary was compiled against — today, Claude via the ":
      " Todos los roles se ejecutan con el modelo para el cual se compiló el binario del agente; actualmente, Claude mediante la CLI ",
    " CLI. A pipeline that wants a cheap role for triage and an expensive role for review can't express that yet. See":
      ". Todavía no es posible expresar un pipeline con un rol económico para clasificación y otro más costoso para revisión. Consulta",
    "Under the Hood — Model-Agnostic Roles":
      "Bajo el capó: roles independientes del modelo",
    "Skills as bundles.": "Habilidades como paquetes.",
    " Procedural knowledge now ships as versioned ":
      " El conocimiento procedimental ya se distribuye como ",
    "skill bundles": "paquetes de habilidades versionados",
    "a board binds and the runner materializes into the working tree. What still doesn't exist is the role-level bundle — tools plus prompt partials plus rules as a named unit a new role can inherit from an existing one. Every stage declares its tool list inline.":
      "que un tablero vincula y el runner materializa en el árbol de trabajo. Lo que todavía no existe es el paquete a nivel de rol: herramientas, fragmentos de prompts y reglas como una unidad con nombre que un rol nuevo pueda heredar de otro existente. Cada etapa declara su lista de herramientas en línea.",
    "Cross-stage context.": "Contexto entre etapas.",
    " A stage can't read another stage's raw LLM output (beyond what was persisted as participant state or a review note). A blackboard-pattern primitive would unlock richer handoffs; not built.":
      " Una etapa no puede leer la salida sin procesar del LLM de otra etapa, salvo lo que se haya persistido como estado del participante o nota de revisión. Una primitiva basada en el patrón de pizarra permitiría traspasos más completos, pero todavía no existe.",
    "Model-per-role independence is the declared next milestone":
      "La independencia de modelo por rol es el próximo hito declarado",
    "Decoupling the role from the runner binary's model identity is an explicit north-star item. The plumbing is partial today: prompt configs can carry a ":
      "Desacoplar el rol de la identidad de modelo del binario del runner es un objetivo explícito de la visión del producto. Hoy la infraestructura es parcial: las configuraciones de prompts pueden incluir una indicación ",
    " hint, but the Go agent ignores it. The milestone wires that hint end-to-end so a":
      ", pero el agente de Go la ignora. El hito conectará esa indicación de extremo a extremo para que una etapa",
    " stage can run against Claude Haiku while":
      " pueda ejecutarse con Claude Haiku mientras",
    " runs against Opus, in the same pipeline, from the same runner. Tracking issue and design notes live in the feedback archive under ":
      " se ejecuta con Opus dentro del mismo pipeline y desde el mismo runner. El issue de seguimiento y las notas de diseño están en el archivo de feedback, en ",
  },
  sensors: {
    "A ": "Un ",
    sensor: "sensor",
    " is a platform-side check that inspects the output of a stage and decides whether the stage is allowed to progress. Sensors are the feedback half of the harness — the LLM produces a change, the sensor grades it, and the result feeds into the stage's":
      " es un control de la plataforma que inspecciona la salida de una etapa y decide si puede avanzar. Los sensores son la mitad de feedback del harness: el LLM produce un cambio, el sensor lo evalúa y el resultado alimenta la acción ",
    " action. They are the only place in the pipeline where a deterministic verdict (test passed, merge conflict detected) can override the LLM's own claim that the work is done.":
      " de la etapa. Son el único punto del pipeline donde un veredicto determinista, como una prueba aprobada o un conflicto de merge detectado, puede prevalecer sobre la afirmación del propio LLM de que el trabajo está terminado.",
    "The runner registers its sensor catalog on every heartbeat — the backend stores it on ":
      "El runner registra su catálogo de sensores en cada heartbeat; el backend lo almacena en ",
    " and the pipeline validator rejects ":
      " y el validador del pipeline rechaza cualquier ",
    " that references a sensor name no active runner has declared. Operators configure sensors per stage; the runner builds them from the manifest and runs them after the LLM call.":
      " que haga referencia a un nombre de sensor no declarado por ningún runner activo. Los operadores configuran sensores por etapa; el runner los construye a partir del manifiesto y los ejecuta después de la llamada al LLM.",
    "The shipped catalog": "El catálogo incluido",
    "Three sensors ship with the Go runner today, registered in":
      "Actualmente se incluyen tres sensores con el runner de Go, registrados en",
    " and published to the platform via the heartbeat catalog. The ":
      " y publicados en la plataforma mediante el catálogo del heartbeat. El campo ",
    " field is the important distinction: ":
      " establece la distinción importante: los sensores ",
    computational: "computational",
    " sensors are deterministic and fast (linters, test runners, merge-conflict checks).":
      " son deterministas y rápidos, como linters, ejecutores de pruebas y controles de conflictos de merge. Los sensores ",
    Inferential: "Inferential",
    " sensors use an LLM or a remote API and produce a probabilistic verdict that can vary between runs.":
      " utilizan un LLM o una API remota y producen un veredicto probabilístico que puede variar entre ejecuciones.",
    "The three sensors a runner publishes today":
      "Los tres sensores que publica actualmente un runner",
    "The list is intentionally short. ":
      "La lista es deliberadamente breve. ",
    " covers the language-specific test gate for the repos Backplane ships against today; a TypeScript equivalent and a ":
      " cubre el control de pruebas específico del lenguaje para los repositorios con los que trabaja Backplane actualmente; existe seguimiento para un equivalente de TypeScript y un sensor ",
    " sensor are tracked but not yet written. The inferential half is represented by":
      ", pero todavía no se han implementado. La parte inferencial está representada por",
    " and, at the pipeline level, by the reviewer role itself — which is an LLM-driven sensor in everything but name.":
      " y, a nivel del pipeline, por el propio rol de revisor, que es un sensor controlado por LLM salvo en el nombre.",
    "Attaching sensors to a stage": "Vincular sensores a una etapa",
    "A stage carries an optional ": "Una etapa incluye un arreglo opcional ",
    " array. Each entry is a sensor ":
      ". Cada entrada contiene el ",
    " from the catalog plus any config overrides. The runner builds the sensor from the manifest's default config, overlays the stage-level overrides, and invokes":
      " del sensor en el catálogo y cualquier anulación de configuración. El runner construye el sensor con la configuración predeterminada del manifiesto, superpone las anulaciones de la etapa e invoca",
    " after the LLM call. A":
      " después de la llamada al LLM. Un",
    " carries a ": " contiene un booleano ",
    " boolean, an optional score, a list of findings, a human-readable summary, and a duration.":
      ", una puntuación opcional, una lista de hallazgos, un resumen legible y una duración.",
    "A stage with two sensors configured":
      "Una etapa con dos sensores configurados",
    "Fail-open vs fail-closed": "Fail-open frente a fail-closed",
    "If a sensor returns an error (the subprocess couldn't run, the remote API timed out, the binary wasn't in ":
      "Si un sensor devuelve un error, porque el subproceso no pudo ejecutarse, la API remota agotó el tiempo de espera o el binario no estaba en ",
    "), the runner logs it and treats the stage as failing — the":
      ", el runner lo registra y considera que la etapa falló; se aplica la acción ",
    " action applies. This is a deliberate":
      ". Este es un comportamiento deliberado ",
    "fail-closed": "fail-closed",
    " default: we refuse to promote a change past a gate we couldn't evaluate. The alternative — silently passing when the gate is broken — is a correctness bug that hides until the first real regression slips through.":
      ": no permitimos que un cambio supere un control que no pudimos evaluar. La alternativa, aprobar silenciosamente cuando el control está roto, es un bug de corrección que permanece oculto hasta que se filtra la primera regresión real.",
    "If a sensor returns cleanly with ":
      "Si un sensor responde correctamente con ",
    ", the failure is the sensor's actual verdict and the same path runs. The findings are attached to the execution record so the operator can inspect them in the UI without grepping the runner logs.":
      ", el fallo es el veredicto real del sensor y se ejecuta el mismo flujo. Los hallazgos se adjuntan al registro de ejecución para que el operador pueda revisarlos en la interfaz sin buscar en los logs del runner.",
    "The sensor picker only lists sensors the active runner has published. An unrecognized name fails validation at save time.":
      "El selector solo muestra los sensores publicados por el runner activo. Un nombre no reconocido provoca un error de validación al guardar.",
    "The catalog is published by runners, not the backend":
      "El catálogo lo publican los runners, no el backend",
    "If you hit \"save\" on a stage referencing ":
      "Si presionas \"guardar\" en una etapa que hace referencia a ",
    " and see \"unknown sensor name,\" the fix is not in the platform — it is in whichever runner build you expected to own that sensor. The backend computes the known set from the ":
      " y aparece \"nombre de sensor desconocido\", la solución no está en la plataforma, sino en la compilación del runner que esperabas que proporcionara ese sensor. El backend calcula el conjunto conocido a partir de la ",
    union: "unión",
    " of sensor catalogs across active agents in the workspace. A runner that last heartbeated three days ago still counts. Restart the runner you expected to supply the sensor and the catalog refreshes on the next heartbeat.":
      " de los catálogos de sensores de todos los agentes activos del espacio de trabajo. Un runner cuyo último heartbeat fue hace tres días todavía cuenta. Reinicia el runner que debía proporcionar el sensor y el catálogo se actualizará en el siguiente heartbeat.",
    "A declarative sensor DSL is on the roadmap, not shipped":
      "Está previsto un DSL declarativo de sensores, pero aún no está disponible",
    "Adding a new sensor today means writing Go: implement the":
      "Actualmente, agregar un sensor nuevo exige escribir Go: implementar la interfaz",
    " interface, register a factory in the harness registry, cut a runner release. That is a higher bar than the vision document describes. The longer-horizon ambition is a declarative sensor spec — author the check in YAML or JSON, publish it to the platform, have any runner pick it up — so a non-Go operator can add a gate without a binary rebuild. Tracked; not imminent.":
      ", registrar una factory en el registro del harness y publicar una versión del runner. Es una exigencia mayor que la descrita en el documento de visión. A más largo plazo se busca una especificación declarativa de sensores: crear el control en YAML o JSON, publicarlo en la plataforma y permitir que cualquier runner lo tome, de modo que un operador que no programe en Go pueda agregar un control sin recompilar el binario. El trabajo está registrado, pero no es inminente.",
  },
  "approval-categories-and-risk-scoring": {
    "Approvals are the gate a runner crosses before it does something destructive or high-blast-radius. A stage with":
      "Las aprobaciones son el control que debe superar un runner antes de realizar una acción destructiva o de gran impacto. Una etapa con",
    " allows its LLM to emit": " permite que su LLM emita",
    "via MCP. The backend scores the request, auto-approves the cheap ones, and parks the risky ones in a queue the operator drains by hand.":
      "mediante MCP. El backend puntúa la solicitud, aprueba automáticamente las de bajo costo y deja las riesgosas en una cola que el operador procesa manualmente.",
    "Seven categories exist, chosen to cover the action shapes that have cost real money to get wrong. The category is not free-form — an LLM request with an unknown category is rejected before it ever reaches the queue.":
      "Existen siete categorías, elegidas para cubrir los tipos de acciones cuyos errores han tenido un costo real. La categoría no es de formato libre: una solicitud de LLM con una categoría desconocida se rechaza antes de llegar a la cola.",
    "The seven categories": "Las siete categorías",
    "Each category carries a base risk score between 0 and 100. The score is bumped up or down by the action payload — a deletion of a single card scores differently from a bulk delete of forty. The full formula lives in ":
      "Cada categoría tiene una puntuación de riesgo base entre 0 y 100. El payload de la acción aumenta o reduce esa puntuación: eliminar una sola tarjeta no puntúa igual que eliminar cuarenta en lote. La fórmula completa está en ",
    "The category base scores (risk.py)":
      "Puntuaciones base de las categorías (risk.py)",
    "The threshold is an inclusive ceiling: a computed score of 30 or less becomes ":
      "El umbral es un límite inclusivo: una puntuación calculada de 30 o menos pasa a ",
    " at create time and never shows up in the queue. A score of 31 or more becomes ":
      " al momento de crear la solicitud y nunca aparece en la cola. Una puntuación de 31 o más pasa a ",
    ", a row appears in ": ", aparece una fila en ",
    ", and the owning runner sleeps on a WebSocket subscription until a human decides.":
      " y el runner responsable queda a la espera en una suscripción WebSocket hasta que una persona decida.",
    "The ": "La base de 60 de ",
    " base of 60 is deliberate policy, not a tuning accident: an agent-proposed":
      " es una decisión de política deliberada, no un accidente de ajuste: una ",
    skill: "habilidad",
    " must always cross a human — no payload detail lowers it into auto-approve range.":
      " propuesta por un agente siempre debe pasar por una persona; ningún detalle del payload la baja al rango de aprobación automática.",
    "The queue and the decision": "La cola y la decisión",
    "The current API route checks workspace membership but no minimum role: an owner, admin, member, or viewer can approve or reject. The backend publishes":
      "La ruta actual de la API verifica la pertenencia al espacio de trabajo, pero no exige un rol mínimo: propietarios, administradores, miembros y lectores pueden aprobar o rechazar. El backend publica",
    "; the subscribed runner wakes the same tick and re-enters the stage via":
      "; el runner suscrito se activa en el mismo ciclo y vuelve a ingresar a la etapa mediante",
    ". No HTTP polling, no retry gymnastics — the request and the continuation share an approval ID that the runner carries across the gate.":
      ". No hay polling HTTP ni maniobras de reintento: la solicitud y la continuación comparten un ID de aprobación que el runner conserva al cruzar el control.",
    "The risk score is shown next to the category so the operator can triage by blast radius, not arrival order.":
      "La puntuación de riesgo aparece junto a la categoría para que el operador pueda priorizar por alcance del impacto, no por orden de llegada.",
    "Reject is terminal, not a soft veto":
      "El rechazo es definitivo, no un veto temporal",
    "Approving an approval sets status ":
      "Aprobar una solicitud establece el estado ",
    "; rejecting sets ": "; rechazarla establece ",
    ". Both are one-way transitions. A second call to ":
      ". Ambas son transiciones unidireccionales. Una segunda llamada a ",
    " on an already-decided approval returns 409 and mutates nothing. There is no \"reject with chance to retry\" flow — if you want the runner to try again with a different payload, reject, let the stage reach its on-failure action, and let the LLM re-request on its next tick.":
      " sobre una aprobación ya decidida devuelve 409 y no modifica nada. No existe un flujo de \"rechazar con opción de reintento\": si quieres que el runner vuelva a intentarlo con otro payload, rechaza la solicitud, deja que la etapa llegue a su acción de fallo y permite que el LLM cree otra solicitud en el siguiente ciclo.",
    "Expiry and drift": "Vencimiento y desfase",
    "Approvals carry an ": "Las aprobaciones incluyen un ",
    " that defaults to creation time plus 24 hours. Nothing in the backend mutates on expiry today — the row stays in the queue with status ":
      " cuyo valor predeterminado es la hora de creación más 24 horas. Actualmente el backend no modifica nada al vencer: la fila permanece en la cola con estado ",
    " past the deadline; the runner's WebSocket subscription stays open; a late decision still wakes the runner. Operators should treat the 24-hour field as a staleness signal, not a guarantee of auto-rejection.":
      " después del plazo, la suscripción WebSocket del runner sigue abierta y una decisión tardía todavía lo activa. Los operadores deben interpretar el campo de 24 horas como una señal de antigüedad, no como garantía de rechazo automático.",
    "Auto-approve runs before the row is written":
      "La aprobación automática ocurre antes de escribir la fila",
    "Auto-approve is not a background job scanning the queue. The decision happens synchronously inside":
      "La aprobación automática no es una tarea en segundo plano que recorre la cola. La decisión ocurre de forma síncrona dentro de",
    ": if the computed score is at or below ":
      ": si la puntuación calculada es menor o igual que ",
    ", the row is inserted with status ":
      ", la fila se inserta con estado ",
    " and the event fires the same tick. This means tuning the threshold retroactively — by editing ":
      " y el evento se emite en el mismo ciclo. Esto significa que ajustar el umbral retroactivamente, editando ",
    " and redeploying — changes behavior for future requests only. Rows already in the queue keep the status they were written with.":
      " y volviendo a desplegar, solo cambia el comportamiento de las solicitudes futuras. Las filas que ya están en la cola conservan el estado con el que se escribieron.",
    "The risk formula is an in-code heuristic, not a declarative model":
      "La fórmula de riesgo es una heurística en código, no un modelo declarativo",
    "The category base scores, the payload bumps, and the auto-approve threshold are Python constants. They are not workspace-configurable, not exposed through the pipeline builder, not tunable from the UI. A workspace that wants stricter deletion gating, or wants to auto-reject anything above a score of 70, edits ":
      "Las puntuaciones base de las categorías, los ajustes según el payload y el umbral de aprobación automática son constantes de Python. No se pueden configurar por espacio de trabajo, no están expuestos en el constructor de pipelines y no se pueden ajustar desde la interfaz. Un espacio de trabajo que requiera controles más estrictos para eliminaciones o quiera rechazar automáticamente cualquier puntuación superior a 70 debe editar ",
    " and redeploys the backend. This is the sane starting point — the sample size of approvals-in-the-wild was zero when the model was written — and a workspace-level override is on the backlog for when the real data justifies the complexity.":
      " y volver a desplegar el backend. Es un punto de partida razonable: cuando se creó el modelo, la muestra de aprobaciones reales era cero. Existe una anulación por espacio de trabajo en el backlog para cuando los datos reales justifiquen esa complejidad.",
  },
  "budget-and-cost-controls": {
    "An agent's optional ": "El ",
    " is compared with the sum of its ":
      " opcional de un agente se compara con la suma de sus ",
    " values from the trailing 30 days. When ":
      " de los últimos 30 días. Cuando ",
    " is null, there is no agent-level cap; Backplane does not substitute a workspace default. A configured budget is exceeded only when recorded spend is greater than the cap.":
      " es null, no existe un límite a nivel de agente; Backplane no lo reemplaza por un valor predeterminado del espacio de trabajo. Un presupuesto configurado solo se considera excedido cuando el gasto registrado supera el límite.",
    "After discovering a card and before claiming it, the Runner requests":
      "Después de descubrir una tarjeta y antes de tomarla, el Runner solicita",
    ". It skips the claim when the budget is exceeded. If that request fails, including with a 429, the tick fails closed instead of proceeding without a budget decision. The check does not interrupt an execution that is already in flight.":
      ". Omite la toma cuando se excede el presupuesto. Si esa solicitud falla, incluso con un 429, el ciclo se detiene de forma segura en lugar de continuar sin una decisión de presupuesto. La comprobación no interrumpe una ejecución que ya está en curso.",
    "The cap and the panel": "El límite y el panel",
    "The ": "El ",
    " on the Runner detail page shows Budget, Spent, and Remaining. With a configured cap it also shows percentage used, the spent-to-budget values, and a progress bar. An exceeded cap adds a warning badge; a null cap adds a No budget set badge. Editing the numeric field and selecting Save updates":
      " de la página de detalle del Runner muestra Presupuesto, Gastado y Restante. Cuando hay un límite configurado, también muestra el porcentaje usado, los valores de gasto y presupuesto, y una barra de progreso. Un límite excedido añade una insignia de advertencia; un límite null añade la insignia Sin presupuesto definido. Editar el campo numérico y seleccionar Guardar actualiza",
    "The panel reports the rolling budget status returned by the backend and lets an operator replace or clear the cap.":
      "El panel informa el estado móvil del presupuesto que devuelve el backend y permite que un operador reemplace o elimine el límite.",
    "Stored Runner registration fields":
      "Campos almacenados del registro del Runner",
    "Rate limiting": "Limitación de solicitudes",
    " applies fixed, 60-second API buckets: 10 login attempts per client IP, 60 unauthenticated requests per client IP, 300 requests per authenticated user session, and 100 requests for an API-key-shaped Authorization header. The API-key bucket is fixed at 100 requests per minute today. The middleware does not read":
      " aplica buckets fijos de API de 60 segundos: 10 intentos de inicio de sesión por IP de cliente, 60 solicitudes no autenticadas por IP de cliente, 300 solicitudes por sesión de usuario autenticada y 100 solicitudes para un encabezado Authorization con forma de clave de API. El bucket de clave de API está fijo en 100 solicitudes por minuto actualmente. El middleware no lee",
    " is stored on the Agent and returned in its configuration. The Go Runner uses it to pace local LLM provider executions; it does not tune the backend API bucket. An API request beyond its bucket returns 429 with rate-limit headers and":
      " se almacena en el agente y se devuelve en su configuración. El Runner de Go lo utiliza para dosificar localmente las ejecuciones del proveedor de LLM; no ajusta el bucket de la API del backend. Una solicitud de API que excede su bucket devuelve 429 con encabezados de límite de solicitudes y",
    "API-key classification happens before authentication":
      "La clasificación de la clave de API ocurre antes de la autenticación",
    "Any Authorization header that starts exactly with":
      "Cualquier encabezado Authorization que comience exactamente con",
    " receives the API-key tier before the credential is verified. Its bucket identity uses only the first 20 characters of that header. This shape is an implementation risk: different keys with the same prefix can share a bucket, while crafted, unverified values can enter the 100/min tier. Do not treat the middleware as an authorization boundary.":
      " recibe el nivel de clave de API antes de verificar la credencial. La identidad de su bucket utiliza solo los primeros 20 caracteres de ese encabezado. Esta forma supone un riesgo de implementación: claves distintas con el mismo prefijo pueden compartir un bucket, mientras que valores fabricados y sin verificar pueden entrar en el nivel de 100 por minuto. No trates el middleware como un límite de autorización.",
    "Alerts and webhooks": "Alertas y webhooks",
    " has two producers with two different payload shapes. User-defined workspace alert thresholds evaluate":
      " tiene dos productores con dos formas de payload diferentes. Los umbrales de alerta del espacio de trabajo definidos por el usuario evalúan",
    " or ": " o ",
    " and publish": " y publican",
    ". An evaluation can publish again while its condition remains true; there is no durable once-per-period guarantee.":
      ". Una evaluación puede volver a publicar mientras su condición siga siendo verdadera; no existe una garantía durable de una sola publicación por período.",
    "The workspace cost circuit breaker compares the rolling 15-minute sum with ":
      "El circuit breaker de costos del espacio de trabajo compara la suma móvil de 15 minutos con ",
    " and publishes": " y publica",
    ". Its 60-second suppression is process-local and is cleared by Resume. The supported action values are ":
      ". Su supresión de 60 segundos es local al proceso y se borra con Reanudar. Los valores de acción admitidos son ",
    ", and ": ", y ",
    "; today ": "; actualmente ",
    " follows the pause behavior because runner shutdown is not wired.":
      " sigue el comportamiento de pausa porque el apagado del Runner no está conectado.",
    "Webhook subscribers receive either payload inside the standard":
      "Los suscriptores de webhooks reciben cualquiera de los payloads dentro del envelope estándar",
    " envelope through a generic signed HTTP POST. Backplane does not provide destination-specific notification integrations on this path; the receiving endpoint decides how to route or format the event.":
      " mediante un POST HTTP genérico y firmado. Backplane no proporciona integraciones de notificación específicas por destino en esta ruta; el endpoint receptor decide cómo enrutar o formatear el evento.",
    "API rate counters are per process, not per fleet":
      "Los contadores de solicitudes de API son por proceso, no por flota",
    " keeps counters in a process-local dictionary. With ":
      " mantiene los contadores en un diccionario local del proceso. Con ",
    " backend instances, the effective API-key ceiling is approximately ":
      " instancias del backend, el límite efectivo de la clave de API es aproximadamente ",
    ", not": ", no",
    ". Restarts also discard the counters. Use an external shared quota if a deployment needs a durable, fleet-wide enforcement boundary.":
      ". Los reinicios también descartan los contadores. Usa una cuota externa compartida si un despliegue necesita un límite de cumplimiento durable para toda la flota.",
  },
  "git-configuration-and-review-modes": {
    "Backplane separates three concerns that used to be described as one GitHub-only path: repository metadata on the board, encrypted workspace credentials, and the forge driver or merge executor that performs PR operations. A provider value alone does not grant access or select a credential.": "Backplane separa tres aspectos que antes se describían como una única ruta exclusiva de GitHub: los metadatos del repositorio en el tablero, las credenciales cifradas del espacio de trabajo y el driver del forge o ejecutor de merge que realiza las operaciones de PR. El valor del proveedor, por sí solo, no concede acceso ni selecciona una credencial.",
    "Repository record": "Registro del repositorio",
    "A board's ": "La fila ",
    " row carries the remote URL, provider, default and optional integration branches, a board-unique slug, policy, and an optional ": " de un tablero contiene la URL remota, el proveedor, la branch predeterminada, una branch de integración opcional, un slug único en el tablero, la política y un ",
    ". The backend accepts five provider identifiers; executable capabilities differ by provider and path.": " opcional. El backend acepta cinco identificadores de proveedor; las capacidades ejecutables varían según el proveedor y la ruta.",
    "The GitRepo model (trimmed)": "El modelo GitRepo (resumido)",
    "Workspace credentials": "Credenciales del espacio de trabajo",
    "Workspace administrators can connect GitHub, GitLab, and Gitea with a personal access token. GitHub also has an OAuth connection flow. The backend probes the token against the selected forge before storing it, derives the account identity from the forge response, encrypts the token at rest, and never returns the token in read responses.": "Los administradores del espacio de trabajo pueden conectar GitHub, GitLab y Gitea con un token de acceso personal. GitHub también dispone de un flujo de conexión OAuth. Antes de almacenarlo, el backend verifica el token en el forge seleccionado, obtiene la identidad de la cuenta desde la respuesta del forge, cifra el token en reposo y nunca lo devuelve en las respuestas de lectura.",
    "GitHub defaults to ": "GitHub usa de forma predeterminada ",
    " and GitLab defaults to ": " y GitLab usa ",
    "; either may receive an optional": "; ambos pueden recibir un ",
    " for a self-hosted installation. Gitea requires a": " opcional para una instalación autohospedada. Gitea exige un ",
    " because there is no canonical Gitea host. Bitbucket appears in the provider model, but token verification is not implemented and the connection dialog disables submission for it.": " porque no existe un host canónico de Gitea. Bitbucket aparece en el modelo de proveedores, pero la verificación de tokens no está implementada y el diálogo de conexión deshabilita el envío para ese proveedor.",
    "A repository may bind one credential explicitly through": "Un repositorio puede vincular explícitamente una credencial mediante",
    ". Without a binding, the resolver may use the workspace's only connection for that provider; multiple candidates are treated as ambiguous. Every resolved credential is host-checked against the repository URL before it can be inserted into a clone URL.": ". Sin un vínculo, el resolvedor puede usar la única conexión del espacio de trabajo para ese proveedor; si hay varias candidatas, se considera una situación ambigua. Cada credencial resuelta se comprueba contra el host de la URL del repositorio antes de insertarla en una URL de clonación.",
    "Connections are managed under Git Connections in Workspace Settings. Workspace administrators add, verify, and remove them; other members see the provider, the account, and the connection health, but never the token.": "Las conexiones se gestionan en Git Connections (el panel Conexiones Git), dentro de Ajustes del espacio de trabajo. Los administradores del espacio de trabajo las agregan, verifican y eliminan; el resto de los miembros ve el proveedor, la cuenta y la salud de la conexión, pero nunca el token.",
    "The Verify action re-runs the probe and reports named checks with guidance. ": "La acción Verificar vuelve a ejecutar la comprobación e informa una lista de verificaciones con nombre, cada una con orientación. ",
    " confirms that the forge recognized the token and named the account. ": " confirma que el forge reconoció el token e identificó la cuenta. ",
    " appears only when the forge disclosed nothing about the token, which is normal for every GitHub fine-grained token; confirm the permissions by hand.": " aparece solo cuando el forge no reveló nada sobre el token, algo normal en todos los tokens de acceso personal detallados de GitHub; confirma los permisos a mano.",
    " on GitHub and ": " en GitHub y ",
    " on GitLab confirm that the required classic-token scope is present.": " en GitLab confirman que el scope requerido del token clásico está presente.",
    " confirms that a GitHub token can read CI state from Actions runs. A successful Verify clears any recorded error; a failure records it and the panel shows the connection as unhealthy. Health is also written from production use: a 401 or 403 during a merge, a Done-gate check, or a reconciler pass marks the connection unhealthy with the real error, and a later successful use clears it.": " confirma que un token de GitHub puede leer el estado de CI desde las ejecuciones de Actions. Una verificación exitosa borra cualquier error registrado; una fallida lo registra y el panel muestra la conexión como no saludable. La salud también se escribe a partir del uso en producción: un 401 o 403 durante un merge, una comprobación del Done-gate o una pasada del reconciliador marca la conexión como no saludable con el error real, y un uso exitoso posterior lo borra.",
    "For every backend operation the credential is resolved in order: the connection the repository is bound to, then the workspace's only connection for that provider, then the platform token from the deployment environment such as ": "En cada operación del backend, la credencial se resuelve en orden: la conexión a la que está vinculado el repositorio, luego la única conexión del espacio de trabajo para ese proveedor, luego el token de la plataforma tomado del entorno del despliegue, como ",
    ", then none. At every step the credential is used only when the repository host matches the host it was issued for. Storing any connection requires": ", y por último ninguna. En cada paso, la credencial se usa solo cuando el host del repositorio coincide con el host para el que fue emitida. Almacenar cualquier conexión requiere",
    ", the Fernet key that encrypts tokens at rest; when it is unset the Add token action is disabled and the API answers 503. Setting ": ", la clave Fernet que cifra los tokens en reposo; si no está definida, la acción Agregar token queda deshabilitada y la API responde 503. Establecer ",
    " to": " en",
    " removes the platform-token step, which is the posture for a multi-tenant deployment. Both are listed in the": " elimina el paso del token de la plataforma, que es la postura recomendada para un despliegue multi-tenant. Ambas variables figuran en la",
    "environment variables reference": "referencia de variables de entorno",
    "Connections and Runner forge drivers are different layers": "Las conexiones y los drivers de forge del Runner son capas diferentes",
    "A GitLab credential is real and can authenticate clone, push, and the backend merge queue even though the Runner has no GitLab forge driver. Conversely, selecting ": "Una credencial de GitLab es válida y puede autenticar operaciones de clone y push, además de la cola de merge del backend, aunque el Runner no tenga un driver de forge para GitLab. A la inversa, seleccionar ",
    " on a repository does not dynamically rebuild a Runner. Each Runner constructs one configured forge driver at startup.": " en un repositorio no reconstruye dinámicamente un Runner. Cada Runner crea un único driver de forge configurado al iniciarse.",
    "Credentials belong to the workspace; repositories bind to a matching provider credential on the board.": "Las credenciales pertenecen al espacio de trabajo; los repositorios se vinculan en el tablero a una credencial del proveedor correspondiente.",
    "Runner forge configuration": "Configuración del forge del Runner",
    "The Runner builds a ": "El Runner crea un ",
    " from": " a partir de",
    " at startup. It ships GitHub and Gitea/Forgejo drivers. The GitHub driver wraps the existing ": " al iniciarse. Incluye drivers para GitHub y Gitea/Forgejo. El driver de GitHub encapsula la CLI ",
    " CLI; the Gitea driver calls the Gitea REST API and requires": " existente; el driver de Gitea llama a la API REST de Gitea y exige ",
    " plus ": " además de ",
    ". An empty ": ". Un valor vacío de ",
    " defaults to ": " usa de forma predeterminada ",
    " for backward compatibility, and an unknown value fails startup.": " por compatibilidad retroactiva, y un valor desconocido impide el inicio.",
    "Runner forge selection": "Selección del forge del Runner",
    "Review mode": "Modo de revisión",
    " is the historical switch that enables the": " es el selector histórico que habilita el paso ",
    " lifecycle step. Despite the field name, the step now calls the configured ": " del ciclo de vida. A pesar del nombre del campo, ahora el paso llama al ",
    " posts a comment and is the default;": " publica un comentario y es el valor predeterminado; ",
    " posts a formal forge review. The latter name is also historical and a single GitHub identity still cannot approve its own PR.": " publica una revisión formal en el forge. Este último nombre también es histórico, y una única identidad de GitHub sigue sin poder aprobar su propio PR.",
    "Merge path": "Ruta de merge",
    "The active merge happens only when an approved lifecycle branch reaches a ": "El merge activo solo ocurre cuando una rama aprobada del ciclo de vida alcanza un paso ",
    " step. That handler reads the top-level": ". Ese controlador lee el indicador de nivel superior ",
    " flag. When the flag is": ". Cuando el indicador es ",
    " or absent, the Runner asks its configured forge driver to merge. When it is ": " o no está presente, el Runner solicita el merge a su driver de forge configurado. Cuando es ",
    ", the Runner enqueues the PR for the backend merge worker.": ", el Runner coloca el PR en la cola del worker de merge del backend.",
    "The backend queue resolves the repository's workspace credential, rebases the PR branch onto ": "La cola del backend resuelve la credencial del espacio de trabajo asociada al repositorio, hace rebase de la branch del PR sobre ",
    ", and merges only after its configured gate. GitHub uses the native": " y realiza el merge solo después de superar el control configurado. GitHub usa la ruta nativa ",
    " path. Other providers use a provider-neutral fast-forward merge and push through plain git; that can leave the host's PR or MR open when the host does not infer closure from the branch.": ". Los demás proveedores usan un merge fast-forward independiente del proveedor y hacen push mediante git convencional; esto puede dejar abierto el PR o MR en el host cuando este no deduce su cierre a partir de la branch.",
    "Reviewer merge step and queue switch": "Paso de merge del revisor y selector de cola",
    "Provider metadata is not a capability promise": "Los metadatos del proveedor no garantizan capacidades",
    "GitHub has a Runner forge driver, OAuth and PAT connections, native repository discovery, native PR merge, and GitHub CI inspection.": "GitHub cuenta con un driver de forge para el Runner, conexiones OAuth y PAT, descubrimiento nativo de repositorios, merge nativo de PR e inspección de GitHub CI.",
    "Gitea/Forgejo has PAT connections and a Runner REST forge driver. Its driver is unit-tested against HTTP fixtures, not certified against every live Gitea or Forgejo version.": "Gitea/Forgejo cuenta con conexiones PAT y un driver REST de forge para el Runner. El driver tiene pruebas unitarias con fixtures HTTP, pero no está certificado para todas las versiones reales de Gitea o Forgejo.",
    "GitLab has verified PAT connections and works through plain git and the backend queue's non-GitHub merge path. A native Runner GitLab forge driver and repository picker are not implemented.": "GitLab cuenta con conexiones PAT verificadas y funciona mediante git convencional y la ruta de merge no GitHub de la cola del backend. No están implementados un driver nativo de forge para el Runner ni un selector de repositorios de GitLab.",
    "Bitbucket and ": "Bitbucket y ",
    " remain metadata values without a verified token connection or Runner forge driver.": " siguen siendo valores de metadatos sin una conexión de token verificada ni un driver de forge para el Runner.",
    "Some public configuration names still say GitHub": "Algunos nombres públicos de configuración todavía mencionan GitHub",
    " and the ": " y el modo de revisión ",
    " review mode predate the forge abstraction. They remain wire-compatible names even where the implementation now dispatches through": " son anteriores a la abstracción de forge. Se mantienen como nombres compatibles con el protocolo aunque la implementación ahora delegue mediante ",
    ". Treat the identifiers as technical API, not as an up-to-date statement of provider scope.": ". Considera estos identificadores parte de la API técnica, no una descripción actualizada del alcance de los proveedores."
  },
};
