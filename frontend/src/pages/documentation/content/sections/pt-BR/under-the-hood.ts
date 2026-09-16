// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_UNDER_THE_HOOD = {
  "architecture-overview": {
    "Four cooperating surfaces, one monorepo. The backend is the system of record. The frontend is the operator's cockpit. The MCP server is the cross-LLM integration point. The runner is the credentialed process that actually executes LLM work against a card. Every piece of the platform falls into one of those four surfaces, and they all live in the same git tree so cross-surface refactors happen in one PR with one CI run.":
      "Quatro superfícies que cooperam entre si, um único monorepo. O backend é o sistema de registro. O frontend é a cabine de controle do operador. O servidor MCP é o ponto de integração entre LLMs. O Runner é o processo com credenciais que realmente executa o trabalho de LLM em um cartão. Cada parte da plataforma pertence a uma dessas quatro superfícies, e todas vivem na mesma árvore git para que refatorações entre superfícies ocorram em um único PR, com uma única execução de CI.",
    "The four surfaces": "As quatro superfícies",
    "Read this diagram left-to-right. A human operator clicks the frontend; the frontend talks to the backend over REST and WebSockets; a runner running on an operator's laptop talks to the same backend with the same protocols; the LLM the runner spawns reaches back to the backend through the MCP server. Nothing is circular.":
      "Leia este diagrama da esquerda para a direita. Um operador humano interage com o frontend; o frontend se comunica com o backend por REST e WebSockets; um Runner executado no computador do operador fala com o mesmo backend pelos mesmos protocolos; e o LLM iniciado pelo Runner acessa o backend por meio do servidor MCP. Nada é circular.",
    "Data flow across the four surfaces":
      "Fluxo de dados entre as quatro superfícies",
    " selects ": " seleciona ",
    " for local in-process delivery or ": " para entrega local no processo ou ",
    " for cross-instance fan-out over Postgres LISTEN/NOTIFY. Both adapters feed the same local subscribers; neither is a durable queue or replay log.":
      " para distribuição entre instâncias por Postgres LISTEN/NOTIFY. Ambos os adaptadores alimentam os mesmos assinantes locais; nenhum é uma fila durável nem um registro com replay.",
    "Backend pattern: Router → Service → Repository → Model":
      "Padrão do backend: Router → Service → Repository → Model",
    "Most feature endpoints flow through the same four layers. The router parses the request and wires dependencies (workspace resolution, auth). The service owns business logic, authorization beyond membership, idempotency, activity recording, and event publishing. The repository is pure data access over a generic ":
      "A maioria dos endpoints de funcionalidades passa pelas mesmas quatro camadas. O router interpreta a requisição e conecta as dependências, como resolução do espaço de trabalho e autenticação. O service concentra a lógica de negócio, a autorização além da associação ao espaço, a idempotência, o registro de atividades e a publicação de eventos. O repository é acesso puro a dados sobre um ",
    ". The model is SQLAlchemy 2.x with UUID primary keys and timestamp mixins.":
      ". O model usa SQLAlchemy 2.x, chaves primárias UUID e mixins de timestamp.",
    "A routine card create is a five-step trace: route handler hits":
      "A criação rotineira de um cartão percorre cinco etapas: o handler da rota chama",
    " for membership, calls":
      " para verificar a associação ao espaço de trabalho e chama",
    ", which computes a fractional position and calls ":
      ", que calcula uma posição fracionária e chama ",
    ", which inserts, flushes, and re-fetches with ":
      ", que insere, executa o flush e consulta novamente com ",
    " so the response includes participants. The session auto-commits on the way out. The same pattern holds across the domain routers. Cross-cutting adapters do have explicit exceptions: the WebSocket router resolves users and workspaces during its handshake, and the workspace-config router checks repository linkage while exporting a runner config.":
      " para que a resposta inclua os participantes. A sessão faz commit automaticamente ao encerrar. O mesmo padrão se mantém nos routers do domínio. Adaptadores transversais têm exceções explícitas: o router WebSocket resolve usuários e espaços de trabalho durante o handshake, e o router de configuração do espaço verifica o vínculo do repositório ao exportar uma configuração do Runner.",
    "One error envelope": "Um único envelope de erro",
    "Every error the API returns — domain errors, plain HTTP errors, and request validation — carries the same four-key body, so a client parses one shape and branches on ":
      "Todo erro que a API retorna — erros de domínio, erros HTTP simples e validação de requisições — carrega o mesmo corpo de quatro chaves, então um cliente interpreta uma única forma e ramifica por ",
    " rather than on prose. ":
      " em vez de pela prosa. ",
    " is the human-readable message,":
      " é a mensagem legível por humanos,",
    " is a stable machine string (":
      " é uma string estável para máquinas (",
    " holds structured parameters for rendering the message, and ":
      " contém parâmetros estruturados para renderizar a mensagem e ",
    " carries machine-readable extras when the code alone is not enough — or ":
      " carrega extras legíveis por máquinas quando o código sozinho não basta, ou ",
    "The envelope, on a stale config write":
      "O envelope, em uma escrita de configuração obsoleta",
    "Validation failures return 422 with":
      "Falhas de validação retornam 422 com",
    " and an": " e um array",
    " array of": " com objetos",
    " objects, one per invalid field. Errors raised outside the domain hierarchy are mapped onto the same envelope from the HTTP status, so the shape holds even for framework-level failures. Message prose can change between releases; the codes are the contract.":
      ", um por campo inválido. Erros lançados fora da hierarquia de domínio são projetados no mesmo envelope a partir do status HTTP, então a forma se mantém mesmo em falhas no nível do framework. A prosa das mensagens pode mudar entre versões; os códigos são o contrato.",
    "Frontend: feature modules, no orphans":
      "Frontend: módulos de funcionalidades, sem órfãos",
    "The React app lives in ": "O aplicativo React fica em ",
    ", with domain code colocated under ":
      ", com o código de domínio colocalizado sob ",
    ". A feature adds": ". Uma funcionalidade adiciona",
    " only as needed rather than carrying an empty fixed scaffold. Twenty-three modules exist today —":
      " somente quando necessário, em vez de manter uma estrutura fixa vazia. Hoje existem vinte e três módulos;",
    " is the largest because it owns the pipeline builder and runner overview; ":
      " é o maior porque reúne o construtor de pipelines e a visão geral dos Runners; ",
    " is next because it owns the board + drag-and-drop + card detail sheet.":
      " vem em seguida porque reúne o quadro, o recurso de arrastar e soltar e o painel de detalhes do cartão.",
    "There is no Redux. There is no Zustand for server state. React Query v5 is the uniform substrate. Shared domain query-key factories live in":
      "Não há Redux. Não há Zustand para estado do servidor. React Query v5 é a base uniforme. As fábricas compartilhadas de query keys do domínio ficam em",
    "; a few composed inbox and local file preview keys stay beside their callers. The AppShell renders the sidebar, topbar, outlet, and the floating ObserverPanel; workspace routing lives in a single":
      "; algumas keys compostas da caixa de entrada e da pré-visualização de arquivos locais permanecem junto a seus consumidores. O AppShell renderiza a barra lateral, a barra superior, o outlet e o ObserverPanel flutuante; o roteamento dos espaços de trabalho fica em um único",
    "MCP: the cross-LLM integration point":
      "MCP: o ponto de integração entre LLMs",
    "The Model Context Protocol is an Anthropic-led protocol that lets an LLM host — Claude Code, Claude Desktop, Cursor, Codex CLI, a custom Go runner — discover and call external tools over a negotiated capability surface. The Backplane MCP server wraps the backend REST API and exposes platform operations as MCP tools. Whatever an agent wants to do programmatically against Backplane — list cards, claim one, move it, create a note, request approval — it does via one of the MCP tools (the full tool census, drift-guarded in CI).":
      "O Model Context Protocol é um protocolo liderado pela Anthropic que permite a um host de LLM, como Claude Code, Claude Desktop, Cursor, Codex CLI ou um Runner Go personalizado, descobrir e chamar ferramentas externas por meio de uma superfície de recursos negociada. O servidor MCP do Backplane encapsula a API REST do backend e expõe operações da plataforma como ferramentas MCP. Tudo o que um agente quiser fazer de forma programática no Backplane, como listar cartões, assumir um deles, movê-lo, criar uma nota ou solicitar aprovação, é feito por uma das ferramentas MCP, cujo catálogo completo é protegido contra divergências no CI.",
    "Interactive hosts such as Claude Code and Codex, plus coding-agent sessions spawned by the Go runner, call the MCP server. Registered workflow prompts use their exact underscore handles, including":
      "Hosts interativos, como Claude Code e Codex, e sessões de agentes de código iniciadas pelo Runner Go chamam o servidor MCP. Os prompts de fluxo registrados usam seus identificadores exatos com sublinhado, incluindo",
    ", and ": ", e ",
    ", and": ", e",
    ". Tools proxy authenticated backend operations; prompts and resources add server-authored context without moving platform authority out of the backend.":
      ". As ferramentas atuam como proxy de operações autenticadas do backend; prompts e recursos adicionam contexto criado pelo servidor sem retirar a autoridade da plataforma do backend.",
    "Runner: the credentialed process": "Runner: o processo com credenciais",
    "The Go runner at ": "O Runner Go em ",
    " is a single static binary that an operator launches on their own hardware. Each process normally starts from one registered agent's config and bearer key. On startup it authenticates against the backend with":
      " é um único binário estático que um operador inicia no próprio hardware. Cada processo normalmente parte da configuração e da chave bearer de um agente registrado. Na inicialização, ele se autentica no backend com",
    ", fetches its platform pipeline config, optionally opens a workspace WebSocket, and enters a work loop that ticks every two minutes by default or wakes on matching WS events. Each stage may spawn the selected coding-agent driver —":
      ", busca a configuração de pipeline da plataforma, abre opcionalmente um WebSocket do espaço de trabalho e entra em um loop que roda a cada dois minutos por padrão ou desperta diante de eventos WS correspondentes. Cada etapa pode iniciar o driver de agente de código selecionado, seja",
    " or ": " ou ",
    ", including per-stage or tier routing — with a rendered prompt, the MCP tool allowlist, and the workspace context.":
      ", incluindo o roteamento por etapa ou tier, com um prompt renderizado, a allowlist de ferramentas MCP e o contexto do espaço de trabalho.",
    "The runner owns git directly: ": "O Runner controla git diretamente: ",
    " handles clone, checkout, commit, and push, while the configured GitHub or Gitea forge adapter handles pull requests and merge behavior. The coding agent edits files; the runner is the component responsible for the branch lifecycle.":
      " gerencia clone, checkout, commit e push, enquanto o adaptador configurado para GitHub ou Gitea gerencia pull requests e o comportamento de merge. O agente de código edita os arquivos; o Runner é o componente responsável pelo ciclo de vida da branch.",
    "One monorepo, ecosystem-specific locks":
      "Um monorepo, locks específicos por ecossistema",
    "All four surfaces live in the same tree. The root and frontend keep separate pnpm lockfiles; Go modules own their own dependencies; Python for the backend and the MCP server is managed via ":
      "As quatro superfícies vivem na mesma árvore. A raiz e o frontend mantêm lockfiles do pnpm separados; os módulos Go controlam suas próprias dependências; e o Python do backend e do servidor MCP é gerenciado por ",
    ". One place to": ". Um único lugar para",
    ". One place to diff across a schema change.":
      ". Um único lugar para comparar as alterações de uma mudança de schema.",
    "Monorepo layout (top two levels)":
      "Estrutura do monorepo, nos dois primeiros níveis",
    "Cross-surface refactors ship in one PR":
      "Refatorações entre superfícies são entregues em um único PR",
    "A rename that touches a Pydantic schema, a TypeScript interface, a Go struct, and an MCP tool signature is one commit with one CI run because the four surfaces share a tree. The drift guard in":
      "Uma renomeação que altera um schema Pydantic, uma interface TypeScript, uma struct Go e a assinatura de uma ferramenta MCP fica em um único commit, com uma única execução de CI, porque as quatro superfícies compartilham a mesma árvore. O controle de divergência em",
    " AST-parses tool and prompt decorators plus resource URIs, then fails CI when the frontend catalog disagrees. The frontend signature-parity test additionally checks every tool and prompt parameter in declaration order with exact requiredness. The first time you add a parameter and CI flags the reference before you remembered to update it, the monorepo pays for itself.":
      " analisa via AST os decorators de ferramentas e prompts, além das URIs de recursos, e faz o CI falhar quando o catálogo do frontend diverge. O teste de paridade de assinaturas do frontend também verifica todos os parâmetros de ferramentas e prompts, sua ordem de declaração e a obrigatoriedade exata. Na primeira vez em que você adicionar um parâmetro e o CI apontar a referência antes de você lembrar de atualizá-la, o monorepo terá provado seu valor.",
    "The rest of this group walks through the patterns that tie these four surfaces together: the event bus and WebSocket model, fractional indexing, idempotency, platform authority, and the model-agnostic future. None of them are incidental — they're the reason a retry-happy LLM operator doesn't set the platform on fire.":
      "O restante deste grupo apresenta os padrões que conectam essas quatro superfícies: o barramento de eventos e o modelo WebSocket, a indexação fracionária, a idempotência, a autoridade da plataforma e o futuro independente de modelo. Nenhum deles é acidental; são o motivo pelo qual um operador LLM propenso a tentativas repetidas não coloca a plataforma em risco.",
  },
  "event-bus-and-websocket-model": {
    "Every published mutation fans out through one event-bus interface.":
      "Toda mutação publicada é distribuída por uma única interface de barramento de eventos.",
    " keeps delivery in process;": " mantém a entrega dentro do processo;",
    " adds cross-instance fan-out via Postgres LISTEN/NOTIFY while preserving the same local subscribers. The backend's WebSocket router translates those into outbound frames for every connection subscribed to a matching pattern. A webhook subscriber drains the same bus for outbound HTTP fan-out. The frontend has a one-line React hook that turns a WS subscription into a React Query cache invalidation. The runner has a WS client that wakes its work loop on any matching event. This is the low-latency path across the four surfaces; the runner still keeps its scheduled poll as a fallback.":
      " adiciona distribuição entre instâncias via Postgres LISTEN/NOTIFY e preserva os mesmos assinantes locais. O router WebSocket do backend converte os eventos em frames para cada conexão inscrita. Um assinante de webhook consome o mesmo barramento para distribuição HTTP. O frontend invalida o cache do React Query com um hook e o Runner desperta seu loop diante de eventos correspondentes. Esse é o caminho de baixa latência entre as quatro superfícies; o Runner mantém a consulta programada como alternativa.",
    "The local bus and the Postgres adapter":
      "O barramento local e o adaptador Postgres",
    " lives at": " fica em",
    ". It is a subscribe / publish ring backed by a list of":
      ". É um circuito de subscribe/publish sustentado por uma lista de",
    " tuples. Subscriptions can be workspace-scoped or global. Patterns are shell globs — ":
      " tuplas. As inscrições podem ter escopo de espaço de trabalho ou ser globais. Os padrões são globs de shell, como ",
    " — so fine-grained filtering is declarative, not procedural. Publish is fan-out via":
      "; assim, a filtragem detalhada é declarativa, não procedural. A publicação é distribuída por meio de",
    ". Subscriber errors are logged but never raised back to the publisher. The":
      ". Erros dos assinantes são registrados, mas nunca propagados de volta ao publicador. A subclasse",
    " subclass dispatches locally, sends a NOTIFY on ":
      " distribui localmente, envia um NOTIFY por ",
    ", and re-injects LISTEN messages from other instances without echoing them back. A single module-level":
      ", e reinsere mensagens LISTEN de outras instâncias sem retransmiti-las. Um único singleton",
    " singleton is shared by the direct publishers.":
      " no nível do módulo é compartilhado pelos publicadores diretos.",
    "activity.{entity}.{action} fan-out":
      "Distribuição de activity.{entity}.{action}",
    " is the cross-cutting mutation recorder. Services use it for audited entity mutations. The method writes the activity row to the database, then unconditionally publishes ":
      " é o registrador transversal de mutações. Os services o usam para mutações auditadas de entidades. O método grava a linha de atividade no banco de dados e então publica, sem condição, ",
    " on the bus — ": " no barramento, como ",
    ", and so on. Agent lifecycle now also records ":
      ", entre outros. O ciclo de vida dos agentes agora também registra ",
    " and": " e",
    ", and ": ", e ",
    ". Adding a new pair needs no per-event constant because the event name derives from the":
      ". Adicionar um novo par não exige uma constante por evento; os enums ",
    " and ": " e ",
    "enums.": " definem o nome.",
    "Service-specific events that are not activity-shaped —":
      "Eventos específicos de um service que não seguem o formato de atividade, como ",
    " — publish directly from their owning services. Most constants live in":
      ", são publicados diretamente pelos services responsáveis. A maioria das constantes fica em",
    "; merge-queue and notification names live beside their publishers.":
      "; os nomes da fila de merge e das notificações ficam junto a seus publicadores.",
    "Bridge events: deprecated but still emitting":
      "Eventos de transição: obsoletos, mas ainda emitidos",
    "A small map — ": "Um pequeno mapa, com ",
    " — publishes in parallel with the":
      ", publica em paralelo com o evento equivalente em",
    " twin. These are bridge events kept for backward compatibility. The source is explicitly commented":
      ". Esses eventos de transição são mantidos para compatibilidade retroativa. O código-fonte contém explicitamente o comentário",
    "\"deprecated, do not extend\"": "\"deprecated, do not extend\"",
    ". New consumers should subscribe to the ":
      ". Novos consumidores devem se inscrever no namespace ",
    " namespace; the bridge is what exists so pre-M-Observability consumers keep working while they migrate. The bridge map in ":
      "; a transição existe para que consumidores anteriores ao M-Observability continuem funcionando durante a migração. O mapa de transição em ",
    " is the sunset list — removing it requires confirming no live consumer depends on the old name.":
      " é a lista de desativação; removê-lo exige confirmar que nenhum consumidor ativo depende do nome antigo.",
    "The WebSocket subscribe protocol": "O protocolo de inscrição WebSocket",
    "A WebSocket client connects to": "Um cliente WebSocket se conecta a",
    " with an API key in ": " com uma API key em ",
    ", a signed browser session, or an IAP/trusted-proxy identity. The legacy ":
      ", uma sessão assinada do navegador ou uma identidade IAP/trusted proxy. O fallback legado ",
    "fallback is still accepted, but the runner uses the header so secrets do not land in access logs. On accept, the connection is registered with the ":
      " continua aceito, mas o Runner usa o header para que secrets não apareçam nos logs de acesso. Depois de aceita, a conexão é registrada no ",
    ", which holds live socket handles and bridges bus events to them. The client then sends":
      ", que mantém os handles dos sockets ativos e encaminha a eles os eventos do barramento. Em seguida, o cliente envia",
    ". The connection manager re-subscribes on every such frame: each pattern becomes one ":
      ". O gerenciador de conexões refaz as inscrições a cada frame desse tipo: cada padrão se torna uma inscrição no ",
    " subscription whose callback serializes the event as JSON and sends it over the socket.":
      " cujo callback serializa o evento como JSON e o envia pelo socket.",
    "Heartbeats flow both ways. The server sends":
      "Heartbeats circulam nas duas direções. O servidor envia",
    " every": " a cada",
    " seconds; runners additionally push ":
      " segundos; além disso, os Runners enviam frames ",
    " frames carrying CPU, memory, card counts, and current board to keep the backend's live runner view fresh.":
      " com CPU, memória, contagem de cartões e quadro atual para manter atualizada a visão ao vivo dos Runners no backend.",
    "Timing mitigations are load-bearing, not decorative":
      "As mitigações de timing são essenciais, não decorativas",
    "There is no event replay between connect and subscribe. An event published in the window between ":
      "Não há replay de eventos entre a conexão e a inscrição. Um evento publicado no intervalo entre ",
    " and the first": " e o primeiro frame",
    " frame is lost to that client. The mitigations for subscribe timing are stacked for a reason. The transport":
      " é perdido para esse cliente. As mitigações do timing de inscrição são combinadas por um motivo. O transporte",
    ") carries a stale-connection guard that checks ":
      ") inclui uma proteção contra conexões obsoletas que verifica ",
    " on every callback — defence against React StrictMode's double-mount race where the stale socket's ":
      " em cada callback. Isso protege contra a corrida de montagem dupla do React StrictMode, na qual o ",
    " would otherwise flip state belonging to the newer connection. The provider":
      " do socket obsoleto alteraria um estado pertencente à conexão mais nova. O provider",
    ") holds a": ") mantém um contador de estado ",
    " state counter that invalidates every memoized ":
      " que invalida cada closure memoizada de ",
    " closure when a new service is created, so children subscribing ":
      " quando um novo service é criado, para que componentes filhos que se inscrevem ",
    "before": "antes",
    " the provider's effect ran don't hold a null service ref. Subscribe frames are re-sent on reconnect and on every new pattern registration — the server does not remember patterns across connections.":
      " da execução do efeito do provider não mantenham uma referência nula ao service. Os frames de inscrição são reenviados após uma reconexão e a cada registro de um novo padrão; o servidor não memoriza padrões entre conexões.",
    "useDomainSync: the one-line bridge":
      "useDomainSync: a ponte de uma linha",
    "Every React Query hook that wants live sync gets it with a single line. ":
      "Todo hook do React Query que precisa de sincronização ao vivo a obtém com uma única linha. ",
    "subscribes to ": "se inscreve em ",
    ", debounces for 250ms by default (to coalesce bursts during a drag operation), and invalidates the query key. No manual subscribe / unsubscribe lifecycle. No cache mutation logic. The WS stream invalidates; React Query refetches; the UI re-renders.":
      ", aplica debounce padrão de 250 ms para agrupar rajadas durante uma operação de arrastar e invalida a query key. Não há ciclo manual de subscribe/unsubscribe nem lógica de mutação do cache. O fluxo WS invalida, o React Query busca novamente e a interface renderiza de novo.",
    "useDomainSync — shared live-sync hook across the frontend":
      "useDomainSync: hook compartilhado de sincronização em tempo real no frontend",
    "Optimistic mutations (card move, card create, column reorder) snapshot the cache, mutate locally, rollback on error, and":
      "Mutações otimistas, como mover ou criar um cartão e reordenar colunas, salvam um snapshot do cache, alteram o estado localmente, fazem rollback em caso de erro e usam",
    " on the same key re-confirms or corrects the optimistic state once the backend commits. Two hooks on the same key — one optimistic, one WS-backed — compose cleanly because both fall through to the same React Query key.":
      " na mesma chave para reconfirmar ou corrigir o estado otimista após o commit do backend. Dois hooks na mesma chave, um otimista e outro sustentado por WS, combinam sem conflito porque ambos convergem para a mesma chave do React Query.",
    "The runner uses the same bus": "O Runner usa o mesmo barramento",
    "The Go runner connects to the same WebSocket endpoint with its API key and subscribes to ":
      "O Runner Go se conecta ao mesmo endpoint WebSocket com sua API key e se inscreve em ",
    ", and": ", e",
    ", plus ": ", além de ",
    ". Any matching event wakes": ". Qualquer evento correspondente desperta",
    ", short-circuiting the default two-minute poll interval. Approval waits are implemented as a subscribe-and-block on a specific approval ID — the runner does not poll for decisions, it sleeps on the WS event and wakes on":
      ", interrompendo o intervalo padrão de polling de dois minutos. A espera por aprovações é implementada como inscrição e bloqueio em um ID de aprovação específico; o Runner não consulta decisões por polling, ele aguarda o evento WS e desperta com",
    "The runner drops any event whose ":
      "O Runner descarta qualquer evento cujo ",
    " or": " ou",
    " matches itself, to avoid self-trigger loops. The exception is ":
      " corresponda a ele próprio, evitando loops de autoacionamento. A exceção é ",
    ", which carries ": ", que carrega ",
    " and is the one event a runner should act on only when addressed specifically.":
      " e é o único evento sobre o qual um Runner deve agir apenas quando for endereçado especificamente a ele.",
    "Cross-instance delivery is not durable delivery":
      "Entrega entre instâncias não é entrega durável",
    "The memory backend is correct only for one instance: a publish reaches local subscribers and nowhere else. The Postgres backend closes that multi-instance visibility gap with LISTEN/NOTIFY, including automatic LISTEN reconnects and thin payloads above Postgres's notification size limit. It is still at-most-once and has no replay. A process failure, full receive queue, or NOTIFY outage can drop cross-instance delivery; local delivery has already happened. Webhooks intentionally ignore remote copies so only the originating instance sends external HTTP. Durable or financially consequential workflows need persisted state, not this notification bus.":
      "O backend memory só é correto para uma instância: uma publicação chega aos assinantes locais e a nenhum outro lugar. O Postgres fecha essa lacuna com LISTEN/NOTIFY, reconexão automática e payloads reduzidos acima do limite de notificação. A entrega continua sendo no máximo uma vez e sem replay. Uma falha de processo, uma fila cheia ou uma indisponibilidade de NOTIFY pode perder a entrega entre instâncias; a entrega local já aconteceu. Webhooks ignoram intencionalmente as cópias remotas para que apenas a instância de origem envie HTTP externo. Fluxos duráveis ou com consequências financeiras precisam de estado persistido, não deste barramento.",
    "The event taxonomy itself is documented at":
      "A taxonomia de eventos está documentada em",
    " with every live event, its publishers, its subscribers, and its payload shape. Adding a new event is a three-step process — pick an ":
      " com cada evento ativo, seus publicadores, seus assinantes e o formato do payload. Adicionar um evento novo exige três etapas: escolher um nome ",
    " name if the mutation is CRUD-shaped, otherwise define a constant in":
      " se a mutação seguir o formato CRUD; caso contrário, definir uma constante em",
    ", publish it from the owning service, and register a frontend consumer. The taxonomy doc is the single authoritative reference for what's on the wire.":
      ", publicá-la pelo service responsável e registrar um consumidor no frontend. O documento de taxonomia é a única referência oficial do que circula pela rede.",
  },
  "fractional-indexing": {
    "Columns and cards do not use an integer ":
      "Colunas e cartões não usam uma coluna inteira ",
    " column. They use a ": " como ordenação. Eles usam uma ",
    ". A new item gets": ". Um item novo recebe",
    ". Moves compute the midpoint between neighbors. Reordering a card never touches any other row's position — the drag-drop-commit is one ":
      ". Os movimentos calculam o ponto médio entre os vizinhos. Reordenar um cartão nunca altera a posição de nenhuma outra linha; a operação de arrastar, soltar e confirmar se resume a um único ",
    " on one row, regardless of how many cards sit above or below.":
      " em uma única linha, independentemente de quantos cartões estejam acima ou abaixo.",
    "The algorithm is trivial. The payoff is not: no O(N) reorder updates, no integer renumbering, no write contention when two users drag simultaneously, no drift when an optimistic update collides with a WebSocket-delivered event from another client. The frontend computes positions; the backend just stores the float.":
      "O algoritmo é trivial, mas o benefício não: não há atualizações O(N) para reordenar, renumeração de inteiros, contenção de escrita quando dois usuários arrastam simultaneamente nem divergência quando uma atualização otimista coincide com um evento entregue por WebSocket de outro cliente. O frontend calcula as posições; o backend apenas armazena o valor de ponto flutuante.",
    "Why this beats integer renumbering":
      "Por que isso supera a renumeração de inteiros",
    "The naive alternative is a monotonically-increasing integer per column, re-numbered whenever a card moves into position":
      "A alternativa ingênua é usar um inteiro crescente em cada coluna e renumerá-lo sempre que um cartão se move para a posição",
    ". That implementation has three failure modes. The first is write amplification — dropping a card to the top of a column with 50 cards rewrites 51 rows. The second is lock contention — two concurrent drags in the same column serialize into a ladder of ":
      ". Essa implementação tem três modos de falha. O primeiro é a amplificação de escrita: soltar um cartão no topo de uma coluna com 50 cartões reescreve 51 linhas. O segundo é a contenção de locks: dois movimentos simultâneos na mesma coluna são serializados em uma sequência de instruções ",
    " statements because each one needs row locks on every card after the insertion point. The third is the ugliest: with optimistic updates, the client's provisional ordering and the server's canonical ordering diverge during the race window, and reconciliation requires either a transactional snapshot or a cache-patch protocol that every consumer has to respect.":
      ", pois cada um precisa bloquear as linhas de todos os cartões depois do ponto de inserção. O terceiro é o mais problemático: com atualizações otimistas, a ordenação provisória do cliente e a ordenação canônica do servidor divergem durante a janela de corrida, e a reconciliação exige um snapshot transacional ou um protocolo de atualização do cache que todos os consumidores precisam respeitar.",
    "Fractional indexing makes all three disappear. A move is one row, one write. Concurrent moves commute — two operators dropping two different cards at two different midpoints do not touch each other's positions. Optimistic updates reconcile for free because the client's computed midpoint is the same value the server persists, so the WebSocket confirmation is a no-op rather than a patch.":
      "A indexação fracionária elimina os três problemas. Um movimento corresponde a uma linha e uma escrita. Movimentos simultâneos comutam: dois operadores que soltam cartões diferentes em pontos médios diferentes não alteram as posições um do outro. As atualizações otimistas são reconciliadas sem custo adicional porque o ponto médio calculado pelo cliente é o mesmo valor persistido pelo servidor; assim, a confirmação por WebSocket é um no-op, e não uma correção.",
    "The algorithm": "O algoritmo",
    "Six lines of pure math, living at":
      "Seis linhas de matemática pura, localizadas em ",
    " on the frontend and mirrored at ":
      " no frontend e reproduzidas em ",
    " on the backend for the new-item case. New items go to":
      " no backend para o caso de um item novo. Itens novos recebem ",
    " so sequential appends give numerically spaced positions. Moves take the midpoint of the neighbors on either side of the drop target.":
      " para que inserções sequenciais gerem posições numericamente espaçadas. Os movimentos usam o ponto médio entre os vizinhos de cada lado do destino.",
    "calculatePosition — the whole algorithm":
      "calculatePosition: o algoritmo completo",
    "The backend has one short-circuit worth knowing about: when a move's new position is within 1.0 of the current position, the service treats it as a no-op. This matters because":
      "O backend tem um atalho importante: quando a nova posição de um movimento fica a menos de 1,0 da posição atual, o service o trata como no-op. Isso importa porque o ",
    " occasionally re-fires the move event on drag-end when the pointer has barely moved, and the short-circuit prevents that from thrashing the bus with a meaningless":
      " ocasionalmente dispara novamente o evento de movimento ao encerrar a ação de arrastar, mesmo quando o ponteiro quase não se moveu, e o atalho evita sobrecarregar o barramento com um evento ",
    " event.": " sem significado.",
    "Where it lives in the code": "Onde isso fica no código",
    "The ": "A coluna ",
    " column is a ": " é do tipo ",
    " on both the ": " nos models ",
    " and ": " e ",
    " models. The backend never recomputes positions — it accepts whatever float the client sends, validated against the column's existing positions to ensure it isn't a duplicate within a two-decimal tolerance. Fractional columns need the same treatment: column reordering in the board detail uses the same ":
      ". O backend nunca recalcula as posições: ele aceita o valor de ponto flutuante enviado pelo cliente e o valida em relação às posições existentes na coluna para garantir que não haja duplicidade dentro de uma tolerância de duas casas decimais. As colunas fracionárias precisam do mesmo tratamento: a reordenação de colunas nos detalhes do quadro usa o mesmo helper ",
    "helper against a column-scoped neighbor pair.":
      " com um par de vizinhos limitado à coluna.",
    "Drop-target detection on the frontend uses a three-stage fallback chain from ":
      "A detecção do destino no frontend usa uma cadeia de fallback de três etapas do ",
    " first, then": " primeiro, depois ",
    ", then ": ", e por fim ",
    "restricted to columns. The fallback chain exists because the single-detector shortcuts miss edge cases when a card is dragged over a mostly-empty column (pointer is inside the column but not inside any card's rect). Pairing the fallback chain with fractional indexing gives the UI a feel that is indistinguishable from a desktop kanban app even when two operators are dragging in the same column at the same time.":
      " restrito às colunas. A cadeia de fallback existe porque os atalhos com um único detector não cobrem casos extremos em que um cartão é arrastado sobre uma coluna quase vazia, com o ponteiro dentro da coluna, mas fora do retângulo de qualquer cartão. Combinar essa cadeia com a indexação fracionária faz a interface responder como um aplicativo kanban nativo para desktop, mesmo quando dois operadores arrastam cartões na mesma coluna ao mesmo tempo.",
    "The worst-case precision story": "O pior caso da precisão",
    "IEEE-754 double-precision floats have finite precision. Every midpoint halves the gap between neighbors. In theory, repeatedly dropping a card between two adjacent cards produces a sequence of positions that trend toward a single representable float, after which the midpoint equals one of the neighbors and the tie-break is arbitrary.":
      "Valores de ponto flutuante IEEE-754 de precisão dupla têm precisão finita. Cada ponto médio reduz pela metade a distância entre os vizinhos. Em teoria, soltar repetidamente um cartão entre dois cartões adjacentes produz uma sequência de posições que converge para um único valor representável; depois disso, o ponto médio se iguala a um dos vizinhos e o desempate se torna arbitrário.",
    "In practice, the exponent range gives you on the order of 2":
      "Na prática, o intervalo do expoente oferece cerca de 2",
    "bits of mantissa, which is many more bisections than any realistic kanban workload will perform between the same two cards. We have not seen a precision collision in production and the instrumentation that would catch one — a unique constraint per column on the position column — does not exist today. The mitigation, if we ever needed one, is a column-scoped rebalance that rewrites every position as ":
      "bits de mantissa, o que permite muito mais bisseções do que qualquer carga realista de um kanban faria entre os mesmos dois cartões. Não observamos colisões de precisão em produção, e a instrumentação que detectaria uma delas, uma restrição única por coluna sobre a coluna de posição, não existe hoje. A mitigação, caso algum dia seja necessária, é um rebalanceamento limitado à coluna que reescreva cada posição como ",
    " once precision has meaningfully degraded. That code does not exist yet because the degradation does not exist yet.":
      " quando a precisão tiver se degradado de forma relevante. Esse código ainda não existe porque essa degradação ainda não ocorreu.",
    "Fractional indexing is not rebalance-free forever":
      "A indexação fracionária não dispensa rebalanceamento para sempre",
    "The algorithm is not a perpetual-motion machine. It spreads the amortized cost of reordering across many operations instead of doing one expensive renumber up front, and the constant factors make it feel free — but the worst case is real. A workload that repeatedly drops a card into the same gap will eventually run out of float precision and need a rebalance pass. We have not built that pass because we have not needed it. If you find yourself looking at identical":
      "O algoritmo não é uma máquina de movimento perpétuo. Ele distribui o custo amortizado da reordenação entre muitas operações, em vez de fazer uma renumeração cara de uma só vez, e os fatores constantes fazem com que pareça gratuito; porém, o pior caso é real. Uma carga que solta repetidamente um cartão no mesmo intervalo acabará esgotando a precisão de ponto flutuante e exigirá uma etapa de rebalanceamento. Ainda não criamos essa etapa porque ela não foi necessária. Se você encontrar valores ",
    " values on two different cards in the same column, that is the signal.":
      " idênticos em dois cartões diferentes da mesma coluna, esse é o sinal.",
    "Fractional indexing is one of those design choices that is load bearing in a way that only becomes obvious when you try to imagine the integer-ordered version. Two operators moving cards on the same board at the same time with optimistic updates and real-time WS reconciliation would not survive the naive approach. The six-line function in ":
      "A indexação fracionária é uma daquelas decisões de design essenciais cujo peso só fica evidente ao imaginar a versão ordenada por inteiros. Dois operadores movendo cartões no mesmo quadro ao mesmo tempo, com atualizações otimistas e reconciliação por WS em tempo real, não funcionariam de forma confiável com a abordagem ingênua. A função de seis linhas em ",
    " is what makes the kanban surface tolerate concurrent human and runner drag-drop traffic without gymnastics at any other layer.":
      " é o que permite à superfície kanban tolerar ações simultâneas de arrastar e soltar feitas por humanos e Runners sem exigir soluções complexas em nenhuma outra camada.",
  },
  idempotency: {
    "Create and add endpoints return the existing entity on duplicate instead of raising ":
      "Endpoints de criação e adição retornam a entidade existente em caso de duplicidade, em vez de gerar ",
    ". This is a correctness invariant, not a nicety. LLM retries, multi-role pipeline ticks, and frontend double-clicks all depend on it. An \"already exists\" result is a success, not an error — the requested end state is reached, regardless of how many times the request arrived.":
      ". Isso é uma garantia de correção, não uma conveniência. As novas tentativas dos LLMs, os ciclos de pipelines com várias funções e os cliques duplos no frontend dependem dela. Um resultado de \"já existe\" é um sucesso, não um erro: o estado final solicitado foi alcançado, independentemente de quantas vezes a requisição chegou.",
    "This principle is one of the things the platform gets asked about most by engineers who haven't spent time inside the system. It looks like a REST convention violation. It is not. When the primary operator of your API is a retry-happy LLM that will re-issue a request on any transient failure — network timeout, rate limit, partial response truncation — a 409 on the second call costs a tick and a token bill with no added information. The request succeeded the first time. The only correct behavior is to acknowledge the successful state.":
      "Esse princípio é um dos temas sobre os quais engenheiros que ainda não conhecem o sistema mais perguntam. Ele pode parecer uma violação das convenções REST, mas não é. Quando o principal operador da API é um LLM propenso a repetir uma requisição diante de qualquer falha transitória, como timeout de rede, rate limit ou resposta truncada, um 409 na segunda chamada consome um ciclo e gera custo de tokens sem acrescentar informação. A primeira requisição funcionou. O único comportamento correto é reconhecer o estado bem-sucedido.",
    "The pattern": "O padrão",
    "Every idempotent create in the service layer follows the same shape. Check for the existing entity by its business-unique key. If present, return it. Otherwise create, return the new row. One round-trip to the database in the hit case, two in the miss case. No 409 branch, no retry coordination needed at the caller.":
      "Toda criação idempotente na camada de service segue o mesmo formato. Primeiro, procura a entidade existente por sua chave de negócio única. Se ela existir, retorna essa entidade. Caso contrário, cria e retorna a nova linha. É uma ida ao banco de dados quando a entidade é encontrada e duas quando não é. Não há ramificação para 409 nem necessidade de coordenar novas tentativas no cliente.",
    "The idempotent-create pattern, canonical shape":
      "O formato canônico do padrão de criação idempotente",
    "Where the pattern is applied": "Onde o padrão é aplicado",
    "Every mutation where \"this already exists\" can be spelled as success gets the idempotent treatment. The list is specific, not aspirational:":
      "Toda mutação em que \"isso já existe\" pode ser interpretado como sucesso recebe tratamento idempotente. A lista é concreta, não apenas uma aspiração:",
    "Workspace create.": "Criação de espaço de trabalho.",
    " — idempotent on slug for members of the existing workspace, who get it back unchanged. A non-member colliding on a taken slug gets an opaque 409 that leaks no workspace metadata.":
      ": idempotente por slug para membros do espaço de trabalho existente, que o recebem de volta sem alterações. Quem não é membro e colide com um slug ocupado recebe um 409 opaco que não vaza nenhum metadado do espaço de trabalho.",
    "Board create.": "Criação de quadro.",
    " — idempotent on": ": idempotente por ",
    "Card create via slug.": "Criação de cartão por slug.",
    " Cards posted with an explicit slug reconcile against the existing row if present.":
      " Cartões enviados com um slug explícito são reconciliados com a linha existente, quando houver.",
    "Add participant.": "Adição de participante.",
    " — returns the card unchanged if the user is already a participant in that role.":
      ": retorna o cartão sem alterações se o usuário já participa com essa função.",
    "Add workspace member.": "Adição de membro ao espaço de trabalho.",
    " — returns the existing membership on duplicate.":
      ": retorna a associação existente em caso de duplicidade.",
    "Create team.": "Criação de equipe.",
    " — idempotent on slug within the workspace.":
      ": idempotente por slug dentro do espaço de trabalho.",
    "Add team member.": "Adição de membro à equipe.",
    " Repeating an add overwrites the role list rather than conflicting.":
      " Repetir a adição sobrescreve a lista de funções, em vez de gerar conflito.",
    "Create prompt config.": "Criação de configuração de prompt.",
    " — idempotent on the full scope tuple":
      ": idempotente pela tupla completa de escopo ",
    "Agent registration.": "Registro de Agente.",
    ". Also reactivates soft-deleted runners.":
      ". Também reativa Runners excluídos logicamente.",
    "Where it is deliberately not idempotent":
      "Onde a idempotência é deliberadamente evitada",
    "Three mutations refuse the idempotent treatment because the second caller is reporting a visible race that should fail loudly, not quietly.":
      "Três mutações não recebem tratamento idempotente porque a segunda chamada revela uma condição de corrida visível que deve falhar de forma explícita, não silenciosa.",
    "Claim card.": "Assumir cartão.",
    " issues": " executa ",
    ", refuses the claim if a hero participant already exists, returns":
      ", recusa a atribuição se já existir um participante responsável principal e retorna ",
    ". A second claim is two runners racing for the same card — the loser needs to know it lost, not silently believe it won.":
      ". Uma segunda tentativa de assumir o cartão significa que dois Runners estão disputando o mesmo cartão; quem perder precisa saber que perdeu, e não acreditar silenciosamente que venceu.",
    "Hero reassign via add_participant.":
      "Reatribuição do responsável principal por add_participant.",
    " Adding a non-hero participant to a card with an existing hero is fine. Adding a ":
      " É permitido adicionar um participante que não seja o responsável principal a um cartão que já tenha um. Adicionar outro ",
    hero: "responsável principal",
    " to a card that already has a different hero returns ":
      " a um cartão que já tem um responsável principal diferente retorna ",
    ". Silently re-hosting the card would break every downstream consumer reading ":
      ". Trocar silenciosamente o responsável pelo cartão quebraria todos os consumidores posteriores que leem ",
    "Approval decide.": "Decisão de aprovação.",
    " — re-deciding a non-pending approval returns 409. The terminal state transitions":
      ": tentar decidir novamente uma aprovação que não esteja pendente retorna 409. As transições para estados finais ",
    ") are one-way. A second decision means two humans both thought they were the decider and one of them needs to see the original verdict.":
      ") são unidirecionais. Uma segunda decisão significa que duas pessoas acreditavam ser responsáveis por decidir, e uma delas precisa ver o veredito original.",
    "The incident that anchored the rule":
      "O incidente que fundamentou a regra",
    "The idempotency principle has a specific origin: ST#3. A reviewer role was getting ":
      "O princípio de idempotência tem uma origem específica: ST#3. Uma função de revisão recebia ",
    " on re-adding itself as a card participant from a subsequent pipeline tick. Each 409 ate a tick. Across a full smoke run, the reviewer burned tokens to repeatedly rediscover that it was already on the card. The fix was not \"add better retry logic at the caller\" — the caller is an LLM, it already retries. The fix was \"return the existing participant with a 200.\" Three hundred lines of runner-side retry coordination dissolved.":
      " ao se adicionar novamente como participante de um cartão em um ciclo posterior do pipeline. Cada 409 consumia um ciclo. Durante uma execução completa de smoke test, a função de revisão gastava tokens para redescobrir repetidamente que já estava no cartão. A correção não foi \"adicionar uma lógica melhor de novas tentativas no cliente\"; o cliente é um LLM e já faz novas tentativas. A correção foi \"retornar o participante existente com 200\". Trezentas linhas de coordenação de novas tentativas no Runner deixaram de ser necessárias.",
    "Every idempotent endpoint since ST#3 has been written with that incident in mind. When a design review asks \"should this 409 or return the existing row?\" the answer is almost always the latter, and when it is the former — claim, hero reassign, approval decide — the reason is articulated in the service method's docstring.":
      "Desde ST#3, todo endpoint idempotente é escrito tendo esse incidente em mente. Quando uma revisão de design pergunta \"isso deve retornar 409 ou a linha existente?\", a resposta quase sempre é a segunda opção. Quando é a primeira, nos casos de assumir o cartão, reatribuir o responsável principal ou decidir uma aprovação, o motivo é explicado na docstring do método do service.",
    "A few stragglers are on cleanup":
      "Alguns casos remanescentes estão sendo corrigidos",
    "Not every mutation the platform ships today honors the rule. Audit findings surface the occasional service path that still raises 409 when the caller would be better served by the existing row. ":
      "Nem toda mutação disponível hoje na plataforma segue essa regra. As auditorias ocasionalmente identificam um caminho de service que ainda gera 409 quando seria melhor retornar a linha existente ao cliente. ",
    " on the MCP side, specifically, does a pre-GET to detect duplicates rather than leaning on the backend contract — which is deliberately member-scoped: a member retrying a taken slug gets the existing workspace back, while a stranger gets an opaque 409 so slug collisions cannot harvest workspace metadata. Every new endpoint review includes the \"is this idempotent, or is there a principled reason it isn't?\" question on the checklist. Ask us how we know.":
      " no lado MCP, especificamente, faz um pre-GET para detectar duplicidades em vez de se apoiar no contrato do backend, que é deliberadamente restrito a membros: um membro que repete a tentativa com um slug ocupado recebe de volta o espaço de trabalho existente, enquanto um desconhecido recebe um 409 opaco para que colisões de slug não sirvam para colher metadados de espaços de trabalho. Toda revisão de um endpoint novo inclui no checklist a pergunta \"isso é idempotente ou existe um motivo fundamentado para não ser?\". Sabemos por experiência.",
    "What this buys you": "O que isso oferece",
    "The observable effect of this rule is that an LLM retry loop does not compound. When a runner re-issues the same":
      "O efeito observável dessa regra é que um loop de novas tentativas de um LLM não se multiplica. Quando um Runner repete a mesma operação ",
    " from four pipeline stages — because each stage independently decides it needs to be on the card — the cost is four cheap 200s instead of three 409s followed by bespoke error handling. When the frontend double-posts a card create because a user double-clicked the button, the second post returns the first card's row and the UI renders a single card rather than an error toast. When a webhook redelivery fires the same":
      " a partir de quatro etapas do pipeline, porque cada etapa decide de forma independente que precisa estar no cartão, o custo é de quatro respostas 200 baratas, em vez de três respostas 409 seguidas de tratamento de erro específico. Quando o frontend envia duas vezes a criação de um cartão porque o usuário clicou duas vezes no botão, o segundo envio retorna a linha do primeiro cartão e a interface renderiza um único cartão, em vez de uma notificação de erro. Quando a reentrega de um webhook dispara duas vezes a mesma operação ",
    " twice, the team exists exactly once.":
      ", a equipe existe exatamente uma vez.",
    "None of these are large individually. Multiplied across every mutation an agentic platform executes, they are the difference between a system that tolerates its operators and one that fights them.":
      "Nenhum desses casos é relevante isoladamente. Multiplicados por todas as mutações executadas por uma plataforma agêntica, eles representam a diferença entre um sistema que tolera seus operadores e outro que trabalha contra eles.",
  },
  "platform-authority-principle": {
    "The backend is the single source of truth for pipeline shape and prompts. The runner fetches both at startup and refuses to start when the backend hasn't authored them. The runner does not carry a compiled-in default pipeline that runs when the platform is silent. The platform owns identity and behavior; the runner owns execution.":
      "O backend é a única fonte de verdade sobre a estrutura do pipeline e os prompts. O Runner busca ambos ao iniciar e se recusa a executar quando eles não foram definidos no backend. O Runner não inclui um pipeline padrão compilado que entra em funcionamento quando a plataforma não fornece uma configuração. A plataforma controla identidade e comportamento; o Runner controla a execução.",
    "This is the hardest principle to appreciate from outside the system, because it looks like an overreaction. \"Why not just let the runner default to a sensible pipeline if the platform returns nothing?\" That question has a specific answer grounded in a specific incident, and it is worth stating it plainly: defaults at the client level hide platform bugs. Defaults at the platform level are legitimate. The distinction is load-bearing.":
      "Esse é o princípio mais difícil de compreender de fora do sistema, pois pode parecer uma reação exagerada. \"Por que não deixar o Runner usar um pipeline padrão razoável quando a plataforma não retorna nada?\" Essa pergunta tem uma resposta específica, fundamentada em um incidente concreto: valores padrão no cliente ocultam falhas da plataforma. Valores padrão definidos na plataforma são legítimos. Essa distinção é essencial.",
    "What this means in practice": "O que isso significa na prática",
    "On every boot, the Go runner calls":
      "A cada inicialização, o Runner Go chama ",
    ". The response is expected to carry a non-empty ":
      ". A resposta deve conter um ",
    " with a non-empty ": " não vazio, com um array ",
    " array. If either is missing, the runner logs a clear error and exits — it does not fall back to a built-in pipeline, it does not pick a reasonable default, it refuses to operate. On every tick, the runner re-fetches the config and re-applies platform authority: roles whose prompts have been removed are dropped from the live scheduler without a restart. Authoring a new prompt in the UI restores the role on the next refresh.":
      " não vazio. Se qualquer um deles estiver ausente, o Runner registra um erro claro e encerra: não recorre a um pipeline incorporado, não escolhe um padrão considerado razoável e se recusa a operar. A cada ciclo, o Runner busca novamente a configuração e reaplica a autoridade da plataforma. Funções cujos prompts foram removidos deixam o scheduler ativo sem exigir reinicialização. Criar um novo prompt na interface restaura a função na próxima atualização.",
    "Prompts follow the same rule. Every stage declares its prompt source from the platform's prompt registry, synthesis layer, or an operator-authored override. The runner prefers":
      "Os prompts seguem a mesma regra. Cada etapa declara sua fonte de prompt no registro de prompts da plataforma, na camada de síntese ou em uma substituição criada pelo operador. O Runner prioriza ",
    " (backend-assembled, with the post-process imperative spliced in) over raw":
      ", montado pelo backend com a instrução imperativa de pós-processamento inserida, em vez do ",
    " — so operator edits on synthesized placeholders retain the platform-owned imperative text. A stage with no prompt in the cache returns":
      " bruto. Assim, edições do operador em placeholders sintetizados preservam o texto imperativo controlado pela plataforma. Uma etapa sem prompt no cache retorna ",
    " rather than executing against a compiled-in template.":
      " em vez de executar com um template compilado.",
    "The ST#8 anchor incident": "O incidente de referência ST#8",
    "The principle has an origin. ST#8 silently shipped a three-role hardcoded pipeline over a five-role platform pipeline. The backend was configured correctly. The runner ignored it, because the runner carried a compiled-in default that won the race when the authoritative fetch was slower than the first tick of the scheduler. Operators saw the three-role behavior and assumed the platform was misconfigured. The platform was not misconfigured. The runner was.":
      "O princípio tem uma origem. No ST#8, um pipeline fixo com três funções foi executado silenciosamente no lugar do pipeline de cinco funções definido na plataforma. O backend estava configurado corretamente. O Runner o ignorou porque incluía um padrão compilado que venceu a corrida quando a busca da configuração oficial demorou mais do que o primeiro ciclo do scheduler. Os operadores viram o comportamento com três funções e presumiram que a plataforma estava configurada incorretamente. A plataforma não estava. O Runner estava.",
    "The fix was not \"add better defaults.\" The fix was \"refuse to operate on stale authority.\" The runner now blocks startup on the platform config, and the scheduler re-applies platform authority every tick. The compiled-in defaults that won ST#8 are being removed one by one. The principle is what the fix crystallized: defaults and fallbacks are legitimate at the platform level; they are a bug at the client level.":
      "A correção não foi \"adicionar padrões melhores\". Foi \"recusar a operação com uma fonte de autoridade desatualizada\". Agora o Runner bloqueia a inicialização até receber a configuração da plataforma, e o scheduler reaplica a autoridade da plataforma a cada ciclo. Os padrões compilados que prevaleceram no ST#8 estão sendo removidos um a um. A correção consolidou o princípio: padrões e fallbacks são legítimos na plataforma; no cliente, são uma falha.",
    "The refuse-to-start check in Loop.New":
      "A verificação que recusa a inicialização em Loop.New",
    "What the principle buys for extensibility":
      "O que o princípio oferece à extensibilidade",
    "Because the runner does not have a compiled-in picture of what roles exist, an operator can author a role named":
      "Como o Runner não tem uma representação compilada das funções existentes, um operador pode criar uma função chamada ",
    " in the UI and the runner picks it up on the next poll without a single Go file changing. If the operator removes a role, the scheduler drops it without a restart. The 2026-04-18 runner-launch walkthrough confirmed this end-to-end: a custom ":
      " na interface, e o Runner a reconhece na próxima consulta sem alterar nenhum arquivo Go. Se o operador remover uma função, o scheduler a descarta sem exigir reinicialização. O passo a passo de inicialização do Runner de 18 de abril de 2026 confirmou isso de ponta a ponta: uma função personalizada ",
    " role ran through the full pipeline lifecycle, never having existed in the runner binary's type system.":
      " percorreu todo o ciclo de vida do pipeline sem jamais ter existido no sistema de tipos do binário do Runner.",
    "The corollary is that extensibility is not a separate feature. It is a consequence of the runner being thin. Every time the runner gains a hardcoded notion of what a role means — what column type to target, what git action to take, what post-process kind to run — that is a regression against extensibility, and it's a regression against platform authority, and they are the same thing.":
      "A consequência é que a extensibilidade não constitui uma funcionalidade separada. Ela decorre de o Runner ser enxuto. Sempre que o Runner ganha uma definição fixa do que uma função significa, como qual tipo de coluna deve escolher, qual ação git deve executar ou qual pós-processamento deve aplicar, ocorre uma regressão tanto na extensibilidade quanto na autoridade da plataforma. As duas coisas são equivalentes.",
    "What is still left to clean up": "O que ainda precisa ser corrigido",
    "The principle is articulated and the runtime hot path is clean. A handful of residual hardcoded fallbacks survive in the Go runner and violate the principle in spirit, even though they do not fire on the critical path:":
      "O princípio está definido e o caminho crítico de runtime está limpo. Alguns fallbacks fixos ainda permanecem no Runner Go e contrariam o princípio, embora não sejam acionados no caminho crítico:",
    "Column-type string fallbacks":
      "Fallbacks de strings de tipos de coluna",
    " and ": " e ",
    " each carry a handful of hardcoded column-type strings (":
      " ainda contêm algumas strings fixas de tipos de coluna, como ",
    ") used when the corresponding ": ", usadas quando o campo ",
    " field is empty. Operator mistakes that omit the field land on a legacy default instead of surfacing the omission.":
      " correspondente está vazio. Erros do operador que omitem esse campo recorrem a um padrão legado em vez de revelar a omissão.",
    " in validation paths": " nos caminhos de validação",
    "still carries a full hardcoded three-role default. It is dead on the runtime hot path (the boot check refuses to start without a platform config), but":
      "ainda contém um padrão fixo completo de três funções. Ele não é usado no caminho crítico de runtime, pois a verificação de inicialização se recusa a operar sem uma configuração da plataforma, mas ",
    " still references it for validation — so validation output can disagree with refusal-to-start behavior. This is the cleanup that would close the principle loop.":
      " ainda o referencia para validação. Por isso, o resultado da validação pode divergir do comportamento que recusa a inicialização. Corrigir isso fecharia o ciclo do princípio.",
    "Role literals in execution logging":
      "Literais de função nos registros de execução",
    " is literally hardcoded at two call sites on the hero path, so every hero-driven execution records":
      " está literalmente fixado em dois pontos de chamada no caminho do responsável principal; por isso, toda execução conduzida por ele registra ",
    " even when a custom researcher or planner drove it. Purely a reporting bug — the execution ran correctly, the execution row misattributes.":
      " mesmo quando foi conduzida por uma função personalizada de pesquisa ou planejamento. Trata-se apenas de um erro de registro: a execução ocorreu corretamente, mas a linha de execução atribui a autoria de forma incorreta.",
    "Scheduling and git defaults": "Padrões de agendamento e git",
    " that historically leaked operator-set values the platform should own — backoff seconds, ":
      " que historicamente deixavam escapar valores definidos pelo operador que deveriam pertencer à plataforma, como segundos de backoff, ",
    ", commit-message templates, branch prefixes. Recent refactors tightened most of these by leaving the runner-side field empty and treating any non-zero platform value as authoritative; a couple of shadow defaults still exist and are tracked for removal.":
      ", templates de mensagem de commit e prefixos de branch. Refatorações recentes corrigiram a maioria desses casos, deixando vazio o campo do Runner e tratando qualquer valor diferente de zero fornecido pela plataforma como oficial. Alguns padrões ocultos ainda existem e estão marcados para remoção.",
    "Residual fallbacks are maintenance liability, not runtime bugs":
      "Fallbacks remanescentes são um passivo de manutenção, não falhas de runtime",
    "None of the residuals above fire on the runtime hot path. The runner will refuse to start without a platform pipeline. The scheduler will drop a role whose prompt has disappeared. The compiled-in three-role default is reachable only from validation paths that ultimately get overridden by the boot check. The concern is maintenance: every shadow default is a place where the code has two opinions about what should happen, and when the platform evolves, keeping them in sync is continuous work that should instead be zero work. The fix is to delete the shadows outright, which we are doing one batch at a time rather than all at once because each deletion reads against several tests.":
      "Nenhum dos casos remanescentes acima é acionado no caminho crítico de runtime. O Runner se recusa a iniciar sem um pipeline da plataforma. O scheduler descarta uma função cujo prompt tenha desaparecido. O padrão compilado de três funções só pode ser alcançado pelos caminhos de validação e acaba sendo superado pela verificação de inicialização. O problema é de manutenção: cada padrão oculto representa um ponto em que o código tem duas opiniões sobre o comportamento correto e, à medida que a plataforma evolui, mantê-las sincronizadas exige um trabalho contínuo que deveria ser inexistente. A correção é eliminar esses padrões por completo, o que está sendo feito em lotes, e não de uma só vez, porque cada remoção afeta vários testes.",
    "The final cleanup is tied to the LLM abstraction milestone":
      "A correção final está ligada ao marco de abstração de LLMs",
    "The residual fallbacks cluster around two themes: role-specific behavior and model-specific behavior. Both of those themes are exactly what the LLM abstraction milestone dissolves. Once per-role provider and model are first-class platform config, the pre-abstraction heuristics that currently justify some of the Go hardcodes (the self-review guard, the hero-path role literal, the reviewer-specific branch logic) become unnecessary. The cleanup is scheduled to ride in with that milestone rather than land as its own sprint. Tracked in":
      "Os fallbacks remanescentes se concentram em dois temas: comportamentos específicos de funções e de modelos. O marco de abstração de LLMs elimina justamente ambos. Quando provider e modelo por função forem configurações de primeira classe da plataforma, as heurísticas anteriores à abstração que hoje justificam alguns valores fixos em Go, como a proteção contra autorrevisão, o literal de função no caminho do responsável principal e a lógica de branch específica da revisão, deixarão de ser necessárias. A correção está programada para acompanhar esse marco, em vez de ocupar um sprint próprio. Acompanhada em ",
    "The principle is short to state. The discipline is long to maintain. Every design review asks whether the proposed change adds a client-side fallback, and if so, why the platform is the wrong place for it. The answer is usually \"the platform is the right place for it.\" The answer is never \"defaults at both layers are fine.\"":
      "O princípio é simples de enunciar, mas exige disciplina contínua para ser mantido. Toda revisão de design pergunta se a mudança proposta adiciona um fallback no cliente e, em caso afirmativo, por que a plataforma não seria o lugar correto para ele. A resposta geralmente é \"a plataforma é o lugar correto\". A resposta nunca é \"padrões nas duas camadas são aceitáveis\".",
  },
  "model-agnostic-roles": {
    "The north star is per-role ":
      "O objetivo principal é ter, para cada função, ",
    " and": " e ",
    ". Implementer on Sonnet for speed and cost. Reviewer on GPT-5 because a different model is a different reviewer. Documentator on Gemini because its context window fits a whole codebase. All three roles driven by the same runner, against the same card, from the same pipeline config. This is the declared target and it is on the backlog, not on trunk.":
      ". Implementador no Sonnet por velocidade e custo. Revisor no GPT-5 porque um modelo diferente é um revisor diferente. Responsável pela documentação no Gemini porque sua janela de contexto comporta uma base de código inteira. As três funções são conduzidas pelo mesmo Runner, trabalham no mesmo cartão e partem da mesma configuração de pipeline. Esse é o objetivo declarado e está no backlog, não no trunk.",
    "This page documents what is wired today, what the target shape looks like, and what it will take to get there. It is one of the few pages in this documentation where a future state is load bearing enough to deserve its own section — everything on the platform flows through the LLM runner, and the runner being model-locked today bounds what the platform can ship tomorrow.":
      "Esta página documenta o que está implementado hoje, qual é o formato desejado e o que será necessário para chegar lá. É uma das poucas páginas desta documentação em que um estado futuro é importante o suficiente para merecer uma seção própria. Tudo na plataforma passa pelo Runner de LLM, e o fato de ele estar limitado a um único modelo hoje restringe o que a plataforma poderá entregar amanhã.",
    "Why role independence implies model independence":
      "Por que a independência de funções implica independência de modelos",
    "Role extensibility without model extensibility is a half-answer. An operator can declare a ":
      "A extensibilidade de funções sem extensibilidade de modelos é uma resposta incompleta. Um operador pode declarar uma função ",
    " role and the platform will dispatch cards to it — the runtime hot path and the prompt synthesis both handle arbitrary roles. What the operator cannot do today is say \"the security auditor runs on a different model than the implementer.\" The auditor inherits the runner's single LLM config. Every role routes through the same Claude CLI subprocess against the same model string, and":
      ", e a plataforma enviará cartões para ela. Tanto o caminho crítico de runtime quanto a síntese de prompts aceitam funções arbitrárias. O que o operador ainda não pode fazer é dizer \"o auditor de segurança usa um modelo diferente do Implementador\". O auditor herda a única configuração de LLM do Runner. Todas as funções passam pelo mesmo subprocesso da Claude CLI, usando a mesma string de modelo, e ",
    " is keyed by pipeline": " usa como chave a ",
    phase: "fase",
    ", not ": ", e não a ",
    role: "função",
    " — the runner can vary which model it uses for ":
      ". O Runner pode variar o modelo usado em ",
    " versus": " e em ",
    ", but not which model a custom":
      ", mas não o modelo que uma função personalizada de ",
    analyst: "análise",
    " uses at the same phase.": " usa na mesma fase.",
    "The practical consequences are immediate. You cannot run a mixed-provider quorum reviewer. You cannot send the cost-sensitive drafting role to a cheap model and the precision-sensitive review role to an expensive one. You cannot experiment with \"does GPT-5 review Sonnet's output better than Opus reviews Sonnet's output\" without standing up two runners. The data model supports the distinction in principle; the runtime does not implement it yet.":
      "As consequências práticas são imediatas. Não é possível executar uma revisão por quórum com vários providers. Não é possível encaminhar uma função de redação sensível a custo para um modelo barato e uma função de revisão sensível a precisão para um modelo caro. Também não é possível experimentar se \"o GPT-5 revisa a saída do Sonnet melhor do que o Opus revisa a saída do Sonnet\" sem iniciar dois Runners. O modelo de dados comporta essa distinção em princípio, mas o runtime ainda não a implementa.",
    "What is wired today": "O que está implementado hoje",
    "A single ": "Um único ",
    " lives on the runner's YAML at": " fica no YAML do Runner em ",
    ". It carries a provider string, a default model, optional per-phase overrides, and credentials. All routes flow through":
      ". Ele contém uma string de provider, um modelo padrão, substituições opcionais por fase e credenciais. Todos os caminhos passam por ",
    ", which spawns": ", que inicia ",
    " as a subprocess. The": " como subprocesso. A variável de ambiente ",
    " environment variable is deliberately stripped from the subprocess so Claude Code Max (OAuth/subscription) wins unless the operator sets an explicit key in config.":
      " é removida deliberadamente do subprocesso para priorizar o Claude Code Max, por OAuth ou assinatura, a menos que o operador defina uma chave explícita na configuração.",
    "The pipeline config DSL has ":
      "A DSL da configuração de pipeline já tem blocos ",
    " blocks per stage already — they declare the stage name, the tools allowlist, the post-process kind, and the directives. What they do ":
      " por etapa. Eles declaram o nome da etapa, a allowlist de ferramentas, o tipo de pós-processamento e as diretivas. O que eles ainda ",
    not: "não ",
    "declare today is a provider or a model. The fields are not in the schema. Adding them is a schema change; making them take effect is the rest of the work.":
      "declaram é um provider ou um modelo. Esses campos não existem no schema. Adicioná-los é uma mudança de schema; fazê-los funcionar representa o restante do trabalho.",
    "The target shape": "O formato desejado",
    "Per-role, per-stage ": "Configuração ",
    " configuration on the pipeline config itself. Credentials stored at the workspace level and resolved by the runner at stage dispatch time. A provider abstraction in Go that dispatches to Anthropic, OpenAI, or Google from the same call site without the runner caring which it lands on. Prompt caching normalized across providers. Tool-call normalization so an MCP tool behaves the same whether the model underneath speaks Anthropic's tool-use format or OpenAI's function-call format.":
      " por função e por etapa na própria configuração de pipeline. Credenciais armazenadas no nível do espaço de trabalho e resolvidas pelo Runner no momento de encaminhar a etapa. Uma abstração de providers em Go que direcione para Anthropic, OpenAI ou Google a partir do mesmo ponto de chamada, sem que o Runner precise saber o destino. Cache de prompts normalizado entre providers. Normalização de chamadas de ferramentas para que uma ferramenta MCP se comporte da mesma forma, seja qual for o formato usado pelo modelo, como tool use da Anthropic ou function call da OpenAI.",
    "The target pipeline_config llm block (not yet wired)":
      "O bloco llm desejado em pipeline_config, ainda não implementado",
    "What it will take": "O que será necessário",
    "The work breaks into five threads. None are individually hard. Together they are the LLM abstraction milestone.":
      "O trabalho se divide em cinco frentes. Nenhuma é difícil isoladamente. Juntas, elas formam o marco de abstração de LLMs.",
    "Credential storage at the workspace level.":
      "Armazenamento de credenciais no nível do espaço de trabalho.",
    " A workspace can hold references to Anthropic, OpenAI, and Google credentials, encrypted at rest. The runner resolves the ":
      " Um espaço de trabalho pode guardar referências a credenciais da Anthropic, OpenAI e Google, criptografadas em repouso. O Runner resolve ",
    " on stage dispatch. Per-role credentials compose with workspace budgets for per-provider spend tracking.":
      " ao encaminhar a etapa. Credenciais por função se combinam com os orçamentos do espaço de trabalho para acompanhar gastos por provider.",
    "Provider interface in Go.": "Interface de provider em Go.",
    " A": " Uma interface ",
    " interface with implementations for Anthropic CLI, Anthropic SDK, OpenAI, and Google Generative AI. The runner dispatches to the right one based on the stage's ":
      " com implementações para Anthropic CLI, Anthropic SDK, OpenAI e Google Generative AI. O Runner escolhe a implementação correta com base no ",
    ". The existing Claude CLI path becomes one provider among several.":
      " da etapa. O caminho existente da Claude CLI se torna um provider entre vários.",
    "Prompt caching normalization.": "Normalização do cache de prompts.",
    " Anthropic's ephemeral-cache-control blocks and OpenAI's prompt-caching semantics do not map one-to-one. The runner needs a cache abstraction that accepts the platform's prompt parts and emits provider-appropriate cache controls.":
      " Os blocos ephemeral-cache-control da Anthropic e a semântica de cache de prompts da OpenAI não têm correspondência direta. O Runner precisa de uma abstração de cache que aceite as partes do prompt definidas pela plataforma e gere controles de cache adequados a cada provider.",
    "Tool-call format normalization.":
      "Normalização do formato de chamadas de ferramentas.",
    " The MCP server speaks the tool-call protocol every major host supports, but the subprocess-level formats differ. Whatever wrapper the Go runner uses has to translate the provider's tool-use frames into MCP calls transparently.":
      " O servidor MCP usa o protocolo de chamadas de ferramentas aceito por todos os principais hosts, mas os formatos no nível do subprocesso são diferentes. O wrapper usado pelo Runner Go precisa transformar de modo transparente os frames de tool use do provider em chamadas MCP.",
    "Self-review guard removal.":
      "Remoção da proteção contra autorrevisão.",
    " The hardcoded": " A verificação fixa ",
    " check in the runner that prevents a runner from reviewing its own work is a pre-abstraction heuristic. Once models can differ per role, \"this runner reviewed its own work\" is no longer a concern — the reviewer is a different model with a different persona, and the same physical process being involved stops mattering.":
      " no Runner, que impede um Runner de revisar o próprio trabalho, é uma heurística anterior à abstração. Quando os modelos puderem variar por função, \"este Runner revisou o próprio trabalho\" deixará de ser uma preocupação: o Revisor será um modelo diferente, com uma persona diferente, e não importará que o mesmo processo físico esteja envolvido.",
    "Why this isn't already done": "Por que isso ainda não foi feito",
    "Two reasons. The first is that single-provider operation has been the short path to proving everything else. Role extensibility, prompt synthesis, platform authority, pipeline DSL, post-process imperatives — all of these had to land and stabilize before the multi-provider story was worth the churn. The second is that prompt caching is a meaningful part of what keeps runner costs tractable, and building the caching layer for one provider well is easier than building it for three provisionally.":
      "Há dois motivos. O primeiro é que operar com um único provider foi o caminho mais curto para validar todo o restante. Extensibilidade de funções, síntese de prompts, autoridade da plataforma, DSL de pipeline e instruções imperativas de pós-processamento precisavam ser implementadas e estabilizadas antes que o custo de introduzir vários providers se justificasse. O segundo é que o cache de prompts tem um papel relevante em manter os custos do Runner viáveis, e construir bem a camada de cache para um provider é mais simples do que construí-la provisoriamente para três.",
    "Neither reason survives indefinitely. The single-provider scaffolding has stabilized — the runtime hot path is clean, the extensibility story is proven in production with custom roles, the audit findings cluster at the boundaries rather than the core. Prompt caching is well enough understood across providers that the normalization layer is a week of work, not a quarter. The LLM abstraction milestone is the next major unit of work rather than the year-out horizon it was when the platform first started.":
      "Nenhum dos motivos permanece válido indefinidamente. A base para um único provider se estabilizou: o caminho crítico de runtime está limpo, a extensibilidade foi comprovada em produção com funções personalizadas e os achados de auditoria se concentram nas bordas, não no núcleo. O cache de prompts já é bem compreendido entre providers, de modo que a camada de normalização representa uma semana de trabalho, não um trimestre. O marco de abstração de LLMs é a próxima grande unidade de trabalho, e não mais um horizonte de um ano como era no início da plataforma.",
    "The declared north star, explicitly not yet shipped":
      "O objetivo declarado, explicitamente ainda não entregue",
    "Per-role model selection is the single largest declared-but- unshipped item on the platform roadmap. The scoping document lives at":
      "A seleção de modelo por função é o maior item declarado, mas ainda não entregue, no roadmap da plataforma. O documento de escopo fica em ",
    ". The feedback memo at": ". O memorando de feedback em ",
    "captures the principle: role extensibility without model extensibility is a half-answer. We are taking that seriously rather than quietly. If you are reading this page because you wanted to send your reviewer role to GPT-5 and your implementer to Sonnet — that is the feature we know we owe you. It is not here yet.":
      "registra o princípio: extensibilidade de funções sem extensibilidade de modelos é uma resposta incompleta. Estamos tratando isso com seriedade e transparência. Se você está lendo esta página porque queria enviar sua função de Revisor ao GPT-5 e a de Implementador ao Sonnet, essa é a funcionalidade que sabemos que precisamos entregar. Ela ainda não está disponível.",
    "Every other page in this group documents something that works. This one documents something that should. The distinction is worth the page. When someone asks \"can Backplane run a mixed-model pipeline?\" the honest answer today is no, and the principled answer tomorrow is yes, and the work between here and there is the explicit subject of a scheduled milestone rather than something you have to guess at. That is the kind of honesty documentation is for.":
      "Todas as outras páginas deste grupo documentam algo que funciona. Esta documenta algo que deveria funcionar. A distinção merece uma página. Quando alguém pergunta \"o Backplane pode executar um pipeline com vários modelos?\", a resposta honesta hoje é não, e a resposta fundamentada para o futuro é sim. O trabalho entre esses dois pontos é o tema explícito de um marco planejado, e não algo que você precisa deduzir. É para esse tipo de transparência que a documentação existe.",
  },
};
