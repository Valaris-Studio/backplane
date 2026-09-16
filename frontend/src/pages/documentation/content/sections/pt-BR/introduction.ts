// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_INTRODUCTION = {
  "what-backplane-is": {
    "Backplane is four things that turn out to be one thing: a context-management system for LLM agents, a project-management suite, a coordination platform for teams and agents working the same board, and a workflow automation engine built on pipelines and loops. Agents lose their memory between sessions; Backplane is where the memory lives — boards, cards, notes, definitions, and a full activity history that any agent can read back in a single call.":
      "O Backplane é quatro coisas que acabam sendo uma só: um sistema de gestão de contexto para agentes de LLM, uma suíte de gestão de projetos, uma plataforma de coordenação para equipes e agentes que trabalham no mesmo quadro e um motor de automação de fluxos de trabalho construído sobre pipelines e loops. Os agentes perdem a memória entre sessões; o Backplane é onde essa memória vive: quadros, cartões, notas, definições e um histórico completo de atividade que qualquer agente pode reler em uma única chamada.",
    "Humans shape the system — they define pipelines, author prompts, set budgets, approve risky actions. Agents do the work, whether that is an autonomous runner claiming cards inside a separate Git branch or a coding session you are driving yourself. The platform arbitrates: it stores the canonical pipeline shape, moves cards through columns, records every execution and its cost, coordinates approvals, and broadcasts everything to observers in real time.":
      "As pessoas moldam o sistema: definem pipelines, criam prompts, estabelecem orçamentos e aprovam ações de risco. Os agentes fazem o trabalho, seja um runner autônomo assumindo cartões dentro de uma branch Git separada, seja uma sessão de programação que você mesmo conduz. A plataforma faz a arbitragem: armazena a estrutura canônica do pipeline, move cartões entre colunas, registra cada execução e seu custo, coordena aprovações e transmite tudo aos observadores em tempo real.",
    "The players": "Os participantes",
    "Three kinds of actors share a workspace. ":
      "Três tipos de participantes compartilham um espaço de trabalho. ",
    Operators: "Operadores",
    " are humans with UI access; they configure pipelines, write prompts, and approve high-risk actions. ":
      " são pessoas com acesso à interface; elas configuram pipelines, escrevem prompts e aprovam ações de alto risco. ",
    Runners: "Runners",
    " are credentialed processes that execute roles on cards they claim — in practice, each runner today is a Claude CLI invocation wrapped in a Go client that knows how to speak MCP. ":
      " são processos com credenciais que executam funções nos cartões que assumem. Na prática, hoje cada runner é uma invocação do Claude CLI encapsulada por um cliente Go que sabe se comunicar via MCP. ",
    Observers: "Observadores",
    " are anyone watching the activity stream: a teammate following a live run, a dashboard aggregating cost, a webhook forwarding events to Slack.":
      " são todas as pessoas ou sistemas que acompanham o fluxo de atividades: alguém da equipe seguindo uma execução ao vivo, um dashboard consolidando custos ou um webhook encaminhando eventos ao Slack.",
    "Kanban board with a live pipeline run in progress":
      "Quadro kanban com uma execução de pipeline em andamento",
    "The board view is the operator's primary surface — every runner action lands here as a card movement or note.":
      "A visualização do quadro é a principal área de trabalho do operador: cada ação de um runner aparece aqui como um movimento de cartão ou uma nota.",
    "Kanban board titled 'Platform Polish' at the top.":
      "Quadro kanban com o título 'Platform Polish' na parte superior.",
    "Five columns: Backlog (3 cards), Ready (2), In Progress (1), Review (1), Done (4).":
      "Cinco colunas: Backlog (3 cartões), Ready (2), In Progress (1), Review (1), Done (4).",
    "The In Progress card is titled 'Wire useDomainSync for activity fan-out' and shows a green runner avatar plus a 'claimed 2m ago' timestamp.":
      "O cartão em In Progress tem o título 'Wire useDomainSync for activity fan-out' e mostra o avatar verde de um runner, além da indicação 'assumido há 2 min'.",
    "A toast in the bottom-right reads 'claude-sonnet-4 opened PR #214'.":
      "Uma notificação no canto inferior direito informa 'claude-sonnet-4 abriu o PR #214'.",
    "Sidebar shows Documentation highlighted as the current page would appear for a first-time reader.":
      "A barra lateral mostra Documentação destacada, como a página atual apareceria para quem a acessa pela primeira vez.",
    "What the platform coordinates": "O que a plataforma coordena",
    "A kanban app built for human users can assume the page occasionally refreshes. Backplane can't. The primary operators are LLMs that retry on every error, work concurrently across pipeline stages, read fields by name from tool responses, and pay for every token. Those four properties reshape every layer:":
      "Um aplicativo kanban feito para pessoas pode pressupor que a página será atualizada de vez em quando. O Backplane não pode. Os principais operadores são LLMs que tentam novamente após cada erro, trabalham de forma simultânea em diferentes etapas do pipeline, leem campos pelo nome nas respostas das ferramentas e pagam por cada token. Essas quatro características transformam todas as camadas:",
    "Idempotent mutations.": "Mutações idempotentes.",
    " Every create/add endpoint returns the existing entity if it already exists, never a 409. This is why ":
      " Cada endpoint de criação ou adição retorna a entidade existente quando ela já existe, nunca um 409. É por isso que ",
    " is safe to call from four pipeline stages in a row.":
      " pode ser chamado com segurança em quatro etapas consecutivas do pipeline.",
    "WebSocket-first event bus.": "Barramento de eventos baseado em WebSocket.",
    " Any mutation fans out on the workspace bus so every observer — UI, dashboard, other runner — stays coherent without polling.":
      " Qualquer mutação é propagada pelo barramento do espaço de trabalho, para que cada observador, seja a interface, um dashboard ou outro runner, permaneça sincronizado sem polling.",
    "Composite MCP tools.": "Ferramentas MCP compostas.",
    " collapses what would be five REST calls into one round-trip. The agent pays once.":
      " reúne o que seriam cinco chamadas REST em uma única ida e volta. O agente paga uma vez.",
    "Schema as contract.": "Schema como contrato.",
    " Runners read tool responses by field name, so drift between the database, the API schema, and the MCP docstring is a real bug — not cosmetic.":
      " Os runners leem as respostas das ferramentas pelo nome dos campos; portanto, qualquer divergência entre o banco de dados, o schema da API e a docstring do MCP é um bug real, não uma questão cosmética.",
    "The agents table is still called 'agents'":
      "A tabela de agentes ainda se chama 'agents'",
    "We renamed the concept to ": "Renomeamos o conceito para ",
    Runner: "Runner",
    " in the UI in April 2026. The database table, SQLAlchemy model, API routes, and MCP tool names all stayed as ":
      " na interface em abril de 2026. A tabela do banco de dados, o modelo SQLAlchemy, as rotas da API e os nomes das ferramentas MCP continuaram como ",
    ". This is deliberate — breaking every integration for a cosmetic win isn't worth it. If you see":
      ". Isso foi intencional: não vale a pena quebrar todas as integrações por uma melhoria meramente cosmética. Se você encontrar",
    " in the MCP catalog, that's a runner. Ask us how we know.":
      " no catálogo MCP, trata-se de um runner. Pergunte como sabemos.",
    "A minimal pipeline, in the shape you'll configure":
      "Um pipeline mínimo, no formato que você vai configurar",
    "Every workspace has a ": "Todo espaço de trabalho tem uma ",
    " — a declarative description of the stages a card moves through, what role executes at each stage, what column types trigger it, and what sensors veto or gate the work. Here's the smallest one that does something real: a single implementer role that picks up cards from the ":
      " — uma descrição declarativa das etapas percorridas por um cartão, da função executada em cada etapa, dos tipos de coluna que a acionam e dos sensores que vetam ou condicionam o trabalho. Este é o menor exemplo que faz algo concreto: uma única função de implementador que assume cartões da coluna ",
    Ready: "Ready",
    "column and moves them to ": " e os move para ",
    Review: "Review",
    " when done.": " quando termina.",
    "Minimal pipeline_config — one implementer stage":
      "pipeline_config mínimo: uma etapa de implementador",
    "Backplane is not autonomous by default, and not model-locked":
      "O Backplane não é autônomo por padrão e não é limitado a um único modelo",
    "Runners execute pipelines you configured — they don't invent objectives and they stop at the approval gates you defined. Model routing today goes through Claude via the ":
      "Os runners executam os pipelines que você configurou: eles não inventam objetivos e param nos pontos de aprovação que você definiu. Hoje, o roteamento de modelos passa pelo Claude por meio do subprocesso de CLI ",
    " CLI subprocess; per-role provider selection is the declared north star and the plumbing is partial.":
      "; a seleção de provedor por função é a direção declarada do produto, e sua infraestrutura ainda está incompleta.",
    "From here, the rest of the documentation walks you through the core concepts (workspaces, runners, roles, prompts, approvals), a hands-on getting-started path, and the configuration surfaces where operators actually shape runner behavior.":
      "A partir daqui, o restante da documentação apresenta os conceitos principais, como espaços de trabalho, runners, funções, prompts e aprovações; um roteiro prático de primeiros passos; e as áreas de configuração em que os operadores realmente definem o comportamento dos runners.",
  },
  "what-it-is-not": {
    "The previous page described what Backplane is. This one draws the fence. Operators arriving with expectations shaped by other tools — autonomous agent frameworks, general-purpose task platforms, one-model-forever wrappers — deserve to know up front what this platform does not try to be. Bounded expectations prevent the specific disappointment of asking a tool to do something it was never designed to do.":
      "A página anterior descreveu o que é o Backplane. Esta estabelece os limites. Operadores que chegam com expectativas formadas por outras ferramentas, como frameworks de agentes autônomos, plataformas de tarefas de uso geral ou wrappers presos para sempre a um único modelo, merecem saber desde o início o que esta plataforma não pretende ser. Expectativas bem delimitadas evitam a frustração específica de pedir a uma ferramenta algo para o qual ela nunca foi projetada.",
    "Not autonomous": "Não é autônomo",
    "Runners execute pipelines that operators configure. They don't invent their own objectives, they don't pick new tasks outside the ones you've defined, and they stop at the approval gates you declared. If a card requires a destructive action — a deletion, a deployment, a schema change — the runner pauses and asks a human. Autonomy stops where your configuration stops.":
      "Os runners executam pipelines configurados pelos operadores. Eles não inventam objetivos próprios, não escolhem novas tarefas fora das que você definiu e param nos pontos de aprovação declarados. Se um cartão exigir uma ação destrutiva, como uma exclusão, uma implantação ou uma alteração de schema, o runner pausa e pede a decisão de uma pessoa. A autonomia termina onde termina a sua configuração.",
    "Backplane is not an autonomous agent platform":
      "O Backplane não é uma plataforma de agentes autônomos",
    "Runners are not goal-seeking. They claim cards from columns you've set up, execute the role and stage defined in your pipeline config, and report back. If you leave the pipeline empty, nothing happens. If you leave the board empty, nothing happens. The operator remains the source of direction.":
      "Os runners não definem nem perseguem objetivos por conta própria. Eles assumem cartões das colunas que você configurou, executam a função e a etapa definidas na configuração do pipeline e reportam o resultado. Se o pipeline ficar vazio, nada acontece. Se o quadro ficar vazio, nada acontece. O operador continua sendo a fonte de direção.",
    "Not domain-locked, but opinionated":
      "Não é limitado a um domínio, mas é opinativo",
    "Backplane is opinionated about shape, not about domain. The primitives — boards, cards, roles, prompts, approvals, notes — organize any work an LLM agent can be pointed at: an autonomous coding loop, a plain kanban board your team runs by hand, an MCP-assisted session where you drive and the agent keeps the board honest, or the renovation you're project-managing on a Sunday. Role configs are yours to write; nothing in them assumes a compiler.":
      "O Backplane é opinativo quanto à forma, não quanto ao domínio. Os elementos básicos, quadros, cartões, funções, prompts, aprovações e notas, organizam qualquer trabalho para o qual um agente de LLM possa ser direcionado: um loop de programação autônomo, um quadro kanban comum que sua equipe toca à mão, uma sessão assistida por MCP em que você conduz e o agente mantém o quadro em dia, ou a reforma que você está coordenando num domingo. As configurações de função são suas para escrever; nada nelas pressupõe um compilador.",
    "What is tuned for software is the git-coupled machinery: the merge queue, PR-overlap sensors, and the done-merge gate only mean something on a board with a repo linked. Boards without a repo simply skip them.":
      "O que é de fato ajustado a software é a maquinaria acoplada ao git: a fila de merge, os sensores de sobreposição de PRs e o controle de merge na conclusão só fazem sentido em um quadro com um repositório vinculado. Quadros sem repositório simplesmente os ignoram.",
    "Not a hosted agent, and not a chat wrapper":
      "Não é um agente hospedado nem um wrapper de chat",
    "Backplane does not run your agent for you. You bring the agent — a runner process, a Claude Code session, any MCP client — and Backplane gives it a place to keep state, take direction, and be watched. If you want a turnkey hosted agent that thinks up its own work, that is a different product.":
      "O Backplane não executa o seu agente por você. Você traz o agente, seja um processo runner, uma sessão do Claude Code ou qualquer cliente MCP, e o Backplane dá a ele um lugar para manter estado, receber direção e ser acompanhado. Se o que você quer é um agente hospedado pronto para uso que invente o próprio trabalho, esse é outro produto.",
    "Not model-locked — but not model-free either":
      "Não está limitado a um modelo, mas também não é independente deles",
    "Today most stages route through Claude via the ":
      "Hoje, a maioria das etapas é encaminhada ao Claude por meio do subprocesso de CLI ",
    " CLI subprocess. Per-role provider and model configuration — implementer on Sonnet, reviewer on GPT-5, documentator on Gemini, all from the same runner — is the declared north star. The scoping document exists. The plumbing is partial. The platform is not structurally locked to one vendor, but the day you can route each role to its own model is still ahead, tracked under the LLM abstraction milestone.":
      ". A configuração de provedor e modelo por função, com o implementador no Sonnet, o revisor no GPT-5 e o responsável pela documentação no Gemini, todos a partir do mesmo runner, é a direção declarada do produto. O documento de escopo existe. A infraestrutura está incompleta. A plataforma não está estruturalmente presa a um fornecedor, mas o dia em que cada função poderá ser encaminhada ao seu próprio modelo ainda está por vir e é acompanhado no marco de abstração de LLM.",
    "Not yet per-role LLM selection":
      "A seleção de LLM por função ainda não está disponível",
    "The ": "O campo ",
    " field exists and accepts provider and model hints. The runner today passes them to Claude CLI regardless. Wiring alternative providers end-to-end is the next big structural work stream, not a configuration flag you can flip today.":
      " existe e aceita indicações de provedor e modelo. Hoje, o runner as repassa ao Claude CLI de qualquer forma. Integrar provedores alternativos de ponta a ponta é a próxima grande frente estrutural de trabalho, não uma opção de configuração que já possa ser ativada.",
    "Not a replacement for developer judgement":
      "Não substitui o julgamento de quem desenvolve",
    "Approval gates, review cycles, and the human-authored pipeline config are where judgement lives. The runner executes; the operator decides what executing looks like. If a pipeline ships a bug, the pipeline is wrong — not the runner. If a reviewer role rubber-stamps everything, the prompt or the model selection is wrong. The platform gives you the levers; pulling them is still your job.":
      "Os pontos de aprovação, os ciclos de revisão e a configuração do pipeline criada por pessoas são onde reside o julgamento. O runner executa; o operador decide como deve ser a execução. Se um pipeline entrega um bug, o pipeline está errado, não o runner. Se uma função de revisor aprova tudo sem critério, o prompt ou a seleção do modelo está errada. A plataforma oferece os controles; usá-los ainda é responsabilidade sua.",
    "So what is it, then?": "Então, o que ele é?",
    "A coordination layer for LLM runners doing real engineering work on real git repositories, with the controls operators need to keep the work honest. The previous section — What Backplane Is — covers the shape of that in more detail. Between the two pages you should have a useful mental model before you start clicking.":
      "Uma camada de coordenação para runners de LLM que fazem trabalho real de engenharia em repositórios git reais, com os controles de que os operadores precisam para manter o processo íntegro. A seção anterior, O que é o Backplane, descreve essa estrutura em mais detalhes. Juntas, as duas páginas devem oferecer um modelo mental útil antes de você começar a navegar pela plataforma.",
  },
  "quick-tour": {
    "Five minutes, one pass through the core loop. This tour follows a single card from the moment it lands on a board to the moment a runner ships a PR for it. No deep dives — each stop points at the dedicated section where you'll find the full treatment.":
      "Cinco minutos e uma passagem pelo ciclo principal. Este tour acompanha um único cartão desde o momento em que chega a um quadro até o momento em que um runner entrega um PR para ele. Sem aprofundamentos: cada parada aponta para a seção dedicada, onde você encontrará a explicação completa.",
    "Workspace and board": "Espaço de trabalho e quadro",
    "Every URL in the platform lives under a workspace slug:":
      "Todas as URLs da plataforma ficam sob o slug de um espaço de trabalho:",
    ". Inside a workspace you have boards, members, teams, a pipeline config, budgets, and activity history. Inside a board you have columns, cards, definitions, resources, notes, git repos, and alerts. The board view is where operators spend most of their day.":
      ". Dentro de um espaço de trabalho, há quadros, membros, equipes, uma configuração de pipeline, orçamentos e histórico de atividades. Dentro de um quadro, há colunas, cartões, definições, recursos, notas, repositórios git e alertas. A visualização do quadro é onde os operadores passam a maior parte do dia.",
    "Kanban board with five columns and several cards":
      "Quadro kanban com cinco colunas e vários cartões",
    "The board is the operator's primary surface. Column types — not column names — drive pipeline behavior.":
      "O quadro é a principal área de trabalho do operador. Os tipos de coluna, não seus nomes, determinam o comportamento do pipeline.",
    "Page header reads 'Platform Polish'.":
      "O cabeçalho da página mostra 'Platform Polish'.",
    "Five columns in order: 'Backlog' (4 cards), 'Ready' (2 cards), 'In Progress' (1 card), 'Review' (1 card), 'Done' (6 cards).":
      "Cinco colunas, nesta ordem: 'Backlog' (4 cartões), 'Ready' (2 cartões), 'In Progress' (1 cartão), 'Review' (1 cartão), 'Done' (6 cartões).",
    "Each card shows a title, a priority badge ('high', 'medium', or 'low'), and one or two participant avatars.":
      "Cada cartão mostra um título, um selo de prioridade ('high', 'medium' ou 'low') e um ou dois avatares de participantes.",
    "Top-right shows a 'Create card' button and a filter bar with 'Type', 'Priority', 'Assignee', 'Search'.":
      "No canto superior direito, aparecem o botão 'Criar cartão' e uma barra de filtros com 'Tipo', 'Prioridade', 'Responsável' e 'Buscar'.",
    "Left sidebar highlights the 'Boards' entry as active.":
      "A barra lateral esquerda destaca a opção 'Quadros' como ativa.",
    "A card enters the pipeline": "Um cartão entra no pipeline",
    "Someone — a human operator or an architect runner following the":
      "Alguém, seja um operador humano ou um runner arquiteto seguindo o prompt",
    " prompt — creates a card in the Backlog column. The card has a title, a type (":
      ", cria um cartão na coluna Backlog. O cartão tem título, tipo (",
    "), a priority, a description, and optionally labels, a due date, and participants. Nothing happens yet. Backlog cards are waiting for a scheduler to notice them.":
      "), prioridade, descrição e, opcionalmente, rótulos, data de entrega e participantes. Nada acontece ainda. Os cartões no Backlog aguardam que um agendador os identifique.",
    "A runner claims": "Um runner assume o cartão",
    "A runner polls the backend (via WebSocket, not HTTP interval) for work matching its team membership. Each runner executes one stage per tick. The backend answers: \"claim card X for stage Y.\" The claim is atomic: the card's ":
      "Um runner consulta o backend, via WebSocket e não por intervalos HTTP, em busca de trabalho compatível com sua participação em uma equipe. Cada runner executa uma etapa por ciclo. O backend responde: \"assuma o cartão X para a etapa Y\". A operação é atômica: o campo de participante ",
    hero: "hero",
    " participant slot is filled in a single transaction. Two runners racing for the same card lose one cleanly; the loser backs off and the winner moves the card into the next column — typically ":
      " do cartão é preenchido em uma única transação. Quando dois runners disputam o mesmo cartão, um deles perde de forma segura; ele recua, enquanto o vencedor move o cartão para a próxima coluna, normalmente ",
    "In Progress": "In Progress",
    "Runner overview with KPI strip and runner table":
      "Visão geral dos runners com faixa de KPIs e tabela de runners",
    "The runner overview shows who is working on what, what it cost, and how long it took.":
      "A visão geral dos runners mostra quem está trabalhando em cada item, quanto custou e quanto tempo levou.",
    "KPI strip across the top reads 'Runners: 4', 'Success rate: 96%', 'Avg duration: 2m 14s', 'Total spend: $47.22'.":
      "A faixa de KPIs no topo mostra 'Runners: 4', 'Taxa de sucesso: 96%', 'Duração média: 2 min 14 s' e 'Gasto total: US$ 47,22'.",
    "Runner table below lists four rows. The top row shows 'claude-sonnet-implementer' with status 'active' and current card 'Wire useDomainSync'.":
      "A tabela de runners abaixo contém quatro linhas. A primeira mostra 'claude-sonnet-implementer' com status 'active' e o cartão atual 'Wire useDomainSync'.",
    "Right panel titled 'Pending approvals' shows one pending approval with category 'bulk_change'.":
      "O painel à direita, intitulado 'Aprovações pendentes', mostra uma aprovação pendente da categoria 'bulk_change'.",
    "Bottom strip titled 'Execution timeline' shows colored bars per role across the last hour.":
      "A faixa inferior, intitulada 'Linha do tempo das execuções', mostra barras coloridas por função ao longo da última hora.",
    "The stage executes": "A etapa é executada",
    "The runner assembles a prompt — board definition, pinned notes, card description, prior review findings, platform-spliced post-process imperatives — and invokes Claude CLI. If the board binds":
      "O runner monta um prompt com a definição do quadro, notas fixadas, descrição do cartão, constatações de revisões anteriores e instruções de pós-processamento inseridas pela plataforma, e então invoca o Claude CLI. Se o quadro tiver ",
    skills: "habilidades",
    " — versioned procedural playbooks from the workspace library — the runner materializes them into the working tree first, so the agent discovers them like project files. Every tool call the LLM makes goes through the Backplane MCP server, which routes it back to the backend. Every mutation publishes an ":
      " vinculadas (manuais de procedimento versionados da biblioteca do espaço de trabalho), o runner as materializa primeiro na árvore de trabalho, de modo que o agente as descobre como arquivos do projeto. Toda chamada de ferramenta feita pelo LLM passa pelo servidor MCP do Backplane, que a encaminha de volta ao backend. Cada mutação publica um evento ",
    " event on the WebSocket bus. Observers see the work happen live: cards move, comments appear, tokens and cost accumulate on the execution row.":
      " no barramento WebSocket. Os observadores acompanham o trabalho ao vivo: cartões se movem, comentários aparecem e tokens e custos se acumulam no registro da execução.",
    "Watch the Observer panel during your first run":
      "Acompanhe o painel do observador durante sua primeira execução",
    "The floating Observer panel (admin-only, draggable, remembers its position) streams every card, agent, execution, and approval event in real time. The first time you run a pipeline end-to-end, open it. You will see more about what the platform is doing in thirty seconds of scrolling events than in any diagram we could draw for you.":
      "O painel flutuante do observador, disponível apenas para administradores, arrastável e capaz de lembrar sua posição, transmite em tempo real todos os eventos de cartões, agentes, execuções e aprovações. Abra-o na primeira vez que executar um pipeline de ponta a ponta. Em trinta segundos percorrendo os eventos, você entenderá mais sobre o que a plataforma está fazendo do que em qualquer diagrama que pudéssemos criar.",
    "Approval, if the stage demands one":
      "Aprovação, se a etapa exigir",
    "If the stage declares an approval gate — say, because the work category is ":
      "Se a etapa declarar um ponto de aprovação, por exemplo porque a categoria do trabalho é ",
    " or the risk score crosses the auto-approve threshold — the runner pauses and emits a":
      " ou porque a pontuação de risco ultrapassa o limite de aprovação automática, o runner pausa e emite uma chamada da ferramenta ",
    " tool call. The backend creates a pending approval; a human sees it in the ":
      ". O backend cria uma aprovação pendente; uma pessoa a vê na fila de ",
    Approvals: "Aprovações",
    " queue and decides. The runner is subscribed to ":
      " e toma a decisão. O runner está inscrito em ",
    " on the WS bus, so the moment the decision lands the runner wakes and continues. No polling, no wasted ticks.":
      " no barramento WS; assim que a decisão chega, o runner desperta e continua. Sem polling e sem ciclos desperdiçados.",
    "Approval dialog showing a pending bulk-change approval":
      "Diálogo de aprovação mostrando uma alteração em massa pendente",
    "Approvals show the action description and payload the runner requested — enough context to decide without reopening the card.":
      "As aprovações mostram a descrição da ação e o payload solicitado pelo runner, com contexto suficiente para decidir sem reabrir o cartão.",
    "Dialog titled 'Approve bulk card deletion'.":
      "Diálogo intitulado 'Aprovar exclusão de cartões em massa'.",
    "Category badge reads 'bulk_change' in amber.":
      "O selo de categoria mostra 'bulk_change' em âmbar.",
    "Risk score strip reads '0.72 / 1.00'.":
      "A faixa de pontuação de risco mostra '0.72 / 1.00'.",
    "Action description paragraph reads 'Delete 8 stale cards from the Backlog column older than 90 days'.":
      "O parágrafo de descrição da ação informa 'Excluir 8 cartões inativos há mais de 90 dias da coluna Backlog'.",
    "Payload JSON block shows the card IDs to be deleted.":
      "O bloco de payload JSON mostra os IDs dos cartões que serão excluídos.",
    "Two buttons at the bottom: 'Approve' (primary) and 'Reject' (outline).":
      "Dois botões na parte inferior: 'Aprovar' (principal) e 'Rejeitar' (contorno).",
    "Ship and repeat": "Entregue e repita",
    "The runner pushes the branch, opens a PR, moves the card into the column configured in the stage's ":
      "O runner faz push da branch, abre um PR e move o cartão para a coluna configurada na ação ",
    " action (typically ": " da etapa, normalmente ",
    Review: "Review",
    " for an implement stage, ": " para uma etapa de implementação e ",
    Done: "Done",
    " for a reviewer stage), records the execution's cost and duration, and enters its next tick. The next stage in the pipeline — a reviewer role, a documentator role, a custom role you defined — picks the card up from its new column and the loop continues.":
      " para uma etapa de revisão, registra o custo e a duração da execução e inicia o próximo ciclo. A próxima etapa do pipeline, seja uma função de revisor, uma função responsável pela documentação ou uma função personalizada que você definiu, assume o cartão na nova coluna e o ciclo continua.",
    "That's the shape. The rest of this documentation walks each piece in depth — what the pipeline builder accepts, how to author prompts, how to register a runner, how to read the runner overview, and where to look when a card gets stuck.":
      "Essa é a estrutura. O restante da documentação aprofunda cada parte: o que o construtor de pipelines aceita, como criar prompts, como registrar um runner, como interpretar a visão geral dos runners e onde procurar quando um cartão fica bloqueado.",
  },
};
