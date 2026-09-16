// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_EXTENDING = {
  "adding-a-new-mcp-tool": {
    "MCP tools are the programmatic surface runners and operator LLMs use to touch Backplane. Adding one is a small, six-step loop: pick a module, write a decorated function, include a next-step hint, register by import, test it, and update the frontend catalog so the drift guard stays happy. This page walks each step with a concrete example — a":
      "Las herramientas MCP son la superficie programática que usan los runners y los LLMs de los operadores para interactuar con Backplane. Agregar una sigue un ciclo breve de seis pasos: elegir un módulo, escribir una función decorada, incluir una indicación para el paso siguiente, registrarla mediante un import, probarla y actualizar el catálogo del frontend para mantener conforme el control de divergencias. Esta página recorre cada paso con un ejemplo concreto: una herramienta",
    " tool that moves a card to the archived column.":
      " que mueve una tarjeta a la columna de archivo.",
    "Pick a module": "Elige un módulo",
    "Tools group by entity in ":
      "Las herramientas se agrupan por entidad en ",
    ". A card operation goes in ":
      ". Una operación sobre tarjetas se ubica en ",
    "; a workspace operation in ":
      "; una operación sobre espacios de trabajo, en ",
    ". Create a new file only if no existing module fits — the MCP host shows tools in a flat list, so file boundaries are for contributors, not callers.":
      ". Crea un archivo nuevo solo si ningún módulo existente es adecuado; el host MCP muestra las herramientas en una lista plana, por lo que los límites entre archivos sirven a quienes contribuyen al código, no a quienes llaman las herramientas.",
    "Write the function": "Escribe la función",
    "Every tool follows the same shape:":
      "Todas las herramientas siguen la misma estructura:",
    ", decorated with ": ", decorada con ",
    " over ": " sobre ",
    ", returning a JSON-serialized dict. The backend HTTP call goes through the lifespan-scoped ":
      ", y devuelve un dict serializado como JSON. La llamada HTTP al backend pasa por el ",
    " on the request context.":
      " limitado al ciclo de vida dentro del contexto de la solicitud.",
    "archive_card — a minimal mutation tool":
      "archive_card: una herramienta de mutación mínima",
    "Parameter order is load-bearing":
      "El orden de los parámetros es esencial",
    " is always the last parameter. FastMCP injects the context positionally in some call paths; putting another keyword-only argument after ":
      " siempre es el último parámetro. FastMCP inyecta el contexto por posición en algunos flujos de llamada; colocar otro argumento solo por nombre después de ",
    " makes the tool invisible in the MCP handshake on certain hosts. Required positional args first, then optional keyword args, then ":
      " hace que la herramienta no aparezca en el handshake de MCP en algunos hosts. Primero van los argumentos posicionales obligatorios, luego los argumentos opcionales por nombre y finalmente ",
    ". No exceptions.": ". Sin excepciones.",
    "The ": "El ",
    " field": " es un campo de orientación",
    "Every response dict should carry an ":
      "Cada dict de respuesta debe incluir una clave ",
    " key with a short action-oriented instruction. The LLM reads the response verbatim; a good hint shaves an entire round-trip off the next step because the model already knows which tool to call. Bad hints describe what just happened (\"Card archived successfully\"). Good hints point to the next tool.":
      " con una instrucción breve y orientada a la acción. El LLM lee la respuesta literalmente; una buena indicación elimina un viaje completo de ida y vuelta en el paso siguiente porque el modelo ya sabe qué herramienta debe llamar. Las indicaciones deficientes describen lo que acaba de ocurrir (\"Tarjeta archivada correctamente\"). Las buenas indican la próxima herramienta.",
    "Write hints in the imperative":
      "Escribe las indicaciones en modo imperativo",
    "\"Call ": "\"Llama a ",
    " with ": " con ",
    "to confirm.\" is a useful hint — it names a tool, names an argument, and gives a reason. \"The card has been archived.\" is not — it tells the LLM nothing it couldn't already infer from the status field. When in doubt, imagine the LLM has exactly one more tool call to make: what would help it pick?":
      "para confirmar\" es una indicación útil: nombra una herramienta, un argumento y una razón. \"La tarjeta fue archivada\" no lo es; no le dice al LLM nada que no pueda deducir del campo de estado. Ante la duda, imagina que al LLM le queda exactamente una llamada a una herramienta: ¿qué le ayudaría a elegir?",
    "Register, test, and declare": "Registra, prueba y declara",
    "MCP registration happens at import time via the ":
      "El registro en MCP ocurre al importar mediante el ",
    "decorator. Add an import line to ":
      "decorador. Agrega una línea de import a ",
    " so the module loads when the server boots.":
      " para que el módulo se cargue cuando inicia el servidor.",
    "server.py — side-effect imports":
      "server.py: imports con efectos secundarios",
    "Write a unit test in ": "Escribe una prueba unitaria en ",
    " that mocks": " que simule ",
    " to record the HTTP call and asserts the verb, path, and body. Naming follows":
      " para registrar la llamada HTTP y comprobar el verbo, la ruta y el cuerpo. Los nombres siguen ",
    " and": " y ",
    test_archive_card_success: "test_archive_card_success",
    "Finally, add the tool name to the frontend catalog at":
      "Por último, agrega el nombre de la herramienta al catálogo del frontend en ",
    " in the": " dentro del array ",
    " array (sorted alphabetically). The drift guard at ":
      ", ordenado alfabéticamente. El control de divergencias en ",
    "will fail CI if the catalogs disagree — it exists because half-added tools that the UI can't show are worse than no tool at all.":
      " hará que CI falle si los catálogos no coinciden. Existe porque una herramienta agregada a medias que la interfaz no puede mostrar es peor que no tener ninguna herramienta.",
    "The drift guard catches us about twice a month":
      "El control de divergencias nos detecta un error unas dos veces al mes",
    "The drift guard started as a paranoia test. It's fired often enough — someone adds a tool, skips the frontend catalog update, CI reminds them — that we now treat it as part of the definition of \"done.\" If you ship a tool and the operator UI can't show it in the agent tool picker, the tool effectively doesn't exist for the humans configuring the pipeline. The guard exists because we learned this the expensive way.":
      "El control de divergencias comenzó como una prueba por precaución. Se ha activado suficientes veces, cuando alguien agrega una herramienta, omite actualizar el catálogo del frontend y CI se lo recuerda, como para que ahora forme parte de la definición de \"completado\". Si entregas una herramienta y la interfaz del operador no puede mostrarla en el selector de herramientas del agente, para las personas que configuran el pipeline esa herramienta no existe en la práctica. El control existe porque lo aprendimos de la forma más costosa.",
    "If the tool mutates cards": "Si la herramienta modifica tarjetas",
    "Add the tool name to ": "Agrega el nombre de la herramienta a ",
    " in": " en ",
    ". This populates the": ". Esto completa el campo ",
    " field on execution records so the UI can show which cards a stage touched. Skipping this step means the execution row looks like the stage did nothing, which makes debugging a confused pipeline harder than it needs to be.":
      " en los registros de ejecución para que la interfaz muestre qué tarjetas modificó una etapa. Omitir este paso hace que el registro de ejecución parezca indicar que la etapa no hizo nada, lo que dificulta innecesariamente depurar un pipeline confuso.",
  },
  "adding-a-new-pipeline-stage-variant": {
    "A pipeline stage is a ticking function the runner invokes once per heartbeat against a discovered card. Adding a new stage variant — whether a genuinely new role like ":
      "Una etapa de pipeline es una función cíclica que el runner invoca una vez por heartbeat sobre una tarjeta descubierta. Agregar una variante de etapa nueva, ya sea un rol realmente nuevo como ",
    " or a differently-configured copy of an existing one — is a pure configuration change. No backend code, no Go code, no redeploy. You patch ":
      " o una copia de una etapa existente con otra configuración, es un cambio exclusivo de configuración. No requiere código de backend, código de Go ni volver a desplegar. Modificas ",
    ", optionally author a prompt, and the next runner tick picks it up.":
      ", creas un prompt de forma opcional y el runner lo incorpora en el siguiente ciclo.",
    "When to add a stage": "Cuándo agregar una etapa",
    "Reach for a new stage when a role's discover filter, claim shape, git action, or output post-processing differs from every existing stage. If the only change is the prompt text, you don't need a new stage — override the prompt at the workspace level instead. If the only change is which column a stage moves cards to on success, edit the existing stage's ":
      "Crea una etapa nueva cuando el filtro de descubrimiento, la forma de tomar una tarjeta, la acción git o el posprocesamiento de salida de un rol difieran de todas las etapas existentes. Si el único cambio es el texto del prompt, no necesitas una etapa nueva; reemplaza el prompt a nivel del espacio de trabajo. Si el único cambio es la columna a la que una etapa mueve las tarjetas cuando tiene éxito, edita el bloque ",
    " block. A new stage earns its keep when the pipeline needs a genuinely new step.":
      " de la etapa existente. Una etapa nueva se justifica cuando el pipeline necesita un paso realmente nuevo.",
    "A worked example: a linter role":
      "Ejemplo práctico: un rol de linter",
    "Suppose the pipeline has a backlog column, and you want a lightweight role that picks up every new card, runs a linter prompt against its description, attaches a ":
      "Supongamos que el pipeline tiene una columna Backlog y quieres un rol ligero que tome cada tarjeta nueva, ejecute un prompt de linter sobre su descripción y agregue una etiqueta ",
    " label, and moves on. The linter runs before the implementer so the human operator sees a clean description by the time they triage. No git action, no branch, just a prompt and a label.":
      " antes de continuar. El linter se ejecuta antes que el implementador para que el operador humano vea una descripción limpia al momento de clasificarla. Sin acción git ni rama, solo un prompt y una etiqueta.",
    "New stage appended to pipeline_config.stages[]":
      "Nueva etapa agregada a pipeline_config.stages[]",
    "Submit this via the pipeline builder (the UI saves an optimistic":
      "Envía esta configuración mediante el constructor de pipelines; la interfaz guarda un ",
    " to ": " optimista en ",
    ") or via the MCP ": "; o mediante la herramienta MCP ",
    " tool. Append": ". Agrega ",
    " so the scheduler considers it — the":
      " para que el planificador lo considere. La protección ",
    " seatbelt in the Go runner will cover you if you forget, but explicit ordering is friendlier to the operator reading the config.":
      " del runner de Go te cubrirá si lo olvidas, pero un orden explícito es más claro para el operador que lee la configuración.",
    "Authoring a prompt": "Crear un prompt",
    "For brand-new roles not in the platform registry, the backend synthesizes a minimal placeholder prompt so the stage runs without hand-authoring. The synthesis stitches together a role identity, the card context, and a post-process imperative matched to your":
      "Para los roles completamente nuevos que no están en el registro de la plataforma, el backend sintetiza un prompt mínimo para que la etapa pueda ejecutarse sin escribirlo manualmente. La síntesis combina la identidad del rol, el contexto de la tarjeta y una instrucción obligatoria de posproceso que coincide con tu ",
    "synthesizes \"emit a review note via MCP,\" ":
      "sintetiza \"emitir una nota de revisión mediante MCP\"; ",
    "synthesizes \"commit and push your changes.\"":
      "sintetiza \"hacer commit y push de tus cambios\".",
    "A synthesized prompt is a starting point, not a destination. Open Runner → Prompts → your custom role, and override the synthesized prompt with one that actually specifies what \"lint\" means for your project: what fields to check, what severity to flag, what label-color scheme to follow. The override saves as a prompt_config row scoped to the workspace; the synthesis machinery only fires when no override exists.":
      "Un prompt sintetizado es un punto de partida, no el resultado final. Abre Runner → Prompts → tu rol personalizado y reemplaza el prompt sintetizado por uno que especifique qué significa realmente \"lint\" para tu proyecto: qué campos comprobar, qué severidad señalar y qué esquema de colores de etiquetas seguir. El reemplazo se guarda como un registro prompt_config limitado al espacio de trabajo; la síntesis solo se activa cuando no existe un reemplazo.",
    "The prompt editor is a plain textarea":
      "El editor de prompts es un textarea sencillo",
    "Custom-role prompts render in a plain monospace ":
      "Los prompts de roles personalizados se muestran en un ",
    ". No markdown preview, no variable autocomplete, no diff against the synthesized default. The engine treats prompts as opaque strings with a handful of ":
      " monoespaciado sencillo. No hay vista previa de markdown, autocompletado de variables ni diff frente al valor sintetizado predeterminado. El motor trata los prompts como cadenas opacas con algunos contenidos ",
    " placeholders the runner substitutes before sending to the LLM. A richer editor with variable lookup and a live preview is on the backlog. For now: draft in your editor of choice, paste in, save. If you break it, the runner returns ":
      " que el runner sustituye antes de enviarlos al LLM. Un editor más completo, con búsqueda de variables y vista previa en vivo, está en el backlog. Por ahora, redacta en el editor que prefieras, pega el contenido y guarda. Si lo rompes, el runner devuelve ",
    " rather than executing a malformed prompt.":
      " en lugar de ejecutar un prompt mal formado.",
    "Testing the stage": "Probar la etapa",
    "Register a runner with the workspace (see Getting Started → Registering a runner) and drop a card in the backlog column. Within one tick of the runner's heartbeat, the card should gain the ":
      "Registra un runner en el espacio de trabajo, consulta Primeros pasos → Registrar un runner, y coloca una tarjeta en la columna Backlog. En un ciclo del heartbeat del runner, la tarjeta debería recibir la etiqueta ",
    "label. Watch the activity feed — every stage invocation emits":
      "y luego observa el flujo de actividad; cada invocación de una etapa emite ",
    " with the role and": " con el rol y la ",
    " you set, so you can confirm the linter fired without reaching for logs.":
      " que configuraste, para que puedas confirmar que el linter se activó sin consultar los logs.",
    "Exclude yourself from rediscovery":
      "Evita que la etapa vuelva a descubrir lo mismo",
    "A stage that adds a label on success must also exclude cards with that label in its discover filter, or it claims the same card every tick forever. The example above does both — ":
      "Una etapa que agrega una etiqueta cuando tiene éxito también debe excluir las tarjetas con esa etiqueta en su filtro de descubrimiento; de lo contrario, tomará la misma tarjeta en cada ciclo indefinidamente. El ejemplo anterior hace ambas cosas: ",
    "on success and ": " cuando tiene éxito y ",
    " in discover. A second guard is":
      " en el descubrimiento. Una segunda protección es ",
    ", which uses the participant record as a second idempotency key. Use both; they cover different failure modes.":
      ", que usa el registro de participante como una segunda clave de idempotencia. Usa ambas; cubren modos de falla diferentes.",
    "Scope new stages to a test board first":
      "Limita primero las etapas nuevas a un tablero de prueba",
    "The pipeline config is workspace-scoped, but discover filters can reference labels. A pragmatic rollout: require a":
      "La configuración del pipeline se limita al espacio de trabajo, pero los filtros de descubrimiento pueden hacer referencia a etiquetas. Un despliegue gradual pragmático consiste en exigir una etiqueta ",
    " label, apply it only to cards on your test board, and watch the new stage run against a curated set before flipping the filter off. It's slower than a global rollout and it catches more mistakes.":
      ", aplicarla solo a las tarjetas del tablero de prueba y observar cómo la etapa nueva se ejecuta sobre un conjunto controlado antes de retirar el filtro. Es más lento que un despliegue global y detecta más errores.",
  },
  "integrating-a-new-git-host": {
    "The Runner no longer hard-wires every PR operation to": "El Runner ya no conecta de forma rígida todas las operaciones de PR con",
    ". A provider-neutral": ". Una interfaz ",
    " interface now owns change creation, review, comments, status, merge, branch protection, and open-change queries. Backplane ships GitHub and Gitea/Forgejo drivers today. A GitLab driver is not implemented.": " independiente del proveedor controla ahora la creación de cambios, revisiones, comentarios, estado, merge, protección de branches y consultas de cambios abiertos. Backplane incluye actualmente drivers para GitHub y Gitea/Forgejo. No hay un driver de GitLab implementado.",
    "Plain git remains separate. Clone, fetch, checkout, commit, rebase, and push stay in the git layer because those operations are already host-neutral. The forge interface covers only the API or CLI surface a code host adds around a repository.": "Git convencional permanece separado. Las operaciones clone, fetch, checkout, commit, rebase y push se mantienen en la capa git porque ya son independientes del host. La interfaz de forge cubre únicamente la superficie de API o CLI que un host de código agrega alrededor de un repositorio.",
    "Implemented interface": "Interfaz implementada",
    "Current forge.Provider contract": "Contrato actual de forge.Provider",
    "The neutral vocabulary calls a pull request or merge request a": "El vocabulario neutral denomina",
    ". Persisted database fields keep their existing": " a un pull request o merge request. Los campos persistidos de la base de datos conservan sus nombres ",
    " names for compatibility. Merge strategies are the closed values ": " por compatibilidad. Las estrategias de merge son los valores cerrados ",
    ", and": " y ",
    "; review decisions are ": "; las decisiones de revisión son ",
    ", and ": " y ",
    "Drivers that ship": "Drivers incluidos",
    "GitHub": "GitHub",
    " wraps the existing ": " encapsula los métodos existentes, basados en ",
    "-backed": ", de ",
    " methods. This preserves the established GitHub behavior behind the neutral interface.": ". Esto conserva el comportamiento establecido de GitHub detrás de la interfaz neutral.",
    "Gitea/Forgejo": "Gitea/Forgejo",
    " calls the Gitea v1 REST API. It uses": " llama a la API REST v1 de Gitea. Usa ",
    " and ": " y ",
    ", and parses Gitea pull-request URLs for repository identity.": ", y analiza las URL de pull requests de Gitea para identificar el repositorio.",
    " constructs exactly one driver from ": " crea exactamente un driver a partir de ",
    " at Runner startup. Empty means": " cuando se inicia el Runner. Un valor vacío equivale a ",
    " requires both its base URL and token; any other value returns an explicit startup error.": " exige tanto su URL base como su token; cualquier otro valor devuelve un error de inicio explícito.",
    "Git credentials are a separate backend capability": "Las credenciales de Git son una capacidad independiente del backend",
    "Workspace PAT connections already support GitHub, GitLab, and Gitea. That does not mean all three have a Runner forge driver. Credentials answer “may this workspace authenticate to this host?”; a driver answers “can this Runner call this host's PR API?”": "Las conexiones PAT del espacio de trabajo ya admiten GitHub, GitLab y Gitea. Esto no significa que los tres tengan un driver de forge para el Runner. Las credenciales responden «¿puede este espacio de trabajo autenticarse en este host?»; un driver responde «¿puede este Runner llamar a la API de PR de este host?».",
    "Adding another Runner driver": "Agregar otro driver para el Runner",
    "Implement ": "Implementa ",
    " in a provider-specific package under ": " en un paquete específico del proveedor dentro de ",
    "Map neutral decisions, statuses, merge strategies, and change fields at the driver edge. Do not leak provider-specific response types into the base interface.": "Mapea las decisiones, los estados, las estrategias de merge y los campos de cambio neutrales en el límite del driver. No expongas tipos de respuesta específicos del proveedor en la interfaz base.",
    "Register the new ": "Registra el nuevo valor de ",
    " value in": " en",
    " and validate every provider-specific credential or base-URL requirement.": " y valida todas las credenciales y los requisitos de URL base específicos del proveedor.",
    "Add an injectable client seam and hermetic tests for request shape, response mapping, invalid values, authentication errors, and idempotent change creation.": "Agrega una abstracción de cliente inyectable y pruebas herméticas para la forma de las solicitudes, el mapeo de respuestas, los valores inválidos, los errores de autenticación y la creación idempotente de cambios.",
    "Update ": "Actualiza ",
    " and the configuration drift tests in the same change.": " y las pruebas de divergencia de configuración en el mismo cambio.",
    "Current GitLab boundary": "Límite actual de GitLab",
    "GitLab tokens can be probed, encrypted, host-matched, bound to a repository, and used by the backend merge queue for authenticated git operations. The queue's non-GitHub path rebases and fast-forwards through plain git. What is missing is a native Runner driver for merge requests, reviews, status rollups, and branch protection, plus a GitLab repository-picker adapter.": "Los tokens de GitLab pueden verificarse, cifrarse, comprobarse contra el host, vincularse a un repositorio y usarse en la cola de merge del backend para operaciones de git autenticadas. La ruta no GitHub de la cola hace rebase y fast-forward mediante git convencional. Falta un driver nativo del Runner para merge requests, revisiones, estados consolidados y protección de branches, además de un adaptador del selector de repositorios de GitLab.",
    "A forge driver does not normalize webhooks": "Un driver de forge no normaliza webhooks",
    " covers outbound Runner operations. It does not normalize inbound webhook payloads, and it does not add a backend repository picker. Those are separate provider surfaces that must be implemented and tested independently.": " cubre las operaciones salientes del Runner. No normaliza los payloads de webhooks entrantes ni agrega un selector de repositorios al backend. Son superficies independientes del proveedor que deben implementarse y probarse por separado.",
    "The Gitea driver has fixture coverage, not broad live certification": "El driver de Gitea tiene cobertura con fixtures, no una certificación amplia en entornos reales",
    "The driver is unit-tested through an injected HTTP client against the documented Gitea v1 shapes. The source explicitly records that it has not yet been exercised against a live matrix of Gitea and Forgejo versions. Treat a new deployment as an integration test, especially around review events and mergeability responses.": "El driver tiene pruebas unitarias mediante un cliente HTTP inyectado y las estructuras documentadas de Gitea v1. El código fuente registra explícitamente que todavía no se ha probado contra una matriz real de versiones de Gitea y Forgejo. Considera una implementación nueva como una prueba de integración, especialmente para los eventos de revisión y las respuestas sobre la posibilidad de hacer merge."
  },
  "writing-a-custom-sensor": {
    "Sensors are the feedback half of the runner harness: they evaluate what an agent produced and emit structured pass/fail signals the pipeline uses to gate the next step. Today sensors are compiled into the Go runner — adding one means writing Go, rebuilding the":
      "Los sensores son el componente de retroalimentación del arnés del runner: evalúan lo que produjo un agente y emiten señales estructuradas de aprobación o falla que el pipeline usa para condicionar el paso siguiente. Hoy los sensores se compilan dentro del runner de Go; agregar uno implica escribir Go, volver a compilar el binario ",
    " binary, and shipping a new runner image. This is a compile-time extension point, not a runtime one, and it will stay that way until the declarative sensor DSL (see below) lands.":
      " y distribuir una imagen nueva del runner. Este es un punto de extensión en tiempo de compilación, no de ejecución, y seguirá así hasta que llegue la DSL declarativa de sensores que se describe más adelante.",
    "The Sensor interface": "La interfaz Sensor",
    "A sensor implements three methods: ":
      "Un sensor implementa tres métodos: ",
    " (either ": ", que puede ser ",
    " for deterministic checks or ":
      " para comprobaciones deterministas o ",
    " for LLM-backed ones), and ":
      " para las respaldadas por un LLM, y ",
    " returning a": ", que devuelve un ",
    " with a pass flag, an optional 0..1 score, findings, and a summary. The interface lives in":
      " con un indicador de aprobación, una puntuación opcional de 0 a 1, hallazgos y un resumen. La interfaz vive en ",
    "A minimal sensor template": "Template mínimo de un sensor",
    "The shortest useful sensor: a placeholder that checks whether any files were changed at all. Not shippable as-is, but demonstrates the shape every sensor follows — constructor, manifest, three interface methods. Use it as a skeleton when building a real check.":
      "El sensor útil más breve es un contenido provisional que comprueba si se modificó algún archivo. No se puede entregar tal como está, pero demuestra la estructura que sigue cada sensor: constructor, manifiesto y tres métodos de interfaz. Úsalo como base al crear una comprobación real.",
    "A minimal custom sensor skeleton":
      "Estructura mínima de un sensor personalizado",
    "Registering the sensor": "Registrar el sensor",
    "Sensors register into ": "Los sensores se registran en ",
    " in": " dentro de ",
    ". The registry both constructs sensors on demand (":
      ". El registro crea sensores bajo demanda, mediante ",
    ") and publishes a manifest the runner's heartbeat ships to the backend — which is how the pipeline builder populates its sensor dropdown. Skip the manifest and the sensor is invisible to operators even if it runs.":
      ", y publica un manifiesto que el heartbeat del runner envía al backend. Así completa el constructor de pipelines su lista desplegable de sensores. Si omites el manifiesto, el sensor será invisible para los operadores aunque se ejecute.",
    "Adding the sensor to DefaultRegistry":
      "Agregar el sensor a DefaultRegistry",
    "Test and ship": "Prueba y entrega",
    "Sensor tests follow the pattern in":
      "Las pruebas de sensores siguen el patrón de ",
    " — construct the sensor, feed it a":
      ": crea el sensor, entrégale un ",
    " with controlled fixture data, assert the resulting ":
      " con datos controlados de fixture y comprueba el ",
    ". Keep the test hermetic: don't shell out to real tools, don't hit the network. Sensors run on every pipeline tick; a flaky sensor is worse than no sensor.":
      " resultante. Mantén la prueba hermética: no ejecutes herramientas reales mediante el shell ni accedas a la red. Los sensores se ejecutan en cada ciclo del pipeline; un sensor inestable es peor que no tener sensor.",
    "Rebuild the runner: ": "Vuelve a compilar el runner: ",
    ". Publish the new binary (or image) to wherever your runners pull from; operators re-register on their next restart and the new sensor shows up in the pipeline builder's sensor picker, populated from the heartbeat manifest. Add its name to a stage's ":
      ". Publica el binario o la imagen nueva donde tus runners obtienen sus artefactos; los operadores vuelven a registrarse al reiniciar y el sensor nuevo aparece en el selector del constructor de pipelines, que se completa desde el manifiesto del heartbeat. Agrega su nombre al array de una etapa ",
    "array to start gating on it.":
      " para comenzar a condicionar el avance con él.",
    "The manifest is the contract": "El manifiesto es el contrato",
    "The backend validates pipeline configs against the sensor manifest shipped in the last heartbeat. A stage referencing a sensor name the runner hasn't registered will fail validation when the config saves. If you add a sensor, rebuild, and deploy, make sure every runner rolls before you publish a pipeline that depends on the new sensor — a mid-rollout operator can save a config the stale runners can't honor.":
      "El backend valida las configuraciones de pipeline frente al manifiesto de sensores enviado en el último heartbeat. Una etapa que haga referencia a un sensor que el runner no haya registrado fallará durante la validación al guardar la configuración. Si agregas un sensor, vuelves a compilar y haces el deployment, comprueba que todos los runners se hayan actualizado antes de publicar un pipeline que dependa del sensor nuevo; durante un despliegue parcial, un operador puede guardar una configuración que los runners desactualizados no puedan cumplir.",
    "You can't add a sensor at runtime":
      "No puedes agregar un sensor durante la ejecución",
    "Operators configuring a pipeline can ":
      "Los operadores que configuran un pipeline pueden ",
    reference: "hacer referencia a",
    " sensors. They can't ": " sensores. No pueden ",
    define: "definirlos",
    " them. Adding a sensor requires a Go file, a build, and a runner redeploy. For a platform that markets itself on extensibility this is uncomfortable, and we know it. The compile-time boundary exists because sensors run with full filesystem and network access inside the runner process — a runtime-authored sensor is a sandboxing problem we haven't solved yet.":
      ". Agregar un sensor requiere un archivo de Go, una compilación y un nuevo deployment del runner. Para una plataforma que se presenta como extensible, esto resulta incómodo y lo sabemos. El límite de tiempo de compilación existe porque los sensores se ejecutan con acceso completo al sistema de archivos y la red dentro del proceso del runner; un sensor creado durante la ejecución plantea un problema de sandboxing que todavía no hemos resuelto.",
    "The declarative sensor DSL": "La DSL declarativa de sensores",
    "The long-horizon goal is a YAML-authored sensor spec an operator can write in the pipeline builder: a command to run, an exit-code mapping, a regex or JSON path to extract findings, and a pass/fail rule. The interpreter would execute the sensor in a sandboxed subprocess with a fixed filesystem view and no network. This unblocks operator-defined ":
      "El objetivo a largo plazo es una especificación de sensor escrita en YAML que el operador pueda crear en el constructor de pipelines: un comando que ejecutar, un mapeo de códigos de salida, una expresión regular o ruta JSON para extraer hallazgos y una regla de aprobación o falla. El intérprete ejecutaría el sensor en un subproceso aislado, con una vista fija del sistema de archivos y sin red. Esto habilitaría herramientas definidas por el operador como ",
    ", and any other toolchain without asking us to ship a new runner binary. Scoped, not scheduled — no ETA.":
      " y cualquier otra cadena de herramientas sin pedirnos que distribuyamos un binario nuevo del runner. Tiene alcance definido, pero no está programado; no hay fecha estimada.",
  },
};
