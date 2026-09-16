// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_EXTENDING = {
  "adding-a-new-mcp-tool": {
    "MCP tools are the programmatic surface runners and operator LLMs use to touch Backplane. Adding one is a small, six-step loop: pick a module, write a decorated function, include a next-step hint, register by import, test it, and update the frontend catalog so the drift guard stays happy. This page walks each step with a concrete example — a":
      "As ferramentas MCP são a superfície programática que Runners e LLMs dos operadores usam para interagir com o Backplane. Adicionar uma delas é um ciclo curto de seis etapas: escolher um módulo, escrever uma função decorada, incluir uma orientação para o próximo passo, registrar por importação, testar e atualizar o catálogo do frontend para manter o controle de divergência satisfeito. Esta página percorre cada etapa com um exemplo concreto: uma ferramenta ",
    " tool that moves a card to the archived column.":
      " que move um cartão para a coluna de arquivados.",
    "Pick a module": "Escolha um módulo",
    "Tools group by entity in ":
      "As ferramentas são agrupadas por entidade em ",
    ". A card operation goes in ":
      ". Uma operação de cartão fica em ",
    "; a workspace operation in ":
      "; uma operação de espaço de trabalho, em ",
    ". Create a new file only if no existing module fits — the MCP host shows tools in a flat list, so file boundaries are for contributors, not callers.":
      ". Crie um arquivo novo somente se nenhum módulo existente for adequado. O host MCP exibe as ferramentas em uma lista plana; portanto, os limites entre arquivos servem aos contribuidores, não aos clientes.",
    "Write the function": "Escreva a função",
    "Every tool follows the same shape:":
      "Toda ferramenta segue o mesmo formato: ",
    ", decorated with ": ", decorada com ",
    " over ": " acima de ",
    ", returning a JSON-serialized dict. The backend HTTP call goes through the lifespan-scoped ":
      ", e retorna um dict serializado em JSON. A chamada HTTP ao backend passa pelo ",
    " on the request context.":
      " com escopo de lifespan no contexto da requisição.",
    "archive_card — a minimal mutation tool":
      "archive_card: uma ferramenta mínima de mutação",
    "Parameter order is load-bearing":
      "A ordem dos parâmetros é essencial",
    " is always the last parameter. FastMCP injects the context positionally in some call paths; putting another keyword-only argument after ":
      " é sempre o último parâmetro. O FastMCP injeta o contexto por posição em alguns caminhos de chamada. Colocar outro argumento somente nomeado depois de ",
    " makes the tool invisible in the MCP handshake on certain hosts. Required positional args first, then optional keyword args, then ":
      " torna a ferramenta invisível no handshake MCP em alguns hosts. Primeiro vêm os argumentos posicionais obrigatórios; depois, os argumentos nomeados opcionais; por fim, ",
    ". No exceptions.": ". Sem exceções.",
    "The ": "O campo ",
    " field": " de resposta",
    "Every response dict should carry an ":
      "Todo dict de resposta deve conter uma chave ",
    " key with a short action-oriented instruction. The LLM reads the response verbatim; a good hint shaves an entire round-trip off the next step because the model already knows which tool to call. Bad hints describe what just happened (\"Card archived successfully\"). Good hints point to the next tool.":
      " com uma instrução curta e orientada à ação. O LLM lê a resposta literalmente; uma boa orientação elimina uma ida e volta inteira do próximo passo porque o modelo já sabe qual ferramenta chamar. Orientações ruins descrevem o que acabou de acontecer, como \"Cartão arquivado com sucesso\". Boas orientações indicam a próxima ferramenta.",
    "Write hints in the imperative":
      "Escreva as orientações no imperativo",
    "\"Call ": "\"Chame ",
    " with ": " com ",
    "to confirm.\" is a useful hint — it names a tool, names an argument, and gives a reason. \"The card has been archived.\" is not — it tells the LLM nothing it couldn't already infer from the status field. When in doubt, imagine the LLM has exactly one more tool call to make: what would help it pick?":
      "para confirmar.\" é uma orientação útil: ela identifica uma ferramenta, um argumento e um motivo. \"O cartão foi arquivado.\" não é útil, pois não informa ao LLM nada que ele não pudesse deduzir pelo campo de status. Em caso de dúvida, imagine que o LLM só pode fazer mais uma chamada de ferramenta: o que o ajudaria a escolher?",
    "Register, test, and declare": "Registre, teste e declare",
    "MCP registration happens at import time via the ":
      "O registro MCP ocorre no momento da importação por meio do decorator ",
    "decorator. Add an import line to ":
      " para registrar a ferramenta. Adicione uma linha de importação a ",
    " so the module loads when the server boots.":
      " para que o módulo seja carregado quando o servidor iniciar.",
    "server.py — side-effect imports":
      "server.py: importações por efeito colateral",
    "Write a unit test in ": "Escreva um teste unitário em ",
    " that mocks": " que use um mock de ",
    " to record the HTTP call and asserts the verb, path, and body. Naming follows":
      " para registrar a chamada HTTP e verificar o verbo, o caminho e o body. A nomenclatura segue ",
    " and": " e ",
    test_archive_card_success: "test_archive_card_success",
    "Finally, add the tool name to the frontend catalog at":
      "Por fim, adicione o nome da ferramenta ao catálogo do frontend em ",
    " in the": " no array ",
    " array (sorted alphabetically). The drift guard at ":
      ", em ordem alfabética. O controle de divergência em ",
    "will fail CI if the catalogs disagree — it exists because half-added tools that the UI can't show are worse than no tool at all.":
      " fará o CI falhar se os catálogos divergirem. Ele existe porque uma ferramenta adicionada pela metade, que a interface não consegue exibir, é pior do que nenhuma ferramenta.",
    "The drift guard catches us about twice a month":
      "O controle de divergência nos detecta cerca de duas vezes por mês",
    "The drift guard started as a paranoia test. It's fired often enough — someone adds a tool, skips the frontend catalog update, CI reminds them — that we now treat it as part of the definition of \"done.\" If you ship a tool and the operator UI can't show it in the agent tool picker, the tool effectively doesn't exist for the humans configuring the pipeline. The guard exists because we learned this the expensive way.":
      "O controle de divergência começou como um teste por excesso de cautela. Ele foi acionado vezes suficientes, quando alguém adicionava uma ferramenta, não atualizava o catálogo do frontend e era lembrado pelo CI, para que hoje seja parte da definição de \"concluído\". Se uma ferramenta é entregue, mas a interface do operador não consegue mostrá-la no seletor de ferramentas do Agente, na prática ela não existe para as pessoas que configuram o pipeline. O controle existe porque aprendemos isso da forma mais cara.",
    "If the tool mutates cards": "Se a ferramenta altera cartões",
    "Add the tool name to ": "Adicione o nome da ferramenta a ",
    " in": " em ",
    ". This populates the": ". Isso preenche o campo ",
    " field on execution records so the UI can show which cards a stage touched. Skipping this step means the execution row looks like the stage did nothing, which makes debugging a confused pipeline harder than it needs to be.":
      " nos registros de execução para que a interface possa mostrar quais cartões uma etapa alterou. Ignorar essa etapa faz a linha de execução parecer que a etapa não fez nada, o que dificulta desnecessariamente o diagnóstico de um pipeline confuso.",
  },
  "adding-a-new-pipeline-stage-variant": {
    "A pipeline stage is a ticking function the runner invokes once per heartbeat against a discovered card. Adding a new stage variant — whether a genuinely new role like ":
      "Uma etapa do pipeline é uma função cíclica que o Runner invoca uma vez por heartbeat para cada cartão descoberto. Adicionar uma nova variante de etapa, seja uma função realmente nova como ",
    " or a differently-configured copy of an existing one — is a pure configuration change. No backend code, no Go code, no redeploy. You patch ":
      " ou uma cópia de uma função existente com configuração diferente, é uma mudança exclusivamente de configuração. Não exige código no backend, código Go nem redeploy. Você atualiza ",
    ", optionally author a prompt, and the next runner tick picks it up.":
      ", opcionalmente cria um prompt, e o Runner reconhece a mudança no ciclo seguinte.",
    "When to add a stage": "Quando adicionar uma etapa",
    "Reach for a new stage when a role's discover filter, claim shape, git action, or output post-processing differs from every existing stage. If the only change is the prompt text, you don't need a new stage — override the prompt at the workspace level instead. If the only change is which column a stage moves cards to on success, edit the existing stage's ":
      "Crie uma etapa quando o filtro de descoberta, o formato de atribuição, a ação git ou o pós-processamento da saída de uma função forem diferentes dos de todas as etapas existentes. Se a única mudança for o texto do prompt, não é preciso criar uma etapa: substitua o prompt no nível do espaço de trabalho. Se a única mudança for a coluna para a qual a etapa move cartões em caso de sucesso, edite o bloco ",
    " block. A new stage earns its keep when the pipeline needs a genuinely new step.":
      " da etapa existente. Uma nova etapa se justifica quando o pipeline precisa de um passo realmente novo.",
    "A worked example: a linter role":
      "Exemplo completo: uma função de linter",
    "Suppose the pipeline has a backlog column, and you want a lightweight role that picks up every new card, runs a linter prompt against its description, attaches a ":
      "Suponha que o pipeline tenha uma coluna de backlog e você queira uma função leve que assuma cada cartão novo, execute um prompt de linter sobre sua descrição e adicione o rótulo ",
    " label, and moves on. The linter runs before the implementer so the human operator sees a clean description by the time they triage. No git action, no branch, just a prompt and a label.":
      ". Depois, ela segue em frente. O linter é executado antes do Implementador para que o operador humano veja uma descrição limpa no momento da triagem. Não há ação git nem branch, apenas um prompt e um rótulo.",
    "New stage appended to pipeline_config.stages[]":
      "Nova etapa adicionada a pipeline_config.stages[]",
    "Submit this via the pipeline builder (the UI saves an optimistic":
      "Envie essa configuração pelo construtor de pipelines, no qual a interface envia de forma otimista um ",
    " to ": " em ",
    ") or via the MCP ": ", ou pela ferramenta MCP ",
    " tool. Append": ". Inclua ",
    " so the scheduler considers it — the":
      " para que o scheduler a considere. A proteção ",
    " seatbelt in the Go runner will cover you if you forget, but explicit ordering is friendlier to the operator reading the config.":
      " no Runner Go corrige a omissão caso você se esqueça, mas uma ordenação explícita facilita a leitura da configuração pelo operador.",
    "Authoring a prompt": "Criação de um prompt",
    "For brand-new roles not in the platform registry, the backend synthesizes a minimal placeholder prompt so the stage runs without hand-authoring. The synthesis stitches together a role identity, the card context, and a post-process imperative matched to your":
      "Para funções totalmente novas que não estejam no registro da plataforma, o backend sintetiza um prompt placeholder mínimo para que a etapa seja executada sem criação manual. A síntese combina uma identidade de função, o contexto do cartão e uma instrução imperativa de pós-processamento correspondente ao seu ",
    "synthesizes \"emit a review note via MCP,\" ":
      " sintetiza \"emitir uma nota de revisão via MCP\"; ",
    "synthesizes \"commit and push your changes.\"":
      " sintetiza \"fazer commit e push das alterações\".",
    "A synthesized prompt is a starting point, not a destination. Open Runner → Prompts → your custom role, and override the synthesized prompt with one that actually specifies what \"lint\" means for your project: what fields to check, what severity to flag, what label-color scheme to follow. The override saves as a prompt_config row scoped to the workspace; the synthesis machinery only fires when no override exists.":
      "Um prompt sintetizado é um ponto de partida, não o resultado final. Abra Runner → Prompts → sua função personalizada e substitua o prompt sintetizado por outro que especifique o que \"lint\" significa no seu projeto: quais campos verificar, quais severidades sinalizar e qual esquema de cores dos rótulos seguir. A substituição é salva como uma linha de prompt_config com escopo do espaço de trabalho; o mecanismo de síntese só é acionado quando não existe uma substituição.",
    "The prompt editor is a plain textarea":
      "O editor de prompts é um textarea simples",
    "Custom-role prompts render in a plain monospace ":
      "Prompts de funções personalizadas são exibidos em um ",
    ". No markdown preview, no variable autocomplete, no diff against the synthesized default. The engine treats prompts as opaque strings with a handful of ":
      " monoespaçado simples. Não há pré-visualização de markdown, preenchimento automático de variáveis nem diff em relação ao padrão sintetizado. O mecanismo trata os prompts como strings opacas com alguns ",
    " placeholders the runner substitutes before sending to the LLM. A richer editor with variable lookup and a live preview is on the backlog. For now: draft in your editor of choice, paste in, save. If you break it, the runner returns ":
      " placeholders que o Runner substitui antes de enviar ao LLM. Um editor mais completo, com consulta de variáveis e pré-visualização ao vivo, está no backlog. Por enquanto, escreva no editor de sua preferência, cole e salve. Se o prompt estiver inválido, o Runner retorna ",
    " rather than executing a malformed prompt.":
      " em vez de executar um prompt malformado.",
    "Testing the stage": "Teste da etapa",
    "Register a runner with the workspace (see Getting Started → Registering a runner) and drop a card in the backlog column. Within one tick of the runner's heartbeat, the card should gain the ":
      "Registre um Runner no espaço de trabalho, conforme Primeiros passos → Registro de um Runner, e coloque um cartão na coluna de backlog. Em até um ciclo de heartbeat do Runner, o cartão deve receber ",
    "label. Watch the activity feed — every stage invocation emits":
      " como rótulo. Acompanhe o feed de atividades: cada invocação da etapa emite ",
    " with the role and": " com a função e o ",
    " you set, so you can confirm the linter fired without reaching for logs.":
      " definidos, permitindo confirmar que o linter foi acionado sem consultar logs.",
    "Exclude yourself from rediscovery":
      "Evite que a etapa redescubra o próprio trabalho",
    "A stage that adds a label on success must also exclude cards with that label in its discover filter, or it claims the same card every tick forever. The example above does both — ":
      "Uma etapa que adiciona um rótulo em caso de sucesso também precisa excluir os cartões com esse rótulo em seu filtro de descoberta; caso contrário, assumirá o mesmo cartão em todos os ciclos. O exemplo acima faz as duas coisas: usa ",
    "on success and ": " em caso de sucesso e ",
    " in discover. A second guard is":
      " na descoberta. Uma segunda proteção é ",
    ", which uses the participant record as a second idempotency key. Use both; they cover different failure modes.":
      ", que usa o registro do participante como uma segunda chave de idempotência. Use ambas, pois elas cobrem modos de falha diferentes.",
    "Scope new stages to a test board first":
      "Limite primeiro as novas etapas a um quadro de teste",
    "The pipeline config is workspace-scoped, but discover filters can reference labels. A pragmatic rollout: require a":
      "A configuração de pipeline tem o escopo do espaço de trabalho, mas os filtros de descoberta podem referenciar rótulos. Uma ativação pragmática é exigir o rótulo ",
    " label, apply it only to cards on your test board, and watch the new stage run against a curated set before flipping the filter off. It's slower than a global rollout and it catches more mistakes.":
      ", aplicá-lo apenas aos cartões do quadro de teste e observar a nova etapa operar sobre um conjunto selecionado antes de desativar o filtro. É mais lento do que uma ativação global, mas detecta mais erros.",
  },
  "integrating-a-new-git-host": {
    "The Runner no longer hard-wires every PR operation to": "O Runner não conecta mais de forma rígida todas as operações de PR ao",
    ". A provider-neutral": ". Uma interface ",
    " interface now owns change creation, review, comments, status, merge, branch protection, and open-change queries. Backplane ships GitHub and Gitea/Forgejo drivers today. A GitLab driver is not implemented.": " independente do provedor agora controla a criação de mudanças, revisões, comentários, status, merge, proteção de branches e consultas de mudanças abertas. Atualmente, o Backplane inclui drivers para GitHub e Gitea/Forgejo. Um driver para GitLab não foi implementado.",
    "Plain git remains separate. Clone, fetch, checkout, commit, rebase, and push stay in the git layer because those operations are already host-neutral. The forge interface covers only the API or CLI surface a code host adds around a repository.": "O git convencional permanece separado. As operações clone, fetch, checkout, commit, rebase e push continuam na camada git porque já são independentes do host. A interface de forge cobre apenas a superfície de API ou CLI que um host de código acrescenta ao redor de um repositório.",
    "Implemented interface": "Interface implementada",
    "Current forge.Provider contract": "Contrato atual de forge.Provider",
    "The neutral vocabulary calls a pull request or merge request a": "O vocabulário neutro chama",
    ". Persisted database fields keep their existing": " um pull request ou merge request. Os campos persistidos no banco de dados mantêm seus nomes ",
    " names for compatibility. Merge strategies are the closed values ": " por compatibilidade. As estratégias de merge são os valores fechados ",
    ", and": " e ",
    "; review decisions are ": "; as decisões de revisão são ",
    ", and ": " e ",
    "Drivers that ship": "Drivers incluídos",
    "GitHub": "GitHub",
    " wraps the existing ": " encapsula os métodos existentes, baseados em ",
    "-backed": ", de ",
    " methods. This preserves the established GitHub behavior behind the neutral interface.": ". Isso preserva o comportamento consolidado do GitHub por trás da interface neutra.",
    "Gitea/Forgejo": "Gitea/Forgejo",
    " calls the Gitea v1 REST API. It uses": " chama a API REST v1 do Gitea. Ele usa ",
    " and ": " e ",
    ", and parses Gitea pull-request URLs for repository identity.": " e analisa as URLs de pull requests do Gitea para identificar o repositório.",
    " constructs exactly one driver from ": " cria exatamente um driver a partir de ",
    " at Runner startup. Empty means": " na inicialização do Runner. Um valor vazio significa ",
    " requires both its base URL and token; any other value returns an explicit startup error.": " exige sua URL base e seu token; qualquer outro valor retorna um erro explícito de inicialização.",
    "Git credentials are a separate backend capability": "Credenciais Git são uma capacidade separada do backend",
    "Workspace PAT connections already support GitHub, GitLab, and Gitea. That does not mean all three have a Runner forge driver. Credentials answer “may this workspace authenticate to this host?”; a driver answers “can this Runner call this host's PR API?”": "As conexões PAT do espaço de trabalho já oferecem suporte a GitHub, GitLab e Gitea. Isso não significa que os três tenham um driver de forge para o Runner. As credenciais respondem “este espaço de trabalho pode se autenticar neste host?”; um driver responde “este Runner pode chamar a API de PR deste host?”.",
    "Adding another Runner driver": "Adição de outro driver para o Runner",
    "Implement ": "Implemente ",
    " in a provider-specific package under ": " em um pacote específico do provedor dentro de ",
    "Map neutral decisions, statuses, merge strategies, and change fields at the driver edge. Do not leak provider-specific response types into the base interface.": "Mapeie decisões, status, estratégias de merge e campos de mudança neutros no limite do driver. Não exponha tipos de resposta específicos do provedor na interface base.",
    "Register the new ": "Registre o novo valor de ",
    " value in": " em",
    " and validate every provider-specific credential or base-URL requirement.": " e valide todas as credenciais e exigências de URL base específicas do provedor.",
    "Add an injectable client seam and hermetic tests for request shape, response mapping, invalid values, authentication errors, and idempotent change creation.": "Adicione uma abstração de cliente injetável e testes herméticos para o formato das requisições, o mapeamento de respostas, os valores inválidos, os erros de autenticação e a criação idempotente de mudanças.",
    "Update ": "Atualize ",
    " and the configuration drift tests in the same change.": " e os testes de divergência de configuração na mesma alteração.",
    "Current GitLab boundary": "Limite atual do GitLab",
    "GitLab tokens can be probed, encrypted, host-matched, bound to a repository, and used by the backend merge queue for authenticated git operations. The queue's non-GitHub path rebases and fast-forwards through plain git. What is missing is a native Runner driver for merge requests, reviews, status rollups, and branch protection, plus a GitLab repository-picker adapter.": "Os tokens do GitLab podem ser verificados, criptografados, comparados com o host, vinculados a um repositório e usados pela fila de merge do backend em operações git autenticadas. O caminho não GitHub da fila faz rebase e fast-forward por git convencional. Faltam um driver nativo do Runner para merge requests, revisões, consolidação de status e proteção de branches, além de um adaptador do seletor de repositórios do GitLab.",
    "A forge driver does not normalize webhooks": "Um driver de forge não normaliza webhooks",
    " covers outbound Runner operations. It does not normalize inbound webhook payloads, and it does not add a backend repository picker. Those are separate provider surfaces that must be implemented and tested independently.": " cobre as operações de saída do Runner. Ele não normaliza payloads de webhooks recebidos nem adiciona um seletor de repositórios ao backend. Essas são superfícies separadas do provedor e precisam ser implementadas e testadas de forma independente.",
    "The Gitea driver has fixture coverage, not broad live certification": "O driver do Gitea tem cobertura com fixtures, não certificação ampla em ambientes reais",
    "The driver is unit-tested through an injected HTTP client against the documented Gitea v1 shapes. The source explicitly records that it has not yet been exercised against a live matrix of Gitea and Forgejo versions. Treat a new deployment as an integration test, especially around review events and mergeability responses.": "O driver tem testes unitários com um cliente HTTP injetado e os formatos documentados da API Gitea v1. O código-fonte registra explicitamente que ele ainda não foi exercitado contra uma matriz real de versões do Gitea e do Forgejo. Trate uma nova implantação como um teste de integração, principalmente quanto aos eventos de revisão e às respostas de possibilidade de merge."
  },
  "writing-a-custom-sensor": {
    "Sensors are the feedback half of the runner harness: they evaluate what an agent produced and emit structured pass/fail signals the pipeline uses to gate the next step. Today sensors are compiled into the Go runner — adding one means writing Go, rebuilding the":
      "Os sensores são a metade de feedback do harness do Runner: eles avaliam o que um Agente produziu e emitem sinais estruturados de aprovação ou reprovação que o pipeline usa para controlar o próximo passo. Hoje, os sensores são compilados no Runner Go. Adicionar um deles exige escrever Go, recompilar o binário ",
    " binary, and shipping a new runner image. This is a compile-time extension point, not a runtime one, and it will stay that way until the declarative sensor DSL (see below) lands.":
      " e entregar uma nova imagem do Runner. Esse é um ponto de extensão em compile-time, não em runtime, e continuará assim até a implementação da DSL declarativa de sensores descrita abaixo.",
    "The Sensor interface": "A interface Sensor",
    "A sensor implements three methods: ":
      "Um sensor implementa três métodos: ",
    " (either ": ", que pode ser ",
    " for deterministic checks or ":
      " para verificações determinísticas ou ",
    " for LLM-backed ones), and ":
      " para verificações baseadas em LLM, e ",
    " returning a": ", que retorna um ",
    " with a pass flag, an optional 0..1 score, findings, and a summary. The interface lives in":
      " com um indicador de aprovação, uma pontuação opcional entre 0 e 1, achados e um resumo. A interface fica em ",
    "A minimal sensor template": "Um template mínimo de sensor",
    "The shortest useful sensor: a placeholder that checks whether any files were changed at all. Not shippable as-is, but demonstrates the shape every sensor follows — constructor, manifest, three interface methods. Use it as a skeleton when building a real check.":
      "O sensor útil mais curto é um placeholder que verifica se algum arquivo foi alterado. Ele não está pronto para entrega como se encontra, mas demonstra o formato seguido por todos os sensores: construtor, manifest e três métodos da interface. Use-o como esqueleto ao criar uma verificação real.",
    "A minimal custom sensor skeleton":
      "Esqueleto mínimo de um sensor personalizado",
    "Registering the sensor": "Registro do sensor",
    "Sensors register into ": "Os sensores são registrados em ",
    " in": " em ",
    ". The registry both constructs sensors on demand (":
      ". O registro cria sensores sob demanda com ",
    ") and publishes a manifest the runner's heartbeat ships to the backend — which is how the pipeline builder populates its sensor dropdown. Skip the manifest and the sensor is invisible to operators even if it runs.":
      " e publica um manifest que o heartbeat do Runner envia ao backend. É assim que o construtor de pipelines preenche o menu de sensores. Sem o manifest, o sensor fica invisível para os operadores mesmo que seja executado.",
    "Adding the sensor to DefaultRegistry":
      "Adição do sensor a DefaultRegistry",
    "Test and ship": "Teste e entrega",
    "Sensor tests follow the pattern in":
      "Os testes de sensores seguem o padrão de ",
    " — construct the sensor, feed it a":
      ": crie o sensor, forneça um ",
    " with controlled fixture data, assert the resulting ":
      " com dados controlados de fixture e verifique o ",
    ". Keep the test hermetic: don't shell out to real tools, don't hit the network. Sensors run on every pipeline tick; a flaky sensor is worse than no sensor.":
      " resultante. Mantenha o teste hermético: não execute ferramentas reais pelo shell nem acesse a rede. Sensores são executados em cada ciclo do pipeline; um sensor instável é pior do que nenhum sensor.",
    "Rebuild the runner: ": "Recompile o Runner: ",
    ". Publish the new binary (or image) to wherever your runners pull from; operators re-register on their next restart and the new sensor shows up in the pipeline builder's sensor picker, populated from the heartbeat manifest. Add its name to a stage's ":
      ". Publique o novo binário, ou a imagem, no local de onde seus Runners fazem pull. Na próxima reinicialização, os operadores são registrados novamente e o novo sensor aparece no seletor de sensores do construtor de pipelines, preenchido pelo manifest do heartbeat. Adicione seu nome ao array ",
    "array to start gating on it.":
      " da etapa para que ele comece a controlar o avanço.",
    "The manifest is the contract": "O manifest é o contrato",
    "The backend validates pipeline configs against the sensor manifest shipped in the last heartbeat. A stage referencing a sensor name the runner hasn't registered will fail validation when the config saves. If you add a sensor, rebuild, and deploy, make sure every runner rolls before you publish a pipeline that depends on the new sensor — a mid-rollout operator can save a config the stale runners can't honor.":
      "O backend valida as configurações de pipeline usando o manifest de sensores enviado no último heartbeat. Uma etapa que referencia um sensor não registrado pelo Runner falhará na validação ao salvar a configuração. Se você adicionar um sensor, recompilar e fizer deploy, confirme que todos os Runners foram atualizados antes de publicar um pipeline que dependa do novo sensor. Durante a atualização, um operador pode salvar uma configuração que Runners desatualizados não conseguem cumprir.",
    "You can't add a sensor at runtime":
      "Não é possível adicionar um sensor em runtime",
    "Operators configuring a pipeline can ":
      "Operadores que configuram um pipeline podem ",
    reference: "referenciar",
    " sensors. They can't ": " sensores, mas não podem ",
    define: "defini-los",
    " them. Adding a sensor requires a Go file, a build, and a runner redeploy. For a platform that markets itself on extensibility this is uncomfortable, and we know it. The compile-time boundary exists because sensors run with full filesystem and network access inside the runner process — a runtime-authored sensor is a sandboxing problem we haven't solved yet.":
      ". Adicionar um sensor exige um arquivo Go, um build e um redeploy do Runner. Isso é incômodo para uma plataforma que se apresenta como extensível, e temos consciência disso. O limite de compile-time existe porque os sensores são executados dentro do processo do Runner com acesso total ao sistema de arquivos e à rede. Um sensor criado em runtime traz um problema de sandboxing que ainda não resolvemos.",
    "The declarative sensor DSL": "A DSL declarativa de sensores",
    "The long-horizon goal is a YAML-authored sensor spec an operator can write in the pipeline builder: a command to run, an exit-code mapping, a regex or JSON path to extract findings, and a pass/fail rule. The interpreter would execute the sensor in a sandboxed subprocess with a fixed filesystem view and no network. This unblocks operator-defined ":
      "O objetivo de longo prazo é uma especificação de sensor escrita em YAML que o operador possa criar no construtor de pipelines: um comando a executar, um mapeamento de exit codes, uma regex ou um caminho JSON para extrair achados e uma regra de aprovação ou reprovação. O interpretador executaria o sensor em um subprocesso isolado, com uma visão fixa do sistema de arquivos e sem acesso à rede. Isso permite que o operador defina ",
    ", and any other toolchain without asking us to ship a new runner binary. Scoped, not scheduled — no ETA.":
      " e qualquer outra toolchain sem pedir a entrega de um novo binário do Runner. O escopo está definido, mas o trabalho não foi programado e não há ETA.",
  },
};
