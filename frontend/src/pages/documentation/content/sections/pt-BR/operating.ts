// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_OPERATING = {
  "reading-the-runner-overview": {
    "The Runner Console at ": "O Console de runners em ",
    " has four tabs:": " tem quatro abas:",
    Overview: "Visão geral",
    Pipeline: "Pipeline",
    Runners: "Runners",
    ", and": " e",
    Activity: "Atividade",
    ". Overview is deliberately health-first. It summarizes active-runner metrics, configuration warnings, pending approvals, and execution analytics; runner management and teams live in Runners, while the execution feed lives in Activity.":
      ". A Visão geral prioriza deliberadamente a saúde do sistema. Ela resume métricas de runners ativos, alertas de configuração, aprovações pendentes e análises de execução; o gerenciamento de runners e equipes fica em Runners, enquanto o feed de execuções fica em Atividade.",
    "Runner overview with five headline metrics, pending approvals, and analytics":
      "Visão geral de runners com cinco métricas principais, aprovações pendentes e análises",
    "Overview is a health summary. Its metric cards link to the tabs that own the detail.":
      "A Visão geral é um resumo de saúde. Seus cartões de métricas levam às abas que contêm os detalhes.",
    "Runner Console tabs: Overview, Pipeline, Runners, and Activity, with Overview active.":
      "Abas do Console de runners: Visão geral, Pipeline, Runners e Atividade, com Visão geral ativa.",
    "An optional configuration-error alert links to Runners; a no-runners hint does the same.":
      "Um alerta opcional de erro de configuração leva a Runners; a indicação de que não há runners faz o mesmo.",
    "Five metric cards: Total runners, Success rate, Average duration, Total tokens, and Total cost.":
      "Cinco cartões de métricas: Total de runners, Taxa de sucesso, Duração média, Total de tokens e Custo total.",
    "Pending approvals appears below the metrics, followed by the Analytics dashboard.":
      "As aprovações pendentes aparecem abaixo das métricas, seguidas pelo dashboard de análises.",
    "Analytics includes outcome metrics, execution totals, 30-day daily activity, and distribution by role or action.":
      "As análises incluem métricas de resultado, totais de execução, atividade diária de 30 dias e distribuição por função ou ação.",
    "The five headline metrics": "As cinco métricas principais",
    "Total runners": "Total de runners",
    " is the count returned by the active-runner metrics query. Inactive runners are excluded from this Overview request. Clicking the card opens the Runners tab.":
      " é a quantidade retornada pela consulta de métricas de runners ativos. Runners inativos são excluídos desta solicitação da Visão geral. Clicar no cartão abre a aba Runners.",
    "Success rate": "Taxa de sucesso",
    " is completed executions divided by total executions across the returned runners. The denominator is the full execution count exposed by each runner metric, so it is not limited to completed plus failed outcomes.":
      " corresponde às execuções concluídas divididas pelo total de execuções dos runners retornados. O denominador é a contagem completa exposta pela métrica de cada runner, portanto não se limita a resultados concluídos e com falha.",
    "Average duration": "Duração média",
    " is the arithmetic mean of each active runner's reported average duration. It is therefore an unweighted mean across runners, not one global average over all execution rows.":
      " é a média aritmética da duração média informada por cada runner ativo. Portanto, é uma média não ponderada entre runners, não uma média global de todas as execuções.",
    "Total tokens": "Total de tokens",
    " and ": " e ",
    "Total cost": "Custo total",
    " sum the cumulative values returned for all active runners. Overview does not expose a selectable time window for these five cards. The four execution-oriented cards link to Activity.":
      " somam os valores acumulados retornados para todos os runners ativos. A Visão geral não oferece uma janela de tempo selecionável para esses cinco cartões. Os quatro cartões relacionados a execuções levam a Atividade.",
    "Warnings, approvals, and analytics": "Alertas, aprovações e análises",
    "A zero-runner hint directs setup to the Runners tab. If any active runner reports ":
      "Quando não há runners, uma indicação direciona a configuração para a aba Runners. Se algum runner ativo informar ",
    ", a destructive-colored alert links to the same tab so the configuration can be inspected. Pending approvals are listed next, with a direct path to the approval queue.":
      ", um alerta de cor crítica leva à mesma aba para que a configuração seja inspecionada. Em seguida aparecem as aprovações pendentes, com acesso direto à fila de aprovações.",
    "The lazy-loaded Analytics dashboard adds success and rework rates, average cost per card, average duration, execution totals, daily successes and failures for the latest 30 data points, and a role or action distribution. Those analytics are server-derived and are not the same aggregation as the five runner cards above.":
      "O dashboard de análises com carregamento sob demanda acrescenta taxas de sucesso e retrabalho, custo médio por cartão, duração média, totais de execução, sucessos e falhas diários para os 30 pontos de dados mais recentes e distribuição por função ou ação. Essas análises são calculadas no servidor e não usam a mesma agregação dos cinco cartões anteriores.",
    "Use the owning tab for diagnosis": "Use a aba responsável para o diagnóstico",
    "Overview no longer embeds the runner table, team roster, or execution timeline. Open ":
      "A Visão geral não incorpora mais a tabela de runners, a lista da equipe nem a linha do tempo de execuções. Abra ",
    " for liveness, inactive runners, teams, launch configuration, and reported config errors. Open ":
      " para verificar liveness, runners inativos, equipes, configuração de inicialização e erros de configuração informados. Abra ",
    "for individual execution history and links to execution detail.":
      "para consultar o histórico de execuções individuais e os links para seus detalhes.",
  },
  "debugging-a-stuck-card": {
    "Open the card detail sheet before guessing why work stopped. Its Stuck Reasons panel derives operator-facing signals from the current column, participants, recent card executions, latest review decision, skipped prompt stages, and live pipeline configuration. Done cards suppress the panel because they are already terminal.":
      "Abra o painel de detalhes do cartão antes de tentar adivinhar por que o trabalho parou. O painel Motivos do bloqueio deriva sinais para o operador a partir da coluna atual, dos participantes, das execuções recentes do cartão, da decisão de revisão mais recente, das etapas ignoradas por falta de prompt e da configuração vigente do pipeline. Cartões concluídos ocultam o painel porque já são terminais.",
    "Card detail sheet with current stuck reasons and execution history":
      "Painel de detalhes do cartão com os motivos atuais do bloqueio e o histórico de execuções",
    "Stuck reasons are evidence to investigate, not a second scheduler.":
      "Os motivos do bloqueio são evidências para investigar, não um segundo scheduler.",
    "Card detail sheet with a Stuck Reasons section below pull-request context.":
      "Painel de detalhes do cartão com uma seção Motivos do bloqueio abaixo do contexto do pull request.",
    "Possible rows include Blocked column, No hero assigned, Awaiting prompt, Changes requested, Recent failures, and Stale card.":
      "As linhas possíveis incluem Coluna bloqueada, Sem hero atribuído, Aguardando prompt, Alterações solicitadas, Falhas recentes e Cartão obsoleto.",
    "Stages awaiting prompt appears separately with role, stage, and an Author prompt link.":
      "As etapas que aguardam prompt aparecem separadamente com função, etapa e um link Criar prompt.",
    "The card's latest execution history remains visible below the diagnostic sections.":
      "O histórico de execuções mais recente do cartão permanece visível abaixo das seções de diagnóstico.",
    "The six current reasons": "Os seis motivos atuais",
    "Blocked column.": "Coluna bloqueada.",
    " The current column has": " A coluna atual tem",
    "; discovery skips it until an operator moves the card to a non-blocked column.":
      "; a descoberta o ignora até que um operador mova o cartão para uma coluna não bloqueada.",
    "No hero assigned.": "Sem hero atribuído.",
    " No participant has role": " Nenhum participante tem a função",
    ", and at least one visible pipeline stage claims as a hero. Pipelines that use only another participant role do not get this false warning.":
      ", e pelo menos uma etapa visível do pipeline assume cartões como hero. Pipelines que usam somente outra função de participante não recebem esse alerta incorreto.",
    "Awaiting prompt.": "Aguardando prompt.",
    " One or more distinct": " Um ou mais pares distintos",
    " pairs produced a skipped execution for this card. Author the missing prompt and let a later tick try again.":
      " produziram uma execução ignorada para este cartão. Crie o prompt ausente e permita que um tick posterior tente novamente.",
    "Changes requested.": "Alterações solicitadas.",
    " The latest parsed review decision is ": " A decisão de revisão interpretada mais recente é ",
    "; rework and a newer approval are needed.":
      "; são necessários retrabalho e uma aprovação posterior.",
    "Recent failures.": "Falhas recentes.",
    " At least two card executions failed during the last 24 hours. Inspect their execution errors before retrying a deterministic failure.":
      " Pelo menos duas execuções do cartão falharam nas últimas 24 horas. Inspecione os erros antes de repetir uma falha determinística.",
    "Stale card.": "Cartão obsoleto.",
    " This fallback appears only when no more specific reason applies, the card has not changed for at least seven days, and no execution touched it recently.":
      " Esse motivo de fallback aparece somente quando não há outro mais específico, o cartão não muda há pelo menos sete dias e nenhuma execução o alterou recentemente.",
    "Follow the owning surfaces": "Siga as superfícies responsáveis",
    "Use the board's ": "Use a aba ",
    History: "Histórico",
    " tab for mutations and its": " do quadro para mutações e a aba",
    Timeline: "Linha do tempo",
    " tab when replaying board state will clarify the sequence.":
      " quando reproduzir o estado do quadro ajudar a esclarecer a sequência.",
    "Open the Runner Console's ": "Abra a aba ",
    Runners: "Runners",
    " tab for last heartbeat, liveness, inactive state, and ":
      " do Console de runners para verificar o último heartbeat, liveness, estado inativo e ",
    "Open its ": "Abra a aba ",
    Activity: "Atividade",
    " tab for the execution feed, then follow an execution into status, error, tool, duration, token, and cost detail.":
      " para consultar o feed de execuções e depois acessar os detalhes de status, erro, ferramenta, duração, tokens e custo.",
    "For a skipped prompt, use the card sheet's ": "Para um prompt ignorado, use o link ",
    "Author prompt": "Criar prompt",
    " link; it opens Pipeline with the relevant role and stage in the URL.":
      " do painel do cartão; ele abre Pipeline com a função e a etapa correspondentes na URL.",
    "A skipped execution means the runner respected platform authority":
      "Uma execução ignorada significa que o runner respeitou a autoridade da plataforma",
    "The pause icon on a kanban card and the Awaiting prompt reason are not proof that the runner is broken. They record that the runner found the card but did not receive authored prompt content for that role and stage. Fix the prompt in Pipeline, then verify the next execution in Activity.":
      "O ícone de pausa em um cartão kanban e o motivo Aguardando prompt não provam que o runner está com problema. Eles registram que o runner encontrou o cartão, mas não recebeu conteúdo de prompt para aquela função e etapa. Corrija o prompt em Pipeline e verifique a próxima execução em Atividade.",
  },
  "the-observer-panel": {
    "The observer is the eye icon in the top bar. Click it and a sheet slides in from the right streaming WebSocket events live. It is mounted once per workspace session — as soon as you have a ":
      "O Observador é o ícone de olho na barra superior. Ao clicar, uma folha desliza pela direita e transmite eventos WebSocket ao vivo. Ele é montado uma vez por sessão do espaço de trabalho; assim que existe um ",
    " in the URL, the icon is there — and the icon badges an unread count while the sheet is closed, capped visually at ":
      " na URL, o ícone aparece e exibe um selo com a quantidade de itens não lidos enquanto a folha está fechada, limitada visualmente a ",
    ". It used to be a free-floating draggable window whose x/y lived in ":
      ". Antes, ele era uma janela flutuante e arrastável cujas coordenadas x/y ficavam em ",
    "; that is gone, and the stale":
      "; esse comportamento foi removido, e a entrada obsoleta ",
    " entry is evicted on mount.":
      " é eliminada durante a montagem.",
    "Observer sheet docked to the right edge showing a live stream of events with namespace chips, a search box, and a buffered counter":
      "Folha do Observador acoplada à borda direita, mostrando um fluxo de eventos ao vivo com chips de namespace, campo de busca e contador do buffer",
    "The panel is the fastest way to answer 'did the backend actually fire that event' without opening DevTools.":
      "O painel é a maneira mais rápida de responder 'o backend realmente disparou esse evento?' sem abrir o DevTools.",
    "Right-side sheet roughly 420px wide, docked flush to the viewport edge, with a dark-surface background.":
      "Folha do lado direito, com cerca de 420 px de largura, acoplada à borda da viewport e com fundo escuro.",
    "Header reads 'Observer' with a pause button (showing two vertical bars) and a clear button (trash icon).":
      "O cabeçalho mostra 'Observador', um botão de pausa com duas barras verticais e um botão de limpar com ícone de lixeira.",
    "Filter chip row with no chip selected by default: 'All', 'Card', 'Runner', 'Execution', 'Approval', and — only after such traffic is seen — 'Other'.":
      "Linha de chips de filtro sem nenhum selecionado por padrão: 'Todos', 'Cartão', 'Runner', 'Execução', 'Aprovação' e, somente após esse tráfego aparecer, 'Outros'.",
    "Below the chips, a search input reading 'Search event type or id…' and a muted counter 'Showing 24 of 137 buffered (cap 1000)'.":
      "Abaixo dos chips, um campo de busca com o texto 'Buscar tipo ou id do evento…' e um contador discreto 'Exibindo 24 de 137 no buffer (limite 1000)'.",
    "Event list below showing rows in reverse-chronological order: 'card.moved  a1f3c2d4  12s ago', 'execution.started  9b7e1a05  14s ago', 'agent.heartbeat_received  4c2d8f61  16s ago'.":
      "A lista de eventos abaixo mostra as linhas em ordem cronológica inversa: 'card.moved  a1f3c2d4  há 12 s', 'execution.started  9b7e1a05  há 14 s', 'agent.heartbeat_received  4c2d8f61  há 16 s'.",
    "Each row carries a namespace badge, raw event type, full mono event_id, and relative timestamp; selecting it expands the JSON payload.":
      "Cada linha contém um selo de namespace, o tipo raw do evento, o event_id completo em fonte monoespaçada e um horário relativo; selecioná-la expande o payload JSON.",
    "What streams through it": "O que passa pelo painel",
    "The panel subscribes to ": "O painel assina ",
    " and buffers the whole bus — the most recent 1000 events — but, with no chip selected, shows only four agentic namespaces by default:":
      " e mantém no buffer todo o barramento, limitado aos 1000 eventos mais recentes, mas, sem nenhum chip selecionado, exibe por padrão apenas quatro namespaces agênticos:",
    ", and": ", e",
    ". Everything else the bus carries is one chip away: an ":
      ". Todo o restante transportado pelo barramento fica a um chip de distância: o chip ",
    Other: "Outros",
    " chip appears as soon as non-agentic traffic lands, so a namespace nobody enumerated in advance is still diagnosable here rather than invisible platform-wide.":
      " aparece assim que chega tráfego não relacionado a agentes. Dessa forma, um namespace que ninguém previu continua diagnosticável aqui, em vez de ficar invisível em toda a plataforma.",
    "The namespace chips are toggleable and additive. ":
      "Os chips de namespace podem ser ativados ou desativados e combinados. ",
    All: "Todos",
    "clears the selected filters and returns to the default four-namespace view; it does not change the panel into an unfiltered whole-bus view. The search box narrows the list by event type or ":
      "limpa os filtros selecionados e retorna à visualização padrão de quatro namespaces; não transforma o painel em uma visualização sem filtros de todo o barramento. O campo de busca restringe a lista pelo tipo de evento ou por um trecho do ",
    "substring, and the counter beside it reads ":
      ", e o contador ao lado mostra ",
    "shown of buffered": "exibidos de armazenados no buffer",
    "against the cap. Selecting a row expands its raw JSON payload. Pause freezes the list at its current state without unsubscribing, so you can inspect a frame without events scrolling off — events arriving while paused are dropped, not queued. Clear empties the buffer without touching the subscription.":
      "em relação ao limite. Selecionar uma linha expande seu payload JSON raw. Pausar congela a lista no estado atual sem cancelar a assinatura, permitindo inspecionar um quadro sem que os eventos saiam da tela; os eventos que chegam durante a pausa são descartados, não enfileirados. Limpar esvazia o buffer sem alterar a assinatura.",
    "The buffer is in-memory and live-only: nothing is persisted and a reload starts empty. The stored audit trail is ":
      "O buffer existe apenas em memória e em tempo real: nada é persistido, e uma recarga começa com a lista vazia. A trilha de auditoria armazenada fica em ",
    ", which is a different surface answering a different question.":
      ", uma interface distinta que responde a outra pergunta.",
    "When to reach for it": "Quando recorrer a ele",
    "Three situations where it earns its keep:":
      "Três situações em que ele se mostra especialmente útil:",
    "Verifying a mutation actually broadcast. If you changed a card and the board didn't update in another tab, first question is \"did the event fire at all?\" The panel answers that in under a second.":
      "Verificar se uma mutação realmente foi transmitida. Se você alterou um cartão e o quadro não foi atualizado em outra aba, a primeira pergunta é: \"o evento chegou a ser disparado?\" O painel responde em menos de um segundo.",
    "Tracing a pipeline run end-to-end. Watch the":
      "Rastrear uma execução do pipeline de ponta a ponta. Observe a sequência",
    " sequence line up in real time.": " se alinhar em tempo real.",
    "Spotting noisy subscribers. If the panel shows the same event repeating, someone is publishing in a loop.":
      "Identificar assinantes ruidosos. Se o painel mostra o mesmo evento repetidamente, alguém está publicando em loop.",
    "Keep it open during smoke tests": "Mantenha-o aberto durante smoke tests",
    "When you are walking through a new pipeline or a fresh runner, open the sheet on your second monitor and leave it open. Every click in the app should produce a visible event, and any click that doesn't is interesting. It turns \"did that work?\" into \"I can see it worked\" — faster than tailing server logs, and available to anyone on the team without shell access.":
      "Ao percorrer um pipeline novo ou testar um Runner recém-configurado, abra a folha no segundo monitor e deixe-a aberta. Cada clique no aplicativo deve produzir um evento visível; qualquer clique que não produza é relevante. Isso transforma \"funcionou?\" em \"consigo ver que funcionou\": é mais rápido do que acompanhar logs do servidor e está disponível para qualquer pessoa da equipe sem acesso ao shell.",
    "Admin-only, deliberately": "Somente para administradores, de propósito",
    "The panel is mounted for every user but gated behind":
      "O painel é montado para todos os usuários, mas fica protegido por",
    ". Non-admins get no trigger icon at all — not a placeholder, nothing. And the client gate is only the UX half: the events socket rejects observer-grade subscription patterns from non-admins server-side, so hand-opening it gains nothing. This is on purpose — the bus carries actor IDs, payloads, and change JSON for every mutation in the workspace, which is a perfectly reasonable audit surface for an admin and a mildly uncomfortable privacy surface for a regular member. If we ever need a member-safe observer view, it will be a separate, filtered feed. Until then: admin gate.":
      ". Pessoas sem perfil de administrador não veem nenhum ícone para abrir o painel: nem um placeholder. E o bloqueio no cliente é apenas metade da experiência; no servidor, o socket de eventos rejeita padrões de assinatura próprios do Observador para quem não é administrador, então abri-lo manualmente não oferece acesso adicional. Isso é intencional: o barramento transporta IDs de atores, payloads e JSON de alterações de cada mutação no espaço de trabalho. É uma superfície de auditoria adequada para um administrador, mas uma superfície de privacidade desconfortável para um membro comum. Se um dia precisarmos de uma visão segura para membros, ela será um fluxo separado e filtrado. Até lá, o acesso permanece restrito a administradores.",
  },
  "activity-history-and-audit-logs": {
    "Recorded platform mutations write durable ":
      "As mutações registradas da plataforma gravam linhas duráveis de ",
    " rows and publish live bus events. Workspace History at":
      " e publicam eventos ao vivo no bus. O Histórico do workspace em",
    " spans the workspace; a board's History tab scopes the same feed to that board. The stored feed is the source to use for audit questions after a live WebSocket event has passed.":
      " abrange todo o workspace; a aba Histórico de um quadro limita o mesmo feed àquele quadro. O feed armazenado é a fonte indicada para perguntas de auditoria depois que um evento WebSocket ao vivo já passou.",
    "History feed with entity, action, and search controls":
      "Feed de histórico com controles de entidade, ação e busca",
    "History uses server-side filters and bounded infinite scrolling rather than loading the workspace into the browser.":
      "O Histórico usa filtros do lado do servidor e rolagem infinita limitada, em vez de carregar todo o workspace no navegador.",
    "Filter controls for Entity type and Action, plus a debounced Search field for activity summaries.":
      "Controles de filtro para Tipo de entidade e Ação, além de um campo Busca com debounce para os resumos de atividade.",
    "Reverse-chronological rows grouped by date, with icons, localized messages, actor context, and relative timestamps.":
      "Linhas em ordem cronológica inversa agrupadas por data, com ícones, mensagens localizadas, contexto do autor e horários relativos.",
    "Resolvable card and note titles are links; repeated loop or cycle events can be grouped into one expandable row.":
      "Títulos resolvíveis de cartões e notas são links; eventos repetidos de um loop ou ciclo podem ser agrupados em uma linha expansível.",
    "The bottom sentinel fetches the next page when more durable history is available.":
      "O marcador inferior busca a próxima página quando existe mais histórico durável.",
    "Filtering and pagination": "Filtros e paginação",
    "Entity type, action, and search are sent as server-side query parameters. Search is debounced by 300 milliseconds. Each request asks for 50 rows using a ":
      "Tipo de entidade, ação e busca são enviados como parâmetros de consulta do servidor. A busca usa debounce de 300 milissegundos. Cada solicitação pede 50 linhas por meio de um cursor de horário ",
    " timestamp cursor, and the client retains at most three pages at once. The current History controls do not offer person or time-window selectors.":
      ", e o cliente mantém no máximo três páginas de uma vez. Os controles atuais do Histórico não oferecem seletores de pessoa nem de janela de tempo.",
    "Board History also keeps its live subscription strictly scoped to the active board. Incoming events invalidate or extend the visible feed; older rows continue through the same bounded cursor path.":
      "O Histórico do quadro também mantém a assinatura ao vivo estritamente limitada ao quadro ativo. Eventos recebidos invalidam ou ampliam o feed visível; linhas mais antigas continuam pelo mesmo caminho limitado de cursor.",
    "What a stored row carries": "O que uma linha armazenada contém",
    "Identity and ordering fields include ": "Os campos de identidade e ordenação incluem ",
    ", optional ": ", o campo opcional ",
    ", optional": ", o campo opcional ",
    ", and": " e",
    ". Display data includes a structured": ". Os dados de exibição incluem um ",
    " plus ": " estruturado junto com ",
    ", with legacy": ", com o campo legado ",
    " as fallback. ": " como fallback. ",
    ", and ": " e ",
    " preserve the structured detail needed by audit views and replay. A":
      " preservam os detalhes estruturados necessários para auditoria e reprodução. Um marcador ",
    " marker identifies API-key activity in the feed.":
      " identifica no feed a atividade feita com chave de API.",
    "Representative card-move activity": "Atividade representativa de movimentação de cartão",
    "Timeline replay": "Reprodução da linha do tempo",
    "History answers who did what; Timeline reconstructs how the board changed. Open the board route shown below from its Timeline tab or the History link. The frontend requests up to 5000 events, receives them in ascending order with a current-board baseline, and replays snapshots in the browser with transport controls and a scrubber.":
      "O Histórico responde quem fez o quê; a Linha do tempo reconstrói como o quadro mudou. Abra a rota exibida abaixo pela aba Linha do tempo ou pelo link do Histórico. O frontend solicita até 5000 eventos, recebe-os em ordem crescente com uma linha de base do quadro atual e reproduz snapshots no navegador com controles de transporte e um scrubber.",
    "Board replay route": "Rota de reprodução do quadro",
    "Replay is deliberately bounded": "A reprodução é limitada de propósito",
    "The timeline endpoint defaults to 500 rows and enforces a hard cap of 5000. Its response marks ":
      "O endpoint da linha do tempo usa 500 linhas por padrão e impõe um limite rígido de 5000. A resposta marca ",
    " when more history exists. A truncated replay is useful evidence, but it is not proof that the visible first event was the board's original state.":
      " quando existe mais histórico. Uma reprodução truncada é uma evidência útil, mas não prova que o primeiro evento visível era o estado original do quadro.",
    "Durable rows and live events are related, not identical":
      "Linhas duráveis e eventos ao vivo são relacionados, mas não idênticos",
    "Recording activity publishes a namespaced live event for that entity and action, plus a small compatibility bridge for selected legacy card and column events. The live payload contains the mutation context used for immediate UI updates; the database row adds durable identifiers, ordering, and timestamps. Use History or Timeline when exact replay matters instead of treating the observer buffer as storage.":
      "Registrar atividade publica um evento ao vivo com namespace para aquela entidade e ação, além de uma pequena ponte de compatibilidade para determinados eventos legados de cartões e colunas. O payload ao vivo contém o contexto da mutação usado para atualizações imediatas da interface; a linha do banco acrescenta identificadores duráveis, ordenação e horários. Use Histórico ou Linha do tempo quando a reprodução exata for importante, em vez de tratar o buffer do observador como armazenamento.",
  },
  "webhooks-and-external-notifications": {
    "A webhook sends selected workspace events to an external endpoint. Each active registration contains a delivery URL, a list of exact event names, and an HMAC secret. When one of those exact names is emitted, the backend makes one signed POST. There is no wildcard subscription matching and no webhook management screen in the current frontend.":
      "Um webhook envia eventos selecionados do workspace para um endpoint externo. Cada registro ativo contém uma URL de entrega, uma lista de nomes exatos de eventos e um segredo HMAC. Quando um desses nomes exatos é emitido, o backend faz um único POST assinado. Não há correspondência de assinaturas por curingas nem uma tela de gerenciamento de webhooks no frontend atual.",
    "Manage registrations through MCP": "Gerencie registros pelo MCP",
    "The complete management surface is ": "A superfície completa de gerenciamento inclui ",
    ", and ": " e ",
    ". Create requires URL, event list, and secret. List can filter by active state; get exposes delivery health but never returns the secret. Update changes only supplied fields, replaces the entire event list when":
      ". A criação exige URL, lista de eventos e segredo. A listagem pode filtrar por estado ativo; a leitura expõe a saúde de entrega, mas nunca retorna o segredo. A atualização altera somente os campos fornecidos e substitui toda a lista de eventos quando",
    " is present, rotates the secret, and can pause or resume with ":
      " está presente, troca o segredo e permite pausar ou retomar com ",
    ". Passing ":
      ". Passar ",
    " to":
      " para",
    " removes the registration for good: it accepts no other field, and an already-missing registration is treated as a converged result.":
      " remove o registro definitivamente: não aceita nenhum outro campo, e um registro já ausente é tratado como um resultado convergente.",
    "Current webhook mutation routes check workspace membership but set no minimum role. An owner, admin, member, or viewer can create, update, or delete a registration. Treat this as current behavior, not as an administrative authorization guarantee.":
      "As rotas atuais que modificam webhooks verificam a associação ao workspace, mas não exigem um nível mínimo de permissão. Proprietários, administradores, membros e visualizadores podem criar, atualizar ou excluir um registro. Esse é o comportamento atual, não uma garantia de autorização restrita a administradores.",
    "Outside development, the URL must use HTTPS. Registration and URL updates resolve the host and reject loopback, private, link-local, reserved, multicast, and other non-global addresses. An unresolved host may still be registered and will fail later at delivery time.":
      "Fora do ambiente de desenvolvimento, a URL deve usar HTTPS. O registro e as atualizações de URL resolvem o host e rejeitam endereços loopback, privados, link-local, reservados, multicast e outros não globais. Um host não resolvido ainda pode ser registrado, mas falhará mais tarde durante a entrega.",
    "The signing secret is recoverable server-side":
      "O segredo de assinatura é recuperável no servidor",
    " never returns the secret, but the backend must store it in recoverable form to calculate each HMAC. It is not an irreversibly hashed credential. Restrict database access, rotate the secret with ":
      " nunca retorna o segredo, mas o backend precisa armazená-lo de forma recuperável para calcular cada HMAC. Não é uma credencial com hash irreversível. Restrinja o acesso ao banco e troque o segredo com ",
    ", and update the receiver at the same time.":
      ", atualizando o receptor ao mesmo tempo.",
    "Supported exact event names": "Nomes exatos de eventos compatíveis",
    "Use values from the backend's ": "Use valores do enum ",
    " enum. Activity subscriptions cover the exact entity and action pairs below; direct service events cover approvals, executions, runner status, config, and cost thresholds. Bare card and column bridge names remain only for backward compatibility, so new integrations should choose the activity names.":
      " do backend. As assinaturas de atividade cobrem os pares exatos de entidade e ação abaixo; eventos diretos de serviços cobrem aprovações, execuções, estado de runners, configuração e limites de custo. Os nomes simples de ponte de cartões e colunas permanecem somente por compatibilidade, portanto novas integrações devem escolher os nomes de atividade.",
    "Current webhook event vocabulary": "Vocabulário atual de eventos de webhook",
    "Signed delivery and health": "Entrega assinada e saúde",
    "The backend serializes one JSON body containing ": "O backend serializa um corpo JSON contendo ",
    ", a UTC": ", um horário UTC ",
    ". It signs the exact raw body with HMAC-SHA256 and sends the digest as":
      ". Ele assina o corpo raw exato com HMAC-SHA256 e envia o digest como",
    ". The request also includes ": ". A solicitação também inclui ",
    ". Receivers must verify the raw body before parsing it; re-serializing JSON can change the signed bytes.":
      ". Os receptores devem verificar o corpo raw antes de interpretá-lo; serializar o JSON novamente pode alterar os bytes assinados.",
    "Signed webhook request": "Solicitação de webhook assinada",
    "Delivery has a 5-second client timeout. Any HTTP status below 400 counts as success, resets ":
      "A entrega tem timeout de cliente de 5 segundos. Qualquer status HTTP abaixo de 400 conta como sucesso, zera ",
    " to zero, and updates": " e atualiza",
    ". A timeout, network error, or status 400 and above increments ":
      ". Um timeout, erro de rede ou status 400 ou superior incrementa ",
    ". After 10 consecutive failures, the backend automatically sets ":
      ". Depois de 10 falhas consecutivas, o backend define automaticamente ",
    " to false. Inspect these fields with ": " como false. Inspecione esses campos com ",
    " or": " ou",
    ", then use ": " e depois use ",
    " to resume after correcting the receiver.":
      " para retomar após corrigir o receptor.",
    "No retry queue, outbox, or dead-letter store":
      "Sem fila de novas tentativas, outbox ou armazenamento dead-letter",
    "Each matching event gets one delivery attempt. Failed attempts are not replayed, so webhook notifications are not a durable integration log. For critical synchronization, reconcile against Activity History and treat webhook delivery as the low-latency signal.":
      "Cada evento correspondente recebe uma tentativa de entrega. Tentativas com falha não são reproduzidas, portanto notificações de webhook não formam um registro durável de integração. Para sincronização crítica, reconcilie com o Histórico de atividade e trate a entrega do webhook como o sinal de baixa latência.",
    "Registration-time URL checks are not a complete network sandbox":
      "As verificações de URL no registro não formam um sandbox de rede completo",
    "The write-time guard reduces server-side request forgery risk, but it does not eliminate DNS rebinding or redirect-to-internal behavior at delivery time. Only register receivers you control and keep the signing secret scoped to that integration.":
      "A proteção na gravação reduz o risco de falsificação de solicitações do lado do servidor, mas não elimina DNS rebinding nem redirecionamento para redes internas durante a entrega. Registre somente receptores que você controla e limite o segredo de assinatura a essa integração.",
  },
  "rollback-and-recovery-playbook": {
    "Two classes of recovery matter once you're running this in production:":
      "Duas classes de recuperação importam quando o Backplane está em produção:",
    "revert a bad deploy": "reverter um deploy problemático",
    " and ": " e ",
    "recover data from the database": "recuperar dados do banco de dados",
    ". How you do either depends on how you're hosting Backplane — a docker-compose host, a managed container platform, bare VMs behind a load balancer. The mechanics below are the general shape; where a specific platform's commands are shown, they're one example, not the only path.":
      ". A maneira de fazer cada uma depende de como você hospeda o Backplane: um host com docker-compose, uma plataforma gerenciada de contêineres ou VMs diretamente atrás de um balanceador de carga. Os procedimentos abaixo apresentam a estrutura geral; quando aparecem comandos de uma plataforma específica, eles são apenas um exemplo, não o único caminho.",
    "Reverting a bad deploy": "Reversão de um deploy problemático",
    "The backend and frontend are ordinary containers built from the images in this repo (see ":
      "O backend e o frontend são contêineres comuns criados a partir das imagens deste repositório; consulte ",
    "). \"Rolling back\" means running the previous image again, not rebuilding or reverting code:":
      ". Fazer \"rollback\" significa executar novamente a imagem anterior, não recompilar nem reverter o código:",
    "docker compose:": "docker compose:",
    " re-tag or re-pull the last known-good image and ":
      " aplique novamente a tag ou faça pull da última imagem comprovadamente funcional e execute ",
    " to recreate the affected service. If you're building locally,":
      " para recriar o serviço afetado. Se estiver compilando localmente, execute",
    " the last-good commit and rebuild.":
      " no último commit funcional e compile novamente.",
    "Any platform with revision/rollout history":
      "Qualquer plataforma com histórico de revisões ou rollouts",
    "(Kubernetes, Cloud Run, Nomad, ECS, …): use that platform's native rollback — shifting traffic or redeploying a pinned image tag — rather than rebuilding from source. Keeping the last few images around is what makes this fast.":
      "(Kubernetes, Cloud Run, Nomad, ECS, …): use o rollback nativo da plataforma, redirecionando o tráfego ou reimplantando uma tag de imagem fixada, em vez de recompilar a partir do código-fonte. Manter as últimas imagens disponíveis é o que torna esse processo rápido.",
    "On Google Cloud Run — the maintainer's own deployment target":
      "No Google Cloud Run: o ambiente de deploy usado pela equipe mantenedora",
    "On Cloud Run specifically, this is effective in seconds — traffic re-assignment, not a rebuild, and no cold-start penalty on an already-warm revision. The same \"keep the old thing running, just stop sending traffic to the new thing\" principle applies whatever you're running on.":
      "Especificamente no Cloud Run, isso entra em vigor em segundos: é um redirecionamento de tráfego, não uma recompilação, e não há penalidade de cold start em uma revisão já aquecida. O mesmo princípio de \"mantenha a versão antiga em execução e apenas pare de enviar tráfego para a nova\" se aplica a qualquer ambiente.",
    "Database recovery": "Recuperação do banco de dados",
    "Backplane runs on Postgres (16, in the provided docker-compose setup). This app has no built-in backup/restore tooling of its own — recovery is whatever backup strategy you've put in front of your Postgres instance: ":
      "O Backplane usa Postgres, versão 16 na configuração docker-compose fornecida. O aplicativo não inclui ferramentas próprias de backup e restauração; a recuperação depende da estratégia adotada para sua instância Postgres: ",
    " on a schedule, volume snapshots, or a managed Postgres provider's point-in-time recovery (PITR) if you're using one.":
      " em uma rotina programada, snapshots de volume ou recuperação pontual (PITR) do provedor Postgres gerenciado, se aplicável.",
    "Whichever mechanism you use, the same rule holds: recovery should be an out-of-place restore to a new instance or database, validated separately, then promoted. Never restore in-place over a live production database — if the restore is wrong, you want the broken original still there.":
      "Independentemente do mecanismo, a regra é a mesma: faça a restauração fora do ambiente original, em uma nova instância ou banco, valide-a separadamente e só então a promova. Nunca restaure diretamente sobre um banco de produção ativo; se a restauração estiver errada, você vai querer que o original, mesmo com problema, continue disponível.",
    "On Google Cloud SQL — the maintainer's own deployment target":
      "No Google Cloud SQL: o ambiente de deploy usado pela equipe mantenedora",
    "Verify DATABASE_URL before any Alembic invocation":
      "Verifique DATABASE_URL antes de qualquer invocação do Alembic",
    "If your Postgres instance hosts more than one database — this app plus anything else you run alongside it — Alembic obeys whatever URL":
      "Se sua instância Postgres hospeda mais de um banco, este aplicativo e qualquer outro sistema executado ao lado dele, o Alembic obedece à URL que",
    " hands it, and ": " fornece, e ",
    "it will happily migrate the wrong database":
      "migrará o banco errado sem qualquer hesitação",
    " if the env is pointing there. Before any ":
      " se o ambiente apontar para ele. Antes de executar ",
    ", an Alembic downgrade, or a manual SQL session, print the resolved URL and confirm the database name is the one you think it is. Two minutes of paranoia here beats an afternoon of cleanup.":
      ", um downgrade do Alembic ou uma sessão SQL manual, exiba a URL resolvida e confirme se o nome do banco é realmente o esperado. Dois minutos de cautela aqui evitam uma tarde inteira de correções.",
    "Database migrations do not roll back — they are superseded":
      "Migrações de banco não sofrem rollback: são substituídas por novas revisões",
    "Rolling deploys (any platform that replaces instances gradually rather than all-at-once) mean for a brief window ":
      "Deploys graduais, em qualquer plataforma que substitua instâncias progressivamente em vez de todas de uma vez, fazem com que, por um breve período, ",
    both: "tanto",
    " old and new application code run against the new schema. That is the whole reason migrations must be forward-compatible (add nullable columns, never drop read-live columns, never rename — see Migration Safety in the project's own developer docs).":
      " o código antigo quanto o novo sejam executados contra o schema novo. É por isso que as migrações devem ser compatíveis com versões anteriores: adicione colunas anuláveis, nunca remova colunas ainda lidas e nunca renomeie. Consulte Segurança de migrações na documentação de desenvolvimento do projeto.",
    "The corollary: you cannot fix a broken migration by editing the landed revision. Once a migration has been applied to production, it is a historical fact. A fix is a ":
      "A consequência é que você não pode corrigir uma migração com problema editando a revisão já aplicada. Depois que uma migração chega à produção, ela se torna um fato histórico. A correção é uma ",
    new: "nova",
    " migration that supersedes the old one — add the correction, bump the revision, deploy forward. Never run an Alembic downgrade in production. Never edit a committed migration file and redeploy. Never drop a column in the same release that stops reading it; that is a two-deploy dance, always.":
      " migração que substitui a anterior: adicione a correção, avance a revisão e faça um novo deploy. Nunca execute um downgrade do Alembic em produção. Nunca edite um arquivo de migração já commitado e faça outro deploy. Nunca remova uma coluna no mesmo release que deixa de lê-la; isso sempre exige dois deploys.",
  },
};
