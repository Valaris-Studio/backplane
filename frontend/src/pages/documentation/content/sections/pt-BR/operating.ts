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
    "Observer panel with received events, capture start time and diagnostic controls": "Painel do Observador com eventos recebidos, horário de início da captura e controles de diagnóstico",
    "A bounded view of frames received by this tab, not a saved event log.": "Uma visualização limitada das mensagens recebidas por esta aba, não um registro de eventos salvo.",
    "The panel shows All, namespace filters, search, pause and clear controls, plus connection, denial and eviction details.": "O painel mostra Todos, filtros de namespace, busca, pausa e limpeza, além de detalhes de conexão, recusa e remoção de eventos.",
    "Open the eye in the top bar to inspect WebSocket frames received by this tab. The Observer is available to workspace owners and admins. Its closed-panel badge counts retained unseen events, capped visually at 99+.": "Abra o olho na barra superior para inspecionar as mensagens WebSocket recebidas por esta aba. O Observador está disponível para proprietários e administradores do workspace. O selo do painel fechado conta eventos retidos ainda não vistos, com limite visual de 99+.",
    "What this tab received": "O que esta aba recebeu",
    "Received by this tab since marks the start of the current buffer. All clears the namespace filters and shows every retained authorized domain frame, including unknown namespaces. Namespace chips and the event-type or ID search narrow that view without changing capture.": "Recebido por esta aba desde indica o início do buffer atual. Todos limpa os filtros de namespace e mostra todas as mensagens de domínio autorizadas e retidas, incluindo namespaces desconhecidos. Os chips de namespace e a busca por tipo ou ID do evento filtram a visualização sem alterar a captura.",
    "Select a row to expand its diagnostic JSON payload. Known credential fields, bearer text and tokenized URL queries are redacted before retention. Oversized or deeply nested values are truncated and labeled. This is a bounded diagnostic projection; arbitrary free text can still be sensitive. No extra entity bodies are fetched to fill missing payloads.": "Selecione uma linha para expandir seu payload JSON de diagnóstico. Campos conhecidos de credenciais, tokens bearer e consultas de URL com tokens são ocultados antes da retenção. Valores grandes demais ou profundamente aninhados são truncados e identificados. É uma projeção de diagnóstico limitada; texto livre ainda pode ser sensível. Nenhum conteúdo adicional de entidades é buscado para completar payloads.",
    "The live buffer retains at most 1000 events and 4 MiB of projected UTF-8 data, with at most 16 KiB per frame. Pausing can retain a second 4 MiB display snapshot, for up to 8 MiB of distinct projected data. These are data limits, not total browser memory limits. Older frames are evicted when a limit is reached. Eviction counts describe this local buffer, not events lost elsewhere.": "O buffer ativo retém no máximo 1000 eventos e 4 MiB de dados UTF-8 projetados, com até 16 KiB por mensagem. Ao pausar, uma segunda cópia da visualização pode reter até 4 MiB, totalizando até 8 MiB de dados projetados distintos. Esses limites se aplicam aos dados, não à memória total do navegador. As mensagens mais antigas são removidas quando um limite é atingido. A contagem de remoções descreve este buffer local, não eventos perdidos em outros pontos.",
    "Pause, clear and reconnect": "Pausar, limpar e reconectar",
    "Pause freezes the displayed list while bounded capture continues. New arrivals remain unseen while paused, even with the panel open. Pending arrivals and evictions remain visible as counts. Resume shows the frames still retained. Arrivals while the panel is open and unpaused are treated as seen.": "Pausar congela a lista exibida enquanto a captura limitada continua. Novas chegadas permanecem não vistas durante a pausa, mesmo com o painel aberto. Novas chegadas pendentes e remoções continuam visíveis como contagens. Retomar mostra as mensagens ainda retidas. Chegadas com o painel aberto e sem pausa são consideradas vistas.",
    "Clear empties the buffer and resets its counts and capture-start time. Switching workspace, losing access, signing out or reloading also starts a fresh buffer. Data is held only in memory in this tab; it is not a saved log.": "Limpar esvazia o buffer e reinicia suas contagens e o horário de início da captura. Trocar de workspace, perder acesso, sair ou recarregar também inicia um novo buffer. Os dados ficam apenas na memória desta aba; não são um registro salvo.",
    "Connection status and subscription denial are separate from the event list. A connected socket does not prove every subscription was accepted. Its last ping describes this tab’s transport, not agent health. A filtered empty list does not mean no frames arrived. Disconnected intervals are gaps: the bus does not replay them, and the panel cannot count events it never received.": "O estado da conexão e a recusa de assinaturas são separados da lista de eventos. Um socket conectado não prova que todas as assinaturas foram aceitas. Seu último ping descreve o transporte desta aba, não a saúde dos agentes. Uma lista vazia por filtros não significa que nenhuma mensagem chegou. Intervalos desconectados são lacunas: o barramento não os reproduz, e o painel não pode contar eventos que nunca recebeu.",
    "Check delivery, then the durable record": "Confira a entrega e depois o registro persistente",
    "Use the Observer to correlate received event IDs and types with an action. Absence alone cannot distinguish an unpublished event, an authorization filter or a delivery gap. Use History, Timeline and execution records to verify committed state; every click is not guaranteed to publish an event.": "Use o Observador para relacionar IDs e tipos de eventos recebidos com uma ação. A ausência, por si só, não distingue um evento não publicado, um filtro de autorização ou uma lacuna de entrega. Use Histórico, Timeline e registros de execução para verificar o estado confirmado; não há garantia de que cada clique publique um evento.",
    "Admin access does not grant private-event access": "Acesso de administrador não concede acesso a eventos privados",
    "The server checks current authority before delivery. Another person's captured-session, device and notification events remain private even from another admin. Internal control frames are intentionally unavailable. Ordinary live updates and notifications use their own subscriptions and continue without the Observer wildcard.": "O servidor verifica a autorização atual antes da entrega. Eventos de sessões capturadas, dispositivos e notificações de outra pessoa continuam privados mesmo para outro administrador. Mensagens internas de controle são intencionalmente indisponíveis. Atualizações ao vivo e notificações comuns usam suas próprias assinaturas e continuam sem o curinga do Observador.",
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
