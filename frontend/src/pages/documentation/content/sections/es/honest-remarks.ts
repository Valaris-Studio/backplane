// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_HONEST_REMARKS = {
  "what-works-well": {
    "Backplane's strongest parts are the boundaries that the repository can verify. The backend, frontend, MCP server, and Go Runner live together, and focused contract tests pin the payloads and names they share. That does not make every boundary automatic, but it turns important drift into a test failure instead of an operator surprise.":
      "Las partes más sólidas de Backplane son los límites que el repositorio puede verificar. El backend, el frontend, el servidor MCP y el Runner de Go conviven, y las pruebas de contrato focalizadas fijan las cargas y los nombres que comparten. Esto no automatiza todos los límites, pero convierte las divergencias importantes en fallos de prueba, en lugar de sorpresas para el operador.",
    "The platform owns execution shape":
      "La plataforma controla la estructura de ejecución",
    "The Runner fetches ": "El Runner obtiene ",
    " from the backend and executes the stages that the platform resolved. A registration can carry multiple ":
      " del backend y ejecuta las etapas que resolvió la plataforma. Un registro puede incluir varios ",
    ", and assignment responses can select a provider and model for the current stage. Pipeline behavior therefore changes through platform configuration rather than a hardcoded role list in the Runner binary.":
      ", y las respuestas de asignación pueden seleccionar un proveedor y un modelo para la etapa actual. Por lo tanto, el comportamiento del pipeline cambia mediante la configuración de la plataforma, no mediante una lista de roles fija en el binario del Runner.",
    "Dependencies are an end-to-end feature":
      "Las dependencias son una funcionalidad de extremo a extremo",
    "The ": "La relación ",
    " relation is backed by database constraints, cycle validation, scheduler filtering, board and card APIs, frontend management surfaces, and MCP tools. A planner can build a dependency graph and a Runner can avoid work whose prerequisites are not complete without encoding the graph in prose.":
      " cuenta con restricciones de base de datos, validación de ciclos, filtros del scheduler, APIs de tableros y tarjetas, superficies de gestión en el frontend y herramientas MCP. Un planificador puede construir un grafo de dependencias y un Runner puede evitar trabajo cuyos prerrequisitos no estén completos, sin codificar el grafo en texto.",
    "Provider seams execute real implementations":
      "Las interfaces de proveedores ejecutan implementaciones reales",
    "The coding-agent seam has working ":
      "La interfaz de agentes de código cuenta con ",
    " and": " y",
    " implementations. The forge seam exposes":
      " como implementaciones operativas. La interfaz del forge expone",
    " and ships GitHub and Gitea/Forgejo drivers. The registries reject unknown provider names instead of silently falling back to a different implementation.":
      " e incluye drivers para GitHub y Gitea/Forgejo. Los registros rechazan los nombres de proveedores desconocidos, en lugar de recurrir silenciosamente a otra implementación.",
    "Event delivery has a scale-aware backend":
      "La entrega de eventos tiene un backend preparado para escalar",
    "The event API keeps one subscriber contract while":
      "La API de eventos conserva un único contrato de suscripción, mientras ",
    " selects an in-process memory bus or a":
      " selecciona un bus en memoria dentro del proceso o una implementación ",
    " implementation based on PostgreSQL":
      " basada en PostgreSQL ",
    ". The health endpoint reports the selected backend and listener state, so cross-instance delivery is observable when it is enabled.":
      ". El endpoint de salud informa el backend seleccionado y el estado del listener, por lo que la entrega entre instancias es observable cuando está habilitada.",
    "The useful discipline is enforced, not aspirational":
      "La disciplina útil se aplica; no es solo una aspiración",
    "Contract tests cover high-risk seams such as MCP signatures, lifecycle kinds, dependency events, localized technical tokens, and Runner wire shapes. The repository still contains ordinary maintenance debt; the strength is that critical invariants have executable checks.":
      "Las pruebas de contrato cubren límites de alto riesgo, como las firmas MCP, los tipos de ciclo de vida, los eventos de dependencias, los tokens técnicos localizados y las estructuras de intercambio del Runner. El repositorio aún contiene deuda de mantenimiento normal; la fortaleza es que las invariantes críticas tienen verificaciones ejecutables.",
  },
  "known-rough-edges": {
    "These limitations are visible in the current code. They are not a historical audit score, a staffing claim, or a promise that a fix is scheduled. Treat them as boundaries to verify before relying on the affected capability in a production workflow.":
      "Estas limitaciones son visibles en el código actual. No son el resultado de una auditoría histórica, una afirmación sobre asignación de personal ni una promesa de que exista una corrección programada. Deben tratarse como límites que hay que verificar antes de depender de la capacidad afectada en un flujo de producción.",
    "Cross-surface schemas still require vigilance":
      "Los esquemas entre superficies aún exigen vigilancia",
    "Earlier gaps in Runner identity are closed: ":
      "Las brechas anteriores en la identidad del Runner están cerradas: ",
    " and": " y",
    " include ": " incluyen ",
    ", and": ", y ",
    " consumes ": " consume ",
    ". Drift has not disappeared. For example, the backend workspace response exposes":
      ". La divergencia no ha desaparecido. Por ejemplo, la respuesta del espacio de trabajo del backend expone ",
    ", while the frontend's":
      ", mientras que la interfaz ",
    " interface does not currently declare it. Python, TypeScript, Go, and MCP payloads remain separate contracts.":
      " del frontend no lo declara actualmente. Las cargas de Python, TypeScript, Go y MCP siguen siendo contratos independientes.",
    "Two CLI providers, different confidence levels":
      "Dos proveedores CLI con distintos niveles de confianza",
    "The Runner can execute both ":
      "El Runner puede ejecutar tanto ",
    ", including per-stage selection. Their capability matrices differ: Codex reports tokens but not a native dollar cost or per-session dollar cap, while Claude exposes a native budget flag whose usefulness depends on the authentication mode.":
      ", incluso con selección por etapa. Sus matrices de capacidades son distintas: Codex informa tokens, pero no un costo nativo en dólares ni un límite en dólares por sesión; Claude expone una opción nativa de presupuesto cuya utilidad depende del modo de autenticación.",
    "Codex execution is implemented, but live certification is limited":
      "La ejecución con Codex está implementada, pero la certificación en vivo es limitada",
    "The Codex driver is covered by fixtures and fake-binary tests, and its isolated MCP configuration has been checked against a real CLI. The source still records that a complete live Valaris tool-call run has not been certified. Do not turn unit coverage into a production guarantee.":
      "El driver de Codex está cubierto por fixtures y pruebas con un binario simulado, y su configuración MCP aislada se comprobó contra una CLI real. El código aún registra que no se ha certificado una ejecución completa en vivo con una llamada real a una herramienta de Valaris. La cobertura unitaria no debe convertirse en una garantía de producción.",
    "The default event bus is still process-local":
      "El bus de eventos predeterminado sigue siendo local al proceso",
    " defaults to ": " usa de forma predeterminada ",
    ". That mode is appropriate for one backend process but does not distribute events between instances. Setting it to ":
      ". Ese modo es adecuado para un único proceso de backend, pero no distribuye eventos entre instancias. Configurarlo como ",
    " enables the PostgreSQL ":
      " habilita el transporte de PostgreSQL ",
    " transport and listener health reporting. A Redis backend is explicitly rejected because it is not implemented.":
      " y el informe de salud del listener. El backend Redis se rechaza explícitamente porque no está implementado.",
    "Forge support is intentionally uneven":
      "La cobertura de forges es intencionalmente desigual",
    " has GitHub and Gitea/Forgejo drivers. The Gitea driver is tested against HTTP fixtures, not a broad live matrix of Gitea and Forgejo releases. GitLab credentials and plain-git paths exist elsewhere in the platform, but there is no native Runner GitLab forge driver for merge requests, reviews, status rollups, or branch protection.":
      " cuenta con drivers para GitHub y Gitea/Forgejo. El driver de Gitea se prueba con fixtures HTTP, no contra una matriz amplia y en vivo de versiones de Gitea y Forgejo. Las credenciales de GitLab y las rutas de git estándar existen en otras partes de la plataforma, pero no hay un driver nativo de forge para GitLab en el Runner que gestione merge requests, revisiones, estados consolidados o protección de branches.",
    "The tree is not permanently spotless":
      "El árbol no está permanentemente libre de deuda",
    "The repository contains targeted ":
      "El repositorio contiene comentarios ",
    " comments and some":
      " focalizados y algunas conversiones ",
    " casts. Some are explicit follow-ups or narrow type escapes; their presence still means a claim of zero debt would be false. Contract tests protect selected boundaries, but they do not prove that every component or integration path is covered.":
      ". Algunos son seguimientos explícitos o escapes de tipos acotados; su presencia significa que afirmar que no existe deuda sería falso. Las pruebas de contrato protegen límites seleccionados, pero no demuestran que todos los componentes o rutas de integración estén cubiertos.",
  },
  "actively-working-on": {
    "This route keeps its established title, but the repository cannot prove who is actively assigned to a topic or when it will ship. The sections below separate capabilities already present in the current revision from concrete validation gaps. They are not an implementation calendar or an ETA.":
      "Esta ruta conserva su título establecido, pero el repositorio no puede demostrar quién está asignado activamente a un tema ni cuándo se entregará. Las secciones siguientes separan las capacidades ya presentes en la revisión actual de las brechas concretas de validación. No constituyen un calendario de implementación ni una fecha estimada.",
    "Already landed: structured dependencies":
      "Ya implementado: dependencias estructuradas",
    "Structured card dependencies are no longer future work. The":
      "Las dependencias estructuradas entre tarjetas ya no son trabajo futuro. El modelo ",
    " model, migrations, CRUD and bulk-set endpoints, cycle checks, scheduler exclusions, frontend controls, and MCP tools are present. Any follow-up should start from that shipped contract rather than rescoping the feature from zero.":
      ", las migraciones, los endpoints CRUD y de actualización masiva, las comprobaciones de ciclos, las exclusiones del scheduler, los controles del frontend y las herramientas MCP están presentes. Cualquier seguimiento debe partir de ese contrato entregado, en lugar de volver a definir la funcionalidad desde cero.",
    "Already landed: the forge abstraction":
      "Ya implementado: la abstracción del forge",
    "The Runner now routes change creation, review, status, comments, merge, branch protection, and open-change queries through":
      "El Runner ahora dirige la creación de cambios, las revisiones, el estado, los comentarios, el merge, la protección de branches y las consultas de cambios abiertos mediante ",
    ". Backplane ships GitHub and Gitea/Forgejo drivers. GitLab is a documented coverage gap, not evidence that the provider seam itself is still hypothetical.":
      ". Backplane incluye drivers para GitHub y Gitea/Forgejo. GitLab es una brecha de cobertura documentada, no una prueba de que la propia interfaz de proveedores siga siendo hipotética.",
    "Open validation gaps visible in source":
      "Brechas abiertas de validación visibles en el código",
    "The ": "El proveedor ",
    " provider needs a certified live run that exercises a real Valaris MCP tool call. The Gitea driver needs testing against the specific live Gitea or Forgejo version an operator plans to use. These are evidence gaps recorded by the implementations, not promises that a team is currently executing either validation.":
      " necesita una ejecución en vivo certificada que utilice una llamada real a una herramienta MCP de Valaris. El driver de Gitea necesita pruebas contra la versión específica y en vivo de Gitea o Forgejo que el operador planea utilizar. Son brechas de evidencia registradas por las implementaciones, no promesas de que un equipo esté ejecutando actualmente alguna de esas validaciones.",
    "Known coverage gaps are not roadmap commitments":
      "Las brechas de cobertura conocidas no son compromisos de roadmap",
    "A native Runner GitLab forge driver and a Redis event-bus backend are not implemented. The frontend ":
      "No están implementados un driver nativo de forge para GitLab en el Runner ni un backend Redis para el bus de eventos. El tipo ",
    " type also omits the backend's ":
      " del frontend también omite el campo ",
    " field. This page records those facts so planning can begin from current code; it does not assign owners, priority, or delivery dates.":
      " del backend. Esta página registra esos hechos para que la planificación parta del código actual; no asigna responsables, prioridad ni fechas de entrega.",
    "Read code status separately from delivery status":
      "Lee el estado del código por separado del estado de entrega",
    "“Implemented”, “tested”, and “live-certified” are different claims. Backplane should only advance a claim when the matching evidence exists in code, automated tests, or a recorded live validation.":
      "«Implementado», «probado» y «certificado en vivo» son afirmaciones distintas. Backplane solo debe elevar una afirmación cuando exista la evidencia correspondiente en el código, en pruebas automatizadas o en una validación en vivo registrada.",
  },
  "the-north-star": {
    "Backplane's direction is portable, operator-defined execution with explicit evidence at every boundary. The platform defines the work, Runners execute it, and humans retain approval and direction. Provider names should select real implementations, not decorative configuration.":
      "La dirección de Backplane es una ejecución portable y definida por el operador, con evidencia explícita en cada límite. La plataforma define el trabajo, los Runners lo ejecutan y los humanos conservan la aprobación y la dirección. Los nombres de proveedores deben seleccionar implementaciones reales, no configuración decorativa.",
    "Configuration remains platform-authoritative":
      "La configuración sigue bajo la autoridad de la plataforma",
    "The backend owns ":
      "El backend controla ",
    ", prompts, role scope, and the provider and model resolved for an assignment. The Runner consumes that contract and refuses invalid or unknown provider names. Adding a role or changing an execution stage should not require recompiling a hardcoded role table.":
      ", los prompts, el alcance de roles y el proveedor y modelo resueltos para una asignación. El Runner consume ese contrato y rechaza nombres de proveedores inválidos o desconocidos. Agregar un rol o cambiar una etapa de ejecución no debe exigir recompilar una tabla fija de roles.",
    "Provider choice executes today":
      "La elección de proveedor se ejecuta hoy",
    " and ": " y ",
    " are concrete":
      " son implementaciones concretas de ",
    " implementations, and the Runner can register both and dispatch a stage to the backend-resolved provider. This is a working CLI abstraction, not universal model support: direct Anthropic, OpenAI, Gemini, and local-model providers are not implemented by that registry.":
      ", y el Runner puede registrar ambas y dirigir una etapa al proveedor resuelto por el backend. Es una abstracción CLI operativa, no compatibilidad universal con modelos: ese registro no implementa proveedores directos para Anthropic, OpenAI, Gemini ni modelos locales.",
    "Portable does not mean identical":
      "Portable no significa idéntico",
    "Provider capabilities differ. Structured output, native cost reporting, session resume, MCP wiring, and budget enforcement are declared as capabilities so the Runner can adapt. A new provider must implement the contract and prove its behavior instead of inheriting Claude-specific assumptions.":
      "Las capacidades de los proveedores son distintas. La salida estructurada, el informe nativo de costos, la reanudación de sesiones, la conexión MCP y la aplicación de presupuestos se declaran como capacidades para que el Runner pueda adaptarse. Un proveedor nuevo debe implementar el contrato y demostrar su comportamiento, en lugar de heredar supuestos específicos de Claude.",
    "Code-host operations use a neutral seam":
      "Las operaciones del host de código usan una interfaz neutral",
    " gives the Runner neutral change, review, status, and merge operations. GitHub and Gitea/Forgejo implement that seam today. Plain git remains separate, and the absence of a native GitLab driver is stated as a limit rather than hidden behind generic vocabulary.":
      " ofrece al Runner operaciones neutrales de cambio, revisión, estado y merge. GitHub y Gitea/Forgejo implementan hoy esa interfaz. Git estándar permanece separado, y la ausencia de un driver nativo para GitLab se declara como un límite, en lugar de ocultarse detrás de vocabulario genérico.",
    "Evidence advances the claim":
      "La evidencia eleva la afirmación",
    "A compile-time interface check proves shape. A focused test proves a behavior under its fixtures. A live smoke proves one integrated path in a named environment. The north star is not a spotless-code claim; it is a platform where each operational promise names the strongest evidence that currently supports it.":
      "Una comprobación de interfaz en compilación demuestra la estructura. Una prueba focalizada demuestra un comportamiento con sus fixtures. Una prueba de humo en vivo demuestra una ruta integrada en un entorno identificado. La dirección no consiste en afirmar que el código es impecable, sino en construir una plataforma donde cada promesa operativa nombre la evidencia más sólida que la respalda actualmente.",
  },
};
