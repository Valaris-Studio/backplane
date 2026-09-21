// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_CONFIGURATION = {
  "pipeline-builder": {
    "A workspace's ": "O ",
    " is the platform-owned contract that tells a Runner which roles exist, which ordered steps each role executes, and how work is scheduled. The current builder exposes one shared lifecycle draft through three views: Graph, Tree, and the legacy Form. Switching views does not create a second config or discard unsaved edits.": " é o contrato controlado pela plataforma que informa ao Runner quais funções existem, quais etapas ordenadas cada função executa e como o trabalho é agendado. O construtor atual apresenta um único rascunho compartilhado do ciclo de vida em três visualizações: Graph, Tree e o Form legado. Alternar entre as visualizações não cria outra configuração nem descarta alterações não salvas.",
    "Graph is the default operational view. Advanced opens Tree by default; the legacy Form remains available as an escape hatch while Tree earns trust. All three views read and save through": "Graph é a visualização operacional padrão. Advanced abre Tree por padrão; o Form legado continua disponível como alternativa enquanto Tree ganha confiança. As três visualizações leem e salvam por meio de",
    ", so they serialize the same": ", portanto serializam os mesmos",
    " arrays back to the backend.": " e os enviam ao backend.",
    "Pipeline page showing the Graph view and the Advanced control": "Página do pipeline com a visualização Graph e o controle Advanced",
    "Graph, Tree, and the legacy Form are three editors over one lifecycle draft, not three pipeline formats.": "Graph, Tree e o Form legado são três editores de um mesmo rascunho do ciclo de vida, e não três formatos de pipeline.",
    "The Pipeline tab shows Graph as the selected primary view and Advanced beside it.": "A aba Pipeline mostra Graph como visualização principal selecionada e Advanced ao lado.",
    "The graph contains runner lanes, role nodes, decision nodes, terminal nodes, and failure-gap indicators.": "O gráfico contém raias de runners, nós de função, nós de decisão, nós terminais e indicadores de rotas de falha incompletas.",
    "Selecting Advanced reveals Tree and legacy Form links; Tree is selected by default.": "Ao selecionar Advanced, aparecem os links Tree e Form legado; Tree vem selecionado por padrão.",
    "A Manage prompts link sits beside the view controls.": "O link Gerenciar prompts fica ao lado dos controles de visualização.",
    "No JSON transfer action is present.": "Não há nenhuma ação para transferir JSON.",
    "The lifecycle is the canonical path": "O ciclo de vida é o caminho canônico",
    "Each stage has a free-form, pipeline-unique ": "Cada estágio tem um ",
    " and an ordered ": " de formato livre e exclusivo no pipeline, além de uma lista ",
    " list. Every step has a role-local, unique ": " ordenada. Cada etapa tem um ",
    ", a closed-set ": " exclusivo dentro da função, um ",
    ", optional": " de conjunto fechado, ",
    ", and routing through ": " opcionais e roteamento por ",
    ", or ": " ou ",
    ". Step names are the graph addresses: every routing target must name another step in the same role.": ". Os nomes das etapas são os endereços do gráfico: cada destino de roteamento deve indicar outra etapa da mesma função.",
    "A lifecycle-backed reviewer stage": "Um estágio de revisão baseado no ciclo de vida",
    "Lifecycle and legacy fields are not two active paths": "O ciclo de vida e os campos legados não são dois caminhos ativos",
    "When lifecycle is non-empty, the Runner executes the lifecycle walker and ignores the legacy flat ": "Quando lifecycle não está vazio, o Runner executa o percurso do ciclo de vida e ignora em tempo de execução os blocos planos legados ",
    ", and ": " e ",
    " blocks at runtime. When lifecycle is empty, the Runner uses those flat blocks for backward compatibility with older persisted configs. New pipelines should express execution in ": ". Quando lifecycle está vazio, o Runner usa esses blocos planos para manter compatibilidade com configurações persistidas antigas. Novos pipelines devem expressar a execução em ",
    "What each view is for": "Para que serve cada visualização",
    "Graph": "Graph",
    " is the primary visual surface. It shows Runner lanes, roles, step routing, branch decisions, terminals, and health findings. It can edit the same draft in place.": " é a superfície visual principal. Ela mostra raias de runners, funções, roteamento entre etapas, decisões de ramificação, terminais e alertas de integridade. Permite editar o mesmo rascunho no próprio contexto.",
    "Tree": "Tree",
    " is the default Advanced editor. It expands configuration, scheduling, roles, steps, and property groups while keeping the lifecycle hierarchy visible.": " é o editor Advanced padrão. Ele expande configuração, agendamento, funções, etapas e grupos de propriedades, mantendo visível a hierarquia do ciclo de vida.",
    "legacy Form": "Form legado",
    " is the nested lifecycle form kept as a secondary fallback. It does not switch execution back to the flat legacy stage model.": " é o formulário aninhado do ciclo de vida mantido como alternativa secundária. Ele não devolve a execução ao modelo plano de estágios legado.",
    "Routing and validation": "Roteamento e validação",
    "A step may use ": "Uma etapa pode usar ",
    " for an unconditional edge or": " para uma conexão incondicional ou ",
    " for decision-dependent edges, but not both.": " para conexões que dependem de uma decisão, mas não os dois.",
    " is a separate error edge. The client catches duplicate step names, dangling targets, and the": " é uma conexão de erro separada. O cliente detecta nomes de etapas duplicados, destinos inexistentes e o conflito entre ",
    "-plus-": " e ",
    " conflict before save; the backend validates the complete pipeline against the lifecycle-kind registry.": " antes de salvar; o backend valida o pipeline completo com base no registro de tipos do ciclo de vida.",
    "The closed kind catalog includes discovery, claims, git setup, skills setup, LLM and sensor work, labels and notes, explicit branches, PR operations, MCP calls, role wake-ups, card movement, shipping, and terminal steps. The builder fetches that catalog from": "O catálogo fechado de tipos inclui descoberta, atribuição, preparação de git, preparação de habilidades, trabalho de LLM e sensores, rótulos e notas, ramificações explícitas, operações de PR, chamadas MCP, ativação de funções, movimentação de cartões, entrega e etapas terminais. O construtor obtém esse catálogo em",
    "One of those kinds is easy to miss on older boards:":
      "Um desses tipos passa despercebido com facilidade em quadros antigos:",
    " materializes the board's bound":
      " materializa as ",
    skills: "habilidades",
    " into the working tree before the LLM launches. A stored pipeline saved before the skills registry existed does not gain the step retroactively — add it after":
      " vinculadas ao quadro na árvore de trabalho antes de o LLM iniciar. Um pipeline salvo antes de o registro de habilidades existir não ganha a etapa retroativamente: adicione-a depois de",
    " in each role that should receive skills, or nothing materializes.":
      " em cada função que deva receber habilidades, ou nada será materializado.",
    "; adding a new runtime kind requires backend, frontend, and Runner parity.": "; adicionar um novo tipo de execução exige paridade entre backend, frontend e Runner.",
    "Scheduling": "Agendamento",
    " names every role the scheduler may select. ": " enumera todas as funções que o agendador pode selecionar. ",
    " chooses the first role with claimable work; ": " escolhe a primeira função com trabalho disponível; ",
    " advances across roles and skips those in idle cooldown. Scheduling chooses which role runs next. The role's lifecycle decides what that role does.": " avança entre as funções e ignora aquelas em pausa por inatividade. O agendamento escolhe qual função será executada em seguida. O ciclo de vida da função define o que ela faz.",
    "Saving and conflicts": "Salvamento e conflitos",
    "Saves use optimistic concurrency through": "O salvamento usa concorrência otimista por meio de",
    ". A stale save returns 409 and leaves the local draft intact. The conflict banner can reload the server version or deliberately overwrite it with the current draft; there is no automatic three-way merge.": ". Um salvamento obsoleto retorna 409 e mantém intacto o rascunho local. O aviso de conflito permite recarregar a versão do servidor ou sobrescrevê-la deliberadamente com o rascunho atual; não existe merge automático de três vias.",
    "The builder is not a separate pipeline authority": "O construtor não é uma autoridade independente do pipeline",
    "The UI does not keep a private pipeline copy and the Runner does not prefer local defaults. A successful save updates the platform's": "A interface não mantém uma cópia privada do pipeline, e o Runner não prioriza padrões locais. Um salvamento bem-sucedido atualiza o",
    "; the Runner fetches that platform-owned value. The same config can also be read or updated through MCP.": " da plataforma; o Runner busca esse valor controlado pela plataforma. A mesma configuração também pode ser lida ou atualizada por MCP.",
    "The legacy Form is intentionally still reachable": "O Form legado continua acessível de forma intencional",
    "Tree is the default Advanced editor, but the older nested form remains available and its selection persists locally. That is a migration aid, not a second schema. Both surfaces serialize through the same draft and save path.": "Tree é o editor Advanced padrão, mas o formulário aninhado anterior continua disponível e sua seleção persiste localmente. Isso auxilia a migração, não representa um segundo esquema. As duas superfícies serializam o mesmo rascunho e usam o mesmo caminho de salvamento."
  },
  "prompt-authoring-guide": {
    "A runner's LLM prompt is the contract between your pipeline intent and the model's output. The platform resolves a prompt in three layers, stamps a post-process imperative on it based on the stage's":
      "O prompt de LLM de um runner é o contrato entre a intenção do pipeline e a saída do modelo. A plataforma resolve um prompt em três camadas, acrescenta um imperativo de pós-processamento com base no",
    ", and renders the Go template against the card context before the model sees a single token. Everything in this page describes that flow.":
      " da etapa e renderiza o template Go com o contexto do cartão antes que o modelo receba um único token. Esta página descreve todo esse fluxo.",
    "Three layers": "Três camadas",
    "When a stage's LLM phase fires, the agent resolves the template for the ":
      "Quando a fase de LLM de uma etapa é executada, o agente resolve o template para o par ",
    " pair through a three-layer lookup.":
      " por meio de uma busca em três camadas.",
    "Registry.": "Registro.",
    " The platform seeds a library of default prompts on first workspace access (see":
      " A plataforma inicializa uma biblioteca de prompts padrão no primeiro acesso ao espaço de trabalho; consulte",
    "). This covers the seeded personas — implementer, reviewer, documentator, researcher, planner.":
      ". Isso cobre as personas iniciais: implementer, reviewer, documentator, researcher e planner.",
    "Synthesis.": "Síntese.",
    " For a ": " Para um par ",
    " pair that isn't in the registry, the platform synthesizes a minimal template with the canonical variables and the post-process imperative. Custom roles start here.":
      " ausente do registro, a plataforma sintetiza um template mínimo com as variáveis canônicas e o imperativo de pós-processamento. As funções personalizadas começam aqui.",
    "Override.": "Sobrescrita.",
    " An operator-authored row in": " Uma linha criada pelo operador em",
    " scoped to": " e limitada a",
    " wins over both. This is where you shape behavior for a specific workspace.":
      " prevalece sobre as outras duas camadas. É aqui que você define o comportamento de um espaço de trabalho específico.",
    "The Go agent also carries hardcoded fallbacks for the seeded personas so a fresh runner can tick before the platform's cache has warmed. This is a resilience net, not an escape hatch — platform authority means the override in ":
      "O agente Go também inclui fallbacks hardcoded para as personas iniciais, permitindo que um runner novo execute um ciclo antes que o cache da plataforma esteja aquecido. É uma proteção de resiliência, não uma rota de fuga: a autoridade da plataforma significa que a sobrescrita em ",
    " is the source of truth in any case of disagreement.":
      " é a fonte de verdade em qualquer divergência.",
    "Prompt editor with a template on the left and a rendered preview on the right":
      "Editor de prompts com um template à esquerda e a pré-visualização renderizada à direita",
    "The editor shows the raw template; the preview shows what the runner will send after variable substitution and imperative splicing.":
      "O editor mostra o template bruto; a pré-visualização mostra o que o runner enviará após substituir as variáveis e inserir o imperativo.",
    "Left pane titled 'Template' shows a multiline textarea with the raw Go template source including lines '{{.Title}}' and '{{.ProjectDirectives}}'.":
      "O painel esquerdo, intitulado 'Template', mostra uma área de texto multilinha com o código-fonte bruto do template Go, incluindo as linhas '{{.Title}}' e '{{.ProjectDirectives}}'.",
    "Right pane titled 'Rendered preview' shows the same text with variables substituted against a sample card — '{{.Title}}' replaced by 'Wire activity fan-out'.":
      "O painel direito, intitulado 'Pré-visualização renderizada', mostra o mesmo texto com as variáveis substituídas a partir de um cartão de exemplo: '{{.Title}}' é substituído por 'Wire activity fan-out'.",
    "A pill near the top reads 'Role: orchestrator / Stage: implement'.":
      "Um chip próximo ao topo mostra 'Função: orchestrator / Etapa: implement'.",
    "Bottom bar shows two buttons: 'Save override' (primary) and 'Reset to default' (secondary).":
      "A barra inferior mostra dois botões: 'Salvar sobrescrita' (principal) e 'Restaurar padrão' (secundário).",
    "A small green banner reads 'Post-process imperative: writes_code (auto-appended)'.":
      "Um pequeno aviso verde mostra 'Imperativo de pós-processamento: writes_code (adicionado automaticamente)'.",
    "Template variables": "Variáveis do template",
    "Templates are rendered with Go's ":
      "Os templates são renderizados com a sintaxe ",
    " syntax against a context struct assembled by the agent. The canonical variables available in every template:":
      " do Go sobre uma estrutura de contexto montada pelo agente. Estas variáveis canônicas estão disponíveis em todos os templates:",
    " — the UUID of the claimed card.": " — o UUID do cartão assumido.",
    " and ": " e ",
    " — the card's display fields.": " — os campos de exibição do cartão.",
    " — board definition coding standards plus pinned notes, injected when":
      " — padrões de código da definição do quadro e notas fixadas, injetados quando",
    ". Empty otherwise.": ". Caso contrário, fica vazio.",
    " — prior review notes on the card, newest-first. Usually empty on the first tick, populated on rework.":
      " — notas de revisão anteriores do cartão, da mais recente para a mais antiga. Normalmente fica vazio no primeiro ciclo e é preenchido no retrabalho.",
    " — a structured plan field, populated only when a planner stage ran upstream.":
      " — um campo de plano estruturado, preenchido apenas quando uma etapa de planejamento foi executada antes.",
    "Minimal reviewer template using the standard variables":
      "Template mínimo de revisor com as variáveis padrão",
    "The template body stops there. The post-process imperative — the line that tells the model how to format its output — is not something you write into the template. The engine appends it.":
      "O corpo do template termina aí. O imperativo de pós-processamento, a linha que informa ao modelo como formatar a saída, não é escrito por você no template. O mecanismo o acrescenta.",
    "Post-process imperatives": "Imperativos de pós-processamento",
    "This is the section that saves you from six weeks of prompt debugging.":
      "Esta é a seção que evita seis semanas de depuração de prompts.",
    "The stage's ": "O campo ",
    " picks which imperative gets spliced onto the end of the rendered template before it reaches the model. The four kinds map to four imperatives:":
      " da etapa escolhe qual imperativo será inserido no fim do template renderizado antes de chegar ao modelo. Os quatro tipos correspondem a quatro imperativos:",
    " — \"Make the changes directly in the working tree. Do not return code in your response.\" The engine then commits and pushes.":
      " — \"Make the changes directly in the working tree. Do not return code in your response.\" Em seguida, o mecanismo faz commit e push.",
    " — \"Emit a single JSON object with a":
      " — \"Emit a single JSON object with a ",
    " field. Do not write code. Do not create notes.\" The decision string indexes into":
      " field. Do not write code. Do not create notes.\" A string de decisão seleciona uma entrada em",
    " — \"Emit structured markdown findings. The platform will attach them to the card as a review note.\" No git.":
      " — \"Emit structured markdown findings. The platform will attach them to the card as a review note.\" Sem git.",
    " — \"Use the available MCP tools to create or update cards. The platform records the summary only.\" No git, no note.":
      " — \"Use the available MCP tools to create or update cards. The platform records the summary only.\" Sem git e sem nota.",
    "Picking the kind is the single most important design choice in the stage. A reviewer with ":
      "Escolher o tipo é a decisão de design mais importante da etapa. Um revisor com ",
    " will try to edit code instead of producing a decision. An implementer with":
      " tentará editar código em vez de produzir uma decisão. Um implementador com",
    " will emit JSON and never commit. If your runs consistently drift from what you wanted, check the kind before you rewrite the template.":
      " emitirá JSON e nunca fará commit. Se as execuções se afastarem repetidamente do resultado desejado, verifique o tipo antes de reescrever o template.",
    "Do not hand-write the imperative into your template":
      "Não escreva manualmente o imperativo no template",
    "The engine always splices the imperative. If you also write it into the template body, the model gets two imperatives — one from you and one auto-appended — which fight each other in subtle ways. Keep the template to the task description and the variables. Let the kind switch do its job.":
      "O mecanismo sempre insere o imperativo. Se você também o escrever no corpo do template, o modelo receberá dois imperativos, um seu e outro acrescentado automaticamente, que entrarão em conflito de maneiras sutis. Mantenha no template apenas a descrição da tarefa e as variáveis. Deixe a seleção do tipo cumprir sua função.",
    "Override scope": "Escopo da sobrescrita",
    "An override in ": "Uma sobrescrita em ",
    " is keyed by a five-tuple:": " é identificada por uma tupla de cinco elementos:",
    ". Workspace and role scope the \"who\"; stage scopes the \"when\" (which ticking phase); team scopes to an agent team when you want a subset of runners to use a variant. The ":
      ". O espaço de trabalho e a função delimitam \"quem\"; a etapa delimita \"quando\", ou seja, qual fase do ciclo; a equipe restringe a variante a um grupo de agentes quando apenas um subconjunto de runners deve usá-la. O ",
    " is the friendly-ID for a specific prompt revision — you can keep multiple variants named":
      " é o ID legível de uma revisão específica do prompt. É possível manter várias variantes chamadas",
    " and switch between them without losing the others.":
      " e alternar entre elas sem perder as demais.",
    "Resolution walks most-specific to least-specific. A prompt authored for a specific team beats a workspace-wide one; a workspace-wide override beats the registry default; the registry default beats the synthesized placeholder.":
      "A resolução vai do mais específico ao menos específico. Um prompt criado para uma equipe prevalece sobre um prompt do espaço de trabalho; a sobrescrita do espaço de trabalho prevalece sobre o padrão do registro; e o padrão do registro prevalece sobre o placeholder sintetizado.",
    "The editor is a plain textarea today":
      "Hoje, o editor é uma área de texto simples",
    "The prompt editor renders a plain ":
      "O editor de prompts renderiza um elemento ",
    " with no syntax highlighting, no template-variable autocomplete, no preview of the spliced imperative, and no diff-against-default. You can paste a five-paragraph prompt into it and it will accept. Whether the runner uses it correctly is between you and the model. A richer editor is on the roadmap; in the meantime, draft complex prompts in your editor of choice and paste the final.":
      " simples, sem destaque de sintaxe, preenchimento automático de variáveis, pré-visualização do imperativo inserido ou comparação com o padrão. É possível colar um prompt de cinco parágrafos, e ele será aceito. O uso correto pelo runner depende de você e do modelo. Um editor mais completo está planejado; enquanto isso, escreva prompts complexos no editor de sua preferência e cole a versão final.",
    "MCP is the path of least resistance for authoring":
      "MCP é o caminho mais simples para criar prompts",
    "The MCP server exposes ": "O servidor MCP expõe as ferramentas ",
    " and": " e",
    " tools. When you're iterating on a prompt from an agent client (Claude Desktop, Cursor, your own MCP consumer), calling those tools is faster than the UI — no context-switch, no copy-paste, and the tool response shows you the resolved prompt after substitution. The UI exists for the case where you don't have an MCP client connected to the workspace.":
      ". Ao iterar sobre um prompt a partir de um cliente de agentes, como Claude Desktop, Cursor ou seu próprio consumidor MCP, chamar essas ferramentas é mais rápido do que usar a interface: não há troca de contexto nem copiar e colar, e a resposta mostra o prompt resolvido após a substituição. A interface atende ao caso em que não existe um cliente MCP conectado ao espaço de trabalho.",
  },
  "custom-roles": {
    "The design principle is blunt: any role with any rules and any prompts must be user-expressible end-to-end. If the platform only supports a closed set of roles, it's a software-delivery tool pretending to be extensible. The pipeline builder, the prompt registry, and the engine's post-process dispatch were built so that adding a":
      "O princípio de design é direto: qualquer função, com quaisquer regras e prompts, deve poder ser definida pelo usuário de ponta a ponta. Se a plataforma aceita apenas um conjunto fechado de funções, ela é uma ferramenta de entrega de software apenas fingindo ser extensível. O construtor de pipelines, o registro de prompts e o despacho de pós-processamento do mecanismo foram criados para que adicionar um",
    ", a ": ", um ",
    ", or a Spanish": ", ou um ",
    " is a config change, not a code change.":
      " em espanhol seja uma alteração de configuração, não de código.",
    "This page describes the three things that make that true: free-form role strings on stages, per-stage uniqueness flags, and automatic prompt synthesis for any role the registry hasn't heard of.":
      "Esta página descreve os três elementos que tornam isso possível: strings de função livres nas etapas, indicadores de exclusividade por etapa e síntese automática de prompts para qualquer função ainda desconhecida pelo registro.",
    "Declare a custom role": "Declare uma função personalizada",
    "A stage's ": "O campo ",
    " field is a free-form string. There is no enum, no registration step, no \"role catalog\" to update. Paste the stage into your ":
      " de uma etapa é uma string livre. Não há enum, etapa de registro nem \"catálogo de funções\" para atualizar. Cole a etapa no seu ",
    ", wire the discover and LLM fields like any seeded role, and the next agent heartbeat starts ticking it.":
      ", configure os campos discover e LLM como faria com qualquer função inicial e o próximo heartbeat do agente começará a executá-la.",
    "A custom security-auditor stage":
      "Uma etapa personalizada security-auditor",
    "The role string flows everywhere: it's the scheduler priority entry, the participant role stamped on the card, the filter key for":
      "A string da função percorre todo o sistema: é a entrada de prioridade do agendador, a função de participante gravada no cartão, a chave de filtro de",
    ", and the partition key the prompt registry looks up.":
      " e a chave de partição consultada pelo registro de prompts.",
    "Uniqueness flag": "Indicador de exclusividade",
    "Every stage carries an implicit uniqueness contract — one":
      "Toda etapa tem um contrato implícito de exclusividade: um",
    " per card — and an optional per-stage":
      " por cartão, além do campo opcional por etapa",
    ". When ": ". Quando ",
    " is true, a single agent at a time can hold the participant slot for that role on a given card; other agents skip the card until the holder releases or completes. When false (the default for custom roles), multiple agents can claim the same card in that role concurrently — useful for helper-style roles where parallelism helps and conflict is unlikely.":
      " é true, apenas um agente por vez pode ocupar a vaga de participante daquela função em um cartão; os demais ignoram o cartão até que o titular o libere ou conclua. Quando é false, o padrão para funções personalizadas, vários agentes podem assumir simultaneamente o mesmo cartão nessa função. Isso é útil para funções auxiliares em que o paralelismo ajuda e conflitos são improváveis.",
    "The seeded personas set uniqueness conservatively: orchestrator is":
      "As personas iniciais definem a exclusividade de forma conservadora: orchestrator usa",
    " and therefore unique by construction; reviewer is":
      " e, portanto, já é exclusivo por definição; reviewer usa",
    " so two reviewers don't race on the same PR; documentator is not unique. For a custom role, start with the default and turn uniqueness on if you observe races.":
      " para evitar que dois revisores disputem o mesmo PR; documentator não é exclusivo. Em uma função personalizada, comece com o padrão e ative a exclusividade se observar disputas.",
    "priority_order must list every role you declare":
      "priority_order deve listar todas as funções declaradas",
    "Scheduling reads the full set of role strings from":
      "O agendamento lê o conjunto completo de strings de função em",
    " and compares them against": " e o compara com",
    ". A role that isn't in": ". Uma função ausente de",
    " never gets offered a tick — the validator emits ":
      " nunca recebe um ciclo. O validador emite ",
    " only for the inverse case (an entry with no matching stage). Adding a stage without also adding its role to the order list is silent starvation.":
      " apenas no caso inverso, quando uma entrada não tem etapa correspondente. Adicionar uma etapa sem incluir também sua função na lista de ordenação causa inanição silenciosa.",
    "Synthesis — custom roles are never second-class":
      "Síntese: funções personalizadas nunca são de segunda classe",
    "When a stage's ": "Quando o par ",
    " pair isn't in the prompt registry, the platform doesn't fail — it synthesizes a minimal placeholder template. The placeholder contains the canonical template variables (":
      " de uma etapa não existe no registro de prompts, a plataforma não falha: ela sintetiza um template placeholder mínimo. O placeholder contém as variáveis canônicas do template (",
    ") and the post-process imperative inferred from ":
      ") e o imperativo de pós-processamento inferido de ",
    ". The custom role ticks immediately with sensible defaults, and you edit the prompt through the normal authoring flow when you want to refine behavior.":
      ". A função personalizada executa imediatamente com padrões razoáveis, e você edita o prompt pelo fluxo normal de criação quando quiser refinar o comportamento.",
    "The \"Prompts\" page in the workspace config surface lists every":
      "A página \"Prompts\" da configuração do espaço de trabalho lista cada par",
    " pair the platform has seen — seeded, synthesized, or overridden — with a status badge so you can tell at a glance which are running against scaffolding and which have been shaped by an operator. Synthesis is a starting line, not a ceiling.":
      " já observado pela plataforma, seja inicial, sintetizado ou sobrescrito, com um selo de status que permite identificar rapidamente quais usam um scaffold e quais foram definidos por um operador. A síntese é um ponto de partida, não um limite.",
    "The 2026-04-18 walkthrough defined 'Secretario' and it ran":
      "O walkthrough de 2026-04-18 definiu 'Secretario', e a função foi executada",
    "Part of the end-to-end runner-launch walkthrough added a":
      "Parte do walkthrough de lançamento de um runner de ponta a ponta adicionou uma função",
    " role (a Spanish-named note-taking persona) with ":
      ", uma persona de anotações com nome em espanhol, usando ",
    ", no git, and a minimal prompt. It ticked successfully on the second heartbeat after the pipeline save, produced a review note, and moved the card to Done without a code change anywhere in the stack. Eleven other bugs surfaced that day — but the extensibility contract held.":
      ", sem git e com um prompt mínimo. Ela executou com sucesso no segundo heartbeat após o salvamento do pipeline, produziu uma nota de revisão e moveu o cartão para Done sem alterar código em nenhuma parte da stack. Outros onze bugs apareceram naquele dia, mas o contrato de extensibilidade permaneceu válido.",
    "What still gates you": "O que ainda impõe limites",
    "Custom roles are first-class on the pipeline side. A few things on the runtime side are not yet:":
      "Funções personalizadas são de primeira classe no pipeline. Alguns elementos do runtime ainda não são:",
    "Per-role LLM provider/model.": "Provedor e modelo de LLM por função.",
    " Every role runs against whatever model the agent binary was compiled against — today, Claude via the ":
      " Toda função usa o modelo para o qual o binário do agente foi compilado; hoje, Claude por meio da CLI ",
    " CLI. A pipeline that wants a cheap role for triage and an expensive role for review can't express that yet. See":
      ". Um pipeline que queira uma função econômica para triagem e outra mais cara para revisão ainda não consegue expressar essa escolha. Consulte",
    "Under the Hood — Model-Agnostic Roles":
      "Por dentro da plataforma: funções independentes de modelo",
    "Skills as bundles.": "Habilidades como pacotes.",
    " Procedural knowledge now ships as versioned ":
      " O conhecimento procedimental já é entregue como ",
    "skill bundles": "pacotes de habilidades versionados",
    "a board binds and the runner materializes into the working tree. What still doesn't exist is the role-level bundle — tools plus prompt partials plus rules as a named unit a new role can inherit from an existing one. Every stage declares its tool list inline.":
      "que um quadro vincula e o runner materializa na árvore de trabalho. O que ainda não existe é o pacote no nível da função: ferramentas, fragmentos de prompt e regras como uma unidade nomeada que uma nova função possa herdar de outra existente. Cada etapa declara sua lista de ferramentas inline.",
    "Cross-stage context.": "Contexto entre etapas.",
    " A stage can't read another stage's raw LLM output (beyond what was persisted as participant state or a review note). A blackboard-pattern primitive would unlock richer handoffs; not built.":
      " Uma etapa não consegue ler a saída bruta de LLM de outra, além do que foi persistido como estado do participante ou nota de revisão. Um mecanismo baseado no padrão blackboard permitiria entregas mais ricas; ele ainda não foi criado.",
    "Model-per-role independence is the declared next milestone":
      "Independência de modelo por função é o próximo marco declarado",
    "Decoupling the role from the runner binary's model identity is an explicit north-star item. The plumbing is partial today: prompt configs can carry a ":
      "Desacoplar a função da identidade de modelo do binário do runner é um item explícito da direção do produto. Hoje, a infraestrutura é parcial: configurações de prompt podem incluir uma indicação ",
    " hint, but the Go agent ignores it. The milestone wires that hint end-to-end so a":
      ", mas o agente Go a ignora. O marco conecta essa indicação de ponta a ponta para que uma etapa",
    " stage can run against Claude Haiku while":
      " possa usar Claude Haiku enquanto",
    " runs against Opus, in the same pipeline, from the same runner. Tracking issue and design notes live in the feedback archive under ":
      " usa Opus no mesmo pipeline e no mesmo runner. O issue de acompanhamento e as notas de design estão no arquivo de feedback em ",
  },
  sensors: {
    "A ": "Um ",
    sensor: "sensor",
    " is a platform-side check that inspects the output of a stage and decides whether the stage is allowed to progress. Sensors are the feedback half of the harness — the LLM produces a change, the sensor grades it, and the result feeds into the stage's":
      " é uma verificação executada pela plataforma que inspeciona a saída de uma etapa e decide se ela pode avançar. Os sensores são a metade de feedback do harness: o LLM produz uma alteração, o sensor a avalia e o resultado alimenta a ação",
    " action. They are the only place in the pipeline where a deterministic verdict (test passed, merge conflict detected) can override the LLM's own claim that the work is done.":
      " da etapa. Eles são o único ponto do pipeline em que um veredito determinístico, como teste aprovado ou conflito de merge detectado, pode prevalecer sobre a afirmação do próprio LLM de que o trabalho está concluído.",
    "The runner registers its sensor catalog on every heartbeat — the backend stores it on ":
      "O runner registra seu catálogo de sensores a cada heartbeat; o backend o armazena em ",
    " and the pipeline validator rejects ":
      " e o validador do pipeline rejeita qualquer ",
    " that references a sensor name no active runner has declared. Operators configure sensors per stage; the runner builds them from the manifest and runs them after the LLM call.":
      " que referencie um sensor não declarado por nenhum runner ativo. Os operadores configuram sensores por etapa; o runner os constrói a partir do manifesto e os executa após a chamada ao LLM.",
    "The shipped catalog": "O catálogo entregue",
    "Three sensors ship with the Go runner today, registered in":
      "Hoje, três sensores acompanham o runner Go, registrados em",
    " and published to the platform via the heartbeat catalog. The ":
      " e publicados na plataforma pelo catálogo do heartbeat. O campo ",
    " field is the important distinction: ":
      " estabelece a distinção importante: sensores ",
    computational: "computational",
    " sensors are deterministic and fast (linters, test runners, merge-conflict checks).":
      " são determinísticos e rápidos, como linters, executores de testes e verificações de conflito de merge.",
    Inferential: "Inferential",
    " sensors use an LLM or a remote API and produce a probabilistic verdict that can vary between runs.":
      " usam um LLM ou uma API remota e produzem um veredito probabilístico que pode variar entre execuções.",
    "The three sensors a runner publishes today":
      "Os três sensores que um runner publica hoje",
    "The list is intentionally short. ": "A lista é curta de propósito. ",
    " covers the language-specific test gate for the repos Backplane ships against today; a TypeScript equivalent and a ":
      " cobre o controle de testes específico da linguagem para os repositórios usados hoje pelo Backplane; um equivalente para TypeScript e um sensor ",
    " sensor are tracked but not yet written. The inferential half is represented by":
      " estão planejados, mas ainda não foram implementados. A parte inferencial é representada por",
    " and, at the pipeline level, by the reviewer role itself — which is an LLM-driven sensor in everything but name.":
      " e, no nível do pipeline, pela própria função de revisor, que é um sensor orientado por LLM em tudo, menos no nome.",
    "Attaching sensors to a stage": "Associação de sensores a uma etapa",
    "A stage carries an optional ": "Uma etapa contém um array opcional ",
    " array. Each entry is a sensor ":
      ". Cada entrada contém o ",
    " from the catalog plus any config overrides. The runner builds the sensor from the manifest's default config, overlays the stage-level overrides, and invokes":
      " do sensor no catálogo e eventuais sobrescritas de configuração. O runner constrói o sensor com a configuração padrão do manifesto, aplica as sobrescritas da etapa e invoca",
    " after the LLM call. A": " após a chamada ao LLM. Um",
    " carries a ": " contém um booleano ",
    " boolean, an optional score, a list of findings, a human-readable summary, and a duration.":
      ", uma pontuação opcional, uma lista de constatações, um resumo legível e uma duração.",
    "A stage with two sensors configured":
      "Uma etapa com dois sensores configurados",
    "Fail-open vs fail-closed": "Fail-open versus fail-closed",
    "If a sensor returns an error (the subprocess couldn't run, the remote API timed out, the binary wasn't in ":
      "Se um sensor retorna um erro, porque o subprocesso não pôde executar, a API remota excedeu o tempo limite ou o binário não estava em ",
    "), the runner logs it and treats the stage as failing — the":
      ", o runner registra o erro e considera a etapa como falha; a ação",
    " action applies. This is a deliberate":
      " é aplicada. Esse é um padrão deliberadamente",
    "fail-closed": "fail-closed",
    " default: we refuse to promote a change past a gate we couldn't evaluate. The alternative — silently passing when the gate is broken — is a correctness bug that hides until the first real regression slips through.":
      ": recusamos promover uma alteração além de um controle que não conseguimos avaliar. A alternativa, aprovar silenciosamente quando o controle está quebrado, é um bug de correção que permanece oculto até a primeira regressão real passar.",
    "If a sensor returns cleanly with ":
      "Se um sensor retorna normalmente com ",
    ", the failure is the sensor's actual verdict and the same path runs. The findings are attached to the execution record so the operator can inspect them in the UI without grepping the runner logs.":
      ", a falha é o veredito real do sensor e o mesmo fluxo é executado. As constatações são anexadas ao registro da execução para que o operador possa inspecioná-las na interface sem usar grep nos logs do runner.",
    "Pipeline builder stage editor with the Sensors tab active":
      "Editor de etapa do construtor de pipelines com a aba Sensores ativa",
    "The sensor picker only lists sensors the active runner has published. An unrecognized name fails validation at save time.":
      "O seletor lista apenas sensores publicados pelo runner ativo. Um nome não reconhecido falha na validação ao salvar.",
    "A stage editor is open with tabs across the top: 'Discover', 'Claim', 'Git', 'LLM', 'Sensors', 'On success', 'On failure'.":
      "Um editor de etapa está aberto com as abas 'Descoberta', 'Assunção', 'Git', 'LLM', 'Sensores', 'Em caso de sucesso' e 'Em caso de falha' no topo.",
    "The 'Sensors' tab is active and shows two configured rows.":
      "A aba 'Sensores' está ativa e mostra duas linhas configuradas.",
    "First row shows 'go-test' with config 'packages: ./backend/...' and 'timeout: 120s'.":
      "A primeira linha mostra 'go-test' com as configurações 'packages: ./backend/...' e 'timeout: 120s'.",
    "Second row shows 'conflict-check' with 'default_branch: main'.":
      "A segunda linha mostra 'conflict-check' com 'default_branch: main'.",
    "A disabled 'Add sensor' button is labelled 'No more sensors available from this runner'.":
      "O botão desativado 'Adicionar sensor' mostra 'Não há outros sensores disponíveis para este runner'.",
    "A small info line below reads 'Catalog published by runner runner-prod at 14:02:11'.":
      "Uma pequena linha informativa abaixo mostra 'Catálogo publicado pelo runner runner-prod às 14:02:11'.",
    "The catalog is published by runners, not the backend":
      "O catálogo é publicado pelos runners, não pelo backend",
    "If you hit \"save\" on a stage referencing ":
      "Se você clicar em \"salvar\" em uma etapa que referencia ",
    " and see \"unknown sensor name,\" the fix is not in the platform — it is in whichever runner build you expected to own that sensor. The backend computes the known set from the ":
      " e vir \"nome de sensor desconhecido\", a correção não está na plataforma, mas na build do runner que deveria fornecer esse sensor. O backend calcula o conjunto conhecido a partir da ",
    union: "união",
    " of sensor catalogs across active agents in the workspace. A runner that last heartbeated three days ago still counts. Restart the runner you expected to supply the sensor and the catalog refreshes on the next heartbeat.":
      " dos catálogos de sensores dos agentes ativos no espaço de trabalho. Um runner cujo último heartbeat ocorreu há três dias ainda entra no cálculo. Reinicie o runner que deveria fornecer o sensor; o catálogo será atualizado no próximo heartbeat.",
    "A declarative sensor DSL is on the roadmap, not shipped":
      "Uma DSL declarativa de sensores está planejada, mas ainda não foi entregue",
    "Adding a new sensor today means writing Go: implement the":
      "Hoje, adicionar um sensor novo exige escrever Go: implementar a interface",
    " interface, register a factory in the harness registry, cut a runner release. That is a higher bar than the vision document describes. The longer-horizon ambition is a declarative sensor spec — author the check in YAML or JSON, publish it to the platform, have any runner pick it up — so a non-Go operator can add a gate without a binary rebuild. Tracked; not imminent.":
      ", registrar uma factory no registro do harness e criar um release do runner. É uma exigência maior do que a descrita no documento de visão. A ambição de longo prazo é uma especificação declarativa de sensor: criar a verificação em YAML ou JSON, publicá-la na plataforma e permitir que qualquer runner a use, para que um operador que não programa em Go possa adicionar um controle sem recompilar o binário. Está planejado, mas não é iminente.",
  },
  "approval-categories-and-risk-scoring": {
    "Approvals are the gate a runner crosses before it does something destructive or high-blast-radius. A stage with":
      "As aprovações são o controle que um runner atravessa antes de executar algo destrutivo ou de grande impacto. Uma etapa com",
    " allows its LLM to emit": " permite que seu LLM emita",
    "via MCP. The backend scores the request, auto-approves the cheap ones, and parks the risky ones in a queue the operator drains by hand.":
      "via MCP. O backend pontua a solicitação, aprova automaticamente as de baixo risco e coloca as arriscadas em uma fila que o operador processa manualmente.",
    "Seven categories exist, chosen to cover the action shapes that have cost real money to get wrong. The category is not free-form — an LLM request with an unknown category is rejected before it ever reaches the queue.":
      "Existem sete categorias, escolhidas para cobrir os tipos de ação cujos erros já tiveram custo financeiro real. A categoria não é livre: uma solicitação de LLM com categoria desconhecida é rejeitada antes de chegar à fila.",
    "The seven categories": "As sete categorias",
    "Each category carries a base risk score between 0 and 100. The score is bumped up or down by the action payload — a deletion of a single card scores differently from a bulk delete of forty. The full formula lives in ":
      "Cada categoria tem uma pontuação básica de risco entre 0 e 100. O payload da ação aumenta ou reduz essa pontuação; excluir um único cartão tem peso diferente de excluir quarenta em massa. A fórmula completa está em ",
    "The category base scores (risk.py)":
      "Pontuações básicas das categorias (risk.py)",
    "The threshold is an inclusive ceiling: a computed score of 30 or less becomes ":
      "O limite é inclusivo: uma pontuação calculada de 30 ou menos se torna ",
    " at create time and never shows up in the queue. A score of 31 or more becomes ":
      " no momento da criação e nunca aparece na fila. Uma pontuação de 31 ou mais se torna ",
    ", a row appears in ": ", uma linha aparece em ",
    ", and the owning runner sleeps on a WebSocket subscription until a human decides.":
      " e o runner responsável aguarda em uma assinatura WebSocket até que uma pessoa decida.",
    "The ": "A base 60 de ",
    " base of 60 is deliberate policy, not a tuning accident: an agent-proposed":
      " é uma política deliberada, não um acidente de ajuste: uma ",
    skill: "habilidade",
    " must always cross a human — no payload detail lowers it into auto-approve range.":
      " proposta por um agente sempre precisa passar por uma pessoa; nenhum detalhe do payload a rebaixa para a faixa de aprovação automática.",
    "The queue and the decision": "A fila e a decisão",
    "The current API route checks workspace membership but no minimum role: an owner, admin, member, or viewer can approve or reject. The backend publishes":
      "A rota atual da API verifica a associação ao workspace, mas não exige um nível mínimo de permissão: proprietários, administradores, membros e visualizadores podem aprovar ou rejeitar. O backend publica",
    "; the subscribed runner wakes the same tick and re-enters the stage via":
      "; o runner inscrito desperta no mesmo ciclo e retorna à etapa por meio de",
    ". No HTTP polling, no retry gymnastics — the request and the continuation share an approval ID that the runner carries across the gate.":
      ". Não há polling HTTP nem lógica complexa de novas tentativas: a solicitação e a continuação compartilham um ID de aprovação que o runner mantém ao atravessar o controle.",
    "Approval queue row expanded to show action payload and decision buttons":
      "Linha da fila de aprovações expandida para mostrar o payload da ação e os botões de decisão",
    "The risk score is shown next to the category so the operator can triage by blast radius, not arrival order.":
      "A pontuação de risco aparece ao lado da categoria para que o operador priorize pelo impacto, não pela ordem de chegada.",
    "Page header 'Pending approvals' with a badge '3' next to it.":
      "Cabeçalho da página 'Aprovações pendentes' com o selo '3' ao lado.",
    "First queue row expanded. Category pill 'deletion' on the left.":
      "Primeira linha da fila expandida, com o chip de categoria 'deletion' à esquerda.",
    "Risk score '80' rendered as a red badge next to the category.":
      "Pontuação de risco '80' exibida como um selo vermelho ao lado da categoria.",
    "Agent name 'runner-prod', board name 'alpha', created timestamp '2 minutes ago'.":
      "Nome do agente 'runner-prod', nome do quadro 'alpha' e horário de criação 'há 2 minutos'.",
    "Expanded body shows 'Action: delete 14 cards tagged archive-2025' and a JSON payload preview.":
      "O corpo expandido mostra 'Ação: excluir 14 cartões com o rótulo archive-2025' e uma pré-visualização do payload JSON.",
    "Two buttons at the bottom: green 'Approve', red 'Reject', with a small line 'Expires in 23h 57m'.":
      "Dois botões na parte inferior: 'Aprovar' em verde e 'Rejeitar' em vermelho, com a linha menor 'Expira em 23 h 57 min'.",
    "Reject is terminal, not a soft veto":
      "A rejeição é definitiva, não um veto temporário",
    "Approving an approval sets status ":
      "Aprovar uma solicitação define o status como ",
    "; rejecting sets ": "; rejeitar define como ",
    ". Both are one-way transitions. A second call to ":
      ". Ambas são transições unidirecionais. Uma segunda chamada a ",
    " on an already-decided approval returns 409 and mutates nothing. There is no \"reject with chance to retry\" flow — if you want the runner to try again with a different payload, reject, let the stage reach its on-failure action, and let the LLM re-request on its next tick.":
      " em uma aprovação já decidida retorna 409 e não altera nada. Não existe um fluxo de \"rejeitar com possibilidade de nova tentativa\". Para que o runner tente novamente com outro payload, rejeite, deixe a etapa alcançar sua ação de falha e permita que o LLM faça outra solicitação no ciclo seguinte.",
    "Expiry and drift": "Expiração e divergência",
    "Approvals carry an ": "As aprovações contêm um ",
    " that defaults to creation time plus 24 hours. Nothing in the backend mutates on expiry today — the row stays in the queue with status ":
      " cujo padrão é o horário de criação mais 24 horas. Hoje, o backend não altera nada na expiração: a linha permanece na fila com status ",
    " past the deadline; the runner's WebSocket subscription stays open; a late decision still wakes the runner. Operators should treat the 24-hour field as a staleness signal, not a guarantee of auto-rejection.":
      " após o prazo, a assinatura WebSocket do runner continua aberta e uma decisão tardia ainda o desperta. Os operadores devem tratar o campo de 24 horas como um sinal de desatualização, não como garantia de rejeição automática.",
    "Auto-approve runs before the row is written":
      "A aprovação automática ocorre antes de gravar a linha",
    "Auto-approve is not a background job scanning the queue. The decision happens synchronously inside":
      "A aprovação automática não é um job em segundo plano que varre a fila. A decisão ocorre de forma síncrona dentro de",
    ": if the computed score is at or below ":
      ": se a pontuação calculada for menor ou igual a ",
    ", the row is inserted with status ":
      ", a linha é inserida com status ",
    " and the event fires the same tick. This means tuning the threshold retroactively — by editing ":
      " e o evento é disparado no mesmo ciclo. Portanto, ajustar retroativamente o limite, editando ",
    " and redeploying — changes behavior for future requests only. Rows already in the queue keep the status they were written with.":
      " e fazendo outro deploy, altera apenas as solicitações futuras. Linhas que já estão na fila mantêm o status com que foram gravadas.",
    "The risk formula is an in-code heuristic, not a declarative model":
      "A fórmula de risco é uma heurística no código, não um modelo declarativo",
    "The category base scores, the payload bumps, and the auto-approve threshold are Python constants. They are not workspace-configurable, not exposed through the pipeline builder, not tunable from the UI. A workspace that wants stricter deletion gating, or wants to auto-reject anything above a score of 70, edits ":
      "As pontuações básicas das categorias, os ajustes do payload e o limite de aprovação automática são constantes Python. Não podem ser configurados por espaço de trabalho, não estão expostos no construtor de pipelines nem podem ser ajustados pela interface. Um espaço de trabalho que precise de controles mais rígidos para exclusões ou queira rejeitar automaticamente pontuações acima de 70 deve editar ",
    " and redeploys the backend. This is the sane starting point — the sample size of approvals-in-the-wild was zero when the model was written — and a workspace-level override is on the backlog for when the real data justifies the complexity.":
      " e fazer outro deploy do backend. Esse é um ponto de partida sensato: não havia nenhuma aprovação real na amostra quando o modelo foi criado. Uma sobrescrita por espaço de trabalho está no backlog para quando dados reais justificarem a complexidade.",
  },
  "budget-and-cost-controls": {
    "An agent's optional ": "O ",
    " is compared with the sum of its ":
      " opcional de um agente é comparado com a soma de seus ",
    " values from the trailing 30 days. When ":
      " dos últimos 30 dias. Quando ",
    " is null, there is no agent-level cap; Backplane does not substitute a workspace default. A configured budget is exceeded only when recorded spend is greater than the cap.":
      " é null, não há limite no nível do agente; o Backplane não o substitui por um padrão do espaço de trabalho. Um orçamento configurado só é considerado excedido quando o gasto registrado ultrapassa o limite.",
    "After discovering a card and before claiming it, the Runner requests":
      "Depois de descobrir um cartão e antes de assumi-lo, o Runner solicita",
    ". It skips the claim when the budget is exceeded. If that request fails, including with a 429, the tick fails closed instead of proceeding without a budget decision. The check does not interrupt an execution that is already in flight.":
      ". Ele não assume o cartão quando o orçamento foi excedido. Se essa requisição falhar, inclusive com 429, o ciclo é interrompido de forma segura em vez de prosseguir sem uma decisão de orçamento. A verificação não interrompe uma execução que já esteja em andamento.",
    "The cap and the panel": "O limite e o painel",
    "The ": "O ",
    " on the Runner detail page shows Budget, Spent, and Remaining. With a configured cap it also shows percentage used, the spent-to-budget values, and a progress bar. An exceeded cap adds a warning badge; a null cap adds a No budget set badge. Editing the numeric field and selecting Save updates":
      " na página de detalhes do Runner mostra Orçamento, Gasto e Restante. Com um limite configurado, também mostra a porcentagem usada, os valores gasto e orçado e uma barra de progresso. Um limite excedido adiciona um selo de alerta; um limite null adiciona o selo Sem orçamento definido. Editar o campo numérico e selecionar Salvar atualiza",
    "Budget Status panel for one Runner with a configured cap":
      "Painel Status do orçamento de um Runner com limite configurado",
    "The panel reports the rolling budget status returned by the backend and lets an operator replace or clear the cap.":
      "O painel informa o status móvel do orçamento retornado pelo backend e permite que um operador substitua ou remova o limite.",
    "Card header 'Budget Status' with a dollar icon and, when applicable, a status badge.":
      "Cabeçalho do cartão 'Status do orçamento' com um ícone de dólar e, quando aplicável, um selo de status.",
    "A usage row with the percentage used, spent and budget amounts, and a horizontal progress bar.":
      "Uma linha de uso com a porcentagem utilizada, os valores gasto e orçado e uma barra de progresso horizontal.",
    "A three-column summary labeled 'Monthly Budget (USD)', 'Spent', and 'Remaining'.":
      "Um resumo de três colunas com os rótulos 'Orçamento mensal (USD)', 'Gasto' e 'Restante'.",
    "A numeric budget field; changing it reveals the 'Save' button. Clearing the field saves a null cap.":
      "Um campo numérico de orçamento; alterá-lo revela o botão 'Salvar'. Limpar o campo salva um limite null.",
    "Stored Runner registration fields":
      "Campos armazenados do registro do Runner",
    "Rate limiting": "Limitação de requisições",
    " applies fixed, 60-second API buckets: 10 login attempts per client IP, 60 unauthenticated requests per client IP, 300 requests per authenticated user session, and 100 requests for an API-key-shaped Authorization header. The API-key bucket is fixed at 100 requests per minute today. The middleware does not read":
      " aplica buckets fixos de API de 60 segundos: 10 tentativas de login por IP do cliente, 60 requisições não autenticadas por IP do cliente, 300 requisições por sessão de usuário autenticada e 100 requisições para um cabeçalho Authorization com formato de chave de API. O bucket da chave de API é fixo em 100 requisições por minuto atualmente. O middleware não lê",
    " is stored on the Agent and returned in its configuration. The Go Runner uses it to pace local LLM provider executions; it does not tune the backend API bucket. An API request beyond its bucket returns 429 with rate-limit headers and":
      " é armazenado no agente e retornado em sua configuração. O Runner Go o utiliza para cadenciar localmente as execuções do provedor de LLM; ele não ajusta o bucket da API do backend. Uma requisição de API que ultrapassa seu bucket retorna 429 com cabeçalhos de limite de requisições e",
    "API-key classification happens before authentication":
      "A classificação da chave de API ocorre antes da autenticação",
    "Any Authorization header that starts exactly with":
      "Qualquer cabeçalho Authorization que comece exatamente com",
    " receives the API-key tier before the credential is verified. Its bucket identity uses only the first 20 characters of that header. This shape is an implementation risk: different keys with the same prefix can share a bucket, while crafted, unverified values can enter the 100/min tier. Do not treat the middleware as an authorization boundary.":
      " recebe o nível de chave de API antes da verificação da credencial. A identidade do bucket usa apenas os primeiros 20 caracteres desse cabeçalho. Esse formato representa um risco de implementação: chaves diferentes com o mesmo prefixo podem compartilhar um bucket, enquanto valores fabricados e não verificados podem entrar no nível de 100 por minuto. Não trate o middleware como um limite de autorização.",
    "Alerts and webhooks": "Alertas e webhooks",
    " has two producers with two different payload shapes. User-defined workspace alert thresholds evaluate":
      " tem dois produtores com dois formatos diferentes de payload. Os limites de alerta do espaço de trabalho definidos pelo usuário avaliam",
    " or ": " ou ",
    " and publish": " e publicam",
    ". An evaluation can publish again while its condition remains true; there is no durable once-per-period guarantee.":
      ". Uma avaliação pode publicar novamente enquanto a condição permanecer verdadeira; não existe garantia persistente de uma única publicação por período.",
    "The workspace cost circuit breaker compares the rolling 15-minute sum with ":
      "O circuit breaker de custos do espaço de trabalho compara a soma móvel de 15 minutos com ",
    " and publishes": " e publica",
    ". Its 60-second suppression is process-local and is cleared by Resume. The supported action values are ":
      ". Sua supressão de 60 segundos é local ao processo e é limpa por Retomar. Os valores de ação aceitos são ",
    ", and ": ", e ",
    "; today ": "; atualmente ",
    " follows the pause behavior because runner shutdown is not wired.":
      " segue o comportamento de pausa porque o desligamento do Runner não está conectado.",
    "Webhook subscribers receive either payload inside the standard":
      "Os assinantes de webhook recebem qualquer um dos payloads dentro do envelope padrão",
    " envelope through a generic signed HTTP POST. Backplane does not provide destination-specific notification integrations on this path; the receiving endpoint decides how to route or format the event.":
      " por meio de um POST HTTP genérico e assinado. O Backplane não fornece integrações de notificação específicas por destino nesse caminho; o endpoint receptor decide como rotear ou formatar o evento.",
    "API rate counters are per process, not per fleet":
      "Os contadores de requisições da API são por processo, não por frota",
    " keeps counters in a process-local dictionary. With ":
      " mantém os contadores em um dicionário local do processo. Com ",
    " backend instances, the effective API-key ceiling is approximately ":
      " instâncias do backend, o teto efetivo da chave de API é aproximadamente ",
    ", not": ", e não",
    ". Restarts also discard the counters. Use an external shared quota if a deployment needs a durable, fleet-wide enforcement boundary.":
      ". Reinicializações também descartam os contadores. Use uma cota externa compartilhada se uma implantação precisar de um limite de aplicação persistente para toda a frota.",
  },
  "git-configuration-and-review-modes": {
    "Backplane separates three concerns that used to be described as one GitHub-only path: repository metadata on the board, encrypted workspace credentials, and the forge driver or merge executor that performs PR operations. A provider value alone does not grant access or select a credential.": "O Backplane separa três aspectos que antes eram descritos como um único caminho exclusivo do GitHub: os metadados do repositório no quadro, as credenciais criptografadas do espaço de trabalho e o driver do forge ou executor de merge que realiza as operações de PR. O valor do provedor, por si só, não concede acesso nem seleciona uma credencial.",
    "Repository record": "Registro do repositório",
    "A board's ": "A linha ",
    " row carries the remote URL, provider, default and optional integration branches, a board-unique slug, policy, and an optional ": " de um quadro contém a URL remota, o provedor, a branch padrão, uma branch de integração opcional, um slug exclusivo no quadro, a política e um ",
    ". The backend accepts five provider identifiers; executable capabilities differ by provider and path.": " opcional. O backend aceita cinco identificadores de provedor; as capacidades executáveis variam conforme o provedor e o caminho.",
    "The GitRepo model (trimmed)": "O modelo GitRepo (resumido)",
    "Workspace credentials": "Credenciais do espaço de trabalho",
    "Workspace administrators can connect GitHub, GitLab, and Gitea with a personal access token. GitHub also has an OAuth connection flow. The backend probes the token against the selected forge before storing it, derives the account identity from the forge response, encrypts the token at rest, and never returns the token in read responses.": "Os administradores do espaço de trabalho podem conectar GitHub, GitLab e Gitea com um token de acesso pessoal. O GitHub também tem um fluxo de conexão OAuth. Antes de armazená-lo, o backend verifica o token no forge selecionado, obtém a identidade da conta a partir da resposta do forge, criptografa o token em repouso e nunca o devolve nas respostas de leitura.",
    "GitHub defaults to ": "O GitHub usa por padrão ",
    " and GitLab defaults to ": " e o GitLab usa ",
    "; either may receive an optional": "; ambos podem receber uma ",
    " for a self-hosted installation. Gitea requires a": " opcional em uma instalação auto-hospedada. O Gitea exige uma ",
    " because there is no canonical Gitea host. Bitbucket appears in the provider model, but token verification is not implemented and the connection dialog disables submission for it.": " porque não existe um host canônico do Gitea. O Bitbucket aparece no modelo de provedores, mas a verificação de tokens não foi implementada e a caixa de diálogo de conexão desativa o envio para esse provedor.",
    "A repository may bind one credential explicitly through": "Um repositório pode vincular explicitamente uma credencial por meio de",
    ". Without a binding, the resolver may use the workspace's only connection for that provider; multiple candidates are treated as ambiguous. Every resolved credential is host-checked against the repository URL before it can be inserted into a clone URL.": ". Sem um vínculo, o resolvedor pode usar a única conexão do espaço de trabalho para esse provedor; várias candidatas são tratadas como ambíguas. Cada credencial resolvida tem seu host comparado com a URL do repositório antes de ser inserida em uma URL de clonagem.",
    "Connections are managed under Git Connections in Workspace Settings. Workspace administrators add, verify, and remove them; other members see the provider, the account, and the connection health, but never the token.": "As conexões são gerenciadas em Git Connections (o painel Conexões Git), nas Configurações do espaço de trabalho. Os administradores do espaço de trabalho as adicionam, verificam e removem; os demais membros veem o provedor, a conta e a saúde da conexão, mas nunca o token.",
    "The Verify action re-runs the probe and reports named checks with guidance. ": "A ação Verificar executa novamente a sondagem e informa uma lista de verificações nomeadas, cada uma com orientação. ",
    " confirms that the forge recognized the token and named the account. ": " confirma que o forge reconheceu o token e identificou a conta. ",
    " appears only when the forge disclosed nothing about the token, which is normal for every GitHub fine-grained token; confirm the permissions by hand.": " aparece apenas quando o forge não revelou nada sobre o token, o que é normal em todos os tokens refinados do GitHub; confirme as permissões manualmente.",
    " on GitHub and ": " no GitHub e ",
    " on GitLab confirm that the required classic-token scope is present.": " no GitLab confirmam que o escopo exigido do token clássico está presente.",
    " confirms that a GitHub token can read CI state from Actions runs. A successful Verify clears any recorded error; a failure records it and the panel shows the connection as unhealthy. Health is also written from production use: a 401 or 403 during a merge, a Done-gate check, or a reconciler pass marks the connection unhealthy with the real error, and a later successful use clears it.": " confirma que um token do GitHub consegue ler o estado do CI a partir das execuções do Actions. Uma verificação bem-sucedida limpa qualquer erro registrado; uma falha o registra e o painel mostra a conexão como não saudável. A saúde também é gravada a partir do uso em produção: um 401 ou 403 durante um merge, uma checagem do Done-gate ou uma passagem do reconciliador marca a conexão como não saudável com o erro real, e um uso bem-sucedido posterior o limpa.",
    "For every backend operation the credential is resolved in order: the connection the repository is bound to, then the workspace's only connection for that provider, then the platform token from the deployment environment such as ": "Em toda operação do backend, a credencial é resolvida em ordem: a conexão à qual o repositório está vinculado, depois a única conexão do espaço de trabalho para esse provedor, depois o token da plataforma vindo do ambiente da implantação, como ",
    ", then none. At every step the credential is used only when the repository host matches the host it was issued for. Storing any connection requires": ", e por fim nenhuma. Em cada etapa, a credencial só é usada quando o host do repositório corresponde ao host para o qual ela foi emitida. Armazenar qualquer conexão exige",
    ", the Fernet key that encrypts tokens at rest; when it is unset the Add token action is disabled and the API answers 503. Setting ": ", a chave Fernet que criptografa os tokens em repouso; quando ela não está definida, a ação Adicionar token fica desabilitada e a API responde 503. Definir ",
    " to": " como",
    " removes the platform-token step, which is the posture for a multi-tenant deployment. Both are listed in the": " remove a etapa do token da plataforma, que é a postura indicada para uma implantação multi-tenant. Ambas estão listadas na",
    "environment variables reference": "referência de variáveis de ambiente",
    "Connections and Runner forge drivers are different layers": "Conexões e drivers de forge do Runner são camadas diferentes",
    "A GitLab credential is real and can authenticate clone, push, and the backend merge queue even though the Runner has no GitLab forge driver. Conversely, selecting ": "Uma credencial do GitLab é válida e pode autenticar operações de clone e push, além da fila de merge do backend, mesmo que o Runner não tenha um driver de forge para GitLab. Por outro lado, selecionar ",
    " on a repository does not dynamically rebuild a Runner. Each Runner constructs one configured forge driver at startup.": " em um repositório não reconstrói um Runner dinamicamente. Cada Runner cria um único driver de forge configurado na inicialização.",
    "Workspace integrations and board repository configuration": "Integrações do espaço de trabalho e configuração do repositório do quadro",
    "Credentials belong to the workspace; repositories bind to a matching provider credential on the board.": "As credenciais pertencem ao espaço de trabalho; os repositórios são vinculados, no quadro, a uma credencial do provedor correspondente.",
    "Workspace Settings shows connected forge accounts with provider, account, authentication kind, verification state, and a Verify action.": "As configurações do espaço de trabalho mostram as contas de forge conectadas, com provedor, conta, tipo de autenticação, estado de verificação e a ação Verificar.",
    "The Add access token dialog offers GitHub, GitLab, and Gitea; Gitea requires a base URL.": "A caixa de diálogo Adicionar token de acesso oferece GitHub, GitLab e Gitea; o Gitea exige uma URL base.",
    "The board Git dialog lets the operator choose github, gitlab, gitea, bitbucket, or other as repository metadata.": "A caixa de diálogo Git do quadro permite escolher github, gitlab, gitea, bitbucket ou other como metadado do repositório.",
    "When matching connections exist, the repository can be bound to one account.": "Quando existem conexões compatíveis, o repositório pode ser vinculado a uma conta.",
    "Repository discovery through a connected account is currently implemented only for GitHub.": "Atualmente, a descoberta de repositórios por uma conta conectada está implementada apenas para GitHub.",
    "Runner forge configuration": "Configuração do forge do Runner",
    "The Runner builds a ": "O Runner cria um ",
    " from": " a partir de",
    " at startup. It ships GitHub and Gitea/Forgejo drivers. The GitHub driver wraps the existing ": " na inicialização. Ele inclui drivers para GitHub e Gitea/Forgejo. O driver do GitHub encapsula a CLI ",
    " CLI; the Gitea driver calls the Gitea REST API and requires": " existente; o driver do Gitea chama a API REST do Gitea e exige ",
    " plus ": " além de ",
    ". An empty ": ". Um valor vazio de ",
    " defaults to ": " usa por padrão ",
    " for backward compatibility, and an unknown value fails startup.": " para manter a compatibilidade retroativa; um valor desconhecido impede a inicialização.",
    "Runner forge selection": "Seleção do forge do Runner",
    "Review mode": "Modo de revisão",
    " is the historical switch that enables the": " é o seletor histórico que habilita a etapa ",
    " lifecycle step. Despite the field name, the step now calls the configured ": " do ciclo de vida. Apesar do nome do campo, agora essa etapa chama o ",
    " posts a comment and is the default;": " publica um comentário e é o padrão; ",
    " posts a formal forge review. The latter name is also historical and a single GitHub identity still cannot approve its own PR.": " publica uma revisão formal no forge. Esse último nome também é histórico, e uma única identidade do GitHub continua sem poder aprovar o próprio PR.",
    "Merge path": "Caminho de merge",
    "The active merge happens only when an approved lifecycle branch reaches a ": "O merge ativo só acontece quando uma ramificação aprovada do ciclo de vida chega a uma etapa ",
    " step. That handler reads the top-level": ". Esse manipulador lê o indicador de nível superior ",
    " flag. When the flag is": ". Quando o indicador é ",
    " or absent, the Runner asks its configured forge driver to merge. When it is ": " ou está ausente, o Runner solicita o merge ao driver de forge configurado. Quando é ",
    ", the Runner enqueues the PR for the backend merge worker.": ", o Runner coloca o PR na fila do worker de merge do backend.",
    "The backend queue resolves the repository's workspace credential, rebases the PR branch onto ": "A fila do backend resolve a credencial do espaço de trabalho associada ao repositório, faz rebase da branch do PR sobre ",
    ", and merges only after its configured gate. GitHub uses the native": " e realiza o merge somente após o controle configurado. O GitHub usa o caminho nativo ",
    " path. Other providers use a provider-neutral fast-forward merge and push through plain git; that can leave the host's PR or MR open when the host does not infer closure from the branch.": ". Outros provedores usam um merge fast-forward independente do provedor e fazem push por git convencional; isso pode deixar o PR ou MR aberto no host quando ele não deduz o fechamento a partir da branch.",
    "Reviewer merge step and queue switch": "Etapa de merge do revisor e seletor da fila",
    "Provider metadata is not a capability promise": "Os metadados do provedor não garantem capacidades",
    "GitHub has a Runner forge driver, OAuth and PAT connections, native repository discovery, native PR merge, and GitHub CI inspection.": "O GitHub tem um driver de forge para o Runner, conexões OAuth e PAT, descoberta nativa de repositórios, merge nativo de PR e inspeção do GitHub CI.",
    "Gitea/Forgejo has PAT connections and a Runner REST forge driver. Its driver is unit-tested against HTTP fixtures, not certified against every live Gitea or Forgejo version.": "O Gitea/Forgejo tem conexões PAT e um driver REST de forge para o Runner. O driver possui testes unitários com fixtures HTTP, mas não é certificado para todas as versões reais do Gitea ou Forgejo.",
    "GitLab has verified PAT connections and works through plain git and the backend queue's non-GitHub merge path. A native Runner GitLab forge driver and repository picker are not implemented.": "O GitLab tem conexões PAT verificadas e funciona por git convencional e pelo caminho de merge não GitHub da fila do backend. Não foram implementados um driver nativo de forge do GitLab para o Runner nem um seletor de repositórios.",
    "Bitbucket and ": "Bitbucket e ",
    " remain metadata values without a verified token connection or Runner forge driver.": " continuam sendo valores de metadados sem uma conexão de token verificada ou um driver de forge para o Runner.",
    "Some public configuration names still say GitHub": "Alguns nomes públicos de configuração ainda mencionam GitHub",
    " and the ": " e o modo de revisão ",
    " review mode predate the forge abstraction. They remain wire-compatible names even where the implementation now dispatches through": " são anteriores à abstração de forge. Eles continuam sendo nomes compatíveis com o protocolo, mesmo onde a implementação agora delega por meio de ",
    ". Treat the identifiers as technical API, not as an up-to-date statement of provider scope.": ". Trate esses identificadores como parte da API técnica, não como uma descrição atualizada do alcance dos provedores."
  },
};
