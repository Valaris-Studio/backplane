// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_CORE_CONCEPTS = {
  "workspaces-boards-columns-cards": {
    "Backplane nests four containers: a ":
      "O Backplane organiza quatro contêineres em níveis: um ",
    workspace: "espaço de trabalho",
    " holds": " contém ",
    boards: "quadros",
    ", each board holds ": ", cada quadro contém ",
    columns: "colunas",
    ", and each column holds ": " e cada coluna contém ",
    cards: "cartões",
    ". Every URL in the app starts with ":
      ". Todas as URLs do aplicativo começam com ",
    " — the workspace slug is the tenancy boundary. If you don't have a workspace, you don't have anything.":
      ": o slug do espaço de trabalho é o limite de tenancy. Sem um espaço de trabalho, não há nada.",
    Workspace: "Espaço de trabalho",
    "The workspace is the top-level tenancy unit. It owns boards, members, channels, teams, pipeline config, budgets, API keys, approvals, and activity history. Membership carries one of four roles —":
      "O espaço de trabalho é a unidade de tenancy de nível superior. Ele contém quadros, membros, canais, equipes, configuração de pipeline, orçamentos, chaves de API, aprovações e histórico de atividades. Cada vínculo de membro tem um de quatro níveis de acesso: ",
    " — and access to every feature endpoint resolves through a single dependency that checks the slug against the caller's membership.":
      ". O acesso a todos os endpoints de funcionalidades passa por uma única dependência que verifica o slug em relação ao vínculo de membro da pessoa que fez a chamada.",
    "With ": "Com ",
    ", verified IAP, trusted-proxy, and OIDC callback identities can be provisioned automatically. Local authentication instead uses first-run or administrator-created accounts and does not provide public self-registration. Workspaces themselves are created on demand from the landing page by an authenticated user.":
      ", identidades verificadas por IAP, proxy confiável e callback OIDC podem ser provisionadas automaticamente. A autenticação local usa contas da primeira execução ou criadas por administradores e não oferece cadastro público. Workspaces são criados sob demanda pela página inicial por um usuário autenticado.",
    Board: "Quadro",
    "A board is a kanban project. It owns an ordered list of columns and, transitively, every card in those columns. Eight tabs hang off a board: kanban, definitions, resources, notes, history, timeline, git, and alerts. The kanban tab is where drag-and-drop happens; definitions, files, and notes preserve project context; History is the durable event feed; Timeline replays board state; Git binds repositories; and Alerts holds board-scoped rules.":
      "Um quadro é um projeto kanban. Ele contém uma lista ordenada de colunas e, por consequência, todos os cartões dessas colunas. Há oito abas associadas ao quadro: kanban, definições, recursos, notas, histórico, linha do tempo, git e alertas. A movimentação por arrastar e soltar acontece em kanban; definições, arquivos e notas preservam o contexto do projeto; Histórico é o feed durável de eventos; Linha do tempo reproduz o estado do quadro; Git vincula repositórios; e Alertas contém regras do quadro.",
    "Cards carry a denormalized ": "Os cartões contêm um ",
    " alongside their": " desnormalizado, além do ",
    ". It's redundant — you could walk from card to column to board — but it lets board-level queries skip the join.":
      ". É uma informação redundante, pois seria possível percorrer o caminho do cartão até a coluna e o quadro, mas ela permite que consultas no nível do quadro evitem esse join.",
    "Resources have two navigation scopes. The sidebar's Resources page opens the workspace collection; the board's Resources tab passes that board ID to the same file browser. A frozen board makes its scoped resource view read-only without freezing workspace-wide resources.":
      "Os recursos têm dois escopos de navegação. A página Recursos da barra lateral abre a coleção do workspace; a aba Recursos do quadro passa o ID daquele quadro ao mesmo navegador de arquivos. Um quadro congelado deixa sua visualização de recursos somente leitura sem congelar os recursos de todo o workspace.",
    Column: "Coluna",
    "Columns have a human-facing ": "As colunas têm um ",
    name: "nome",
    " and a semantic": " visível para as pessoas e um ",
    column_type: "column_type",
    ". The types are": ". Os tipos são ",
    ", and ": " e ",
    ". Pipeline stages reference the type, never the name — so a column named \"Review\" and a column named \"Peer Review\" behave identically if they share the":
      ". As etapas do pipeline referenciam o tipo, nunca o nome. Portanto, uma coluna chamada \"Review\" e outra chamada \"Peer Review\" se comportam da mesma forma se compartilharem o tipo ",
    " type. The type is what runners match against when discovering work; the name is what humans read on the board.":
      ". O tipo é o que os runners usam para encontrar trabalho; o nome é o que as pessoas leem no quadro.",
    "Renaming a column is cosmetic. Retyping it changes behavior.":
      "Renomear uma coluna é uma mudança cosmética. Alterar seu tipo muda o comportamento.",
    "Operators sometimes rename \"Backlog\" to \"Intake\" or \"Triage\" expecting the pipeline to notice. It won't. Runners find cards by column type. If you want the backlog-discovery stage to stop matching that column, change the type — not the name. Ask us how we know.":
      "Às vezes, operadores renomeiam \"Backlog\" para \"Intake\" ou \"Triage\" esperando que o pipeline perceba a mudança. Isso não acontece. Os runners encontram cartões pelo tipo da coluna. Se você quiser que a etapa de descoberta do backlog deixe de corresponder àquela coluna, altere o tipo, não o nome. Pergunte como sabemos.",
    Card: "Cartão",
    "Cards are the unit of work. Each has a title, a rich-text description, a ":
      "Os cartões são a unidade de trabalho. Cada um tem título, descrição em texto rico, um ",
    "), a priority, string labels, a status, an optional due date, and a list of":
      "), prioridade, rótulos de texto, status, data de entrega opcional e uma lista de ",
    participants: "participantes",
    ". A participant is a user or runner attached to the card in one of four roles: ":
      ". Um participante é um usuário ou runner vinculado ao cartão em uma de quatro funções: ",
    " (the primary executor), ": " (o responsável principal), ",
    ", or": " ou ",
    ". The one-hero-per-card rule lives in the claim service, not as a database constraint — the hero is how runners coordinate \"I've got this one.\"":
      ". A regra de um único hero por cartão fica no serviço de assunção, e não como uma restrição do banco de dados. É por meio do hero que os runners coordenam a mensagem \"este cartão está comigo\".",
    "Fractional positions": "Posições fracionárias",
    "Columns and cards use ": "Colunas e cartões usam posições ",
    " positions instead of integer ordering. A new item gets ":
      " em vez de ordenação por números inteiros. Um novo item recebe ",
    "; a move computes the midpoint between its new neighbors. No O(N) reorder updates, no index rebuilds, no races when two users drag at the same time. The frontend computes positions; the backend just stores the number. See":
      "; uma movimentação calcula o ponto médio entre os novos vizinhos. Não há atualizações de reordenação O(N), reconstruções de índice nem condições de corrida quando duas pessoas arrastam itens ao mesmo tempo. O frontend calcula as posições; o backend apenas armazena o número. Consulte ",
    "Fractional Indexing": "Indexação fracionária",
    "under Under the Hood for the full story.":
      " em Por dentro da plataforma para ver a explicação completa.",
  },
  runners: {
    "A ": "Um ",
    Runner: "Runner",
    " is the credentialed Go process an operator starts on a laptop, VM, container, or Kubernetes pod. It authenticates with one runner API key, resolves its workspace identity, sends heartbeats, and asks the platform for authoritative configuration. Git, provider CLI, and MCP execution stay on the runner host; the Backplane backend coordinates state and records the audit trail.":
      " é o processo Go com credenciais que um operador inicia em um notebook, VM, contêiner ou pod do Kubernetes. Ele se autentica com uma chave de API de runner, resolve sua identidade e workspace, envia heartbeats e solicita a configuração autoritativa da plataforma. Git, CLI do provedor e execução de MCP permanecem no host do runner; o backend do Backplane coordena o estado e registra a trilha de auditoria.",
    "Executable modes": "Modos executáveis",
    "A bare interactive launch opens the setup wizard. Automation should pass ":
      "Uma inicialização interativa sem argumentos abre o assistente de configuração. A automação deve passar ",
    " and choose one of these explicit modes:":
      " e escolher um destes modos explícitos:",
    "Pipeline mode.": "Modo pipeline.",
    " The default when neither": " É o modo padrão quando não está presente",
    " nor ": " nem ",
    " is present. It polls for claimable cards and executes the platform-authored pipeline.":
      ". Ele consulta cartões disponíveis para assumir e executa o pipeline criado na plataforma.",
    "Doctor.": "Diagnóstico.",
    " performs read-only diagnostics and never starts an agent session or spends model budget. Add ":
      " executa diagnósticos somente leitura e nunca inicia uma sessão de agente nem consome o orçamento do modelo. Adicione ",
    " only when you explicitly want supported local repairs.":
      " somente quando quiser aplicar explicitamente correções locais compatíveis.",
    "Discovery.": "Descoberta.",
    " runs one MCP capability discovery pass and exits.":
      " executa uma passagem de descoberta de capacidades MCP e termina.",
    "Loop mode.": "Modo Loop.",
    " works one board continuously. ": " trabalha continuamente em um quadro. ",
    " selects that board explicitly; otherwise the runner requires one unambiguous configured or platform-bound board.":
      " seleciona esse quadro explicitamente; caso contrário, o runner exige um único quadro inequívoco configurado ou vinculado pela plataforma.",
    " is a loop-only runtime override. When present, it takes precedence over ":
      " é um override de execução exclusivo do Loop. Quando presente, tem precedência sobre ",
    " in YAML. The remaining operational flags include ":
      " no YAML. Os outros flags operacionais incluem ",
    ", and": " e",
    "What every working mode validates": "O que cada modo operacional valida",
    "Load and validate the local YAML file and environment overrides.":
      "Carregar e validar o arquivo YAML local e os overrides do ambiente.",
    "Authenticate, resolve the workspace and runner identity, and start heartbeat reporting.":
      "Autenticar, resolver o workspace e a identidade do runner e iniciar o envio de heartbeats.",
    "Validate the selected provider CLI and the MCP configuration before accepting work.":
      "Validar o CLI do provedor selecionado e a configuração MCP antes de aceitar trabalho.",
    "Fetch platform-authored pipeline or board-loop configuration for the selected mode. Missing or ambiguous authority is a startup error, not a signal to invent a local fallback.":
      "Obter a configuração do pipeline ou do Loop do quadro criada na plataforma para o modo selecionado. Autoridade ausente ou ambígua é um erro de inicialização, não um sinal para inventar um fallback local.",
    "Validated host configuration": "Configuração validada do host",
    "The host file contains connectivity, provider, MCP, and filesystem concerns. Pipeline stages, prompts, and board-loop policy remain platform-owned. At minimum, set an API key, a workspace slug, the MCP config path, and a safe git base directory.":
      "O arquivo do host contém aspectos de conectividade, provedor, MCP e sistema de arquivos. Etapas do pipeline, prompts e a política do Loop do quadro continuam pertencendo à plataforma. No mínimo, defina uma chave de API, o slug do workspace, o caminho da configuração MCP e um diretório-base seguro para git.",
    "runner.yaml — required foundations":
      "runner.yaml: fundamentos obrigatórios",
    "git.base_dir must be outside every Git worktree":
      "git.base_dir deve ficar fora de qualquer worktree do Git",
    "The runner resolves relative paths and ":
      "O runner resolve caminhos relativos e ",
    ", converts the result to an absolute path, and refuses a directory nested inside an existing worktree. Give each runner a dedicated parent directory for the repositories and worktrees it creates.":
      ", converte o resultado em caminho absoluto e recusa um diretório contido em um worktree existente. Dê a cada runner um diretório pai exclusivo para os repositórios e worktrees que ele cria.",
    " and ": " e ",
    " are built-in provider names. Additional providers can be declared under":
      " são nomes de provedores integrados. Provedores adicionais podem ser declarados em",
    ", and model tiers can route work without hard-coding a model into every stage. Use the bundled":
      ", e tiers de modelos podem rotear trabalho sem fixar um modelo em cada etapa. Use o arquivo incluído ",
    " as the complete field reference rather than copying an abbreviated example forward.":
      " como referência completa dos campos, em vez de continuar copiando um exemplo abreviado.",
    "The API still calls runners agents": "A API ainda chama runners de agents",
    "The product term is ": "O termo do produto é ",
    ", while database models, API routes, and MCP tools retain the older ":
      ", enquanto modelos do banco, rotas de API e ferramentas MCP mantêm o vocabulário anterior ",
    " vocabulary. For example, ": ". Por exemplo, ",
    " resolves the runner identity. This is deliberate compatibility, not a second kind of executor.":
      " resolve a identidade do runner. Trata-se de compatibilidade deliberada, não de um segundo tipo de executor.",
  },
  "agent-teams": {
    "An ": "Uma ",
    "agent team": "equipe de agentes",
    " is the membership graph that pairs runners with roles inside a workspace. A runner on its own is just a credential. A role on its own is just a string in a pipeline config. The team is the thing that says \"this runner plays these roles on this board.\" Without it, the runner has no mandate to pick up work.":
      " é o grafo de participação que associa runners a funções dentro de um espaço de trabalho. Isoladamente, um runner é apenas uma credencial. Isoladamente, uma função é apenas uma string na configuração de um pipeline. A equipe é o que determina que \"este runner executa estas funções neste quadro\". Sem ela, o runner não tem autorização para assumir trabalho.",
    Shape: "Estrutura",
    "A team lives in a workspace and is optionally scoped to a single board. It has a slug (unique within the workspace), an":
      "Uma equipe pertence a um espaço de trabalho e pode, opcionalmente, ter seu escopo limitado a um único quadro. Ela tem um slug, único dentro do espaço de trabalho, um campo ",
    " flag, and zero or more ": " e zero ou mais ",
    members: "membros",
    ". Each member is a ": ". Cada membro é um par ",
    " pair carrying a list of role strings — the pipeline personas this runner is authorized to execute for this team.":
      " que contém uma lista de strings de função, ou seja, as personas do pipeline que esse runner está autorizado a executar para a equipe.",
    "Team slugs are unique per workspace and creation is idempotent: a repeat create returns the existing team instead of a 409. Adding a member is idempotent too — if the runner is already on the team, its role list is overwritten, not conflicted.":
      "Os slugs de equipe são únicos por espaço de trabalho, e a criação é idempotente: repetir a criação retorna a equipe existente em vez de um 409. Adicionar um membro também é idempotente: se o runner já estiver na equipe, sua lista de funções será substituída, sem gerar conflito.",
    "Unique roles": "Funções exclusivas",
    "A role declared ": "Uma função declarada como ",
    " in ": " em ",
    "may only be staffed by one member on a team. The three legacy roles —":
      "só pode ser ocupada por um membro da equipe. As três funções legadas, ",
    " — are grandfathered into uniqueness by the backend canonicalization pass. Custom roles default to non-unique unless the operator sets the flag. This prevents two runners racing to claim the same card under the same role; it does not prevent two runners playing different roles on the same card.":
      ", são preservadas como exclusivas pela etapa de canonicalização do backend. Funções personalizadas não são exclusivas por padrão, a menos que o operador ative o campo. Isso impede que dois runners disputem o mesmo cartão com a mesma função; não impede que dois runners executem funções diferentes no mesmo cartão.",
    "Creating a team over MCP": "Criação de uma equipe via MCP",
    "Most operators create teams through the Teams section of the Runners tab, but MCP is the cleaner path when scripting a bootstrap. The call is idempotent on ":
      "A maioria dos operadores cria equipes pela seção Equipes da aba Runners, mas o MCP é o caminho mais direto ao automatizar uma inicialização. A chamada é idempotente em ",
    ", so a repeat returns the existing team.":
      "; portanto, uma repetição retorna a equipe existente.",
    "Create a team, then add a runner to it":
      "Crie uma equipe e depois adicione um runner a ela",
    "Runner vs team": "Runner e equipe",
    "A runner is a credential and a process identity; it exists workspace-independently at the platform level (with an":
      "Um runner é uma credencial e uma identidade de processo; ele existe no nível da plataforma, independentemente de um espaço de trabalho, com uma lista ",
    " list gating where it may work). A team is per-workspace and scopes which roles that runner is allowed to play there. The runner's effective roles on a given workspace come from the intersection of team membership and the pipeline's stage roles — so adding a role to ":
      " que limita onde ele pode trabalhar. Uma equipe pertence a cada espaço de trabalho e define quais funções o runner pode executar ali. As funções efetivas do runner em determinado espaço de trabalho resultam da interseção entre sua participação na equipe e as funções das etapas do pipeline. Portanto, adicionar uma função a ",
    " does nothing until a team member carries that role string.":
      " não tem efeito até que um membro da equipe tenha essa string de função.",
    "Multi-team runners exist in the schema, not in the UI":
      "Runners em várias equipes existem no schema, mas não na interface",
    "The data model supports one runner belonging to multiple teams. The backend helper ":
      "O modelo de dados permite que um runner pertença a várias equipes. O helper do backend ",
    " returns the": " retorna a ",
    first: "primeira",
    " active team an agent is in, and the UI treats the relationship as 1:1. A runner that's a member of two teams will only ever pick up work from the first one today. The simplification will lift when multi-team runners become a real use case. Don't plan around it until it does.":
      " equipe ativa da qual um agente participa, e a interface trata a relação como 1:1. Atualmente, um runner que seja membro de duas equipes só assumirá trabalho da primeira. Essa simplificação será removida quando runners em várias equipes se tornarem um caso de uso real. Não baseie seus planos nisso até lá.",
    "Team membership vs card participant":
      "Participação na equipe e participação no cartão",
    "These sound similar and are not the same. ":
      "Os conceitos parecem semelhantes, mas não são iguais. ",
    "Team membership": "Participação na equipe",
    "is a long-lived authorization — \"this runner may play role X here.\"":
      "é uma autorização duradoura: \"este runner pode executar a função X aqui\". ",
    Participant: "Participante",
    " is per-card — \"this runner is the hero on card 42.\" Runners claim cards by adding themselves as a hero participant at execution time; team membership is what let them even consider claiming.":
      " é específico de cada cartão: \"este runner é o hero do cartão 42\". Os runners assumem cartões adicionando a si mesmos como participante hero no momento da execução; é a participação na equipe que permite que sequer considerem assumir o cartão.",
  },
  "roles-and-pipelines": {
    "A ": "Uma ",
    role: "função",
    " is a pipeline persona — a free-form string like ":
      " é uma persona do pipeline, representada por uma string livre como ",
    " or ": " ou ",
    " or": " ou ",
    ". A ": ". Um ",
    pipeline: "pipeline",
    " is the ordered shape of work: which roles run, in what order, against what columns, under what conditions. Both live in ":
      " é a estrutura ordenada do trabalho: quais funções são executadas, em que ordem, sobre quais colunas e sob quais condições. Ambos ficam em ",
    " on the workspace. This is where a platform stops being a kanban app and starts being an agentic system.":
      " no espaço de trabalho. É aqui que uma plataforma deixa de ser um aplicativo kanban e passa a ser um sistema de agentes.",
    Roles: "Funções",
    "Backplane ships with five default roles, each with hand-written prompt templates in the registry:":
      "O Backplane inclui cinco funções padrão, cada uma com templates de prompt escritos manualmente no registro:",
    " — claims unassigned or rework cards, implements code, requests approval for destructive operations.":
      " — assume cartões sem responsável ou que exigem retrabalho, implementa código e solicita aprovação para operações destrutivas.",
    " — checks out the PR branch, emits structured approve / request-changes decisions.":
      " — faz checkout da branch do PR e emite decisões estruturadas de aprovação ou solicitação de alterações.",
    " — updates docs after merge, adds the":
      " — atualiza a documentação após o merge e adiciona o rótulo ",
    " label.": ".",
    " — investigates a card topic and produces a board note.":
      " — investiga o tema de um cartão e produz uma nota no quadro.",
    " — writes a single plan note for the existing card; the lifecycle saves its findings.":
      " — escreve uma única nota de plano para o cartão existente; o ciclo de vida salva suas conclusões.",
    "These are not an enum. ": "Essas funções não são um enum. ",
    " is a string — operators declare any role they want and the platform picks it up end-to-end. The 2026-04-18 walkthrough defined a custom":
      " é uma string: os operadores declaram qualquer função que quiserem, e a plataforma a incorpora de ponta a ponta. O passo a passo de 18/04/2026 definiu uma função personalizada ",
    " role and ran it to completion without a single line of platform code changing. The scheduler, the prompt synthesis layer, and the runner's generic strategy all handle arbitrary role names natively.":
      " e a executou até o fim sem alterar uma única linha de código da plataforma. O agendador, a camada de síntese de prompts e a estratégia genérica do runner lidam nativamente com nomes de função arbitrários.",
    "Pipeline shape": "Estrutura do pipeline",
    "A pipeline is a version number, an array of stages, and a scheduling block. Each stage declares who runs it, how it finds cards, how it claims, what git it sets up, what LLM config it uses, what sensors gate it, and what to do on success or failure.":
      "Um pipeline é composto por um número de versão, um array de etapas e um bloco de agendamento. Cada etapa declara quem a executa, como encontra cartões, como os assume, qual configuração git prepara, qual configuração de LLM usa, quais sensores condicionam seu avanço e o que fazer em caso de sucesso ou falha.",
    "pipeline_config shape — the full DSL":
      "Estrutura de pipeline_config: a DSL completa",
    "Multiple stages per role": "Várias etapas por função",
    "One role commonly owns several stages. The default orchestrator is wired across four: ":
      "É comum que uma função tenha várias etapas. O orquestrador padrão está configurado em quatro: ",
    " for fresh cards,": " para cartões novos, ",
    " for cards that just cleared an approval gate, ":
      " para cartões que acabaram de passar por um ponto de aprovação, ",
    " for turning reviewer feedback into an action plan, and ":
      " para transformar o feedback do revisor em um plano de ação e ",
    " for applying that plan. The scheduler picks one stage per tick; which one depends on the discover strategy's filter matching an available card.":
      " para aplicar esse plano. O agendador escolhe uma etapa por ciclo; a escolha depende de o filtro da estratégia de descoberta corresponder a um cartão disponível.",
    "Stages are cheap. Reach for a new stage before a new role.":
      "Etapas têm baixo custo. Prefira criar uma nova etapa antes de uma nova função.",
    "If the same runner needs to behave differently in two situations — first pass versus rework, pre-approval versus post-approval — author a second stage under the same role rather than inventing a new role. The scheduler handles the fanout; prompts are keyed on":
      "Se o mesmo runner precisar se comportar de forma diferente em duas situações, como primeira execução e retrabalho ou antes e depois da aprovação, crie uma segunda etapa sob a mesma função em vez de inventar uma nova função. O agendador cuida da distribuição; os prompts são identificados por ",
    "; the runner's identity stays clean. Four stages under ":
      "; a identidade do runner permanece clara. Quatro etapas em ",
    " is the shipped default, not an anti-pattern.":
      " são o padrão fornecido, não um antipadrão.",
    Scheduling: "Agendamento",
    "The ": "O campo ",
    " is either ": " pode ser ",
    ". In ": ". No modo ",
    " mode the runner walks ": ", o runner percorre ",
    " left-to-right and picks the first stage with work; idle stages go on a 4-minute cooldown so they don't get polled every tick. In ":
      " da esquerda para a direita e escolhe a primeira etapa com trabalho; etapas ociosas entram em um período de espera de 4 minutos para não serem consultadas a cada ciclo. No modo ",
    " mode it rotates through the list, skipping any stage currently cooling. Scheduling is re-evaluated every tick against live platform config — add a role via the UI and the runner picks it up on the next poll, no restart.":
      ", ele alterna pela lista, ignorando qualquer etapa que esteja no período de espera. O agendamento é reavaliado a cada ciclo em relação à configuração ativa da plataforma: adicione uma função pela interface, e o runner a reconhecerá na próxima consulta, sem reinicialização.",
  },
  prompts: {
    "A ": "Um ",
    prompt: "prompt",
    " is the LLM instruction for a specific":
      " é a instrução para o LLM associada a um par específico ",
    " pair, optionally scoped to a team. It's the text the runner renders and passes to ":
      ", com escopo opcional para uma equipe. É o texto que o runner renderiza e passa para ",
    " each time it executes that stage. Prompts are where the platform's opinion about how each role should think actually lives.":
      " sempre que executa essa etapa. É nos prompts que reside, de fato, a visão da plataforma sobre como cada função deve pensar.",
    "Three layers": "Três camadas",
    "Prompts resolve through three cooperating layers on the backend:":
      "Os prompts são resolvidos por três camadas que trabalham em conjunto no backend:",
    "Registry.": "Registro.",
    " Hand-written platform defaults for the 21 known ":
      " Padrões da plataforma escritos manualmente para os 21 pares conhecidos ",
    " pairs covering the five shipped roles. These ship with the backend.":
      ", que abrangem as cinco funções fornecidas. Esses padrões são distribuídos com o backend.",
    "Synthesis.": "Síntese.",
    " For any ": " Para qualquer par ",
    " that appears in the live pipeline but isn't in the registry, a minimal placeholder is generated from a shared template. Custom roles are never second-class — the UI always has something to author against.":
      " que apareça no pipeline ativo, mas não esteja no registro, um conteúdo mínimo é gerado a partir de um template compartilhado. Funções personalizadas nunca são tratadas como secundárias: a interface sempre oferece uma base para edição.",
    "Overrides.": "Substituições.",
    " Operator-authored": " Registros ",
    " rows, scoped to": " criados pelo operador, com escopo em ",
    ". An override replaces the body from layer 1 or 2 for that scope.":
      ". Uma substituição troca o corpo proveniente da camada 1 ou 2 para esse escopo.",
    "Runners pull their prompt cache at startup and refresh it every tick. Edit a prompt in the UI and the change takes effect on the next refresh without a runner restart.":
      "Os runners carregam o cache de prompts na inicialização e o atualizam a cada ciclo. Edite um prompt na interface, e a alteração entrará em vigor na próxima atualização, sem reiniciar o runner.",
    "The post-process imperative (the load-bearing idea)":
      "A instrução obrigatória de pós-processamento, uma ideia essencial",
    "This is the single most operator-valuable design choice in the platform. Every stage declares a ":
      "Esta é a escolha de design mais valiosa da plataforma para o operador. Cada etapa declara um ",
    " from a dropdown: ": " em uma lista suspensa: ",
    ", or ": " ou ",
    ". The backend splices the correct tool-call instruction into the prompt body automatically — the operator never has to remember to write \"Step N: call ":
      ". O backend insere automaticamente no corpo do prompt a instrução correta de chamada da ferramenta; o operador nunca precisa se lembrar de escrever \"Etapa N: chame ",
    "\" by hand.": "\" manualmente.",
    "The runner prefers the backend-assembled ":
      "O runner dá preferência ao ",
    "over the raw ": " montado pelo backend, em vez do ",
    ", so edits on a synthesized prompt body retain the imperative. A custom ":
      " bruto; assim, edições no corpo de um prompt sintetizado preservam a instrução obrigatória. Uma função personalizada ",
    " role that the operator authored in the UI will call":
      " criada pelo operador na interface chamará ",
    " correctly, because the imperative was spliced in, not typed.":
      " corretamente, porque a instrução obrigatória foi inserida, e não digitada.",
    "Template variables": "Variáveis de template",
    "Prompt bodies are Go ": "Os corpos dos prompts usam a sintaxe Go ",
    " source. The runner renders them with a context object carrying workspace and card identifiers plus stage-specific fields like review history and the project directives pulled from the board definition.":
      ". O runner os renderiza com um objeto de contexto que contém identificadores do espaço de trabalho e do cartão, além de campos específicos da etapa, como o histórico de revisão e as diretrizes do projeto obtidas da definição do quadro.",
    "Minimal prompt template for a custom researcher role":
      "Template mínimo de prompt para uma função personalizada de pesquisador",
    "The ": "A estrutura ",
    " framing is not decoration. Sonnet-class models treat tool-call results as optional reference and will skip directives they read as background prose. Code-fetched context fetched by the runner and injected into a clearly-labeled mandatory section has measurably better compliance than \"please consider the following\" framings.":
      " não é decorativa. Modelos da classe Sonnet tratam os resultados de chamadas de ferramentas como referências opcionais e ignoram diretrizes que interpretam como texto contextual. O contexto obtido pelo runner por código e inserido em uma seção obrigatória claramente identificada produz uma adesão comprovadamente melhor do que formulações como \"considere o seguinte\".",
    "The prompt editor is a textarea today":
      "Hoje, o editor de prompts é uma área de texto",
    "No syntax highlighting, no variable lint, no live preview, no template-inheritance visualization. It's a text box and a Save button. Operators have flagged this often — the MCP server is the path of least resistance for authoring real prompts today, not the UI. An upgrade is on the backlog. Meanwhile, ":
      "Não há destaque de sintaxe, validação de variáveis, visualização ao vivo nem exibição da herança de templates. Há apenas uma caixa de texto e um botão Salvar. Os operadores apontam essa limitação com frequência; atualmente, o servidor MCP é o caminho mais direto para criar prompts reais, e não a interface. Uma melhoria está no backlog. Enquanto isso, ",
    "typo'd as ": " digitado incorretamente como ",
    " renders as empty string, not an error, so proofread.":
      " é renderizado como uma string vazia, não como um erro. Portanto, revise com atenção.",
  },
  approvals: {
    ", and ": " e ",
    "One category exists specifically for the skills flywheel:":
      "Uma categoria existe especificamente para o volante das habilidades:",
    " starts at a base score of 60, so an agent-proposed ":
      " parte de uma pontuação base de 60, de modo que uma ",
    "skill":
      "habilidade",
    " can never auto-approve. Publishing what future agent sessions are taught is always a human decision.":
      " proposta por um agente nunca pode ser aprovada automaticamente. Publicar o que as sessões de agente futuras aprendem é sempre uma decisão humana.",
    "An ": "Uma ",
    approval: "aprovação",
    " gates a destructive or high-risk operation. An agent describes the intended action and payload, the backend records a scored request, and either policy or a human decides whether execution may continue. The durable approval record is part of the audit trail.":
      " controla uma operação destrutiva ou de alto risco. Um agente descreve a ação e o payload pretendidos, o backend registra uma solicitação pontuada e uma política ou pessoa decide se a execução pode continuar. O registro durável da aprovação faz parte da trilha de auditoria.",
    "Categories and scoring": "Categorias e pontuação",
    "The supported categories are ": "As categorias compatíveis são ",
    ", and": " e",
    ". Each starts from a category base score; payload details such as item count, target environment, destructive schema work, privileged roles, or protected branches can raise or lower the result.":
      ". Cada uma parte de uma pontuação-base por categoria; detalhes do payload, como quantidade de itens, ambiente-alvo, mudanças destrutivas de schema, funções privilegiadas ou branches protegidas, podem aumentar ou reduzir o resultado.",
    "A risk score less than or equal to ": "Uma pontuação de risco menor ou igual a ",
    " is auto-approved. Higher scores create a ":
      " é aprovada automaticamente. Pontuações superiores criam uma decisão ",
    " decision for a human. The current ": " para uma pessoa. O valor atual de ",
    " is a backend constant, not a workspace setting.":
      " é uma constante do backend, não uma configuração do workspace.",
    "Park, continue, and resume": "Estacionar, continuar e retomar",
    "A pending approval does not make the runner wait inside an expensive agent session. The runner checkpoints the work in progress, adds the durable ":
      "Uma aprovação pendente não obriga o runner a esperar dentro de uma sessão de agente cara. O runner cria um checkpoint do trabalho em andamento, adiciona o rótulo durável ",
    " label, parks that card, and continues with other cards. The label survives a runner restart even though the in-memory provider resume token does not.":
      ", estaciona o cartão e continua com outros cartões. O rótulo sobrevive a uma reinicialização do runner, embora o token de retomada do provedor mantido em memória não sobreviva.",
    "Approval WebSocket events wake the runner for a near-immediate check; HTTP reads remain the canonical state check and fallback on every poll cycle. An approved request resumes the parked work when its session token is still available. A pending request or a temporary fetch error stays parked instead of being treated as failure.":
      "Eventos WebSocket de aprovação acordam o runner para uma verificação quase imediata; leituras HTTP continuam sendo a verificação canônica do estado e o fallback em cada ciclo de consulta. Uma solicitação aprovada retoma o trabalho estacionado quando seu token de sessão ainda está disponível. Uma solicitação pendente ou um erro temporário de leitura permanece estacionado em vez de ser tratado como falha.",
    "Approvals page with search, status and category filters, and a decision table":
      "Página de aprovações com busca, filtros de status e categoria e uma tabela de decisões",
    "The approvals page separates discovery from the decision dialog and keeps completed decisions readable.":
      "A página de aprovações separa a descoberta da caixa de decisão e mantém legíveis as decisões concluídas.",
    "Page heading 'Approvals' followed by search, Status, and Category filters plus a visible result count.":
      "Cabeçalho 'Aprovações', seguido de busca, filtros Status e Categoria e uma contagem visível de resultados.",
    "Table columns: Status, Category, Description, Risk, Runner, Created, and Actions.":
      "Colunas da tabela: Status, Categoria, Descrição, Risco, Runner, Criado e Ações.",
    "A pending row opens a dialog with the action description, optional details, a reason field, and Approve and Reject buttons.":
      "Uma linha pendente abre uma caixa com a descrição da ação, detalhes opcionais, um campo de motivo e os botões Aprovar e Rejeitar.",
    "A decided row opens the same dialog read-only with decision, reviewer, timestamp, and reason.":
      "Uma linha decidida abre a mesma caixa em modo somente leitura com decisão, pessoa revisora, horário e motivo.",
    "Decision states": "Estados de decisão",
    "The data model exposes ": "O modelo de dados expõe ",
    ". New requests receive an ": ". Novas solicitações recebem uma marca ",
    "timestamp as age metadata. No current job changes the status automatically at that time, and the timestamp does not prevent a late human decision. If a request does have expired status, the runner leaves its card parked for explicit human recovery instead of treating it as a retry or failed stage.":
      " como metadata de idade. Nenhum processo atual muda o status automaticamente naquele momento, e a marca não impede uma decisão humana tardia. Se uma solicitação tiver status expired, o runner deixa o cartão estacionado para recuperação humana explícita em vez de tratá-lo como nova tentativa ou etapa com falha.",
    "Approval wait is durable, provider continuation is not":
      "A espera pela aprovação é durável; a continuação do provedor não",
    "After a runner restart, the ": "Depois de reiniciar um runner, o rótulo ",
    " label still prevents accidental re-execution, but the provider resume token is gone by design. An operator must decide the request and deliberately retrigger or unpark the card as appropriate.":
      " continua impedindo uma nova execução acidental, mas o token de retomada do provedor desaparece por design. Um operador deve decidir a solicitação e reativar ou retirar o cartão do estado estacionado deliberadamente, conforme o caso.",
    "Rejection is terminal": "A rejeição é terminal",
    "A rejection is not a retry signal. The runner marks the approval path as terminal and routes the card to its blocked failure outcome instead of asking again in a loop. The decision remains in history; recovery is a new, deliberate execution after the underlying concern is resolved.":
      "Uma rejeição não é um sinal de nova tentativa. O runner marca o caminho de aprovação como terminal e direciona o cartão ao resultado bloqueado de falha, em vez de perguntar novamente em loop. A decisão permanece no histórico; a recuperação consiste em uma execução nova e deliberada depois que o problema subjacente for resolvido.",
  },
  "loop-mode": {
    "Completion attempts freeze their input context. Editors warn when active work uses a note, definition, prompt or configuration. Policy preview and save enforce the same 128 KiB mandatory-context limit; the separate 256 KiB execution limit also includes the role prompt and evidence. A rejected result records changed inputs when available. Retry completion preserves the candidate and starts a fresh attempt; Recheck completion context can release an older stale attempt immediately while leaving an unchanged active lease intact.": "As tentativas de conclusão congelam seu contexto de entrada. Os editores avisam quando um trabalho ativo usa uma nota, definição, prompt ou configuração. A prévia e o salvamento da política aplicam o mesmo limite de 128 KiB de contexto obrigatório; o limite separado de execução de 256 KiB também inclui o prompt do papel e as evidências. Um resultado rejeitado registra as entradas alteradas quando disponíveis. Repetir a conclusão preserva o candidato e inicia uma nova tentativa; Rever o contexto de conclusão pode liberar imediatamente uma tentativa antiga obsoleta sem alterar uma reserva ativa cujo contexto não mudou.",
    "Restarting a runner reports pending review, merge, validation and accepted work with its next action. Doctor inspects this state without claiming work, retrying attempts or enabling the loop. A card in a Blocked column can still need a separate source-work decision after a setup problem is repaired; completion review and validation remain independent of that column.": "Ao reiniciar um runner, ele informa o trabalho pendente de revisão, merge, validação e o trabalho aceito, com a próxima ação. Doctor inspeciona esse estado sem reservar trabalho, repetir tentativas ou ativar o loop. Uma tarefa na coluna Bloqueada ainda pode exigir uma decisão separada sobre a implementação após corrigir um problema de configuração; a revisão e a validação de conclusão continuam independentes dessa coluna.",
    "Pipeline mode uses next_assignment for atomic reservation. Loop mode follows the configured prompt for scoped search_cards, dependency checks and move_card, with no atomic reservation. completion_query is a stop condition, not a selection filter.": "O modo pipeline usa next_assignment para reserva atômica. O modo loop segue o prompt configurado para search_cards com escopo definido, verificações de dependências e move_card, sem reserva atômica. completion_query é uma condição de parada, não um filtro de seleção.",
    "completion_policy selects the landing actor, independent source review, forge checks, exact merged-commit validation, evidence-only approval, dependency release at accepted or Done, and automatic or manual completion. A board policy replaces the workspace policy as a whole; null inherits. With no effective policy, legacy enforce_done_merge_gate behavior remains. Only a human workspace administrator may change policy or select evidence_only mode.": "completion_policy seleciona quem mescla, a revisão independente do código, as verificações do forge, a validação do commit mesclado exato, a aprovação de evidências, a liberação de dependências em accepted ou Done e a conclusão automática ou manual. A política do quadro substitui integralmente a do espaço de trabalho; null herda. Sem política efetiva, enforce_done_merge_gate permanece. Somente um administrador humano pode alterar a política ou selecionar evidence_only.",
    "Under an explicit policy, submit_completion_candidate records the real open PR and source execution before landing. Independent source review and validation of the frozen merge SHA are separate phases. get_completion_status shows current acceptance and failures; retry_completion schedules a fresh attempt. Later main advancement does not invalidate that exact accepted SHA. Evidence-only candidates require source SHA, artifact digests and named checks. Report blocked_on_human when a human decision is required; never invent a PR or bypass acceptance.": "Com uma política explícita, submit_completion_candidate registra o PR aberto real e a execução de origem antes da mesclagem. A revisão independente do código e a validação do SHA fixo da mesclagem são fases distintas. get_completion_status mostra a aceitação e as falhas atuais; retry_completion agenda outra tentativa. O avanço posterior de main não invalida esse SHA aceito. Candidatos de evidências exigem SHA de origem, hashes de artefatos e verificações identificadas. Informe blocked_on_human quando uma decisão humana for necessária; nunca invente um PR nem ignore a aceitação.",

    "Choose a model for this run": "Escolher um modelo para esta execução",
    "In the runner's loop setup, keep Follow board settings or choose Choose a model for this run. Select the coding agent and enter the exact model ID accepted by its CLI and your account. The review shows the board request and your selection, even when the board pins a concrete model.": "Na configuração do loop do runner, mantenha Follow board settings ou escolha Choose a model for this run. Selecione o agente de programação e informe o ID exato do modelo aceito pela CLI e pela sua conta. A revisão mostra o que o quadro solicita e sua seleção, mesmo quando o quadro fixa um modelo específico.",
    "Use a custom model for one loop process": "Usar um modelo personalizado para um processo de loop",
    "Both flags are required for a non-interactive loop launch. The choice lasts for this process, including later iterations and keep-alive resumption. It does not change the board or saved profile defaults. Restart without the choice to follow board settings again. Board prompts, tools, budgets and stop conditions still apply.": "Os dois parâmetros são obrigatórios para iniciar um loop sem interação. A escolha vale durante este processo, incluindo as próximas iterações e a retomada com keep-alive. Ela não altera o quadro nem os padrões do perfil salvo. Reinicie sem a escolha para voltar a seguir a configuração do quadro. As instruções, ferramentas, orçamentos e condições de parada do quadro continuam valendo.",
    "Use a concrete model ID rather than a tier alias. Startup checks the selected agent binary, not model access for your account. If the CLI rejects the model, the session fails without substituting another model. Execution records show the effective provider and model. Pipeline stages and subagents launched by the coding agent keep their own model selection.": "Use um ID de modelo específico em vez de um alias de nível. A inicialização verifica o executável do agente selecionado, não o acesso ao modelo pela sua conta. Se a CLI rejeitar o modelo, a sessão falha sem substituí-lo por outro. Os registros de execução mostram o provedor e o modelo efetivos. As etapas do pipeline e os subagentes iniciados pelo agente de programação mantêm sua própria seleção de modelo.",
    "Skills in a loop":
      "Habilidades em um loop",
    "A loop session receives the board's bound":
      "Uma sessão de loop recebe as",
    "skills":
      "habilidades",
    " without any pipeline step: the runner re-fetches the board's effective skill set at the top of every iteration and materializes it into the working tree before the session starts. Bind, pin, or publish mid-run and the next iteration picks up the change — the same live-instrument property as the prompt. Unbinding stops updates but does not yet remove the already-materialized files from the loop working directory: materialization only ever adds, so a removed skill's directory lingers until that cleanup ships.":
      " vinculadas ao quadro sem nenhuma etapa de pipeline: o runner volta a buscar o conjunto efetivo de habilidades do quadro no início de cada iteração e o materializa na árvore de trabalho antes de a sessão começar. Vincule, fixe ou publique durante a execução e a próxima iteração incorpora a mudança: a mesma propriedade de instrumento ao vivo que o prompt tem. Desvincular interrompe as atualizações, mas ainda não remove os arquivos já materializados do diretório de trabalho do loop: a materialização apenas adiciona, então o diretório de uma habilidade removida permanece até essa limpeza ser implementada.",
    "The traffic also flows the other way. With":
      "O tráfego também flui no sentido contrário. Com",
    " — on by default in the loop config — a session that proved out a durable method can distill it into a proposed skill via ":
      " (ativado por padrão na configuração do loop), uma sessão que validou um método durável pode destilá-lo em uma habilidade proposta por meio de ",
    ". Nothing publishes on its own: the proposal waits in the approvals queue for a human, and only approval makes it part of what future iterations are taught.":
      ". Nada é publicado sozinho: a proposta aguarda na fila de aprovações por uma pessoa, e só a aprovação a torna parte do que as iterações futuras aprendem.",
    "Loop mode": "Modo de loop",
    " points a single agent session at a board and lets it work the backlog unattended, one card per iteration. Where a pipeline run is a runner playing configured roles against cards the scheduler hands it, a loop is one prompt executed over and over — each iteration a fresh session with no memory of the last one, re-reading the board to decide what to do next.":
      " direciona uma única sessão de agente a um quadro e permite que ela trabalhe no backlog sem supervisão, um cartão por iteração. Enquanto uma execução de pipeline consiste em um runner desempenhando funções configuradas nos cartões entregues pelo scheduler, um loop executa o mesmo prompt repetidamente. Cada iteração é uma nova sessão, sem memória da anterior, que volta a ler o quadro para decidir o que fazer.",
    "That amnesia is the design, not a limitation. The board is the loop's only durable memory: run-log notes, card descriptions, and the board definition are what one iteration leaves for the next. Anything an iteration learns but does not write down is gone when its session ends.":
      "Essa ausência de memória faz parte do design, não é uma limitação. O quadro é a única memória durável do loop: notas de registro de execução, descrições dos cartões e a definição do quadro são o que uma iteração deixa para a próxima. Tudo o que uma iteração aprende e não registra desaparece quando a sessão termina.",
    "The tuning loop": "O ciclo de ajuste",
    "The runner re-fetches the board's loop config at the top of":
      "O runner consulta novamente a configuração de loop do quadro no início de",
    every: "cada",
    " iteration. That single property turns the loop into a live instrument — you edit the prompt mid-run and the next iteration picks it up with no restart and no redeploy.":
      " iteração. Essa propriedade transforma o loop em um instrumento ao vivo: você edita o prompt durante a execução e a próxima iteração o utiliza sem reiniciar nem fazer novo deploy.",
    "An iteration writes a run-log note on the board.":
      "Uma iteração grava uma nota de registro de execução no quadro.",
    "You read it and fold the lesson into ":
      "Você lê a nota e incorpora o aprendizado em ",
    " — one": " com uma única",
    " call; every operator field is editable.":
      "; todos os campos do operador podem ser editados.",
    "The next iteration runs the new method.":
      "A próxima iteração executa o método atualizado.",
    "Treat the prompt as versioned method, the board's notes as the loop's memory, and the config as the only knob you need mid-run. The most valuable thing an iteration produces is often not its diff but its report of what the prompt got wrong.":
      "Trate o prompt como um método versionado, as notas do quadro como a memória do loop e a configuração como o único controle necessário durante a execução. Muitas vezes, o resultado mais valioso de uma iteração não é o diff, mas o relatório sobre o que o prompt interpretou de forma incorreta.",
    "Operator config fields": "Campos de configuração do operador",
    "The board's Loop dialog is the human control surface. It keeps the enable switch disabled until the first valid save, requires a non-empty loop prompt before enabling, warns before discarding unsaved edits, and explains structured disabled reasons. Templates can fill the prompt and tool allowlist with an overwrite confirmation; prompt-variable chips, provider and model controls, the Tool picker, recent telemetry, the paginated iteration log, and stop transitions are available in the same dialog.":
      "A caixa Loop do quadro é a superfície de controle para pessoas. Ela mantém o seletor de ativação desabilitado até o primeiro salvamento válido, exige um prompt de Loop não vazio antes de habilitar, avisa antes de descartar alterações não salvas e explica motivos estruturados de desativação. Modelos podem preencher o prompt e a lista de ferramentas permitidas com confirmação de substituição; chips de variáveis do prompt, controles de provedor e modelo, seletor de ferramentas, telemetria recente, registro paginado de iterações e transições de parada estão disponíveis na mesma caixa.",
    "Saving config and changing state are separate operations. The dialog saves the operator-owned fields below, while its switch enables or disables the saved loop. The ":
      "Salvar a configuração e mudar o estado são operações separadas. A caixa salva os campos abaixo que pertencem ao operador, enquanto seu seletor habilita ou desabilita o Loop salvo. A ferramenta ",
    " MCP tool covers the same policy surface for agents; omitted fields retain their current values, and the runner re-fetches changes on its next cycle.":
      " do MCP cobre a mesma superfície de políticas para agentes; campos omitidos mantêm seus valores atuais e o runner busca novamente as alterações no próximo ciclo.",
    "Core execution fields: ": "Campos principais de execução: ",
    ", and": " e",
    "Time and money rails: ": "Limites de tempo e dinheiro: ",
    "Failure and human-block rails: ": "Limites de falhas e bloqueios humanos: ",
    "and ": "e ",
    " (default) or": " (padrão) ou",
    ". Under ": ". Com ",
    " the runner pre-flights readiness each cycle and idles for free when nothing is actionable. Use ":
      " o runner verifica a disponibilidade antes de cada ciclo e aguarda sem custo quando não há nada acionável. Use ",
    " for loops whose prompt does non-card work, such as triage or documentation sweeps.":
      " para loops cujo prompt realiza trabalho que não depende de cartões, como triagem ou revisão de documentação.",
    ". A person lands the PR, the loop agent lands its own with plain git, or the platform merge queue lands it — the last is the per-board opt-in for autonomous landing. See the posture matrix below.":
      ". Uma pessoa integra o PR, o agente do loop integra o próprio com git puro, ou a fila de merge da plataforma integra: esta última é a adesão por quadro à integração autônoma. Consulte a matriz de posturas mais adiante.",
    ". What the merge executor requires before landing this board's queued PRs. Resolved live per tick, so flipping it unsticks already-queued entries without re-enqueueing. Fail-closed: an unrecognized policy behaves as ":
      ". Define o que o executor de merge exige antes de integrar os PRs deste quadro que estão na fila. É resolvido ao vivo a cada ciclo, portanto a alteração desbloqueia entradas já enfileiradas sem colocá-las novamente na fila. Uma política desconhecida falha de forma segura e se comporta como ",
    " — server-owned, stamped on every disabled→enabled transition. It defines the budget window, which makes":
      " pertence ao servidor e é registrado em cada transição de desativado para ativado. Ele define a janela de orçamento, por isso",
    "re-enabling the loop your budget reset lever":
      "reativar o loop é o mecanismo para reiniciar o orçamento",
    ". Config edits while enabled preserve it.":
      ". Alterações de configuração enquanto o loop está ativo preservam esse valor.",
    "budget_epoch is not writable": "budget_epoch não pode ser alterado",
    "Like ": "Assim como ",
    " and ": " e ",
    ", it is set by the server. A save that carries it back is rejected. To reset the spend window, disable the loop and enable it again.":
      ", ele é definido pelo servidor. Um salvamento que reenviar esse campo será rejeitado. Para reiniciar a janela de gastos, desative o loop e ative-o novamente.",
    "Parking — the readiness, reconcile, wake chain":
      "Espera: a sequência de disponibilidade, reconciliação e reativação",
    "A loop whose cards are all blocked used to burn a full session discovering it had nothing to do. Under the default":
      "Antes, um loop com todos os cartões bloqueados consumia uma sessão inteira apenas para descobrir que não havia nada a fazer. Com o valor padrão",
    " it does not:": " isso não acontece:",
    "Readiness.": "Disponibilidade.",
    " Before spending anything, the runner asks the backend what is actionable right now — how many cards are workable, blocked, or waiting on a merge.":
      " Antes de gastar, o runner pergunta ao backend o que está acionável naquele momento: quantos cartões podem ser trabalhados, estão bloqueados ou aguardam um merge.",
    "Reconcile.": "Reconciliação.",
    " The merged-PR reconciler moves cards whose PRs have landed into Done, which is what unblocks their dependents. It runs on merge events and on a periodic poll.":
      " O reconciliador de PRs integrados move para Done os cartões cujos PRs já receberam merge, liberando seus dependentes. Ele é executado por eventos de merge e por consulta periódica.",
    "Wake.": "Reativação.",
    " When reconciliation makes something workable, the next cycle starts a real iteration. Until then the loop idles at zero cost, logging its parked state with blocked and awaiting-merge counts each cycle.":
      " Quando a reconciliação torna algum trabalho acionável, o próximo ciclo inicia uma iteração real. Até lá, o loop aguarda sem custo e registra em cada ciclo quantos cartões estão bloqueados ou esperando merge.",
    "So a parked loop is healthy and cheap, not stuck. The way to tell the difference is the parked log line and the readiness endpoint — both report what the runner currently sees.":
      "Portanto, um loop em espera está saudável e não gera custo; ele não está travado. A linha de log do estado em espera e o endpoint de disponibilidade mostram a diferença, pois ambos informam o que o runner vê naquele momento.",
    "Disabled, parked, and keep-alive": "Desabilitado, estacionado e keep-alive",
    "These states answer different questions. ": "Esses estados respondem a perguntas diferentes. ",
    " means the loop is enabled but has no actionable work under its starvation policy. It remains eligible to work and waits at zero session spend. By contrast, ":
      " significa que o Loop está habilitado, mas não há trabalho acionável segundo sua política de inatividade. Ele continua apto a trabalhar e aguarda sem gasto de sessão. Por outro lado, ",
    " means the board loop is disabled but the runner was configured to stay resident with":
      " significa que o Loop do quadro está desabilitado, mas o runner foi configurado para permanecer residente por meio de",
    " or the explicit": " ou do flag explícito",
    " flag. It starts no agent session while disabled.":
      ". Nenhuma sessão de agente é iniciada enquanto ele está desabilitado.",
    "A resident runner wakes on ": "Um runner residente acorda com ",
    " through the workspace WebSocket when possible and falls back to checking at most once per minute. That socket is a wake channel only: control Loop with":
      " pelo WebSocket do workspace quando possível e, como fallback, verifica o estado no máximo uma vez por minuto. Esse socket é somente um canal de ativação: controle o Loop com ",
    ", not ": ", não com ",
    " or": " nem",
    ". If an older backend rejects": ". Se um backend mais antigo rejeitar ",
    ", the runner reports the compatible": ", o runner informa o heartbeat compatível ",
    " heartbeat instead. Re-enabling creates a new budget epoch and starts fresh budget accounting.":
      " em seu lugar. Reabilitar cria uma nova época de orçamento e reinicia sua contabilidade.",
    "Keep-alive does not bypass stop conditions":
      "Keep-alive não ignora as condições de parada",
    "Keep-alive changes only what happens after an operator disables the board loop. The safety rails still exit the process when a run reaches its budget, iteration ceiling, completion query, or another terminal guard. Use a process supervisor if those exits should be restarted.":
      "Keep-alive muda apenas o que acontece depois que um operador desabilita o Loop do quadro. Os limites de segurança ainda encerram o processo quando uma execução atinge o orçamento, o máximo de iterações, a consulta de conclusão ou outra condição terminal. Use um supervisor de processos se essas saídas precisarem ser reiniciadas.",
    "Autonomy posture": "Postura de autonomia",
    "Two questions define how much rope the loop has: who merges the pull requests, and what has to be green first.":
      "Duas perguntas definem o grau de autonomia do loop: quem faz merge dos pull requests e o que precisa estar verde antes.",
    "Human landing (default)": "Integração humana (padrão)",
    "PRs land when a person merges them on the forge. The reconciler still moves the card to Done, so the board stays accurate without anyone touching it. While work is blocked behind those merges the loop parks at zero cost and wakes when a merge unblocks dependencies. This posture needs nothing extra and works on any plan.":
      "Os PRs são integrados quando uma pessoa faz merge no forge. O reconciliador ainda move o cartão para Done, mantendo o quadro correto sem intervenção adicional. Enquanto o trabalho aguarda esses merges, o loop fica em espera sem custo e é reativado quando um merge libera dependências. Essa postura não exige configuração extra e funciona em qualquer plano.",
    "Merge-queue landing (opt-in)": "Integração pela fila de merge (opcional)",
    "A board admin sets ": "Uma pessoa administradora do quadro configura ",
    " and adds the enqueue tool to the loop's allowlist. Loop agents then hand finished PRs to the platform's merge executor, which rebases and lands them subject to":
      " e adiciona a ferramenta de enfileiramento à lista permitida do loop. Os agentes entregam os PRs concluídos ao executor de merge da plataforma, que faz rebase e os integra de acordo com",
    ". A loop rarely parks under this posture because it lands its own green PRs. An agent enqueue on a board without the opt-in is rejected server-side.":
      ". Nessa postura, o loop raramente fica em espera porque integra seus próprios PRs verdes. O servidor rejeita a tentativa de um agente de enfileirar trabalho em um quadro que não tenha habilitado essa opção.",
    "Self-merge landing (prompt-directed)":
      "Aterrissagem self-merge (dirigida pelo prompt)",
    " is the honest name for what a prompt saying \"merge it yourself\" already does: the loop agent merges its own branch and moves its own card, with no reviewed PR by construction. The platform grants nothing here, but the board's done-merge gate would block every Done move under it — so a":
      " é o nome honesto do que um prompt dizendo \"faça o merge você mesmo\" já faz: o agente do loop faz o merge do próprio branch e move o próprio cartão, sem nenhum PR revisado por construção. A plataforma não concede nada aqui, mas o portão de Concluído do quadro bloquearia todo movimento para Concluído sob essa aterrissagem, então um salvamento",
    "human":
      "humano",
    " save that chooses this landing relaxes the gate for that board in the same request. The dialog surfaces the trade as a notice you can decline, an explicitly enforced board is never softened implicitly, and moving the landing off ":
      " que escolhe essa aterrissagem relaxa o portão daquele quadro na mesma requisição. O diálogo apresenta a troca como um aviso que você pode recusar, um quadro cujo portão foi imposto explicitamente nunca é suavizado de forma implícita, e ao mover a aterrissagem para fora de ",
    " re-arms the gate automatically. Agent-key saves never relax anything: a landing an agent stored does not count as consent, and an explicit relax from an agent key is refused.":
      " o portão é reativado automaticamente. Salvamentos com chave de agente nunca relaxam nada: uma aterrissagem armazenada por um agente não conta como consentimento, e um relaxamento explícito a partir de uma chave de agente é recusado.",
    "Every posture reports lifetime cost from provider reports or runner estimates, alongside spending and remaining allowance for the current budget epoch. Restarting preserves the epoch; disabling and re-enabling starts a new one. Session dollar settings are advisory unless the provider and billing mode support enforcement; subscription sessions do not have an enforced dollar cap. Missing required spending history stops execution. The early budget warning and shell deny floor still apply.":
      "Todas as posturas mostram o custo total informado pelos provedores ou estimado pelo runner, junto com os gastos e o valor restante do período de orçamento atual. Reiniciar preserva o período; desativar e reativar inicia um novo. Os valores por sessão são orientativos, a menos que o provedor e o modo de cobrança permitam aplicá-los; sessões por assinatura não têm um teto monetário imposto. A execução para se o histórico de gastos obrigatório estiver indisponível. O alerta antecipado de orçamento e as proibições mínimas do shell continuam valendo.",
    "Forge CI is desirable, never a dependency":
      "A CI do forge é desejável, mas nunca uma dependência",
    "Some repositories cannot run forge CI at all — a free-plan organization where Actions are unavailable, for instance. Rather than making those boards second-class, ":
      "Alguns repositórios não conseguem executar CI no forge, por exemplo uma organização de plano gratuito sem Actions disponíveis. Para não relegar esses quadros, ",
    " skips the CI read entirely and lets the board's review flow be the quality gate. We would rather you land work with an honest gate than pretend a red-or-absent CI signal is green.":
      " ignora completamente a consulta de CI e permite que o fluxo de revisão do quadro seja o controle de qualidade. É melhor integrar trabalho com um controle real do que fingir que um sinal de CI vermelho ou inexistente está verde.",
    "Authoring cards for a loop": "Criação de cartões para um loop",
    "Shared-file conflicts between parallel cards are structural, not incidental. Any two cards that append to the same status section, register into the same map, or edit the same barrel export":
      "Conflitos em arquivos compartilhados entre cartões paralelos são estruturais, não acidentais. Dois cartões que adicionam conteúdo à mesma seção de status, se registram no mesmo mapa ou editam o mesmo barrel export",
    will: "vão",
    " conflict when their PRs land. Author them so the collision never exists:":
      " entrar em conflito quando seus PRs forem integrados. Estruture os cartões para que essa colisão não exista:",
    "Prefer ": "Prefira ",
    "per-card registration files": "arquivos de registro por cartão",
    " plus a generated or union registry over one file every card edits.":
      " com um registro gerado ou combinado, em vez de um arquivo editado por todos os cartões.",
    "append-only logs": "logs somente de acréscimo",
    " over in-place status tables — two appends merge cleanly, two edits of the same row do not.":
      " em vez de tabelas de status alteradas no lugar. Dois acréscimos fazem merge de forma limpa; duas edições da mesma linha, não.",
    "File ": "Crie ",
    "explicit integration cards": "cartões de integração explícitos",
    " for union merges, with dependency edges on the cards they integrate. Do not leave the last parallel card to implicitly merge everything.":
      " para merges de união, com dependências para os cartões que integram. Não deixe para o último cartão paralelo a tarefa implícita de unir tudo.",
    "When a card needs an earlier card's unmerged interfaces, copy those interface files verbatim into its branch. They are identical at merge time and rebase away cleanly — which beats stacking branches.":
      "Quando um cartão precisa das interfaces ainda não integradas de um cartão anterior, copie esses arquivos de interface literalmente para sua branch. Eles serão idênticos no momento do merge e desaparecerão de forma limpa durante o rebase, o que é melhor do que empilhar branches.",
    "Write the general rule into the card, not the note":
      "Registre a regra geral no cartão, não na nota",
    "When an iteration hits a non-obvious constraint, have it write the rule into the affected card's description as an as-built block. The next iteration reads cards it is about to work; it may never read a note filed under a different card.":
      "Quando uma iteração encontrar uma restrição pouco evidente, faça com que registre a regra na descrição do cartão afetado como um bloco as-built. A próxima iteração lê os cartões em que vai trabalhar, mas talvez nunca leia uma nota associada a outro cartão.",
    "Knowing why it stopped": "Entender por que parou",
    "A loop should never spin on a state it cannot change. Instruct the prompt to disable the loop with a one-line reason whenever the objective is complete or a human decision is genuinely required — that reason is the first thing you see when you come back to the board.":
      "Um loop nunca deve continuar executando sobre um estado que não pode alterar. Oriente o prompt a desativar o loop com um motivo de uma linha quando o objetivo estiver concluído ou quando uma decisão humana for realmente necessária. Esse motivo será a primeira informação exibida ao voltar ao quadro.",
    "Prompt fragment — disable with a reason":
      "Trecho de prompt: desativar com um motivo",
    "The rails write machine-readable reasons of their own when they stop a loop — budget exhausted, iteration ceiling reached, too many consecutive failures — so a stopped loop always explains itself in the same place.":
      "Os limites registram motivos legíveis por máquina quando interrompem um loop, como orçamento esgotado, máximo de iterações atingido ou falhas consecutivas em excesso. Assim, um loop interrompido sempre explica a causa no mesmo lugar.",
    "Which component owns what": "Qual componente é responsável por cada função",
    "A recurring diagnosis mistake is looking for a loop feature in the wrong binary. Before concluding a build is stale, check who owns the feature:":
      "Um erro comum de diagnóstico é procurar uma função do loop no binário errado. Antes de concluir que uma build está desatualizada, verifique qual componente é responsável:",
    Backend: "Backend",
    " and": " e",
    " enforcement, the merge queue worker, the merged-PR reconciler, readiness and history endpoints, and workspace git credentials. The runner never reads the first two.":
      " aplicam as políticas, junto com o worker da fila de merge, o reconciliador de PRs integrados, os endpoints de disponibilidade e histórico e as credenciais git do espaço de trabalho. O runner nunca lê os dois primeiros valores.",
    "MCP server": "Servidor MCP",
    " — the tools themselves. The runner passes tool ":
      " contém as ferramentas. O runner repassa os ",
    names: "nomes",
    " through to the agent allowlist verbatim.":
      " das ferramentas literalmente para a lista permitida do agente.",
    Runner: "Runner",
    " — parking, budget caps, iteration continuity, and the outcome schema. It stores nothing; it reads":
      " gerencia a espera, os limites de orçamento, a continuidade das iterações e o schema de resultados. Ele não armazena nada; lê",
    " from the platform each iteration.": " da plataforma em cada iteração.",
    "Backend features arrive with deploys. When a runner meets an endpoint that is not there yet, it treats the feature as unsupported and degrades gracefully rather than failing the iteration.":
      "As funções do backend chegam com os deploys. Quando um runner encontra um endpoint que ainda não existe, trata a função como não compatível e opera de forma degradada em vez de fazer a iteração falhar.",
    Templates: "Templates",
    "Most loops should not start from a blank prompt. A ":
      "A maioria dos loops não deveria começar com um prompt em branco. Um ",
    "loop template": "loop template",
    " carries the prompts, the tool allowlist, and sensible rails, with the run-specific parts left as named ":
      " traz os prompts, a lista de permissões de ferramentas e limites razoáveis, deixando as partes específicas de cada execução como ",
    slots: "slots",
    " you fill in. The maintained starting point is ":
      " nomeados que você preenche. O ponto de partida que mantemos é ",
    "Coding Loop v2": "Coding Loop v2",
    "Templates live in the Runner console under ":
      "Os templates ficam no console do Runner, em ",
    ". Pick one, run ": ". Escolha um, execute ",
    fit: "fit",
    " against your board to see what the template expects that the board does not yet have, fill the slots (each carries help text explaining what a good value looks like), preview the fully rendered prompts, and save. Prompts are rendered at save time and stored as ordinary loop config, so the runner reads exactly what it always read — and enabling the loop stays a separate, deliberate act.":
      " no seu quadro para ver o que o template espera e o quadro ainda não tem, preencha os slots (cada um traz um texto de ajuda explicando como é um bom valor), visualize os prompts já renderizados e salve. Os prompts são renderizados no momento do salvamento e armazenados como configuração comum do loop, então o runner lê exatamente o que sempre leu — e ativar o loop continua sendo um ato separado e deliberado.",
    "A bound board refuses hand edits to its prompts rather than silently overwriting them on the next render; detach it first if you want raw text. Each iteration a bound board runs is stamped with the template it came from, which is what gives a template a track record.":
      "Um quadro vinculado recusa edições manuais em seus prompts em vez de sobrescrevê-las silenciosamente na próxima renderização; desvincule-o primeiro se quiser editar o texto direto. Cada iteração executada por um quadro vinculado é marcada com o template de origem, e é isso que dá a um template um histórico de resultados.",
    "The catalog behind that page is":
      "O catálogo por trás dessa página é",
    ". It lists system templates first — code-defined, versioned with the app, so an upgrade is what updates them — then templates authored in your workspace. Entries are summaries; prompts, slots, and tool grants live behind the per-template fetch. Retired system lineages disappear from the catalog but their slugs still resolve, so a board bound to one reports drift instead of breaking.":
      ". Ele lista primeiro os templates de sistema — definidos em código e versionados com o aplicativo, de modo que o que os atualiza é um upgrade — e depois os templates criados no seu espaço de trabalho. As entradas são resumos; os prompts, os slots e as permissões de ferramentas ficam atrás da consulta por template. Linhagens de sistema aposentadas desaparecem do catálogo, mas seus slugs continuam resolvendo, então um quadro vinculado a uma delas relata drift em vez de quebrar.",
    "The full operator playbook — templates and slots, forge sharp edges, and credential troubleshooting — lives at":
      "O playbook completo do operador, com templates e slots, particularidades do forge e solução de problemas de credenciais, está em",
    " in the Backplane repository, with the contract of record in ":
      " no repositório Backplane, e o contrato de referência está em ",
  },
  skills: {
    "propose_skill requires a runner-bound key. An interactive AI using a human key receives 403; prepare its bundle for an authorized human workspace admin to create a draft and publish in the workspace Skills Library. There is no MCP draft-authoring tool. Runner proposals still require human approval before publication.": "propose_skill exige uma chave vinculada a um runner. Uma IA interativa com chave humana recebe 403; prepare o pacote para um administrador humano autorizado do espaço de trabalho criar um rascunho e publicar na biblioteca de Skills do espaço de trabalho. Não há ferramenta MCP para criar rascunhos. Propostas de runners continuam exigindo aprovação humana antes da publicação.",

    "A ":
      "Uma ",
    "skill":
      "habilidade",
    " is a versioned bundle of procedural knowledge — a method, a checklist, a set of conventions — that boards teach to the agents working on them. Each bundle is a ":
      " é um pacote versionado de conhecimento procedimental (um método, uma lista de verificação, um conjunto de convenções) que os quadros ensinam aos agentes que trabalham neles. Cada pacote consiste em um manifesto ",
    "manifest plus optional text support files. The manifest opens with YAML frontmatter whose ":
      "mais arquivos de apoio de texto opcionais. O manifesto começa com um frontmatter YAML cujos campos ",
    " and ":
      " e ",
    "A minimal SKILL.md":
      "Um SKILL.md mínimo",
    "Library and catalog":
      "Biblioteca e catálogo",
    "Skills live in the ":
      "As habilidades vivem na ",
    "workspace library":
      "biblioteca do espaço de trabalho",
    ". They get there three ways: a human authors one on the Skills page, a human activates one from the built-in ":
      ". Elas chegam lá de três maneiras: uma pessoa escreve uma na página de Habilidades, uma pessoa ativa uma a partir do ",
    "catalog":
      "catálogo",
    " of platform-curated skills, or an agent proposes one and a human approves it. Activation copies the catalog entry into the library as an independent published v1 — from that moment it is workspace content, versioned like any other skill, with no link back to the catalog entry it came from.":
      " integrado de habilidades curadas pela plataforma, ou um agente propõe uma e uma pessoa a aprova. A ativação copia a entrada do catálogo para a biblioteca como uma v1 publicada e independente: a partir desse momento ela é conteúdo do espaço de trabalho, versionada como qualquer outra habilidade e sem vínculo com a entrada de catálogo que a originou.",
    "Retiring a skill is a ":
      "Aposentar uma habilidade é um ",
    "soft archive":
      "arquivamento suave",
    ", never a delete. An archived skill keeps serving the boards already bound to it — a working pipeline does not change behavior because someone tidied the library — but it blocks new bindings and new proposals until unarchived.":
      ", nunca uma exclusão. Uma habilidade arquivada continua sendo servida aos quadros que já estavam vinculados a ela (um pipeline em funcionamento não muda de comportamento porque alguém organizou a biblioteca), mas bloqueia novas vinculações e novas propostas até ser desarquivada.",
    "Versions and bindings":
      "Versões e vinculações",
    "Versions are integers, each carrying a content hash over the bundle's files. A published version is immutable: fixing a typo means publishing the next version, and the hash is what lets you prove byte-for-byte which method an agent was given. Drafts and pending proposals exist alongside published versions but are never served.":
      "As versões são números inteiros e cada uma carrega um hash de conteúdo sobre os arquivos do pacote. Uma versão publicada é imutável: corrigir um erro de digitação significa publicar a próxima versão, e o hash é o que permite provar byte a byte qual método um agente recebeu. Rascunhos e propostas pendentes coexistem com as versões publicadas, mas nunca são servidos.",
    "A board's relationship to a skill is deliberately tri-state:":
      "A relação de um quadro com uma habilidade tem deliberadamente três estados:",
    "unbound":
      "sem vínculo",
    " — the default, the skill does not reach the board; ":
      " (o padrão: a habilidade não chega ao quadro); ",
    "bound but disabled":
      "vinculada, mas desabilitada",
    " — the binding and its configuration are kept, nothing is served; and":
      " (a vinculação e sua configuração são mantidas, e nada é servido); e",
    "bound and enabled":
      "vinculada e habilitada",
    ". An enabled binding may pin a specific version; an unpinned binding tracks the latest published version automatically.":
      ". Uma vinculação habilitada pode fixar uma versão específica; uma vinculação sem fixação acompanha automaticamente a última versão publicada.",
    "The board's ":
      "O ",
    "effective set":
      "conjunto efetivo",
    " — what agents actually receive — resolves from three rules: enabled bindings only; the pinned version when pinned, otherwise the latest published version; and a binding whose skill has nothing published yet (draft-only) simply drops out.":
      " do quadro, ou seja, o que os agentes realmente recebem, resolve-se por três regras: apenas vinculações habilitadas; a versão fixada quando há fixação e, caso contrário, a última versão publicada; e uma vinculação cuja habilidade ainda não tem nada publicado (somente rascunhos) simplesmente fica de fora.",
    "How skills reach agents":
      "Como as habilidades chegam aos agentes",
    "The runner ":
      "O runner ",
    "pre-materializes":
      "pré-materializa",
    " the board's effective set into the working tree before the LLM launches, at each coding agent's own discovery path —":
      " o conjunto efetivo do quadro na árvore de trabalho antes de o LLM iniciar, no caminho de descoberta próprio de cada agente de código:",
    " for Claude Code,":
      " para o Claude Code e",
    " for Codex. Files are written verbatim; the agent finds them the way it finds any project-local skill. Nothing is spliced into a prompt, and the runner has no opinion about what a skill says.":
      " para o Codex. Os arquivos são gravados literalmente; o agente os encontra do mesmo modo que encontra qualquer habilidade local do projeto. Nada é inserido em um prompt, e o runner não tem opinião sobre o que uma habilidade diz.",
    "In a pipeline, that copy happens in the ":
      "Em um pipeline, essa cópia acontece na etapa de ciclo de vida ",
    "lifecycle step — after ":
      ", depois de ",
    ", because it needs the clone, and before the ":
      ", porque ela precisa do clone, e antes da etapa ",
    " step, because the agent must see the files at launch. In":
      ", porque o agente precisa ver os arquivos ao iniciar. No",
    "loop mode":
      "modo de loop",
    " no step is needed: the effective set is re-fetched at the top of every iteration, so a newly bound skill or version change is live on the next iteration with no restart. One asymmetry to know: unbinding a skill mid-run stops its updates but leaves the already-materialized files in the loop working directory — materialization only ever adds today.":
      " nenhuma etapa é necessária: o conjunto efetivo é buscado novamente no início de cada iteração, então uma habilidade recém-vinculada ou uma mudança de versão já vale na iteração seguinte, sem reiniciar nada. Uma assimetria que vale conhecer: desvincular uma habilidade durante a execução interrompe suas atualizações, mas deixa os arquivos já materializados no diretório de trabalho do loop — hoje a materialização apenas adiciona.",
    "Stored pipelines predating skills need the step added":
      "Pipelines salvos antes das habilidades precisam que a etapa seja adicionada",
    "A pipeline config saved before the skills registry existed has no":
      "Uma configuração de pipeline salva antes de o registro de habilidades existir não tem nenhuma etapa",
    " step, and the platform does not inject one. Bind all the skills you want — nothing materializes until you add the step to each role's lifecycle in the":
      " e a plataforma não injeta uma. Vincule todas as habilidades que quiser: nada é materializado até você adicionar a etapa ao ciclo de vida de cada função no",
    "pipeline builder":
      "construtor de pipelines",
    "Materialized skills never land in diffs or PRs. The runner appends the skills directory to ":
      "Habilidades materializadas nunca aparecem em diffs nem em PRs. O runner acrescenta o diretório de habilidades a ",
    " before writing the first file, refuses to overwrite any path the repository already tracks, and removes exactly the directories it wrote during cleanup — a skill leaking into a commit would put workspace content into a customer PR.":
      " antes de gravar o primeiro arquivo, recusa-se a sobrescrever qualquer caminho que o repositório já rastreie e remove exatamente os diretórios que gravou durante a limpeza: uma habilidade vazando para um commit colocaria conteúdo do espaço de trabalho no PR de um cliente.",
    "Interactive and MCP-connected agents skip materialization entirely:":
      "Agentes interativos e conectados por MCP pulam a materialização por completo:",
    " returns the workspace library — or, with a board id, that board's effective set — and ":
      " retorna a biblioteca do espaço de trabalho (ou, com um id de quadro, o conjunto efetivo desse quadro) e ",
    "returns full file contents.":
      "retorna o conteúdo completo dos arquivos.",
    " are authoritative for the skill's identity, and whose":
      " são a fonte autoritativa da identidade da habilidade, e cujo",
    " names the hand the skill plays in — the toolset ids its guidance assumes are loaded; the body is plain markdown, the same open convention coding agents already discover in project directories. The platform stores every file verbatim — it never parses, rewrites, or summarizes a skill body.":
      " nomeia a mão em que a habilidade joga: os ids de toolsets que sua orientação presume carregados; o corpo é markdown puro, a mesma convenção aberta que os agentes de código já descobrem nos diretórios de projeto. A plataforma armazena cada arquivo literalmente: nunca analisa, reescreve nem resume o corpo de uma habilidade.",
    "Toolsets enforce, skills guide":
      "Os toolsets impõem, as habilidades orientam",
    "No client can scope an MCP listing from a skill. A skill's":
      "Nenhum cliente pode restringir uma listagem MCP a partir de uma habilidade. O",
    " is a pre-approval hint some agents honour; it never removes a tool from what the server lists. The toolset is what the server lists and allows: ":
      " de uma habilidade é uma dica de pré-aprovação que alguns agentes respeitam; ele nunca remove uma ferramenta do que o servidor lista. O toolset é o que o servidor lista e permite: ",
    "decides the hand, and a tool outside it cannot be listed or called — see the ":
      "decide a mão, e uma ferramenta fora dela não pode ser listada nem chamada; consulte a referência de ",
    "MCP Toolsets":
      "Toolsets MCP",
    "reference.":
      ".",
    "A skill declares the hand it plays in. ":
      "Uma habilidade declara a mão em que joga. ",
    " in the frontmatter names the toolset ids the playbook was written for, so a reader — and the platform — can tell whether the guidance and the session's hand agree. The platform warns in two places: the library flags a playbook that names tools outside its declared toolsets, and the board settings flag a bound skill whose toolsets the board's loop grant does not cover. Neither warning changes what is served.":
      " no frontmatter nomeia os ids de toolsets para os quais o playbook foi escrito, para que um leitor, e a plataforma, saibam se a orientação e a mão da sessão concordam. A plataforma avisa em dois lugares: a biblioteca sinaliza um playbook que nomeia ferramentas fora dos seus toolsets declarados, e as configurações do quadro sinalizam uma habilidade vinculada cujos toolsets a concessão do loop do quadro não cobre. Nenhum aviso muda o que é servido.",
    "The runner never parses ":
      "O runner nunca analisa ",
    ". It materializes the files verbatim; the declaration is validated when a version is stored and read from SKILL.md whenever the skill is served, shown to people, never enforced on an agent.":
      ". Ele materializa os arquivos literalmente; a declaração é validada ao guardar uma versão e lida do SKILL.md sempre que a habilidade é servida, mostrada às pessoas e nunca imposta a um agente.",
    "The self-improvement loop":
      "O ciclo de automelhoria",
    "Skills are the platform's mechanism for compounding what agents learn. The loop runs like this: a runner-bound agent works a card and, along the way, works out something durable — a debugging method that actually found the bug, a migration recipe that survived review, a convention the codebase enforces the hard way. Instead of letting that die with the session, the agent distills the method into a bundle and calls":
      "As habilidades são o mecanismo da plataforma para capitalizar o que os agentes aprendem. O ciclo funciona assim: um agente vinculado a um runner trabalha em um cartão e, pelo caminho, descobre algo durável: um método de depuração que de fato encontrou o bug, uma receita de migração que sobreviveu à revisão, uma convenção que o código impõe do jeito difícil. Em vez de deixar isso morrer com a sessão, o agente destila o método em um pacote e chama",
    "The proposal opens a scored request in the":
      "A proposta abre uma solicitação pontuada na",
    "approvals queue":
      "fila de aprovações",
    " under the":
      " sob a categoria",
    " category, base risk 60 — far above the auto-approve threshold, by design, because skill content steers every future agent session that receives it. It can never auto-approve. A human reads the actual proposed files, and approving is the act that publishes the version. From then on, every future run on every board bound to that skill receives the distilled method. Rejecting keeps the currently published version — or nothing — in place.":
      ", com risco base 60, muito acima do limiar de aprovação automática, e isso é intencional: o conteúdo de uma habilidade orienta toda sessão de agente futura que a receber. Ela nunca pode ser aprovada automaticamente. Uma pessoa lê os arquivos realmente propostos, e aprovar é o ato que publica a versão. A partir daí, cada execução futura em cada quadro vinculado a essa habilidade recebe o método destilado. Rejeitar mantém no lugar a versão publicada atual, ou nenhuma.",
    "Agents propose; humans decide what is published.":
      "Os agentes propõem; as pessoas decidem o que é publicado.",
    " That split is the whole design: the flywheel spins as fast as agents learn, but the knowledge that steers future sessions only changes with a human's name on the decision.":
      " Essa separação é todo o design: o volante gira tão rápido quanto os agentes aprendem, mas o conhecimento que orienta as sessões futuras só muda com o nome de uma pessoa na decisão.",
    "Loops opt in per board: ":
      "Os loops aderem quadro a quadro: ",
    " in the board's loop config — on by default — exposes the proposal tool to loop sessions. Switch it off for boards whose loops should consume skills but never suggest new ones.":
      " na configuração de loop do quadro (ativado por padrão) expõe a ferramenta de proposta às sessões do loop. Desative-a nos quadros cujos loops devem consumir habilidades, mas nunca sugerir novas.",
    "Tell the prompt what qualifies as a skill":
      "Diga ao prompt o que qualifica como habilidade",
    "The proposals worth approving are methodologies — reusable procedure that would help a different agent on a different card next month. If your loop prompt asks for skill proposals, say what does not qualify: status updates, card-specific context, and anything the board definition already covers belong on the board, not in the library.":
      "As propostas que valem a aprovação são metodologias: procedimento reutilizável que ajudaria outro agente em outro cartão no mês que vem. Se o seu prompt de loop pede propostas de habilidades, diga o que não qualifica: atualizações de status, contexto específico de um cartão e tudo o que a definição do quadro já cobre pertencem ao quadro, não à biblioteca.",
    "Scope and roadmap":
      "Escopo e roteiro",
    "Skills are ":
      "Hoje as habilidades são pacotes ",
    "text-only":
      "somente de texto",
    " bundles today, with hard limits: at most 32 files, 64 KiB per file, 512 KiB per bundle. No binaries and no executable bit — every file materializes as a plain":
      ", com limites rígidos: no máximo 32 arquivos, 64 KiB por arquivo e 512 KiB por pacote. Sem binários e sem bit de execução: cada arquivo é materializado como um arquivo comum com modo",
    " file. A skill that ships a helper script must therefore instruct the agent to invoke it through an interpreter —":
      ". Por isso, uma habilidade que inclua um script auxiliar precisa instruir o agente a invocá-lo por meio de um interpretador:",
    ", never":
      ", nunca",
    "Text-only is a real constraint, not a footnote":
      "Somente texto é uma restrição real, não uma nota de rodapé",
    "A methodology that depends on a reference image, a binary fixture, or a large dataset cannot ship as a skill yet. The limits are deliberate: a skill is meant to be a method an agent reads, not an artifact pipeline — and every byte of it is reviewed by a human before it publishes, which only works while bundles stay small and readable.":
      "Uma metodologia que dependa de uma imagem de referência, de um fixture binário ou de um conjunto de dados grande ainda não pode ser publicada como habilidade. Os limites são deliberados: uma habilidade deve ser um método que um agente lê, não um pipeline de artefatos, e uma pessoa revisa cada byte dela antes da publicação, o que só funciona enquanto os pacotes permanecerem pequenos e legíveis.",
    "Richer ingest is on the roadmap":
      "Uma ingestão mais rica está no roteiro",
    "Binary assets referenced as media rather than inlined, and per-file modes so a bundled script can be executable, are both on the roadmap. Until then, the interpreter-invocation convention above is the supported path.":
      "Ativos binários referenciados como mídia em vez de embutidos, e modos por arquivo para que um script incluído possa ser executável, estão ambos no roteiro. Até lá, a convenção de invocação por interpretador descrita acima é o caminho suportado.",
  },
};
