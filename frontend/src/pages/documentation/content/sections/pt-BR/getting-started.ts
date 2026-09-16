// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_GETTING_STARTED = {
  "creating-your-first-workspace": {
    "After login, the root route shows the workspace picker. It lists every workspace your account can access and offers Create workspace. The global language switcher currently offers English, Spanish, and Brazilian Portuguese.":
      "Depois do login, a rota raiz mostra o seletor de espaços de trabalho. Ele lista todos os espaços que sua conta pode acessar e oferece a ação Criar espaço de trabalho. O seletor global de idioma inclui atualmente inglês, espanhol e português do Brasil.",
    "Name and slug": "Nome e slug",
    "The create dialog asks for a human-readable name and a URL slug. Keep the slug short, lowercase, and hyphenated because it appears in routes such as /acme-ops/boards, /acme-ops/runner, and /acme-ops/settings.":
      "O diálogo de criação solicita um nome legível e um slug de URL. Mantenha o slug curto, em minúsculas e separado por hífens, porque ele aparece em rotas como /acme-ops/boards, /acme-ops/runner e /acme-ops/settings.",
    "The workspace slug is immutable": "O slug do espaço de trabalho é imutável",
    "Workspace updates can change the display name, but the current API has no slug rename operation. Links, webhooks, and runner scope depend on that identifier, so choose it as a permanent value.":
      "As atualizações do espaço de trabalho podem mudar o nome visível, mas a API atual não tem uma operação para renomear o slug. Links, webhooks e o escopo dos runners dependem desse identificador; escolha-o como um valor permanente.",
    "The creator becomes an owner": "Quem cria se torna owner",
    "The creating account is added as the first owner. Workspace roles are owner, admin, member, and viewer, ordered from highest to lowest authority. Owners and admins perform workspace management; only an owner can grant or manage the owner role. Viewers are read-only.":
      "A conta criadora é adicionada como primeiro owner. As funções do espaço de trabalho são owner, admin, member e viewer, em ordem decrescente de autoridade. Owners e admins gerenciam o espaço; somente um owner pode conceder ou administrar a função owner. Viewers têm acesso somente de leitura.",
    "Add people later from /{slug}/members. Give each person the least privilege they need, and keep at least one reachable owner account for membership and destructive workspace decisions.":
      "Adicione pessoas depois por /{slug}/members. Conceda a cada uma o menor privilégio necessário e mantenha pelo menos uma conta owner acessível para gerenciar membros e decisões destrutivas do espaço de trabalho.",
    "The first workspace dashboard": "O primeiro dashboard do espaço de trabalho",
    "Successful creation routes to /{slug}. The welcome checklist guides you through creating a board, adding a project definition and notes, inviting the team, opening a channel, and connecting git. The runner link appears separately when the workspace is ready for automation.":
      "Quando a criação é concluída, você é direcionado para /{slug}. A lista de boas-vindas orienta a criar um quadro, adicionar uma definição do projeto e notas, convidar a equipe, abrir um canal e conectar o git. O link do runner aparece separadamente quando o espaço de trabalho está pronto para automação.",
    "For a personal evaluation, create the board next. For a team pilot, add collaborators early so the board, notes, and decisions are shared from the start.":
      "Para uma avaliação pessoal, crie o quadro em seguida. Para um piloto em equipe, adicione colaboradores cedo para que o quadro, as notas e as decisões sejam compartilhados desde o início.",
    "Once activity exists, the dashboard shows an activity trend panel with a 7-day and a 30-day view. The payload always carries the full 30 days, so switching ranges never costs a request. Hover the sparkline to read a per-day breakout — date plus event count — with a marker on the plotted point; the same readout is keyboard-reachable (focus the chart, then arrow keys, Home, End; Escape dismisses) and announced to screen readers. On touch screens the chart stays a plain trend line.":
      "Quando já existe atividade, o dashboard mostra um painel de tendência de atividade com visões de 7 e de 30 dias. A resposta sempre traz os 30 dias completos, então trocar de intervalo nunca custa uma requisição. Passe o cursor sobre a sparkline para ler o detalhamento por dia — data mais contagem de eventos — com um marcador sobre o ponto traçado; a mesma leitura é acessível pelo teclado (foque o gráfico e use as setas, Home e End; Escape a fecha) e é anunciada a leitores de tela. Em telas sensíveis ao toque o gráfico permanece uma simples linha de tendência.",
  },
  "your-first-board-and-card": {
    "A board is the project surface where people and runners coordinate. It contains typed columns and cards, plus definitions, resources, notes, history, timeline replay, git integration, and alerts.":
      "Um quadro é a superfície do projeto onde pessoas e runners se coordenam. Ele contém colunas tipadas e cartões, além de definições, recursos, notas, histórico, reprodução da linha do tempo, integração com git e alertas.",
    "Create the board": "Crie o quadro",
    "Open /{slug}/boards and choose Create board. The current dialog asks for a name and an optional description; it does not ask for board tags. After creation, Backplane opens the kanban view.":
      "Abra /{slug}/boards e escolha Criar quadro. O diálogo atual solicita um nome e uma descrição opcional; ele não pede tags do quadro. Depois da criação, o Backplane abre a visualização kanban.",
    "A new board is not empty. It receives four default columns: To Do with type backlog, In Progress with type active, Blocked with type blocked, and Done with type done. You may rename or reconfigure them later, but pipeline discovery reads column type rather than the visible title.":
      "Um quadro novo não está vazio. Ele recebe quatro colunas padrão: A fazer, do tipo backlog; Em andamento, do tipo active; Bloqueado, do tipo blocked; e Concluído, do tipo done. Você pode renomeá-las ou reconfigurá-las depois, mas a descoberta do pipeline lê o tipo da coluna, não o título visível.",
    "The board header exposes eight tabs: kanban, definitions, resources, notes, history, timeline, git, and alerts. Timeline is a replay and inspection surface; history is the activity record.":
      "O cabeçalho do quadro mostra oito abas: kanban, definições, recursos, notas, histórico, linha do tempo, git e alertas. A linha do tempo serve para reprodução e inspeção; o histórico é o registro de atividades.",
    "Create the first card": "Crie o primeiro cartão",
    "Use Add card at the bottom of a column. Title is the only required field. The dialog also exposes an optional description, card type, priority, target column, due date, status, labels, and participants. Creation defaults to type task and priority medium.":
      "Use Adicionar cartão na parte inferior de uma coluna. O título é o único campo obrigatório. O diálogo também oferece descrição opcional, tipo de cartão, prioridade, coluna de destino, prazo, status, rótulos e participantes. A criação usa por padrão o tipo task e a prioridade medium.",
    "The supported card types are task, issue, feature, and bug. The UI offers low, medium, high, and urgent priorities; the stored model also supports none. See the internal":
      "Os tipos de cartão aceitos são task, issue, feature e bug. A interface oferece as prioridades low, medium, high e urgent; o modelo armazenado também aceita none. Consulte a referência interna",
    "Card Type and Priority": "Tipo e prioridade de cartão",
    "reference before building automation around those values.":
      "antes de criar automações com base nesses valores.",
    "Markdown, Mermaid, and notes": "Markdown, Mermaid e notas",
    "Card descriptions and workspace notes use the shared rich-text editor. Pasting plain text that looks like Markdown converts headings, lists, links, and other supported structure; pasted HTML takes precedence. Pasting inside a code block remains literal.":
      "As descrições de cartões e as notas do espaço de trabalho usam o editor de rich text compartilhado. Colar texto simples com aparência de Markdown converte títulos, listas, links e outras estruturas aceitas; o HTML colado tem precedência. O conteúdo colado dentro de um bloco de código permanece literal.",
    "The editor can insert a Mermaid code block and render the diagram in place. Use it for compact flows or architecture context that belongs with the work. The note editor also offers Export .md. Card descriptions do not currently expose that Markdown export action.":
      "O editor pode inserir um bloco de código Mermaid e renderizar o diagrama no local. Use-o para fluxos compactos ou contexto de arquitetura relacionado ao trabalho. O editor de notas também oferece Exportar .md. As descrições de cartões não mostram atualmente essa ação de exportação para Markdown.",
    "The same export exists over the API: fetching a workspace or board note with ":
      "A mesma exportação existe na API: buscar uma nota de espaço de trabalho ou de quadro com ",
    " returns its content serialized to Markdown instead of the default raw editor JSON. The conversion is a read-time projection of the stored document — nothing is mutated — so scripts and agents can pull notes as plain Markdown without touching the editor.":
      " retorna seu conteúdo serializado em Markdown em vez do JSON bruto do editor, que é o padrão. A conversão é uma projeção em tempo de leitura do documento armazenado — nada é modificado —, então scripts e agentes podem extrair notas como Markdown puro sem tocar no editor.",
    "Diagrams render under Mermaid's ":
      "Os diagramas são renderizados com o nível de segurança ",
    " security level: the produced SVG is sanitized and click bindings are disabled. Any":
      " do Mermaid: o SVG produzido é sanitizado e os vínculos de clique ficam desabilitados. Toda diretiva",
    " directive embedded in the diagram source is stripped before rendering, because an embedded directive outranks the app's own configuration — without the strip, note content could relax that security level itself. A pasted diagram is drawn, not trusted.":
      " incorporada no código-fonte do diagrama é removida antes da renderização, porque uma diretiva incorporada prevalece sobre a configuração do próprio aplicativo; sem essa remoção, o conteúdo de uma nota poderia relaxar esse nível de segurança por conta própria. Um diagrama colado é desenhado, nunca confiado.",
    "A useful card still needs an executable brief": "Um cartão útil ainda precisa de um briefing executável",
    "Rich formatting does not replace scope. State the goal, constraints, relevant files or resources, acceptance criteria, and what must not be changed. A runner receives the card description as working context.":
      "A formatação rica não substitui o escopo. Informe o objetivo, as restrições, os arquivos ou recursos relevantes, os critérios de aceitação e o que não deve ser alterado. Um runner recebe a descrição do cartão como contexto de trabalho.",
    "Continue in the card detail sheet": "Continue no painel de detalhes do cartão",
    "Open a card to edit its description and metadata, manage labels and participants, link notes, record dependencies, or explain why work is stuck. The board remains the scanning and movement surface; the detail sheet is where the durable implementation context belongs.":
      "Abra um cartão para editar sua descrição e seus metadados, gerenciar rótulos e participantes, vincular notas, registrar dependências ou explicar por que o trabalho está bloqueado. O quadro continua sendo a superfície de leitura e movimentação; o painel de detalhes é onde fica o contexto duradouro de implementação.",
    "Validate persistence before adding automation": "Valide a persistência antes de adicionar automação",
    "Create a card with a Markdown list and a Mermaid block, reload the board, reopen the card, and export a related note as .md. This verifies the editor, database, and board route before a runner enters the loop.":
      "Crie um cartão com uma lista Markdown e um bloco Mermaid, recarregue o quadro, reabra o cartão e exporte uma nota relacionada como .md. Isso verifica o editor, o banco de dados e a rota do quadro antes que um runner entre no ciclo.",
  },
  "installing-the-mcp-server": {
    "For every preset, resolve an authorized workspace from established context after whoami. If unresolved, call list_workspaces and use a returned slug. If the choice is ambiguous, ask the user to confirm. If no authorized workspace exists, report that limitation and stop workspace checks. Never invent a slug.":
      "Para cada predefinição, resolva um espaço de trabalho autorizado a partir do contexto estabelecido após whoami. Se não for possível resolvê-lo, chame list_workspaces e use um slug retornado. Se a escolha for ambígua, peça ao usuário que confirme. Se não houver espaço de trabalho autorizado, informe essa limitação e interrompa as verificações do espaço. Nunca invente um slug.",
    "Identity and workspace resolution":
      "Identidade e resolução do espaço de trabalho",
    "Everyday project work (default): call list_boards in that workspace, then get_project_context with an existing returned board ID. Replace the placeholders below with those authorized values. If no boards exist, report the successful empty list and skip the project-context call.":
      "Trabalho diário do projeto (default): chame list_boards nesse espaço e depois get_project_context com o ID de um quadro existente retornado. Substitua os marcadores abaixo por esses valores autorizados. Se não houver quadros, informe a lista vazia retornada com sucesso e pule a chamada de contexto do projeto.",
    "Everyday project read checks":
      "Verificações de leitura do trabalho diário",
    "Loops and runners: use the loop checks below with the interactive loops preset. Everything combines the everyday and loops checks as representative read checks; they do not verify every tool. Do not expect the default preset to expose all loop tools.":
      "Loops e runners: use as verificações de loops abaixo com a predefinição interativa de loops. Tudo combina as verificações diárias e de loops como leituras representativas; elas não verificam todas as ferramentas. Não espere que a predefinição default exponha todas as ferramentas de loops.",
    "Loop read checks":
      "Verificações de leitura de loops",
    "The package commands install the released package. An unpublished candidate requires its reviewed source checkout or wheel; use the exact candidate commit when it is accessible. A released package install does not validate an unpublished candidate.":
      "Os comandos do pacote instalam a versão publicada. Um candidato não publicado exige seu checkout de código revisado ou seu wheel; use o commit exato do candidato quando estiver acessível. Instalar um pacote publicado não valida um candidato não publicado.",
    "Everyday project work: default keeps the interactive catalog compact.":
      "Trabalho diário do projeto: default mantém o catálogo interativo compacto.",
    "Loops and runners: default,autonomous-operations is for an interactive human connection to prepare and manage loops.":
      "Loops e runners: default,autonomous-operations serve para uma conexão humana interativa que prepara e gerencia loops.",
    "Everything: all is an explicit opt-in to a larger catalog that may exceed client tool limits.":
      "Tudo: all é uma escolha explícita de um catálogo maior que pode ultrapassar os limites de ferramentas do cliente.",
    "Presets are starting selections. Preserve custom toolset compositions and existing credentials. Actual autonomous runner launches use all intersected with their authorized allowlist; do not replace that execution configuration with the interactive loops preset.":
      "As predefinições são seleções iniciais. Preserve as composições personalizadas de toolsets e as credenciais existentes. Os runners autônomos reais usam all em interseção com sua allowlist autorizada; não substitua essa configuração de execução pela predefinição interativa de loops.",
    "A local stdio MCP process can use a remote Backplane API through VALARIS_API_URL. The example configures that local process. For remote MCP HTTP, the operator sets the environment at the actual MCP service startup and restarts it. Client environment cannot configure a remote MCP service.":
      "Um processo MCP local por stdio pode usar uma API remota do Backplane por VALARIS_API_URL. O exemplo configura esse processo local. Para MCP remoto por HTTP, o operador define o ambiente na inicialização do serviço MCP real e o reinicia. O ambiente do cliente não pode configurar um serviço MCP remoto.",
    "Restart the MCP server/connection after changing startup configuration, then start a fresh agent session. Inspect the current native tool schema before calling. Run whoami to confirm identity; authentication or API-key activity does not verify the selected tools. get_server_info reports server-enabled tools, while list_changed_sent only reports notification delivery. Neither proves native client availability.":
      "Reinicie o servidor/conexão MCP após alterar a configuração de inicialização e abra uma nova sessão do agente. Confira o esquema atual da ferramenta nativa antes de chamá-la. Execute whoami para confirmar a identidade; a autenticação ou a atividade da chave API não verifica as ferramentas selecionadas. get_server_info informa as ferramentas habilitadas no servidor, enquanto list_changed_sent só indica a entrega da notificação. Nenhum comprova disponibilidade nativa no cliente.",
    "For loops, replace your-workspace with the selected authorized workspace. list_agents takes no workspace_slug and lists agents visible to your credentials. Empty successful lists count as callable. Inspect propose_skill presence without invoking it. Do not register runners, bind or start loops, propose skills, or mutate boards to verify setup.":
      "Para loops, substitua your-workspace pelo espaço de trabalho autorizado selecionado. list_agents não aceita workspace_slug e lista os agentes visíveis para suas credenciais. Listas vazias retornadas com sucesso contam como chamadas disponíveis. Confira a presença de propose_skill sem invocá-la. Não registre runners, vincule ou inicie loops, proponha skills nem altere quadros para verificar a configuração.",
    "Missing tool: compare the selected toolsets with get_server_info and the client catalog. Check the running server version and its schema. Preserve VALARIS_MCP_ALLOWLIST; only an authorized operator can change a grant. If the server enables the tool but the client lacks it, follow catalog recovery.":
      "Ferramenta ausente: compare os toolsets selecionados com get_server_info e o catálogo do cliente. Confira a versão do servidor em execução e seu esquema. Preserve VALARIS_MCP_ALLOWLIST; só um operador autorizado pode alterar uma permissão. Se o servidor habilita a ferramenta mas o cliente não a tem, siga a recuperação do catálogo.",
    "401: check or replace the API key. 403: confirm authorized workspace membership and permissions with the operator; widening toolsets does not grant access.":
      "401: confira ou substitua a chave API. 403: confirme com o operador a participação no espaço de trabalho autorizado e as permissões; ampliar toolsets não concede acesso.",
    "Network error: check the API origin, connectivity and protected remote endpoint. Process-start failure: check uvx availability and host config syntax. Version or schema mismatch: use a compatible reviewed server artifact and repeat the read-only checks after restart.":
      "Erro de rede: confira a origem da API, a conectividade e o endpoint remoto protegido. Falha ao iniciar o processo: confira a disponibilidade de uvx e a sintaxe da configuração do host. Versão ou esquema incompatível: use um artefato de servidor revisado e compatível e repita as verificações somente de leitura após reiniciar.",
    "Catalog recovery and remote operator setup":
      "Recuperação do catálogo e configuração do operador remoto",
    "backplane-mcp exposes Backplane operations and guided prompts to any MCP-aware agent host. Install it on each machine that needs platform access and give each client its own revocable API key.":
      "backplane-mcp expõe operações do Backplane e prompts guiados a qualquer host de agentes compatível com MCP. Instale-o em cada máquina que precise acessar a plataforma e dê a cada cliente sua própria API key revogável.",
    "Install or run the package": "Instale ou execute o pacote",
    "Run the published package with uvx": "Execute o pacote publicado com uvx",
    "Install into the active virtual environment": "Instale no ambiente virtual ativo",
    "The package exports backplane-mcp and the compatible valaris-mcp alias. To test a reviewed source revision, include the commit in the Git URL; an unqualified branch is not a pin.":
      "O pacote exporta backplane-mcp e o alias compatível valaris-mcp. Para testar uma revisão de código analisada, inclua o commit na URL do Git; uma branch sem qualificação não é um pin.",
    "Run an exact source revision": "Execute uma revisão exata do código",
    "Configure the MCP host": "Configure o host MCP",
    "Claude Desktop uses claude_desktop_config.json. Claude Code supports a project-scoped .mcp.json file and the claude mcp add command. Legacy user-level configuration paths are not the current repository guidance. Other hosts use the same command, arguments, and environment values in their own MCP configuration format.":
      "O Claude Desktop usa claude_desktop_config.json. O Claude Code aceita um arquivo .mcp.json no escopo do projeto e o comando claude mcp add. Caminhos antigos de configuração no nível do usuário não fazem parte da orientação atual do repositório. Outros hosts usam o mesmo comando, argumentos e valores de ambiente no próprio formato de configuração MCP.",
    "Project .mcp.json or desktop MCP block": "Arquivo .mcp.json do projeto ou bloco MCP do desktop",
    "VALARIS_API_URL is the Backplane origin without a trailing /api. The client appends API paths itself. Production Compose on the same machine is http://localhost:8080; direct backend development is commonly http://localhost:8000.":
      "VALARIS_API_URL é a origem do Backplane sem /api no final. O próprio cliente acrescenta os caminhos da API. O Compose de produção na mesma máquina usa http://localhost:8080; o desenvolvimento direto do backend costuma usar http://localhost:8000.",
    "VALARIS_API_KEY is a personal vlr_ key sent as Authorization: Bearer on every request. Create it from the account menu under API Keys; the plaintext is shown once.":
      "VALARIS_API_KEY é uma chave pessoal com prefixo vlr_ enviada como Authorization: Bearer em todas as solicitações. Crie-a em API Keys no menu da conta; o valor em texto simples é exibido uma única vez.",
    "Treat the client configuration as a secret": "Trate a configuração do cliente como segredo",
    "A literal API key in JSON grants the same workspace access as its owner. Keep the file out of git, restrict filesystem access, and rotate the key if it is copied into logs or shared material.":
      "Uma API key literal no JSON concede o mesmo acesso a espaços de trabalho que seu titular. Mantenha o arquivo fora do git, restrinja o acesso no sistema de arquivos e rotacione a chave se ela for copiada para logs ou material compartilhado.",
    "Verify the connection": "Verifique a conexão",
    "Use the exact prompt identifiers": "Use os identificadores exatos dos prompts",
    "The MCP server currently registers ten prompts:": "O servidor MCP registra atualmente dez prompts:",
    "init_project initializes a project from a brief.": "init_project inicializa um projeto a partir de um briefing.",
    "standup, triage, and status summarize and organize work.": "standup, triage e status resumem e organizam o trabalho.",
    "plan_work, decompose_card, and sprint turn objectives into sequenced board work.":
      "plan_work, decompose_card e sprint transformam objetivos em trabalho sequenciado no quadro.",
    "pickup, implement, and ship guide the coding delivery loop.":
      "pickup, implement e ship orientam o ciclo de entrega de código.",
    "These underscore names are the registered MCP IDs. Use the identifier shown by your host rather than translating it or replacing underscores with dashes.":
      "Esses nomes com sublinhado são os IDs registrados no MCP. Use o identificador mostrado pelo seu host em vez de traduzi-lo ou trocar sublinhados por hífens.",
  },
  "registering-a-runner": {
    "A runner is the credentialed process that claims and executes eligible cards. The Launch runner wizard creates its identity and key, binds pipeline roles, exports configuration, and explains how to start the binary on your own machine.":
      "Um runner é o processo com credenciais que assume e executa cartões elegíveis. O assistente Iniciar runner cria sua identidade e chave, vincula funções do pipeline, exporta a configuração e explica como iniciar o binário na sua própria máquina.",
    "Open the four-step wizard": "Abra o assistente de quatro etapas",
    "In /{slug}/runner, open the Runners tab and choose Create runner. The progress strip is Identity, Roles, Config, and Launch. The Config step requires at least one board in the workspace because the exported MCP scope and runner settings are board-aware.":
      "Em /{slug}/runner, abra a aba Runners e escolha Criar runner. A faixa de progresso contém Identidade, Funções, Configuração e Inicialização. A etapa Configuração exige pelo menos um quadro no espaço de trabalho porque o escopo MCP e os ajustes exportados do runner dependem do quadro.",
    "Identity and one-time key": "Identidade e chave exibida uma única vez",
    "Enter a name and optional description. The runner is created in the current workspace. Creation returns a vlr_ API key once; Backplane stores its hash rather than recoverable plaintext.":
      "Informe um nome e uma descrição opcional. O runner é criado no espaço de trabalho atual. A criação retorna uma vez uma API key com prefixo vlr_; o Backplane armazena o hash, não um texto simples recuperável.",
    "Copy the API key before leaving the step": "Copie a API key antes de sair da etapa",
    "If the plaintext is lost, rotate the runner key. Rotation preserves the runner identity, role bindings, budget, and execution history, but the previous key stops working immediately.":
      "Se o texto simples for perdido, rotacione a chave do runner. A rotação preserva a identidade, os vínculos de funções, o orçamento e o histórico de execuções, mas a chave anterior para de funcionar imediatamente.",
    "Bind only the roles this process may execute": "Vincule somente as funções que este processo pode executar",
    "Choose from roles declared by the workspace pipeline. The wizard adds the runner through team membership and can create the Default runners team when needed. Skipping roles is allowed for configuration work, but a runner without an effective pipeline role cannot claim a stage.":
      "Escolha entre as funções declaradas pelo pipeline do espaço de trabalho. O assistente adiciona o runner por uma associação de equipe e pode criar a equipe Default runners quando necessário. É permitido pular funções durante a configuração, mas um runner sem uma função efetiva do pipeline não pode assumir uma etapa.",
    "Role bindings remain editable": "Os vínculos de funções continuam editáveis",
    "Change roles later from the runner detail and team controls. A binding authorizes a role; it does not repair a missing pipeline, prompt, board repository, or coding-agent prerequisite.":
      "Altere as funções depois pelos detalhes do runner e controles da equipe. Um vínculo autoriza uma função; ele não corrige um pipeline, prompt, repositório do quadro ou pré-requisito do agente de código ausente.",
    "Download the board-aware configuration": "Baixe a configuração vinculada ao quadro",
    "Select a board when the workspace has several. The agent-scoped Config bundle contains runner-{name}.yaml and mcp-config-{name}.json, with paths already pointing at each other. The separate mcp-config.json download is board-scoped for agent clients that do not need the runner YAML.":
      "Selecione um quadro quando o espaço de trabalho tiver vários. O pacote Config no escopo do agente contém runner-{name}.yaml e mcp-config-{name}.json, com caminhos que já apontam um para o outro. O download separado de mcp-config.json tem escopo de quadro para clientes de agentes que não precisam do YAML do runner.",
    "The bundle does not embed the raw API key. Both generated files use the $":
      "O pacote não incorpora a API key bruta. Os dois arquivos gerados usam o marcador $",
    "{VALARIS_API_KEY}": "{VALARIS_API_KEY}",
    " placeholder, so the process must receive that environment variable at launch. The bundle is safer to store than a plaintext key, but it still reveals internal URLs and scope and should not be published casually.":
      "; portanto, o processo precisa receber essa variável de ambiente na inicialização. O pacote é mais seguro para armazenar do que uma chave em texto simples, mas ainda revela URLs internas e escopo e não deve ser publicado casualmente.",
    "Use the exported filename explicitly": "Use explicitamente o nome de arquivo exportado",
    "Bare interactive startup discovers runner.yaml and mcp-config.json in its supported locations. It does not auto-discover the exported runner-{name}.yaml filename. Use -config for the downloaded bundle, from the directory that contains both exported files.":
      "A inicialização interativa sem parâmetros descobre runner.yaml e mcp-config.json nos locais aceitos. Ela não descobre automaticamente o arquivo exportado runner-{name}.yaml. Use -config para o pacote baixado a partir do diretório que contém os dois arquivos exportados.",
    "Launch the downloaded bundle": "Inicie o pacote baixado",
    "On success, the runner authenticates, resolves its identity, downloads the platform pipeline, connects its event channel, and starts the work loop. The Runners tab should then report it connected.":
      "Quando funciona, o runner se autentica, resolve sua identidade, baixa o pipeline da plataforma, conecta seu canal de eventos e inicia o ciclo de trabalho. A aba Runners deve então mostrá-lo como conectado.",
    "Rotate and re-download together":
      "Rotacione e baixe novamente em conjunto",
    "Rotate API Key from the runner detail when a key is lost or exposed. Copy the new value once, re-download the updated bundle, update every host that used the old key, and restart those processes with the new key. Test the new key before removing your secure recovery notes.":
      "Use Rotacionar API key nos detalhes do runner quando uma chave for perdida ou exposta. Copie o novo valor uma vez, baixe novamente o pacote atualizado, atualize todos os hosts que usavam a chave antiga e reinicie esses processos com a chave nova. Teste a chave nova antes de remover suas notas seguras de recuperação.",
    "Run doctor before the first work loop": "Execute doctor antes do primeiro ciclo de trabalho",
    "The next page uses -doctor with the explicit config filename. That read-only preflight catches missing CLIs, credentials, MCP config, repository access, scope, and backend connectivity before a card is claimed.":
      "A próxima página usa -doctor com o nome explícito do arquivo de configuração. Essa verificação de somente leitura detecta CLIs, credenciais, configuração MCP, acesso ao repositório, escopo ou conectividade com o backend ausentes antes de um cartão ser assumido.",
  },
  "your-first-pipeline-run": {
    "This walkthrough proves a configured runner can authenticate, accept platform authority, claim eligible work, and report the result. The exact card movements, git actions, approvals, and pull-request behavior come from your saved lifecycle; they are not unconditional defaults.":
      "Este passo a passo comprova que um runner configurado consegue se autenticar, aceitar a autoridade da plataforma, assumir trabalho elegível e informar o resultado. Os movimentos exatos dos cartões, as ações de git, as aprovações e o comportamento dos pull requests vêm do ciclo de vida salvo; não são padrões incondicionais.",
    "1. Obtain the published runner": "1. Obtenha o runner publicado",
    "Version 0.8.4 is published as checksummed macOS, Linux, and Windows binaries for arm64 and amd64. Select the filename for your host; this example is macOS arm64.":
      "A versão 0.8.4 é publicada como binários de macOS, Linux e Windows para arm64 e amd64, com checksum. Selecione o nome de arquivo do seu host; este exemplo é para macOS arm64.",
    "Download and verify the macOS arm64 binary": "Baixe e verifique o binário para macOS arm64",
    "Download and verify the Windows amd64 binary": "Baixe e verifique o binário para Windows amd64",
    "A public container is also available at ghcr.io/valaris-studio/backplane-runner:0.8.4. A container deployment must mount both runner YAML and MCP JSON at the paths referenced by the YAML; the single-mount Compose profile does not do that completely.":
      "Também há um contêiner público em ghcr.io/valaris-studio/backplane-runner:0.8.4. Uma implantação em contêiner precisa montar tanto o YAML do runner quanto o JSON do MCP nos caminhos indicados pelo YAML; o perfil do Compose com uma única montagem não faz isso por completo.",
    "Pull the published container image": "Baixe a imagem de contêiner publicada",
    "2. Prepare the exported bundle": "2. Prepare o pacote exportado",
    "Download the runner-scoped bundle from the Launch runner wizard or the runner detail. Keep runner-laptop-seba.yaml beside mcp-config-laptop-seba.json. The YAML points at its sibling and both use $":
      "Baixe o pacote no escopo do runner pelo assistente Iniciar runner ou pelos detalhes do runner. Mantenha runner-laptop-seba.yaml ao lado de mcp-config-laptop-seba.json. O YAML aponta para o arquivo vizinho e ambos usam $",
    "{VALARIS_API_KEY}": "{VALARIS_API_KEY}",
    " rather than embedding the one-time key.": " em vez de incorporar a chave exibida uma única vez.",
    "Confirm the chosen board, backend URL, workspace slug, work directory, LLM provider, and MCP path. The host also needs git, the selected coding-agent CLI, its authentication, and forge credentials when the lifecycle performs repository work.":
      "Confirme o quadro escolhido, a URL do backend, o slug do espaço de trabalho, o diretório de trabalho, o provedor de LLM e o caminho MCP. O host também precisa de git, da CLI do agente de código selecionada, de sua autenticação e das credenciais do forge quando o ciclo de vida executa trabalho no repositório.",
    "3. Run doctor with the same config": "3. Execute doctor com a mesma configuração",
    "Resolve the key and run the read-only preflight": "Resolva a chave e execute a verificação de somente leitura",
    "Replace ./backplane-runner with the downloaded versioned filename when you have not renamed it. Doctor checks local tools, credential sources, backend reachability, runner identity and budget, MCP configuration, and work-directory safety without claiming a card or spending model budget. Fix failures before starting the loop.":
      "Substitua ./backplane-runner pelo nome versionado do arquivo baixado se você não o renomeou. Doctor verifica ferramentas locais, fontes de credenciais, alcance do backend, identidade e orçamento do runner, configuração MCP e segurança do diretório de trabalho sem assumir um cartão nem gastar orçamento do modelo. Corrija as falhas antes de iniciar o ciclo.",
    "4. Verify platform-side prerequisites": "4. Verifique os pré-requisitos da plataforma",
    "The runner must belong to a team. An empty team role list means all pipeline roles; a non-empty list limits it to that subset. With no team binding, the platform cannot return a runnable pipeline config.":
      "O runner precisa pertencer a uma equipe. Uma lista vazia de funções da equipe significa todas as funções do pipeline; uma lista não vazia limita o runner àquele subconjunto. Sem vínculo de equipe, a plataforma não consegue retornar uma configuração executável do pipeline.",
    "The pipeline needs at least one stage, effective roles, and authored prompts. The runner refuses startup when the returned authority is incomplete.":
      "O pipeline precisa de pelo menos uma etapa, funções efetivas e prompts redigidos. O runner se recusa a iniciar quando a autoridade retornada está incompleta.",
    "The board needs a card in the column type discovered by a stage. If that lifecycle performs git work, the board also needs a usable repository and matching forge credentials.":
      "O quadro precisa de um cartão no tipo de coluna descoberto por uma etapa. Se esse ciclo de vida executa trabalho com git, o quadro também precisa de um repositório utilizável e credenciais correspondentes do forge.",
    "5. Start the work loop": "5. Inicie o ciclo de trabalho",
    "Launch with the exported filename": "Inicie com o nome de arquivo exportado",
    "Healthy startup includes authenticated, agent identity resolved, llm providers ready, either single-role mode or multi-role mode, websocket connected, and work loop starting. The runner polls once immediately on startup; it does not wait for the first scheduled interval. Later work can wake through WebSocket events, with HTTP polling as fallback.":
      "Uma inicialização saudável inclui authenticated, agent identity resolved, llm providers ready, single-role mode ou multi-role mode, websocket connected e work loop starting. O runner consulta uma vez imediatamente na inicialização; ele não espera o primeiro intervalo programado. Trabalhos posteriores podem despertar por eventos WebSocket, com consultas HTTP como alternativa.",
    "6. Observe an eligible card": "6. Observe um cartão elegível",
    "Create or move one well-scoped card into the first stage's discover column type. Watch stdout, the card detail, runner activity, execution history, and the Observer Panel. The Observer currently covers card, column, agent, execution, approval, and activity event namespaces.":
      "Crie ou mova um cartão bem delimitado para o tipo de coluna de descoberta da primeira etapa. Observe stdout, os detalhes do cartão, a atividade do runner, o histórico de execuções e o Painel do observador. O observador cobre atualmente os namespaces de eventos card, column, agent, execution, approval e activity.",
    "Eligibility and movement are lifecycle decisions": "Elegibilidade e movimento são decisões do ciclo de vida",
    "The backend next-assignment endpoint applies column, role, scope, and gate rules before a claim is returned. After execution, configured lifecycle actions determine commits, pushes, pull requests, and card movement. A successful model invocation alone does not promise any one of those outcomes.":
      "O endpoint next-assignment do backend aplica regras de coluna, função, escopo e gates antes de retornar uma atribuição. Depois da execução, as ações configuradas do ciclo de vida determinam commits, pushes, pull requests e movimentos dos cartões. Uma invocação bem-sucedida do modelo, sozinha, não garante nenhum desses resultados.",
    "7. Decide an approval only when requested": "7. Decida uma aprovação somente quando solicitada",
    "An approval appears only when the active lifecycle stage enables it and the execution requests an approval category. Review the payload in /{slug}/approvals and approve or reject it. Do not assume every git push or schema change automatically pauses; that policy belongs to the saved pipeline configuration.":
      "Uma aprovação aparece somente quando a etapa ativa do ciclo de vida a habilita e a execução solicita uma categoria de aprovação. Revise o payload em /{slug}/approvals e aprove ou rejeite. Não suponha que todo git push ou alteração de esquema pause automaticamente; essa política pertence à configuração salva do pipeline.",
    "8. Confirm the configured end state": "8. Confirme o estado final configurado",
    "Verify the execution record, card column and status, activity events, and any expected branch or pull request against the lifecycle you saved. If those expectations differ, preserve the logs and use the troubleshooting page instead of manually forcing the card forward.":
      "Compare o registro da execução, a coluna e o status do cartão, os eventos de atividade e qualquer branch ou pull request esperado com o ciclo de vida salvo. Se as expectativas divergirem, preserve os logs e use a página de solução de problemas em vez de forçar manualmente o cartão a avançar.",
    "Stop with SIGINT. The runner enters a graceful drain for up to 60 seconds before exit. Restart it with the same explicit config and confirm it authenticates and returns to the work loop without regenerating identity or configuration.":
      "Pare com SIGINT. O runner entra em drenagem controlada por até 60 segundos antes de encerrar. Reinicie-o com a mesma configuração explícita e confirme que ele se autentica e volta ao ciclo de trabalho sem gerar novamente identidade ou configuração.",
    "Keep the first run deliberately small": "Mantenha a primeira execução deliberadamente pequena",
    "Use one reversible card and acceptance criteria you can inspect. The goal is to validate distribution, configuration, authority, execution, and evidence before entrusting a larger backlog.":
      "Use um cartão reversível e critérios de aceitação que você possa inspecionar. O objetivo é validar distribuição, configuração, autoridade, execução e evidências antes de confiar um backlog maior.",
  },
  "troubleshooting-your-first-run": {
    "Diagnose from evidence in the runner terminal, backend logs, execution history, and activity feed. Avoid moving a card manually until you know whether it was never eligible, never claimed, or failed after claim.":
      "Faça o diagnóstico com base nas evidências do terminal do runner, dos logs do backend, do histórico de execuções e do feed de atividades. Evite mover manualmente um cartão até saber se ele nunca foi elegível, nunca foi assumido ou falhou depois da atribuição.",
    "Run doctor against the exported config first": "Primeiro, execute doctor com a configuração exportada",
    "The generated runner filename is not auto-discovered. Use the same environment and explicit file that the work loop will use.":
      "O nome gerado do arquivo do runner não é descoberto automaticamente. Use o mesmo ambiente e o mesmo arquivo explícito que o ciclo de trabalho usará.",
    "Read-only first-run preflight": "Verificação inicial de somente leitura",
    "The runner refuses platform authority": "O runner recusa a autoridade da plataforma",
    "A startup error about a missing pipeline config, stages, or roles means the backend did not return executable authority. Confirm the runner is bound to a workspace team, the pipeline is saved and non-empty, and at least one effective role remains. With no team binding the runner does not receive a pipeline; an empty role list on an existing membership means all pipeline roles.":
      "Um erro de inicialização sobre configuração de pipeline, etapas ou funções ausentes significa que o backend não retornou autoridade executável. Confirme que o runner está vinculado a uma equipe do espaço de trabalho, que o pipeline está salvo e não está vazio e que resta pelo menos uma função efetiva. Sem vínculo de equipe, o runner não recebe um pipeline; uma lista de funções vazia em uma associação existente significa todas as funções do pipeline.",
    "The configured workspace or board is rejected": "O espaço de trabalho ou quadro configurado é rejeitado",
    "A runner cannot quietly claim outside its allowed workspace. If the exported workspace or board no longer matches its server-side scope, authentication or configuration validation reports the mismatch. Re-export for the intended board or correct the runner scope in the UI; do not reuse a bundle from another workspace.":
      "Um runner não pode assumir trabalho silenciosamente fora do espaço autorizado. Se o espaço ou quadro exportado não corresponde mais ao escopo no servidor, a autenticação ou a validação da configuração informa a divergência. Exporte novamente para o quadro pretendido ou corrija o escopo do runner na interface; não reutilize um pacote de outro espaço de trabalho.",
    "Cards remain unclaimed": "Os cartões permanecem sem atribuição",
    "Compare the card's column type, not its visible column name, with the stage discover column type.":
      "Compare o tipo da coluna do cartão, não o nome visível da coluna, com o tipo de coluna de descoberta da etapa.",
    "Confirm the runner's effective team roles include the stage role. A non-empty membership list is a restriction; an empty list grants all pipeline roles.":
      "Confirme que as funções efetivas da equipe do runner incluem a função da etapa. Uma lista de associação não vazia é uma restrição; uma lista vazia concede todas as funções do pipeline.",
    "Check budget, dependencies, gates, existing claims, and any board or repository requirements reported by next-assignment.":
      "Verifique orçamento, dependências, gates, atribuições existentes e todos os requisitos de quadro ou repositório informados por next-assignment.",
    "Inspect health_config_errors. When an effective role has no required prompt, platform-authority validation drops that role before claims; the card remains unclaimed rather than entering an awaiting-prompt state.":
      "Inspecione health_config_errors. Quando uma função efetiva não tem um prompt obrigatório, a validação da autoridade da plataforma descarta essa função antes das atribuições; o cartão permanece sem atribuição em vez de entrar em um estado de espera por prompt.",
    "The backend appends missing lifecycle roles to scheduling priority during validation, so manually editing priority order is not the normal fix for a newly added role. Repair the reported pipeline or role error instead.":
      "O backend acrescenta durante a validação as funções ausentes do ciclo de vida à prioridade de agendamento; portanto, editar manualmente a ordem de prioridade não é a correção normal para uma nova função. Corrija o erro informado do pipeline ou da função.",
    "The coding-agent process exits": "O processo do agente de código encerra",
    "Verify the provider selected by the runner config. claude-cli requires the Claude CLI and its login or configured token; codex-cli requires the Codex CLI and its own authentication. The runner intentionally removes an inherited ANTHROPIC_API_KEY before launching Claude when its provider contract selects subscription or explicit configured auth, so a random parent-shell key is not a reliable fallback.":
      "Verifique o provedor selecionado pela configuração do runner. claude-cli exige a CLI do Claude e seu login ou token configurado; codex-cli exige a CLI do Codex e sua própria autenticação. O runner remove intencionalmente uma ANTHROPIC_API_KEY herdada antes de iniciar o Claude quando o contrato do provedor seleciona assinatura ou autenticação configurada explicitamente; por isso, uma chave casual do shell pai não é uma alternativa confiável.",
    "Loop launch verifies the selected MCP configuration and required completion tools before model invocation. Local provider diagnostics report the executable, installation and version, and check recognized runtime dependencies. These diagnostics do not verify account or model access. Use the complete provider installation when a bundled inspection companion is missing. The TUI confirms providers required by the board independently from the source-model override and saves them with the selected profile.":
      "O início do loop verifica a configuração MCP selecionada e as ferramentas de conclusão necessárias antes de invocar o modelo. Os diagnósticos locais do provedor mostram o executável, a instalação e a versão, e verificam as dependências de execução reconhecidas. Esses diagnósticos não verificam o acesso à conta nem ao modelo. Use a instalação completa do provedor quando faltar um executável auxiliar de inspeção incluído. A TUI confirma os provedores exigidos pelo quadro independentemente da seleção temporária do modelo de implementação e os salva com o perfil selecionado.",
    "A claimed card stops progressing": "Um cartão assumido para de avançar",
    "Open its execution record before changing the column. Look for model exit status, timeout, approval state, git clone or forge errors, budget rejection, and the lifecycle action that was expected to move the card. Missing prompt configuration is normally caught before claim, so do not diagnose every stalled card as a prompt gap.":
      "Abra o registro de execução antes de mudar a coluna. Procure o status de saída do modelo, timeout, estado de aprovação, erros de clone git ou do forge, rejeição por orçamento e a ação do ciclo de vida que deveria mover o cartão. A ausência de configuração de prompt normalmente é detectada antes da atribuição; não diagnostique todo cartão parado como uma lacuna de prompt.",
    "Events are delayed": "Os eventos estão atrasados",
    "If the WebSocket cannot connect through a firewall or proxy, the runner can continue with HTTP polling at its configured interval. Startup also polls once immediately. Persistent delay after a healthy connection needs timestamps from stdout and the activity feed, not an assumption that the first interval has not elapsed.":
      "Se o WebSocket não conseguir se conectar por um firewall ou proxy, o runner pode continuar com consultas HTTP no intervalo configurado. A inicialização também consulta uma vez imediatamente. Um atraso persistente depois de uma conexão saudável exige horários do stdout e do feed de atividades, não a suposição de que o primeiro intervalo ainda não passou.",
    "Collect a useful failure report": "Colete um relatório de falha útil",
    "Record the runner version, config filename, workspace and board IDs, failing stage and role, doctor result, relevant sanitized runner and backend log lines, execution ID, and timestamps. Never include the vlr_ key, provider tokens, cookies, or full secret-bearing config.":
      "Registre a versão do runner, o nome do arquivo de configuração, os IDs do espaço de trabalho e do quadro, a etapa e a função que falharam, o resultado de doctor, as linhas relevantes e sanitizadas dos logs do runner e do backend, o ID da execução e os horários. Nunca inclua a chave vlr_, tokens de provedores, cookies ou a configuração completa com segredos.",
    "The Observer Panel and /{slug}/history provide the event trail. Continue with Debugging a Stuck Card under Operating the Platform when the first-run checks pass but the execution still diverges from the saved lifecycle.":
      "O Painel do observador e /{slug}/history fornecem a trilha de eventos. Continue em Depuração de um cartão travado, dentro de Operação da plataforma, quando as verificações iniciais passarem, mas a execução ainda divergir do ciclo de vida salvo.",
  },
} as const;
