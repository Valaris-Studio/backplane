// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

const PT_BR_MCP_TOOL_CATALOG = {
  "Full UUID of the card.": "UUID completo do cartão.",
  "Read the effective completion policy, inheritance, capabilities and incompatibilities.": "Leia a política efetiva de conclusão, sua herança, capacidades e incompatibilidades.",
  "Read the current candidate, exact source and merge revisions, and public completion history.": "Leia o candidato atual, as revisões exatas de origem e mesclagem e o histórico público de conclusão.",
  "Submit current execution provenance for source or operator-selected evidence-only completion.": "Envie a procedência da execução atual para concluir código ou evidências selecionadas pelo operador.",
  "Request policy-authorized merge-queue landing for the current candidate.": "Solicite a mesclagem pela fila autorizada pela política para o candidato atual.",
  "Retry a failed resumable completion phase on the current candidate.": "Tente novamente uma fase de conclusão com falha que pode ser retomada no candidato atual.",
  "This iteration's execution UUID, supplied by the runner.": "UUID de execução desta iteração, fornecido pelo runner.",
  "Full source commit SHA for evidence-only work.": "SHA completo do commit de origem para trabalho com evidências.",
  "Exact artifact records: [{name, uri, sha256}].": "Registros exatos de artefatos: [{name, uri, sha256}].",
  "Named check results: [{id, source_sha, exit_code, output}].": "Resultados de verificações: [{id, source_sha, exit_code, output}].",
  "Proposed unsaved loop rails for fit or preview.": "Parâmetros propostos do loop não salvos para fit ou preview.",
  "Exact published template version; use with draft=false.": "Versão publicada exata do template; use draft=false.",
  "Select draft text with true or published text with false; rehearsals default to draft and full reads default to published.": "Selecione o rascunho com true ou o texto publicado com false; ensaios usam o rascunho e leituras completas usam a versão publicada por padrão.",
  "For fit or preview: proposed slot values. Explicit values take precedence over board autofill and template defaults.": "Para fit ou preview: valores propostos dos slots. Valores explícitos têm prioridade sobre o preenchimento do quadro e os padrões do template.",
  "Before binding, rehearse with draft=false and the exact published version. Unavailable versions conflict before writes. Lint reads the draft.": "Antes de vincular, ensaie com draft=false e a versão publicada exata. Versões indisponíveis falham antes de gravar. Lint lê o rascunho.",
  "Prerequisites follow the effective completion policy: accepted or Done release. Legacy boards still use the done-type column.": "Pré-requisitos seguem a política efetiva: liberação na aceitação ou em Done. Quadros legados continuam usando a coluna do tipo done.",


  "Browse a bounded page of workspace-level or board notes. Bodies are omitted by default; read one note with get_note(format=\"markdown\").": "Consulte uma página limitada de notas do espaço de trabalho ou do quadro. Os corpos são omitidos por padrão; leia uma nota com get_note(format=\"markdown\").",
  "Omit content bodies (default: true). Set false only when the bounded page needs raw ProseMirror bodies.": "Omite os corpos content (default: true). Use false somente quando a página limitada precisar de corpos ProseMirror sem conversão.",
  "Returns {notes, total, limit, offset, has_more, next_offset, _hint}, not a bare list. Follow next_offset with unchanged filters until has_more=false.": "Retorna {notes, total, limit, offset, has_more, next_offset, _hint}, não uma lista simples. Siga next_offset com os mesmos filtros até has_more=false.",
  "Pages are a live view, not a snapshot: restart at offset=0 if notes change during traversal. An older backend without pagination metadata fails explicitly.": "As páginas mostram dados atuais, não um retrato fixo: reinicie em offset=0 se as notas mudarem durante a consulta. Um backend antigo sem metadados de paginação falha explicitamente.",
  "card_id requires board_id and combines with q, pinned_only and kinds before pagination. Without board_id, only workspace-level notes are listed.": "card_id requer board_id e combina com q, pinned_only e kinds antes da paginação. Sem board_id, somente as notas do espaço de trabalho são listadas.",
  "Case-insensitive substring in title and plain-text body, applied before paging.": "Trecho sem distinção entre maiúsculas e minúsculas no título e no corpo em texto simples, aplicado antes da paginação.",
  "Only pinned notes when true (default: false).": "Somente notas fixadas quando true (default: false).",
  "Match any listed note kind, such as plan or review_verdict.": "Corresponde a qualquer tipo de nota listado, como plan ou review_verdict.",
  "Page size, 1–100 (default: 25).": "Tamanho da página, 1–100 (default: 25).",
  "Zero-based offset (default: 0); reuse next_offset with the same filters.": "Deslocamento a partir de zero (default: 0); reutilize next_offset com os mesmos filtros.",
  "List of card objects. Each needs column_id and title; optional: description, card_type, priority, due_date, status, labels and git_repo_slug.": "Lista de objetos de cartão. Cada um precisa de column_id e title; opcionais: description, card_type, priority, due_date, status, labels e git_repo_slug.",
  "git_repo_slug is preserved for each card. An unknown slug or a repository outside this board rejects the entire batch with 422; no cards are created. This does not change the historical create_card fallback.": "git_repo_slug é preservado em cada cartão. Um slug desconhecido ou um repositório fora deste quadro rejeita o lote inteiro com 422; nenhum cartão é criado. Isso não altera o comportamento alternativo histórico de create_card.",
  "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.": "As respostas de gravação podem conter JSON ProseMirror sem conversão, identificado por _content_format ou _description_format e _hint. Não reutilize uma resposta como markdown editável: leia get_note(format=\"markdown\") ou get_card, ou preserve seu markdown original antes de editar.",

  "Set these nullable fields to null: due_date, status, labels, pr_url, branch_name, git_repo_slug. For example, clear_fields=[\"due_date\"].":
    "Define estes campos anuláveis como null: due_date, status, labels, pr_url, branch_name, git_repo_slug. Por exemplo, clear_fields=[\"due_date\"].",
  "Omitted fields and explicit null values keep their current values. Use clear_fields to remove nullable values; setting and clearing the same field is rejected. Use description=\"\" to clear a description, and labels=[] for an empty label list.":
    "Campos omitidos e valores null explícitos mantêm seus valores atuais. Use clear_fields para remover valores anuláveis; definir e limpar o mesmo campo é rejeitado. Use description=\"\" para limpar uma descrição e labels=[] para uma lista de etiquetas vazia.",
  "List product documentation from the connected platform, including version and translation status.": "Lista a documentação do produto da plataforma conectada, incluindo versão e estado da tradução.",
  "Read a bounded Markdown section from the connected platform.": "Lê uma seção Markdown limitada da plataforma conectada.",
  "Registered documentation locale: en, es or pt-BR.": "Idioma registrado da documentação: en, es ou pt-BR.",
  "Section offset, starting at zero.": "Deslocamento de seções, começando em zero.",
  "Maximum sections to return (1–100).": "Número máximo de seções a retornar (1–100).",
  "Section slug returned by list_documentation.": "Slug da seção retornado por list_documentation.",
  "Version returned by list_documentation; a mismatch fails explicitly.": "Versão retornada por list_documentation; uma divergência falha explicitamente.",
  "Character offset for continuing a section.": "Deslocamento de caracteres para continuar uma seção.",
  "Maximum characters to return (1–30000).": "Número máximo de caracteres a retornar (1–30000).",
  "Follow next_offset with the same locale and version. No bundled documentation fallback is used.": "Siga next_offset com o mesmo idioma e versão. Não há alternativa com documentação local.",
  "Product documentation contains no workspace data. Normal authentication and MCP allowlists still apply.": "A documentação do produto não contém dados do espaço de trabalho. A autenticação normal e as listas de permissões MCP continuam valendo.",

  "Start here": "Comece aqui",
  "Work management": "Gestão do trabalho",
  "Knowledge & content": "Conhecimento e conteúdo",
  "Collaboration": "Colaboração",
  "Autonomous operations": "Operações autônomas",
  "Project Context": "Contexto do projeto",
  "Search": "Busca",
  "Assignments": "Atribuições",
  "Bulk Operations": "Operações em massa",
  "Board Health": "Integridade do quadro",
  "Server Info": "Informações do servidor",
  "Workspaces": "Espaços de trabalho",
  "Boards": "Quadros",
  "Columns": "Colunas",
  "Cards": "Cartões",
  "Card Dependencies": "Dependências de cartões",
  "Notes": "Notas",
  "Definitions": "Definições",
  "Resources": "Recursos",
  "Activity": "Atividade",
  "Teams": "Equipes",
  "Channels": "Canais",
  "Git Repos": "Repositórios Git",
  "Webhooks": "Webhooks",
  "Agents & Executions": "Agentes e execuções",
  "Approvals": "Aprovações",
  "Merge Queue": "Fila de merge",
  "Workspace Config": "Configuração do espaço de trabalho",
  "Prompt Configs": "Configurações de prompts",
  "Enqueue a card's pull request for the platform merge queue: the executor rebases and lands it once CI is green, and the reconciler moves the card to Done.":
    "Coloque o pull request de um cartão na fila de merge da plataforma: o executor faz rebase e o integra quando a CI está verde, e o reconciliador move o cartão para Done.",
  "UUID of the card the pull request belongs to.":
    "UUID do cartão ao qual o pull request pertence.",
  "UUID of the board's git repo (see list_git_repos).":
    "UUID do repositório git do quadro; consulte list_git_repos.",
  "The pull request's URL.": "URL do pull request.",
  "The pull request's head branch name.":
    "Nome da branch head do pull request.",
  "Target branch; defaults to the repo's integration branch, then its default branch.":
    "Branch de destino. Usa primeiro a branch de integração do repositório e, se ela não existir, a branch padrão.",
  "This is the INITIAL enqueue — distinct from enqueue_for_merge, which only RE-queues an existing entry after conflict consolidation.":
    "Este é o enfileiramento INICIAL. É diferente de enqueue_for_merge, que apenas coloca novamente na fila uma entrada existente após a consolidação de conflitos.",
  "Runner callers on a loop-configured board need the board's loop config to opt in with loop_landing=\"merge_queue\" — otherwise the backend rejects with loop_landing_not_enabled (per-board owner decision; humans are never gated).":
    "Runners que chamam a ferramenta em um quadro com loop configurado precisam que a configuração habilite loop_landing=\"merge_queue\". Caso contrário, o backend rejeita com loop_landing_not_enabled. Essa é uma decisão do proprietário por quadro e nunca limita pessoas.",
  "A red or pending CI blocks the merge (retryable ci_not_green state) until checks go green; repos with no CI at all merge as before.":
    "Uma CI vermelha ou pendente bloqueia o merge com o estado repetível ci_not_green até que os checks fiquem verdes. Repositórios sem CI continuam fazendo merge como antes.",
  "Idempotent: an already-queued card returns its existing entry.":
    "Idempotente: um cartão que já está na fila retorna a entrada existente.",
  "Permanently delete a workspace and everything inside it. The widest-blast-radius tool on the server — confirm the slug with list_workspaces first.":
    "Exclua permanentemente um espaço de trabalho e todo o seu conteúdo. É a ferramenta com maior alcance destrutivo do servidor; confirme primeiro o slug com list_workspaces.",
  "The URL slug identifying the workspace to delete.":
    "Slug de URL que identifica o espaço de trabalho a ser excluído.",
  "Requires workspace admin or owner rights — the backend gate is the authorization boundary.":
    "Exige permissões de admin ou proprietário do espaço de trabalho. A validação do backend é o limite de autorização.",
  "Idempotent: deleting an already-deleted workspace reports that calmly instead of erroring, so a retrying agent converges.":
    "Idempotente: excluir um espaço de trabalho já removido informa o resultado sem gerar erro, portanto um agente que repete a chamada converge.",
  "Irreversible cascade: deletes every board in the workspace (with their columns, cards, definitions, and git-repo bindings) plus the workspace's notes, resources, channels, and memberships. No undo, no archive, no export step.":
    "Cascata irreversível: exclui todos os quadros do espaço de trabalho, com colunas, cartões, definições e vínculos a repositórios git, além de notas, recursos, canais e memberships. Não há como desfazer, arquivar nem exportar antes da operação.",
  "Secrets are never returned — read a webhook's id here, then use update_webhook to rotate the secret if you need to.":
    "Secrets nunca são retornados. Leia aqui o id de um webhook e use update_webhook para trocar o secret quando necessário.",
  "Read one webhook's URL, subscribed events, active state, and delivery health (last delivery, failure count) by id.":
    "Consulte por id a URL, os eventos assinados, o estado ativo e a integridade de entrega de um webhook, incluindo a última entrega e a contagem de falhas.",
  "The workspace slug that owns the webhook.":
    "Slug do espaço de trabalho proprietário do webhook.",
  "The UUID of the webhook to read.": "UUID do webhook que será consultado.",
  "Workspace-scoped: a webhook belonging to another workspace reads as not-found, so the slug must be the one it was created under.":
    "Tem escopo de espaço de trabalho: um webhook de outro espaço retorna como not-found, portanto o slug deve ser o mesmo usado na criação.",
  "A climbing failure_count means the receiver is rejecting deliveries — check the URL and the signature verification on their side.":
    "Um failure_count crescente indica que o receptor está rejeitando entregas. Verifique a URL e a validação de assinatura no receptor.",
  "The UUID of the webhook to update.": "UUID do webhook que será atualizado.",
  "New delivery URL, re-validated against the same SSRF guard as create_webhook.":
    "Nova URL de entrega, validada novamente pela mesma proteção SSRF de create_webhook.",
  "Replacement event list — see create_webhook for the vocabulary. This replaces the subscription wholesale.":
    "Lista de eventos substituta; consulte o vocabulário em create_webhook. Ela substitui toda a assinatura.",
  "New HMAC signing secret.": "Novo secret de assinatura HMAC.",
  "False pauses deliveries without deleting the registration; true resumes.":
    "False pausa as entregas sem excluir o registro; true retoma as entregas.",
  "events REPLACES the current list, it does not merge — read the webhook first and pass the full set you want.":
    "events SUBSTITUI a lista atual, não faz merge. Leia primeiro o webhook e envie o conjunto completo que deseja manter.",
  "Rotating the secret invalidates signatures the receiver was verifying with the old one; update both sides together.":
    "Trocar o secret invalida as assinaturas que o receptor verificava com o valor anterior. Atualize os dois lados ao mesmo tempo.",
  "Workspace-scoped: a webhook belonging to another workspace reads as not-found.":
    "Tem escopo de espaço de trabalho: um webhook de outro espaço retorna como not-found.",
  "Change a webhook's URL, events, signing secret, or active state; only passed fields change. delete=true removes the registration for good instead.":
    "Altere a URL, os eventos, o secret de assinatura ou o estado ativo de um webhook; somente os campos enviados mudam. delete=true remove o registro definitivamente em vez disso.",
  "delete=true is permanent. Deliveries stop at once and the registration cannot be restored — pause with is_active=false when you may want it back.":
    "delete=true é permanente. As entregas param imediatamente e o registro não pode ser restaurado; pause com is_active=false quando puder querer recuperá-lo.",
  "True permanently removes the webhook (no undo); must be the only field besides the ids. Prefer is_active=false to pause.":
    "True remove permanentemente o webhook (sem desfazer); deve ser o único campo além dos ids. Prefira is_active=false para pausar.",
  "delete=true accepts no other field — a call mixing edits with the delete is rejected before any request is sent.":
    "delete=true não aceita nenhum outro campo: uma chamada que misture edições com a exclusão é rejeitada antes de qualquer solicitação ser enviada.",
  "Idempotent: deleting an already-gone webhook reports so calmly instead of erroring, so a retried call converges.":
    "Idempotente: excluir um webhook que já não existe informa o resultado sem gerar erro, portanto uma chamada repetida converge.",
  "Declare that one card must finish before another can start. Use when ordering work — the scheduler will not assign a card until all its prerequisites are done.":
    "Declare que um cartão deve ser concluído antes que outro possa começar. Use ao ordenar o trabalho: o scheduler não atribuirá um cartão até que todos os seus pré-requisitos estejam concluídos.",
  "URL slug identifying the workspace.": "Slug de URL que identifica o espaço de trabalho.",
  "UUID of the board (URL scope, resolved for routing).":
    "UUID do quadro (escopo da URL, resolvido para roteamento).",
  "Full UUID of the card that depends on another, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que depende de outro ou um prefixo único do id (≥4 caracteres).",
  "Full UUID of the prerequisite card, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que é pré-requisito ou um prefixo único do id (≥4 caracteres).",
  "Both card ids accept a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.":
    "Os ids dos dois cartões aceitam um prefixo curto do id (≥4 caracteres), resolvido neste quadro. Um prefixo ambíguo retorna um erro com a lista de candidatos.",
  "Idempotent: re-adding an existing edge returns the existing row instead of erroring.":
    "Idempotente: adicionar novamente uma aresta existente retorna a linha existente em vez de gerar erro.",
  "Cycles and self-dependencies are rejected with a 422 error — the graph stays acyclic.":
    "Ciclos e autodependências são rejeitados com erro 422; o grafo permanece acíclico.",
  "Edges are workspace-scoped, not board-checked: linking cards on different boards succeeds, but validate_board_dependencies flags such edges as orphans.":
    "As arestas têm escopo de espaço de trabalho, não são verificadas por quadro: vincular cartões de quadros diferentes funciona, mas validate_board_dependencies marca essas arestas como orphans.",
  "Remove a depends-on edge between two cards. Use to unblock a card when a prerequisite no longer applies.":
    "Remova uma aresta de dependência entre dois cartões. Use para desbloquear um cartão quando um pré-requisito deixar de se aplicar.",
  "UUID of the board.": "UUID do quadro.",
  "Full UUID of the dependent card, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão dependente ou um prefixo único do id (≥4 caracteres).",
  "Full UUID of the prerequisite card to unlink, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que é pré-requisito e será desvinculado ou um prefixo único do id (≥4 caracteres).",
  "Both card ids accept a short id prefix (≥4 chars), resolved against this board.":
    "Os ids dos dois cartões aceitam um prefixo curto do id (≥4 caracteres), resolvido neste quadro.",
  "Idempotent: removing an edge that does not exist succeeds as a no-op.":
    "Idempotente: remover uma aresta inexistente funciona sem produzir efeito.",
  "List a card's dependency edges in both directions: the cards it depends on and the cards it blocks. Use to inspect wiring before adding or removing edges.":
    "Liste as arestas de dependência de um cartão nos dois sentidos: os cartões dos quais ele depende e os cartões que ele bloqueia. Use para inspecionar as conexões antes de adicionar ou remover arestas.",
  "Full UUID of the card, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão ou um prefixo único do id (≥4 caracteres).",
  "card_id accepts a short id prefix (≥4 chars), resolved against this board.":
    "card_id aceita um prefixo curto do id (≥4 caracteres), resolvido neste quadro.",
  "depends_on = this card's prerequisites; blocks = cards waiting on this one.":
    "depends_on = pré-requisitos deste cartão; blocks = cartões que aguardam este cartão.",
  "Edges carry the other card's title, status, and column type — often enough without fetching each card.":
    "As arestas incluem título, status e tipo de coluna do outro cartão, o que muitas vezes evita buscar cada cartão separadamente.",
  "Check a whole board's dependency graph for cycles, conflicts, and dangling edges. Use before sprint planning or when cards seem stuck for no clear reason.":
    "Verifique o grafo de dependências de um quadro inteiro em busca de ciclos, conflitos e arestas pendentes. Use antes de planejar uma sprint ou quando cartões parecerem travados sem motivo claro.",
  "UUID of the board to validate.": "UUID do quadro que será validado.",
  "Read-only: reports faults but fixes nothing — repair with add/remove/bulk_set_card_dependencies or by moving cards.":
    "Somente leitura: informa problemas, mas não corrige nada. Repare com add/remove/bulk_set_card_dependencies ou movendo os cartões.",
  "Cards trapped in a cycle can never become eligible for pickup until the loop is broken.":
    "Cartões presos em um ciclo nunca se tornam elegíveis para atribuição até que o ciclo seja desfeito.",
  "conflicts = done cards whose prerequisites are not done; orphans = edges pointing at cards not on this board.":
    "conflicts = cartões done cujos pré-requisitos não estão done; orphans = arestas que apontam para cartões fora deste quadro.",
  "Answer whether a card is unblocked in one call: is every prerequisite done, and if not, exactly which cards still block it. Use before scheduling or picking up work.":
    "Informe em uma única chamada se um cartão está desbloqueado: todos os pré-requisitos foram concluídos? Caso contrário, quais cartões ainda o bloqueiam? Use antes de agendar ou assumir trabalho.",
  "Full UUID of the card to check, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que será verificado ou um prefixo único do id (≥4 caracteres).",
  "card_id accepts a short id prefix (≥4 chars); the returned card_id is always the resolved full UUID.":
    "card_id aceita um prefixo curto do id (≥4 caracteres); o card_id retornado é sempre o UUID completo resolvido.",
  "satisfied mirrors the exact condition the scheduler gates pickup on: every prerequisite in a done-type column.":
    "satisfied reflete a condição exata usada pelo scheduler para liberar a atribuição: todos os pré-requisitos devem estar em uma coluna do tipo done.",
  "blocking lists only the unfinished prerequisites, each with title, status, and column type — the finish-first list.":
    "blocking lista somente os pré-requisitos não concluídos, cada um com título, status e tipo de coluna: é a lista do que deve ser finalizado primeiro.",
  "Fetch the latest review verdict on a card — the decision and the reviewer's reasoning. Use during rework to learn why the card was approved or rejected.":
    "Busque o veredito de revisão mais recente de um cartão: a decisão e a justificativa de quem revisou. Use durante o retrabalho para entender por que o cartão foi aprovado ou rejeitado.",
  "Full UUID of the card whose verdict you want, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão cujo veredito você quer consultar ou um prefixo único do id (≥4 caracteres).",
  "Returns a structured 404 error when the card has never been reviewed — expect it for un-reviewed cards.":
    "Retorna um erro 404 estruturado quando o cartão nunca foi revisado; espere esse resultado em cartões sem revisão.",
  "Replace a card's entire depends-on set atomically in one call. Use when planning to declare a card's full prerequisite list instead of adding edges one by one.":
    "Substitua atomicamente todo o conjunto depends-on de um cartão em uma única chamada. Use no planejamento para declarar a lista completa de pré-requisitos, em vez de adicionar arestas uma a uma.",
  "Full UUID of the card whose dependencies you are replacing, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão cujas dependências serão substituídas ou um prefixo único do id (≥4 caracteres).",
  "Full replacement list of prerequisite cards, each a full UUID or a unique id prefix (≥4 chars). An empty list clears every dependency.":
    "Lista completa de substituição dos cartões que são pré-requisitos; cada item deve ser um UUID completo ou um prefixo único do id (≥4 caracteres). Uma lista vazia remove todas as dependências.",
  "Every id accepts a short prefix (≥4 chars), each costing one resolve round-trip — pass full UUIDs for large sets.":
    "Todo id aceita um prefixo curto (≥4 caracteres), e cada um exige uma ida e volta de resolução; use UUIDs completos em conjuntos grandes.",
  "REPLACES the whole set: edges missing from the list are removed, and an empty list clears every dependency.":
    "SUBSTITUI todo o conjunto: arestas ausentes na lista são removidas, e uma lista vazia elimina todas as dependências.",
  "All-or-nothing: the proposed set is validated for cycles before any change — on rejection existing edges are untouched.":
    "Tudo ou nada: o conjunto proposto é validado contra ciclos antes de qualquer alteração. Se for rejeitado, as arestas existentes permanecem intactas.",
  "Ask a human to approve a high-impact action (deletion, deployment, bulk change) before running it. Use when about to do something risky, then wait for the decision.":
    "Peça a uma pessoa que aprove uma ação de alto impacto (exclusão, deployment ou alteração em massa) antes de executá-la. Use quando estiver prestes a fazer algo arriscado e aguarde a decisão.",
  "Risk category: deletion, bulk_change, deployment, schema_change, permission_change, or external_action.":
    "Categoria de risco: deletion, bulk_change, deployment, schema_change, permission_change ou external_action.",
  "Human-readable description of what will happen if approved.":
    "Descrição legível do que acontecerá se a ação for aprovada.",
  "JSON payload of the action to execute once approved.":
    "Payload JSON da ação que será executada após a aprovação.",
  "UUID of the requesting agent.": "UUID do agente solicitante.",
  "Board UUID if the action is board-scoped.": "UUID do quadro se a ação tiver escopo de quadro.",
  "Do not proceed after calling — poll get_approval_status until the request is approved or rejected.":
    "Não prossiga após a chamada: consulte get_approval_status até que a solicitação seja aprovada ou rejeitada.",
  "Low-risk requests can come back auto_approved immediately, with no human involved.":
    "Solicitações de baixo risco podem retornar auto_approved imediatamente, sem intervenção humana.",
  "expires_at is stamped 24 hours out, but nothing ever flips the stored status to expired — a stale undecided request still reads pending; compare expires_at yourself.":
    "expires_at recebe uma data 24 horas à frente, mas nada altera o status armazenado para expired; uma solicitação antiga ainda sem decisão continua como pending. Compare expires_at por conta própria.",
  "List approval requests in a workspace, optionally filtered by status. Use to discover what is waiting on a decision when you have no approval id in hand.":
    "Liste as solicitações de aprovação de um espaço de trabalho, com filtro opcional por status. Use para descobrir o que aguarda decisão quando você não tiver um id de aprovação.",
  "Filter: pending, approved, rejected, expired, or auto_approved. Approvers usually want pending.":
    "Filtro: pending, approved, rejected, expired ou auto_approved. Quem aprova normalmente procura pending.",
  "status is the only filter — there is no board, agent, or category filter; scan the results yourself.":
    "status é o único filtro; não há filtro por quadro, agente ou categoria. Examine os resultados.",
  "Discover-then-decide: find pending requests here, then act on each with decide_approval.":
    "Descubra e depois decida: encontre aqui as solicitações pending e então processe cada uma com decide_approval.",
  "Check where one approval request stands: pending, approved, rejected, expired, or auto_approved. Use to poll after request_approval before acting.":
    "Consulte o estado de uma solicitação de aprovação: pending, approved, rejected, expired ou auto_approved. Use para consultar após request_approval antes de agir.",
  "Approval id returned by request_approval.": "Id de aprovação retornado por request_approval.",
  "auto_approved means policy granted it without a human — treat it as approved.":
    "auto_approved significa que a política concedeu aprovação sem uma pessoa; trate como approved.",
  "The expired status exists in the enum but the backend never sets it — a past-deadline request still reads pending. Compare expires_at yourself; if it has passed, treat the request as dead and file a fresh one.":
    "O status expired existe no enum, mas o backend nunca o define; uma solicitação cujo prazo passou continua como pending. Compare expires_at por conta própria. Se já passou, considere a solicitação encerrada e crie outra.",
  "Approve or reject a pending approval request as the human in the loop. Use after reviewing what a request asks, typically discovered via list_approvals.":
    "Aprove ou rejeite uma solicitação de aprovação pending como a pessoa responsável pela decisão. Use após revisar o pedido, normalmente encontrado com list_approvals.",
  "UUID of the approval request to decide.":
    "UUID da solicitação de aprovação que receberá a decisão.",
  "Either 'approved' or 'rejected'.": "'approved' ou 'rejected'.",
  "Reason recorded alongside the decision.": "Motivo registrado junto à decisão.",
  "Only pending requests can be decided — an already-decided one returns a 409 conflict.":
    "Somente solicitações pending podem receber decisão; uma solicitação já decidida retorna conflito 409.",
  "Expiry is not enforced here: a request past its expires_at still reads pending and can still be decided.":
    "O vencimento não é aplicado aqui: uma solicitação depois de expires_at ainda aparece como pending e ainda pode receber decisão.",
  "A decision is final: there is no un-approve or un-reject; the requester must file a new request.":
    "A decisão é definitiva: não há como desfazer approval ou rejection; o solicitante deve criar uma nova solicitação.",
  "List a workspace's in-flight merge queue entries — queued, merging, conflict, failed, or blocked. Use to see what is waiting to land or wedged.":
    "Liste as entradas em andamento da fila de merge de um espaço de trabalho: queued, merging, conflict, failed ou blocked. Use para ver o que aguarda integração ou está travado.",
  "Also return entries merged within this many hours, 1..720. Omitted, merged entries are excluded.":
    "Retorne também as entradas integradas dentro desta quantidade de horas, de 1 a 720. Quando o campo é omitido, entradas merged são excluídas.",
  "Only merged is terminal and it is excluded by default — pass merged_within_hours to see recently landed work.":
    "Somente merged é terminal e fica excluído por padrão; informe merged_within_hours para ver trabalhos integrados recentemente.",
  "blocked_pending_consolidation entries DO show up: they are still in flight, parked until their consolidator card lands.":
    "Entradas blocked_pending_consolidation SÃO exibidas: ainda estão em andamento e ficam estacionadas até que o cartão consolidador seja integrado.",
  "Entry state is a closed enum: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflict with a consolidator card on the board).":
    "O estado da entrada é um enum fechado: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflito com um cartão consolidador no quadro).",
  "Fetch one merge queue entry by id to inspect its state, branch, and attempt history. Use when triaging a specific stuck or failed merge.":
    "Busque uma entrada da fila de merge pelo id para inspecionar seu estado, branch e histórico de tentativas. Use ao analisar um merge específico travado ou com falha.",
  "UUID of the merge queue entry.": "UUID da entrada da fila de merge.",
  "Re-queue a card's existing merge-queue entry so the merge is retried, typically after a conflict was resolved. Use when a failed or conflicted merge is now fixable.":
    "Coloque novamente na fila a entrada existente de um cartão para repetir o merge, normalmente depois de resolver um conflito. Use quando um merge com falha ou conflito puder ser tentado novamente.",
  "UUID of the original (parent) card whose merge entry should be retried.":
    "UUID do cartão original (pai) cuja entrada de merge deve ser tentada novamente.",
  "Despite the name, this calls the RE-enqueue endpoint: it 404s unless a merge-queue entry already exists for the card — initial enqueueing happens inside the merge worker.":
    "Apesar do nome, esta chamada usa o endpoint de RE-enqueue: retorna 404 se ainda não existir uma entrada de fila para o cartão. O primeiro enqueue acontece dentro do merge worker.",
  "Idempotent: if the entry is already queued, the existing row is returned with no side effects.":
    "Idempotente: se a entrada já estiver queued, a linha existente será retornada sem efeitos colaterais.",
  "The retry happens on the merge worker's next tick, not immediately; each retry increments the entry's attempt count.":
    "A nova tentativa ocorre no próximo ciclo do merge worker, não imediatamente; cada tentativa incrementa o contador da entrada.",
  "No state guard: an entry in ANY non-queued state — including one already merged — is reset to queued, and the worker will attempt the merge again.":
    "Não há proteção por estado: uma entrada em QUALQUER estado diferente de queued, inclusive uma já merged, volta para queued e o worker tentará o merge novamente.",
  "Remove a merge queue entry so a wedged conflict or failure stops holding the card. Use when human triage needs to take a merge out of the automated path.":
    "Remova uma entrada da fila de merge para que um conflito ou uma falha travada deixe de reter o cartão. Use quando a triagem humana precisar retirar um merge do fluxo automatizado.",
  "UUID of the merge queue entry to cancel.": "UUID da entrada da fila de merge que será cancelada.",
  "Admin/owner only — regular workspace members get a 403.":
    "Somente admin/owner; membros comuns do espaço de trabalho recebem 403.",
  "Deletes the entry row permanently — there is no undo; re-queueing later requires the worker to create a fresh entry.":
    "Exclui permanentemente a linha da entrada; não há como desfazer. Para recolocá-la na fila depois, o worker deverá criar uma nova entrada.",
  "Only queued/merging entries hide a card from next_assignment — cancelling one of those un-hides it (other eligibility gates still apply); a conflict or failed entry was not hiding the card in the first place.":
    "Somente entradas queued/merging ocultam um cartão de next_assignment. Cancelar uma delas volta a exibi-lo (as demais condições de elegibilidade continuam valendo); uma entrada conflict ou failed não ocultava o cartão.",
  "List every workspace you can access. Use it first in a session to discover the workspace_slug that all other workspace-scoped tools require.":
    "Liste todos os espaços de trabalho acessíveis. Use primeiro em uma sessão para descobrir o workspace_slug exigido pelas demais ferramentas com escopo de espaço de trabalho.",
  "Fetch one workspace's metadata — name, slug, owner, timestamps. Use when you already know the slug and need details, not the roster or counts.":
    "Busque os metadados de um espaço de trabalho: nome, slug, owner e timestamps. Use quando já souber o slug e precisar de detalhes, não da lista de membros nem das contagens.",
  "The URL slug identifying the workspace.": "Slug de URL que identifica o espaço de trabalho.",
  "Does NOT return the member roster — use list_workspace_members for people.":
    "NÃO retorna a lista de membros; use list_workspace_members para consultar pessoas.",
  "Entity counts come back null here — only list_workspaces and get_workspace_summary compute them.":
    "As contagens de entidades retornam null aqui; somente list_workspaces e get_workspace_summary as calculam.",
  "List a workspace's members with user_id, email, name, and role. Use it to resolve a person to their user_id before participant or removal calls.":
    "Liste os membros de um espaço de trabalho com user_id, email, nome e função. Use para resolver uma pessoa para seu user_id antes de chamadas de participantes ou remoção.",
  "Case-insensitive search over member names and emails.":
    "Busca sem diferenciar maiúsculas e minúsculas nos nomes e emails dos membros.",
  "Cap on matches when query is set (default 10, max 20). Ignored without query.":
    "Limite de correspondências quando query é informada (padrão 10, máximo 20). Ignorado sem query.",
  "Passing query switches to a capped autocomplete-style match, not the full roster.":
    "Informar query muda a resposta para uma busca limitada no estilo autocomplete, não para a lista completa.",
  "Card participant tools and remove_workspace_member need the user_id returned here — get_workspace does not include members.":
    "As ferramentas de participantes de cartões e remove_workspace_member exigem o user_id retornado aqui; get_workspace não inclui membros.",
  "Identify the caller of this MCP session — your authenticated user id, email, and name. Use it to learn your own user_id or confirm which account you act as.":
    "Identifique quem chama esta sessão MCP: id, email e nome do usuário autenticado. Use para descobrir seu próprio user_id ou confirmar com qual conta está agindo.",
  "This is the USER behind the session — get_agent_config answers the different question of which runner is configured.":
    "Este é o USUÁRIO por trás da sessão; get_agent_config responde à pergunta diferente de qual runner está configurado.",
  "Get a one-call workspace overview: entity counts, recent activity, per-board stats, and a 30-day activity trend. Use before opening a board.":
    "Obtenha uma visão geral do espaço de trabalho em uma chamada: contagens de entidades, atividade recente, estatísticas por quadro e tendência de atividade em 30 dias. Use antes de abrir um quadro.",
  "Create a new workspace with you as owner. Use only when starting a new top-level tenancy — individual projects are boards inside an existing workspace.":
    "Crie um espaço de trabalho tendo você como owner. Use somente ao iniciar uma nova tenancy de nível superior; projetos individuais são quadros dentro de um espaço de trabalho existente.",
  "Display name for the workspace.": "Nome de exibição do espaço de trabalho.",
  "URL-friendly identifier; derived from name when omitted.":
    "Identificador adequado para URL; derivado do nome quando omitido.",
  "Not idempotent: if the slug is already taken you get an error payload embedding the existing workspace, not a success.":
    "Não é idempotente: se o slug já estiver em uso, você recebe um payload de erro que inclui o espaço de trabalho existente, não um sucesso.",
  "Add a user to a workspace by email, with a role. Unknown emails are auto-provisioned as new accounts — there is no invite or registration step.":
    "Adicione um usuário ao espaço de trabalho por email e função. Emails desconhecidos são provisionados automaticamente como novas contas; não há etapa de convite ou cadastro.",
  "Email address of the user to add.": "Endereço de email do usuário que será adicionado.",
  "One of owner, admin, member, viewer. Defaults to member.":
    "Um de owner, admin, member ou viewer. O padrão é member.",
  "A typo'd email silently creates a brand-new auto-provisioned account instead of failing.":
    "Um email digitado incorretamente cria silenciosamente uma nova conta provisionada, em vez de falhar.",
  "Re-adding an existing member is a silent no-op: the role you pass is IGNORED and the old role kept — this tool cannot change a member's role.":
    "Adicionar novamente um membro existente não produz efeito: a função informada é IGNORADA e a anterior é mantida. Esta ferramenta não altera a função de um membro.",
  "Caller must be a workspace admin or owner; granting the owner role is owner-only.":
    "Quem chama deve ser admin ou owner do espaço de trabalho; somente um owner pode conceder a função owner.",
  "Remove a member from a workspace by their user_id. Resolve the id from a name or email with list_workspace_members first.":
    "Remova um membro do espaço de trabalho por user_id. Primeiro resolva o id a partir do nome ou email com list_workspace_members.",
  "UUID of the user to remove (not their email).":
    "UUID do usuário que será removido (não o email).",
  "Takes a user_id UUID, not an email — look it up with list_workspace_members.":
    "Recebe um UUID user_id, não um email; consulte-o com list_workspace_members.",
  "Caller must be a workspace admin or owner. Removing an owner is owner-only, and the last owner can never be removed.":
    "Quem chama deve ser admin ou owner do espaço de trabalho. Somente owner pode remover outro owner, e o último owner nunca pode ser removido.",
  "Change an existing workspace member's role by their user_id. Resolve the id from a name or email with list_workspace_members first.":
    "Altere a função de um membro existente do espaço de trabalho por user_id. Primeiro resolva o id a partir do nome ou email com list_workspace_members.",
  "The UUID of the member whose role to change.": "UUID do membro cuja função será alterada.",
  "New role — one of owner, admin, member, viewer.": "Nova função — uma de owner, admin, member ou viewer.",
  "Role changes touching the owner role — granting it or demoting an owner — require an acting owner and are human-only: runner keys receive a 403 human_required.":
    "Mudanças que tocam a função owner — concedê-la ou rebaixar um owner — exigem um owner atuante e são exclusivamente humanas: chaves de runner recebem 403 human_required.",
  "Calling with the role the member already holds is an idempotent no-op — no activity is recorded.":
    "Chamar com a função que o membro já possui é um no-op idempotente — nenhuma atividade é registrada.",
  "List all boards in a workspace with their metadata. Use it to find a board's id or slug before making board-scoped calls.":
    "Liste todos os quadros de um espaço de trabalho com seus metadados. Use para encontrar o id ou slug de um quadro antes de chamadas com escopo de quadro.",
  "Fetch a board in one call: metadata plus every column with its cards. The primary way to read board state; shrink the payload via summary_only or titles_only.":
    "Busque um quadro em uma chamada: metadados e todas as colunas com seus cartões. É a forma principal de ler o estado do quadro; reduza o payload com summary_only ou titles_only.",
  "UUID of the board; the board's slug also works.":
    "UUID do quadro; o slug do quadro também funciona.",
  "Return per-column counts and priority/status breakdowns with no cards. Most compact.":
    "Retorne contagens por coluna e distribuições de prioridade/status sem cartões. É a forma mais compacta.",
  "Keep the cards but slim each to id/column_id/title/status/priority/card_type/labels for large boards.":
    "Mantenha os cartões, mas reduza cada um a id/column_id/title/status/priority/card_type/labels em quadros grandes.",
  "Large boards can overflow the response cap — fall back to titles_only, then summary_only.":
    "Quadros grandes podem exceder o limite da resposta; tente titles_only e depois summary_only.",
  "summary_only wins over titles_only when both are set.":
    "summary_only prevalece sobre titles_only quando ambos são definidos.",
  "Create a board in a workspace, optionally seeding its structured definition (scope, objectives, milestones, and more) in the same call.":
    "Crie um quadro em um espaço de trabalho e, opcionalmente, inicialize na mesma chamada sua definição estruturada (escopo, objetivos, marcos e mais).",
  "Display name for the board.": "Nome de exibição do quadro.",
  "URL slug for the board and the idempotency key — reuse it to make retries return the existing board.":
    "Slug de URL do quadro e chave de idempotência; reutilize-o para que novas tentativas retornem o quadro existente.",
  "Description of the board's purpose.": "Descrição da finalidade do quadro.",
  "List of tags for categorization.": "Lista de tags para categorização.",
  "Skip creating the default To Do / In Progress / Done columns.":
    "Não criar as colunas padrão To Do / In Progress / Done.",
  "High-level scope/summary for the board's definition.":
    "Escopo/resumo de alto nível da definição do quadro.",
  "Goals, as [{\"text\", \"priority\"?}].": "Objetivos, no formato [{\"text\", \"priority\"?}].",
  "Out-of-scope items, as a list of strings.": "Itens fora de escopo, como lista de strings.",
  "Milestones, as [{\"title\", \"date\", \"type\"?}].":
    "Marcos, no formato [{\"title\", \"date\", \"type\"?}].",
  "Technologies, as a list of strings.": "Tecnologias, como lista de strings.",
  "Stakeholders, as [{\"name\", \"role\"?, \"member_id\"?, \"channel_id\"?}].":
    "Stakeholders, no formato [{\"name\", \"role\"?, \"member_id\"?, \"channel_id\"?}].",
  "Hard constraints, as a list of strings.": "Restrições rígidas, como lista de strings.",
  "Locked decisions, as [{\"decision\", \"rationale\"?}].":
    "Decisões consolidadas, no formato [{\"decision\", \"rationale\"?}].",
  "Reference links, as [{\"url\", \"label\"?}].":
    "Links de referência, no formato [{\"url\", \"label\"?}].",
  "Extra key/value fields, as [{\"key\", \"value\"?}].":
    "Campos adicionais de chave/valor, no formato [{\"key\", \"value\"?}].",
  "Free-text coding standards for the definition.":
    "Padrões de código em texto livre para a definição.",
  "Raw content dict for forward-compat/unknown definition keys.":
    "Dicionário de conteúdo bruto para compatibilidade futura/chaves desconhecidas da definição.",
  "Idempotent ONLY with slug: same slug returns the existing board. Slugless calls always mint a NEW board (auto-slug, '-2' suffix on collision).":
    "Idempotente SOMENTE com slug: o mesmo slug retorna o quadro existente. Chamadas sem slug sempre criam um NOVO quadro (slug automático, sufixo '-2' em caso de colisão).",
  "Re-running with slug plus definition fields overwrites the existing board's definition — the definition upsert re-applies either way.":
    "Executar novamente com slug e campos de definição sobrescreve a definição do quadro existente; o upsert da definição é reaplicado em qualquer caso.",
  "The default To Do/In Progress/Blocked/Done columns are typed (backlog/active/blocked/done), so runner pickup works on a fresh board out of the box.":
    "As colunas padrão To Do/In Progress/Blocked/Done têm tipos (backlog/active/blocked/done), portanto a atribuição ao runner funciona imediatamente em um quadro novo.",
  "Change a board's name, description, or tags. Only fields you pass are changed; the definition is edited separately with update_definition.":
    "Altere o nome, a descrição ou as tags de um quadro. Somente os campos informados mudam; a definição é editada separadamente com update_definition.",
  "New display name.": "Novo nome de exibição.",
  "New description.": "Nova descrição.",
  "New tag list — replaces the existing list entirely.":
    "Nova lista de tags; substitui totalmente a lista existente.",
  "Per-board done merge gate: 'inherit' clears the override and uses the workspace enforce_done_merge_gate setting; 'enforced' enables it; 'off' disables it. The gate applies to runner moves into done, not human moves.":
    "Controle de merge para done por quadro: 'inherit' remove o override e usa enforce_done_merge_gate do espaço de trabalho; 'enforced' o ativa e 'off' o desativa. Aplica-se a movimentos de runners para done, não a movimentos humanos.",
  "Changing done_merge_gate requires workspace admin or owner. A board with no linked git repo remains exempt because it cannot produce a mergeable PR.":
    "Alterar done_merge_gate exige ser admin ou owner do espaço de trabalho. Um quadro sem repositório git vinculado permanece isento porque não pode gerar um PR integrável.",
  "Human keys only — the backend 403s runner callers on every board update, so a runner cannot rewrite board metadata or loosen the done-merge gate that judges its own moves.":
    "Somente chaves humanas — o backend retorna 403 para chamadores do tipo runner em qualquer atualização de quadro, então um runner não pode reescrever os metadados do quadro nem afrouxar o controle de merge para done que julga seus próprios movimentos.",
  "tags replaces the whole list — send the full set you want to keep.":
    "tags substitui a lista inteira; envie o conjunto completo que deseja manter.",
  "Freeze a board: still readable by every member, but every mutation and runner pickup is rejected with board_frozen until the workspace owner unfreezes it.":
    "Congele um quadro: ele continua legível por todos os membros, mas qualquer mutação e atribuição a runners é rejeitada com board_frozen até que o owner do espaço de trabalho o descongele.",
  "Requires workspace admin or owner. Idempotent — freezing a frozen board is a no-op.":
    "Exige admin ou owner do espaço de trabalho. É idempotente: congelar um quadro já congelado não produz efeito.",
  "Mutations on a frozen board fail with 409 and error_code board_frozen — stop retrying and surface the state instead.":
    "Mutações em um quadro congelado falham com 409 e error_code board_frozen; pare de tentar e informe esse estado.",
  "Runners stop picking up the board's cards immediately; in-flight executions may still report telemetry.":
    "Runners param imediatamente de assumir cartões do quadro; execuções em andamento ainda podem relatar telemetria.",
  "Unfreeze a frozen board, restoring all mutations and runner pickup. Workspace OWNER only — admins can freeze but not unfreeze.":
    "Descongele um quadro e restaure mutações e atribuições a runners. Somente o OWNER do espaço de trabalho; admins podem congelar, mas não descongelar.",
  "Owner-only by design: runners and admins get 403 — ask the workspace owner instead of retrying.":
    "Restrito a owner por design: runners e admins recebem 403; peça ao owner do espaço de trabalho em vez de tentar novamente.",
  "Idempotent — unfreezing an unfrozen board is a no-op.":
    "Idempotente: descongelar um quadro que já está descongelado não produz efeito.",
  "Read a board's loop-mode config: enabled flag, prompts, provider/model, tool allowlist, safety caps, and disabled_reason (why the loop last stopped).":
    "Leia a configuração de loop mode de um quadro: indicador enabled, prompts, provider/model, allowlist de ferramentas, limites de segurança e disabled_reason (por que o loop parou da última vez).",
  "Returns a 404 error payload until loop mode is first configured (board settings → Loop Mode, or PUT /loop).":
    "Retorna payload de erro 404 até que o loop mode seja configurado pela primeira vez (configurações do quadro → Loop Mode ou PUT /loop).",
  "The runner re-fetches this config at the top of every iteration — edits apply on the next cycle without a restart.":
    "O runner busca novamente esta configuração no início de cada iteração; as edições valem no próximo ciclo sem reinicialização.",
  "This is the effective config. The raw authoring state behind it — template, version, slot values, drift — is get_board_loop_binding_raw.":
    "Esta é a configuração efetiva. O estado de autoria bruto por trás dela — template, versão, valores de slot, drift — é get_board_loop_binding_raw.",
  "Edit a board's loop config and/or flip loop mode on or off. Loop agents call this with enabled=false and a concise reason when done or blocked.":
    "Edite a configuração de loop de um quadro e/ou ative ou desative o loop mode. Agentes do loop chamam esta ferramenta com enabled=false e um motivo conciso quando concluem ou ficam bloqueados.",
  "True to start/resume the loop, false to stop it. Omit to edit config without touching the state.":
    "True inicia ou retoma o loop; false o interrompe. Omita para editar a configuração sem alterar o estado.",
  "Why the loop is being turned off — stored as disabled_reason and shown on the board. Ignored when enabling.":
    "Motivo para desativar o loop; armazenado como disabled_reason e exibido no quadro. Ignorado ao ativar.",
  "The per-iteration user prompt — the loop's brain.":
    "Prompt de usuário por iteração: é o cérebro do loop.",
  "The session system prompt.": "Prompt de sistema da sessão.",
  'Coding-agent suggestion (free string; "" = runner default).':
    'Sugestão de agente de código (string livre; "" = padrão do runner).',
  "Tier alias (premium/mid/low) or a concrete model id.":
    "Alias de nível (premium/mid/low) ou id concreto do modelo.",
  "MCP tool allowlist (mcp__valaris__* names; empty list = full platform surface). Replaces the stored list.":
    "Allowlist de ferramentas MCP (nomes mcp__valaris__*; lista vazia = superfície completa da plataforma). Substitui a lista armazenada.",
  "Decline lever for the self_merge auto-relax: false keeps the board's done-merge gate armed on a save that lands on self_merge (the loop will then dead-end on its first Done move). Applies to that save only — never stored. The auto-relax itself fires only when loop_landing is passed in the same call; an inherited stored landing never relaxes. Omit to accept the default; only meaningful alongside other config fields.":
    "Alavanca de recusa para o auto-relax de self_merge: false mantém armado o portão de Concluído do quadro em um salvamento que aterrissa em self_merge (o loop então travará no seu primeiro movimento para Concluído). Aplica-se apenas àquele salvamento — nunca é armazenado. O auto-relax em si só dispara quando loop_landing vem na mesma chamada; uma aterrissagem herdada do armazenado nunca relaxa. Omita para aceitar o padrão; só faz sentido junto de outros campos de configuração.",
  "Per-process iteration cap (>= 1).":
    "Limite de iterações por processo (>= 1).",
  "Cooldown between iterations (>= 0).":
    "Intervalo entre iterações (>= 0).",
  "Per-session timeout (>= 1).": "Timeout por sessão (>= 1).",
  "Cumulative budget rail since the last enable (> 0).":
    "Limite acumulado de orçamento desde a última ativação (> 0).",
  "Failure breaker (>= 1).": "Disjuntor de falhas (>= 1).",
  "Consecutive sessions reporting outcome=blocked_on_human before the runner stops the loop with a reason naming the blocker (>= 0; 0 opts out — blocked_on_human then only parks).":
    "Quantidade de sessões consecutivas que informam outcome=blocked_on_human antes que o runner interrompa o loop com um motivo que identifica o bloqueador (>= 0; 0 desativa esse comportamento, e blocked_on_human apenas estaciona a execução).",
  '"park" (probe readiness, sleep free when nothing is actionable) or "always_run".':
    '"park" (verifica a prontidão e espera sem custo quando nada pode ser executado) ou "always_run".',
  '"human", "self_merge" (the loop agent merges its own PR — grants nothing) or "merge_queue" — the per-board opt-in for autonomous landing via the platform merge queue.':
    '"human", "self_merge" (o agente do loop integra o próprio PR e não recebe nenhuma permissão extra) ou "merge_queue": a adesão por quadro à integração autônoma pela fila de merge da plataforma.',
  '"forge_ci" requires forge CI green before the merge queue lands the PR; "none" merges without a CI gate.':
    '"forge_ci" exige CI verde no forge antes que a fila de merge integre o PR; "none" faz merge sem controle de CI.',
  'Declarative run-complete condition, {"label": ..., "exclude_column_type": "done"} — the runner evaluates it before each iteration and disables the loop itself when zero cards match, without spawning a session. It also verifies any session\'s objective_complete claim. Pass {} to clear it (omitting the field leaves it unchanged).':
    'Condição declarativa de conclusão da execução, {"label": ..., "exclude_column_type": "done"}: o runner a avalia antes de cada iteração e desativa o próprio loop quando nenhum cartão corresponde, sem iniciar uma sessão. Também verifica qualquer declaração objective_complete de uma sessão. Informe {} para removê-la; omitir o campo o mantém inalterado.',
  "Idempotent — setting the current state is a no-op (no version bump).":
    "Idempotente: definir o estado atual não produz efeito nem incrementa a versão.",
  "Enabling requires a configured non-empty loop_prompt; otherwise the backend rejects with 422.":
    "A ativação exige um loop_prompt configurado e não vazio; caso contrário, o backend rejeita com 422.",
  "Omitted means unchanged: any config field you don't pass keeps its stored value. Config edits apply on the NEXT iteration.":
    "Omitido significa inalterado: todo campo de configuração não informado preserva o valor armazenado. As edições entram em vigor na PRÓXIMA iteração.",
  "completion_query is how a curated run ends for free: zero matching cards disables the loop before any session is spawned, and refutes a session that claims objective_complete while cards remain.":
    "completion_query permite que uma execução curada termine sem custo: quando nenhum cartão corresponde, o loop é desativado antes de iniciar qualquer sessão; se ainda houver cartões, ela também refuta uma sessão que declare objective_complete.",
  "Passing nothing at all (no config field and no enabled flag) returns an error instead of a silent no-op.":
    "Não informar absolutamente nada, nem campo de configuração nem indicador enabled, retorna um erro em vez de uma operação silenciosa sem efeito.",
  "Config writes are last-write-wins — there is no optimistic lock, so coordinate prompt edits out of band.":
    "As gravações de configuração seguem a última escrita; não há bloqueio otimista, portanto coordene as edições de prompts fora desta ferramenta.",
  "Requires member or better; runner keys inherit their creating user's role.":
    "Exige member ou superior; chaves de runners herdam a função do usuário que as criou.",
  "Permanently delete a board and everything scoped to it. Use to tear down finished or sandbox boards — verify the id with list_boards first.":
    "Exclua permanentemente um quadro e tudo que pertence ao seu escopo. Use para desmontar quadros concluídos ou de sandbox; verifique primeiro o id com list_boards.",
  "board_id accepts a slug too — confirm what it resolves to before deleting.":
    "board_id também aceita um slug; confirme o que ele resolve antes de excluir.",
  "Activity and execution history survive but are unlinked from the board.":
    "O histórico de atividades e execuções é preservado, mas fica desvinculado do quadro.",
  "Irreversible cascade: deletes the board's columns, cards (with their participants and dependencies), notes, definition, git-repo bindings, and resources in one call. No undo.":
    "Cascata irreversível: exclui em uma chamada as colunas, os cartões (com participantes e dependências), as notas, a definição, os vínculos com repositórios git e os recursos do quadro. Não há como desfazer.",
  "Add a column to the end of a board. Set column_type so runner pipelines can discover the column and route cards through it.":
    "Adicione uma coluna ao final do quadro. Defina column_type para que pipelines de runners encontrem a coluna e encaminhem cartões por ela.",
  "Display name for the column.": "Nome de exibição da coluna.",
  "Semantic type: backlog, active, review, done, or blocked.":
    "Tipo semântico: backlog, active, review, done ou blocked.",
  "Hex color string for the column header.": "String de cor hexadecimal do cabeçalho da coluna.",
  "Runners resolve pipeline stages by column_type, never by column name — a column without a type is a human-only zone they ignore.":
    "Runners resolvem etapas do pipeline por column_type, nunca pelo nome da coluna; uma coluna sem tipo é uma área apenas humana que os runners ignoram.",
  "Interactive claims work by moving a card (move_card) into the column whose column_type matches the target stage, not by naming conventions.":
    "A atribuição interativa move um cartão com move_card para a coluna cujo column_type corresponde à etapa de destino, não por convenções de nome.",
  "Rename, recolor, or retype a column. Only fields you pass are changed; column_type controls whether runners see the column at all.":
    "Renomeie, recolora ou altere o tipo de uma coluna. Somente os campos informados mudam; column_type determina se os runners enxergam a coluna.",
  "The UUID of the column to update.": "UUID da coluna que será atualizada.",
  "New hex color string for the header.": "Nova string de cor hexadecimal do cabeçalho.",
  "Semantic type: backlog, active, review, done, or blocked. Pass \"null\" or \"none\" to clear it.":
    "Tipo semântico: backlog, active, review, done ou blocked. Informe \"null\" ou \"none\" para removê-lo.",
  "Clearing the type takes the literal string \"null\" (or \"none\") — a cleared column becomes a human-only zone runners no longer discover cards in.":
    "Remover o tipo exige a string literal \"null\" (ou \"none\"); uma coluna sem tipo vira uma área apenas humana na qual runners deixam de encontrar cartões.",
  "Retyping changes which pipeline stage the column represents for runners — stages resolve by column_type, not name.":
    "Alterar o tipo muda qual etapa do pipeline a coluna representa para os runners; etapas são resolvidas por column_type, não por nome.",
  "Permanently delete a column together with every card inside it. Move cards you want to keep to another column first.":
    "Exclua permanentemente uma coluna e todos os cartões nela. Primeiro mova para outra coluna os cartões que deseja preservar.",
  "The UUID of the column to delete.": "UUID da coluna que será excluída.",
  "Deletes ALL cards in the column along with it — including their participants and dependency edges. It does not reject non-empty columns; the cascade happens immediately, with no undo.":
    "Exclui TODOS os cartões da coluna junto com ela, inclusive participantes e arestas de dependência. Colunas não vazias não são rejeitadas; a cascata ocorre imediatamente e não pode ser desfeita.",
  "Set the left-to-right order of a board's columns by sending the complete ordered list of column ids.":
    "Defina a ordem das colunas de um quadro da esquerda para a direita enviando a lista completa e ordenada de ids de coluna.",
  "Every column UUID on the board, in the desired left-to-right order.":
    "Todos os UUIDs de coluna do quadro, na ordem desejada da esquerda para a direita.",
  "The backend does not validate the list: nonexistent ids are silently skipped, omitted columns keep their old positions, and ids are never checked against this board — a partial or mixed-up list yields an unpredictable order. Always send exactly this board's full column id list.":
    "O backend não valida a lista: ids inexistentes são ignorados, colunas omitidas mantêm suas posições antigas e os ids nunca são conferidos com este quadro. Uma lista parcial ou misturada produz ordem imprevisível. Sempre envie a lista completa de ids de coluna exatamente deste quadro.",
  "List every card on a board grouped by column. Use for a full-board snapshot; prefer search_cards when you only need a filtered subset.":
    "Liste todos os cartões de um quadro agrupados por coluna. Use para obter uma visão completa; prefira search_cards quando precisar apenas de um subconjunto filtrado.",
  "Fetches the entire board detail under the hood — on large boards this is a heavy response; filter with search_cards instead.":
    "Internamente busca todos os detalhes do quadro; em quadros grandes, a resposta é pesada. Use search_cards para filtrar.",
  "Fetch one card with full details and participants. Accepts a full UUID or a short id prefix (4+ chars) from a note or standup — the server resolves it.":
    "Busque um cartão com todos os detalhes e participantes. Aceita UUID completo ou prefixo curto de id (4+ caracteres) vindo de uma nota ou standup; o servidor faz a resolução.",
  "UUID of the board containing the card.": "UUID do quadro que contém o cartão.",
  "The card's full UUID, or a unique short id prefix (at least 4 characters).":
    "UUID completo do cartão ou um prefixo curto e único do id (pelo menos 4 caracteres).",
  "Anything shorter than a full 36-char UUID is treated as a prefix and resolved against this board only.":
    "Qualquer valor menor que um UUID completo de 36 caracteres é tratado como prefixo e resolvido somente neste quadro.",
  "An ambiguous prefix returns an error listing the candidate cards — retry with more characters.":
    "Um prefixo ambíguo retorna erro com a lista de cartões candidatos; tente novamente com mais caracteres.",
  "Create a single card in a chosen column. Use when adding one piece of work; for turning a plan into many cards use bulk_create_cards.":
    "Crie um único cartão em uma coluna escolhida. Use para adicionar uma unidade de trabalho; para converter um plano em vários cartões, use bulk_create_cards.",
  "UUID of the column to place the card in.": "UUID da coluna em que o cartão será colocado.",
  "Card title. Max 500 characters.":
    "Título do cartão. Máximo de 500 caracteres.",
  "Card description (supports rich text). Defaults to empty.":
    "Descrição do cartão (aceita rich text). O padrão é vazio.",
  "One of task, issue, feature, bug. Defaults to task.":
    "Um de task, issue, feature ou bug. O padrão é task.",
  "One of none, low, medium, high, urgent. Defaults to none.":
    "Um de none, low, medium, high ou urgent. O padrão é none.",
  "Due date in YYYY-MM-DD format.": "Data de vencimento no formato YYYY-MM-DD.",
  "Free-form status string. Max 255 characters — a short state label, not prose.":
    "String de status em formato livre. Máximo de 255 caracteres: um rótulo curto de estado, não um texto em prosa.",
  "List of label strings.": "Lista de strings de rótulos.",
  "On multi-repo boards, the slug of the repo this card targets. Omit on single-repo boards to use the board's primary repo.":
    "Em quadros com vários repositórios, o slug do repositório alvo deste cartão. Omita em quadros com um único repositório para usar o repositório principal.",
  "NOT idempotent: cards have no unique slug, so a retried call mints a duplicate card. Search for an existing card before re-creating.":
    "NÃO é idempotente: cartões não têm slug único; repetir a chamada cria um cartão duplicado. Busque um cartão existente antes de recriá-lo.",
  "git_repo_slug only matters on multi-repo boards; omitting it falls back to the board's primary repo.":
    "git_repo_slug só importa em quadros com vários repositórios; se omitido, usa o repositório principal do quadro.",
  "An unknown git_repo_slug is silently dropped (never a 422) — the board's primary repo applies and the drop is recorded in the activity feed.":
    "Um git_repo_slug desconhecido é descartado silenciosamente (nunca retorna 422); aplica-se o repositório principal do quadro e o descarte é registrado no feed de atividades.",
  "Change fields on an existing card — title, description, priority, labels, due date, and more. Use for edits; moving between columns is move_card.":
    "Altere campos de um cartão existente: título, descrição, prioridade, rótulos, vencimento e outros. Use para edições; para mudar de coluna, use move_card.",
  "Full UUID of the card to update, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que será atualizado ou um prefixo único do id (≥4 caracteres).",
  "New card title. Max 500 characters.":
    "Novo título do cartão. Máximo de 500 caracteres.",
  "New type: task, issue, feature, or bug.": "Novo tipo: task, issue, feature ou bug.",
  "New priority: none, low, medium, high, or urgent.":
    "Nova prioridade: none, low, medium, high ou urgent.",
  "New due date in YYYY-MM-DD format.": "Nova data de vencimento no formato YYYY-MM-DD.",
  "New status string. Max 255 characters — a short state label, not prose.":
    "Nova string de status. Máximo de 255 caracteres: um rótulo curto de estado, não um texto em prosa.",
  "New list of label strings — replaces the existing list.":
    "Nova lista de strings de rótulos; substitui a lista existente.",
  "On multi-repo boards, the slug of the repo this card targets.":
    "Em quadros com vários repositórios, o slug do repositório alvo deste cartão.",
  "URL of the pull request this card shipped as — a first-class field, not a link in the description.":
    "URL do pull request pelo qual este cartão foi entregue: é um campo próprio, não um link na descrição.",
  "Name of the branch the card's work landed on.":
    "Nome da branch em que o trabalho do cartão foi integrado.",
  "labels REPLACES the whole list; to add one label, send the existing labels plus the new one.":
    "labels SUBSTITUI a lista inteira; para adicionar um rótulo, envie os rótulos existentes junto com o novo.",
  "pr_url and branch_name are update-only — create_card has no equivalent, because the backend's create schema does not accept them.":
    "pr_url e branch_name existem somente para atualização; create_card não tem equivalentes porque o schema de criação do backend não aceita esses campos.",
  "An unrecognised field name is rejected with a 422 naming it, not silently ignored — a misspelling fails loudly instead of costing you the write.":
    "Um nome de campo não reconhecido é rejeitado com um 422 que o identifica, em vez de ser ignorado silenciosamente. Um erro de digitação falha de forma explícita, sem fazer você perder a gravação.",
  "Permanently delete a card. Use only for mistakes or truly obsolete items — finished work should instead be moved to the done column.":
    "Exclua permanentemente um cartão. Use apenas para enganos ou itens realmente obsoletos; trabalho concluído deve ser movido para a coluna done.",
  "Full UUID of the card to delete, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que será excluído ou um prefixo único do id (≥4 caracteres).",
  "Permanent — there is no undo or archive. Confirm with get_card before deleting.":
    "Permanente: não há como desfazer nem arquivar. Confirme com get_card antes de excluir.",
  "Move a card to another column and/or reorder it within one. This is how humans and interactive agents progress work through the board lifecycle.":
    "Mova um cartão para outra coluna e/ou reordene-o dentro de uma coluna. É assim que pessoas e agentes interativos avançam o trabalho pelo ciclo de vida do quadro.",
  "Full UUID of the card to move, or a unique id prefix (≥4 chars).":
    "UUID completo do cartão que será movido ou um prefixo único do id (≥4 caracteres).",
  "UUID of the target column.": "UUID da coluna de destino.",
  "Optional fractional position within the target column (a float). Omit it to append the card to the end of the column.":
    "Posição fracionária opcional dentro da coluna de destino (um float). Omita para adicionar o cartão ao final da coluna.",
  "Omit position for a plain column move — the server appends the card (max position + 1024). Pass a float only when the ordering matters: it is a fractional index, so use the midpoint between neighbors.":
    "Omita position em uma simples mudança de coluna; o servidor adiciona o cartão ao final (posição máxima + 1024). Informe um float somente quando a ordem importar: como é um índice fracionário, use o ponto médio entre os vizinhos.",
  "card_id accepts a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.":
    "card_id aceita um prefixo curto do id (≥4 caracteres), resolvido neste quadro. Um prefixo ambíguo retorna um erro com a lista de candidatos.",
  "Pick the target column by its column_type (backlog/active/review/done/blocked), never by its display name.":
    "Escolha a coluna de destino por column_type (backlog/active/review/done/blocked), nunca pelo nome exibido.",
  "A same-column move that changes position by less than 1.0 is silently treated as a no-op.":
    "Um movimento dentro da mesma coluna que altera a posição em menos de 1.0 é tratado silenciosamente como sem efeito.",
  "Runner-authenticated moves into a done-typed column hit the merge gate: 422 if the card's description has no PR URL, 409 if the PR is unmerged or lacks an approving reviewer verdict. Human sessions skip the gate.":
    "Movimentos autenticados por runner para uma coluna do tipo done passam pelo gate de merge: 422 se a descrição do cartão não tiver URL de PR; 409 se o PR não estiver merged ou não tiver veredito de aprovação de um reviewer. Sessões humanas ignoram esse gate.",
  "Interactively claiming a card = move_card to the active column + add_card_participant; runners use next_assignment instead.":
    "Assumir um cartão interativamente = move_card para a coluna active + add_card_participant; runners usam next_assignment.",
  "Add a person or agent to a card with a display role (hero = responsible). Pair with move_card when interactively claiming a card.":
    "Adicione uma pessoa ou agente a um cartão com uma função de exibição (hero = responsável). Combine com move_card ao assumir um cartão interativamente.",
  "UUID of the user or agent to add.": "UUID do usuário ou agente que será adicionado.",
  "Display role: hero (responsible), viewer, stakeholder, or helper. Defaults to hero.":
    "Função de exibição: hero (responsável), viewer, stakeholder ou helper. O padrão é hero.",
  "Pipeline-stage role string (max 64 chars), e.g. planner or implementer — set when claiming on behalf of a pipeline stage.":
    "String da função na etapa do pipeline (máximo 64 caracteres), por exemplo planner ou implementer; defina ao assumir em nome de uma etapa.",
  "Idempotent: adding an existing participant returns the card instead of erroring, so retries are safe.":
    "Idempotente: adicionar um participante existente retorna o cartão em vez de gerar erro; novas tentativas são seguras.",
  "A card has at most one hero — adding a different user with role hero returns 409 (already_claimed).":
    "Um cartão tem no máximo um hero; adicionar outro usuário com role hero retorna 409 (already_claimed).",
  "On an existing participant row, a NULL pipeline_role is backfilled in place, but a conflicting non-NULL value is preserved (not overwritten).":
    "Em uma linha de participante existente, um pipeline_role NULL é preenchido, mas um valor não NULL conflitante é preservado, não sobrescrito.",
  "Remove participants from a card: one person by user_id, or every holder of a pipeline_role. Use on rework to clear the stale implementer before it is re-claimed.":
    "Remova participantes de um cartão: uma pessoa por user_id ou todos que tenham um pipeline_role. Use ao devolver trabalho para remover o implementer obsoleto antes que ele seja assumido novamente.",
  "UUID of the one participant to remove. Pass this or pipeline_role, never both.":
    "UUID do único participante que será removido. Passe este ou pipeline_role, nunca ambos.",
  "Pipeline-stage role to clear instead of user_id: planner, implementer, reviewer, rework_mediator, or any custom role. Every holder is removed.":
    "Função da etapa do pipeline que será limpa em vez de user_id: planner, implementer, reviewer, rework_mediator ou qualquer função customizada. Todos que a tenham são removidos.",
  "Exactly one selector: pass user_id or pipeline_role — neither or both is rejected before any request is sent.":
    "Exatamente um seletor: passe user_id ou pipeline_role; nenhum ou ambos é rejeitado antes de qualquer solicitação ser enviada.",
  "pipeline_role removes every participant holding that role, and matches the pipeline_role field, not the display role (hero/viewer/stakeholder/helper).":
    "pipeline_role remove todos os participantes que tenham essa função e faz correspondência com o campo pipeline_role, não com a função de exibição (hero/viewer/stakeholder/helper).",
  "Idempotent: removing a user who is not a participant, or clearing a role nobody holds, succeeds as a no-op.":
    "Idempotente: remover um usuário que não participa, ou limpar uma função que ninguém tem, funciona sem produzir efeito.",
  "On rework, clear the stale implementer by pipeline_role rather than user_id — in multi-runner deployments the implementer is a different user than the mediator.":
    "Ao devolver trabalho, remova o implementer obsoleto por pipeline_role em vez de user_id: em implantações com vários runners o implementer é um usuário diferente do mediador.",
  "Create up to 50 cards on one board in a single call. Use when turning a plan or backlog list into cards instead of looping create_card.":
    "Crie até 50 cartões em um quadro em uma única chamada. Use ao transformar um plano ou lista de backlog em cartões, em vez de repetir create_card.",
  "Hard cap of 50 cards per request — split larger plans into batches.":
    "Limite rígido de 50 cartões por solicitação; divida planos maiores em lotes.",
  "All-or-nothing: one invalid column_id rejects the entire batch.":
    "Tudo ou nada: um column_id inválido rejeita o lote inteiro.",
  "NOT idempotent: like create_card, a retried batch creates duplicates.":
    "NÃO é idempotente: assim como create_card, repetir o lote cria duplicatas.",
  "Find cards on a board by text, priority, type, status, label, assignee, column, or overdue state. Use instead of list_cards whenever you need a subset.":
    "Encontre cartões em um quadro por texto, prioridade, tipo, status, rótulo, responsável, coluna ou atraso. Use no lugar de list_cards sempre que precisar de um subconjunto.",
  "Text to search in card titles and descriptions.":
    "Texto a buscar nos títulos e descrições dos cartões.",
  "Filter by priority: none, low, medium, high, urgent.":
    "Filtrar por prioridade: none, low, medium, high, urgent.",
  "Filter by type: task, issue, feature, bug.": "Filtrar por tipo: task, issue, feature, bug.",
  "Filter by status string.": "Filtrar pela string de status.",
  "Filter to cards carrying this label.": "Filtrar cartões que tenham este rótulo.",
  "True for cards with a hero, False for cards with no hero (helpers/viewers don't count as assigned).":
    "True para cartões com hero; False para cartões sem hero (helpers/viewers não contam como responsáveis).",
  "Filter to cards where this user/agent UUID is a participant.":
    "Filtrar cartões dos quais este UUID de usuário/agente participa.",
  "Filter to a specific column UUID.": "Filtrar por um UUID de coluna específico.",
  "Filter by semantic column type: backlog, active, review, done, blocked.":
    "Filtrar pelo tipo semântico de coluna: backlog, active, review, done, blocked.",
  "Exclude cards in columns of this semantic type.":
    "Excluir cartões em colunas deste tipo semântico.",
  "Include cards from untyped (human-only) columns. Default true; autonomous runners must pass false to keep human parking zones out of pickup scans.":
    "Incluir cartões de colunas sem tipo (somente humanas). O padrão é true; runners autônomos devem informar false para não incluir áreas humanas de espera nas buscas de trabalho.",
  "True for cards past their due date.": "True para cartões que já passaram da data de vencimento.",
  "Maximum results, 1-100. Defaults to 50.": "Máximo de resultados, de 1 a 100. O padrão é 50.",
  "Return compact cards — id, title, column_id, column_name, column_type, labels, priority, status, card_type only. Recommended for browse and triage queries; full responses carry every description and participant list.":
    "Retorne cartões compactos: somente id, title, column_id, column_name, column_type, labels, priority, status e card_type. Recomendado para consultas de navegação e triagem; respostas completas incluem todas as descrições e listas de participantes.",
  "Untyped-column cards (human scratchpad zones) are INCLUDED by default. Autonomous runners picking up work must pass include_untyped=false — those cards were deliberately parked by a human. User-facing reports can omit the flag.":
    "Cartões em colunas sem tipo (áreas de rascunho humano) são INCLUÍDOS por padrão. Runners autônomos que buscam trabalho devem informar include_untyped=false, pois esses cartões foram estacionados deliberadamente por uma pessoa. Relatórios voltados ao usuário podem omitir o indicador.",
  "Full responses include every matched card's description, so a broad label or text query on a busy board can overflow the tool-result token budget. Pass summary_only=true to browse, then get_card for the one you need.":
    "Respostas completas incluem a descrição de cada cartão correspondente; por isso, uma consulta ampla por rótulo ou texto em um quadro movimentado pode exceder o orçamento de tokens do resultado da ferramenta. Informe summary_only=true para navegar e depois use get_card no cartão necessário.",
  "Reserve the next eligible card for a runner — the pickup path. The backend applies all role filters and returns the card with its work context.":
    "Reserve o próximo cartão elegível para um runner: o caminho de atribuição. O backend aplica todos os filtros de função e retorna o cartão com seu contexto de trabalho.",
  "URL slug of the workspace to scan for eligible work.":
    "Slug de URL do espaço de trabalho que será examinado em busca de trabalho elegível.",
  "UUID of the runner requesting work.": "UUID do runner que solicita trabalho.",
  "Request a specific role instead of the runner's primary role; must be a role the runner holds in its team.":
    "Solicite uma função específica em vez da função principal do runner; deve ser uma função que o runner exerça na equipe.",
  "Restrict the scan to one board UUID. Defaults to all boards the runner can access.":
    "Restrinja a busca a um UUID de quadro. O padrão inclui todos os quadros acessíveis ao runner.",
  "Returns a bundle: reserved card + board, column, repo, default branch, effective role, stage_action verb, and a TTL'd reservation — no follow-up fetches needed to start work.":
    "Retorna um bundle com cartão reservado, quadro, coluna, repositório, branch padrão, função efetiva, verbo stage_action e uma reserva com TTL; nenhuma busca adicional é necessária para iniciar o trabalho.",
  "A {\"status\": \"no_work\"} response is normal, not an error — sleep 60-120s and retry.":
    "Uma resposta {\"status\": \"no_work\"} é normal, não um erro; aguarde 60 a 120 s e tente novamente.",
  "Idempotent while your reservation is active: repeated calls return the same card. The reservation auto-expires, so a crashed runner cannot starve the board.":
    "Idempotente enquanto sua reserva estiver ativa: chamadas repetidas retornam o mesmo cartão. A reserva expira automaticamente, portanto um runner que falhou não bloqueia o quadro indefinidamente.",
  "409 means the runner already has an in-flight execution on a different card (response carries active_card_id and execution_id) — finish or cancel that first.":
    "409 significa que o runner já tem uma execução em andamento em outro cartão (a resposta inclui active_card_id e execution_id); conclua ou cancele essa execução primeiro.",
  "A paused runner gets no_work rather than an error; 423 means the workspace cost circuit breaker tripped — no cards are handed out until it clears.":
    "Um runner pausado recebe no_work, não um erro; 423 significa que o circuit breaker de custos do espaço de trabalho foi acionado. Nenhum cartão é atribuído até que ele seja liberado.",
  "Get a full project briefing in one call: board summary, definition, notes, git repos, and recent activity. Make this the first call of any workflow.":
    "Obtenha um briefing completo do projeto em uma chamada: resumo do quadro, definição, notas, repositórios git e atividade recente. Faça desta a primeira chamada de qualquer fluxo.",
  "URL slug of the workspace.": "Slug de URL do espaço de trabalho.",
  "UUID of the board to brief on.": "UUID do quadro sobre o qual será gerado o briefing.",
  "Heavy sections are capped (25 notes, 20 activity rows, definition ~8KB). Trimmed responses carry `_..._truncated` markers and an `_hint` naming the tool that returns the full data.":
    "As seções pesadas têm limites (25 notas, 20 linhas de atividade, definição de cerca de 8 KB). Respostas reduzidas incluem marcadores `_..._truncated` e um `_hint` com a ferramenta que retorna os dados completos.",
  "The board section is always a compact per-column summary — never full cards. Use list_cards or search_cards for card detail.":
    "A seção do quadro é sempre um resumo compacto por coluna, nunca os cartões completos. Use list_cards ou search_cards para obter detalhes dos cartões.",
  "Check a board's computed health: 0-100 score, stale/overdue/unassigned cards, priority and column distribution, and velocity. Use for triage and standups.":
    "Verifique a integridade calculada de um quadro: pontuação de 0 a 100, cartões parados/atrasados/sem responsável, distribuição por prioridade e coluna e velocidade. Use em triagens e standups.",
  "UUID of the board to score.": "UUID do quadro que receberá a pontuação.",
  "Complements get_project_context — health adds the stale/overdue/velocity signals the briefing does not include.":
    "Complementa get_project_context: a integridade adiciona sinais de cartões parados, atrasados e velocidade que o briefing não inclui.",
  "Board UUID to list board-scoped notes instead of workspace-level ones.":
    "UUID do quadro para listar notas do quadro em vez das notas do espaço de trabalho.",
  "Card UUID to filter to notes linked to that card (requires board_id).":
    "UUID do cartão para filtrar notas vinculadas a ele (exige board_id).",
  "Read a single note by id. Prefer format=\"markdown\" for a readable, token-cheap body; the default returns raw ProseMirror JSON.":
    "Leia uma nota pelo id. Prefira format=\"markdown\" para obter um corpo legível e econômico em tokens; o padrão retorna JSON ProseMirror bruto.",
  "UUID of the note to read.": "UUID da nota que será lida.",
  "Board UUID if the note is board-scoped; omit for workspace notes.":
    "UUID do quadro se a nota tiver escopo de quadro; omita para notas do espaço de trabalho.",
  "\"prosemirror\" (default, raw JSON tree) or \"markdown\" (converted, readable).":
    "\"prosemirror\" (padrão, árvore JSON bruta) ou \"markdown\" (convertido e legível).",
  "format=\"markdown\" converts the stored ProseMirror document to markdown — it round-trips with the markdown create_note accepts. Use it unless you need the JSON tree.":
    "format=\"markdown\" converte o documento ProseMirror armazenado em markdown e faz round-trip com o markdown aceito por create_note. Use a menos que precise da árvore JSON.",
  "board_id only selects the URL path — the lookup is by note_id within the workspace, so a board-scoped note is also retrievable without board_id.":
    "board_id apenas escolhe o caminho da URL; a busca é feita por note_id dentro do espaço de trabalho, portanto uma nota de quadro também pode ser recuperada sem board_id.",
  "Create a note on a workspace or board, optionally linked to a card. Use for plans, briefs, decisions, or any prose worth keeping next to the work.":
    "Crie uma nota em um espaço de trabalho ou quadro, opcionalmente vinculada a um cartão. Use para planos, briefings, decisões ou qualquer texto que mereça ficar junto ao trabalho.",
  "The note title.": "Título da nota.",
  "Note body — send markdown (recommended); HTML, plain text, or ProseMirror JSON are also accepted and normalized.":
    "Corpo da nota: envie markdown (recomendado); HTML, texto simples ou JSON ProseMirror também são aceitos e normalizados.",
  "Pin the note to the top of the list.": "Fixar a nota no topo da lista.",
  "Board UUID to scope the note to a board instead of the workspace.":
    "UUID do quadro para dar à nota escopo de quadro em vez de espaço de trabalho.",
  "Card UUID to link the note to; the card must belong to the note's board (pass board_id alongside it — a workspace-level create with card_id is rejected).":
    "UUID do cartão ao qual a nota será vinculada; o cartão deve pertencer ao quadro da nota (passe board_id junto; uma criação no nível do espaço de trabalho com card_id é rejeitada).",
  "Note kind — \"user_note\" (default) for free-form prose; pipeline kinds like \"plan\", \"rework_brief\", \"review_verdict\" are structural notes consumed by runner stages.":
    "Tipo da nota: \"user_note\" (padrão) para texto livre; tipos de pipeline como \"plan\", \"rework_brief\" e \"review_verdict\" são notas estruturais consumidas pelas etapas do runner.",
  "Send content as markdown — the backend normalizes markdown, HTML, plain text, and ProseMirror JSON to canonical ProseMirror before storing (headings h1-h3, bold/italic, code, lists, links, blockquotes).":
    "Envie content como markdown; o backend normaliza markdown, HTML, texto simples e JSON ProseMirror para ProseMirror canônico antes de armazenar (títulos h1-h3, negrito/itálico, código, listas, links e citações).",
  "kind is NOT validated — any string is stored verbatim (deliberately operator-extensible), so a typo silently creates an inert note. Only known kinds (plan, rework_brief, review_verdict, system) drive pipeline behavior.":
    "kind NÃO é validado: qualquer string é armazenada literalmente (para permitir extensão pelo operador), portanto um erro de digitação cria silenciosamente uma nota inerte. Somente tipos conhecidos (plan, rework_brief, review_verdict, system) afetam o pipeline.",
  "A note created with kind=\"review_verdict\" is permanently immutable — update_note and delete_note are rejected on it.":
    "Uma nota criada com kind=\"review_verdict\" é permanentemente imutável; update_note e delete_note são rejeitados.",
  "Edit a note's title, pinned flag, card link, or body. mode picks how content lands: replace the whole body, append at the end, or rewrite one section.":
    "Edite o título, o indicador pinned, o vínculo com o cartão ou o corpo de uma nota. mode decide o que content faz: substituir o corpo inteiro, acrescentar ao final ou reescrever uma seção.",
  "Body blocks — markdown recommended, normalized like create_note. mode decides where they land: the whole body (mode=\"replace\"), after the existing body (mode=\"append\", where content is required), or under one heading (mode=\"section\").":
    "Blocos do corpo; markdown é recomendado e normalizado como em create_note. mode decide onde eles entram: o corpo inteiro (mode=\"replace\"), depois do corpo existente (mode=\"append\", em que content é obrigatório) ou abaixo de um título (mode=\"section\").",
  "\"replace\" (default) rewrites the whole body with content; \"append\" adds content blocks at the end; \"section\" rewrites only the body under anchor_heading.":
    "\"replace\" (padrão) reescreve o corpo inteiro com content; \"append\" acrescenta os blocos de content ao final; \"section\" reescreve somente o corpo abaixo de anchor_heading.",
  "mode=\"section\" only: heading text whose section is rewritten, without the leading # marks — \"Cluster I\", not \"## Cluster I\". Matching is trimmed and case-insensitive.":
    "Somente com mode=\"section\": texto do título cuja seção será reescrita, sem os sinais # iniciais: \"Cluster I\", não \"## Cluster I\". A comparação ignora espaços nas extremidades e diferenças entre maiúsculas e minúsculas.",
  "mode=\"replace\" (the default) swaps the whole body, not a merge. For logs and journals use mode=\"append\", which adds blocks after the existing body and leaves the rest untouched.":
    "mode=\"replace\" (o padrão) troca o corpo inteiro, não faz merge. Para logs e diários use mode=\"append\", que acrescenta blocos depois do corpo existente e deixa o restante intacto.",
  "mode=\"append\" is additive, not idempotent — calling it twice appends twice, and empty content is rejected. If a call's result was lost, read the note back before retrying.":
    "mode=\"append\" é aditivo, não idempotente: chamar duas vezes acrescenta o conteúdo duas vezes, e content vazio é rejeitado. Se o resultado de uma chamada foi perdido, leia a nota novamente antes de repetir.",
  "mode=\"section\" is the idempotent way to edit a status inside a long tracker: only the body under anchor_heading changes, the heading itself stays, and empty or omitted content clears the section. Replaying the same call converges.":
    "mode=\"section\" é a forma idempotente de editar um status em um tracker extenso: somente o corpo abaixo de anchor_heading muda, o título é preservado e content vazio ou omitido limpa a seção. Repetir a mesma chamada converge.",
  "A section runs to the next heading of the same or higher level, so rewriting a ## section also rewrites the ### subsections nested under it.":
    "Uma seção vai até o próximo título do mesmo nível ou de nível superior. Portanto, reescrever uma seção ## também reescreve as subseções ### contidas nela.",
  "In mode=\"section\" a heading that does not exist is a not-found error, not an insert (use mode=\"append\" to add a new section), and a heading that appears more than once is a conflict — disambiguate the headings in the note first.":
    "Com mode=\"section\", um título inexistente gera um erro not-found, não uma inserção (use mode=\"append\" para adicionar uma nova seção), e um título repetido gera conflito. Primeiro diferencie os títulos da nota.",
  "title, pinned, card_id and detach_card apply in every mode and are saved before the body operation, so a rejected append or section edit can still have changed the metadata.":
    "title, pinned, card_id e detach_card valem em todos os modos e são salvos antes da operação no corpo, portanto um append ou uma edição de seção rejeitados ainda podem ter alterado os metadados.",
  "UUID of the note to update.": "UUID da nota que será atualizada.",
  "New title for the note.": "Novo título da nota.",
  "Whether the note should be pinned.": "Se a nota deve ficar fixada.",
  "Board UUID if the note is board-scoped.": "UUID do quadro se a nota tiver escopo de quadro.",
  "Card UUID to link the note to; the card must belong to the note's board. Omit to leave any existing link untouched.":
    "UUID do cartão que será vinculado à nota; o cartão deve pertencer ao quadro da nota. Omita para não alterar o vínculo existente.",
  "Pass true to clear the note's card link (sends an explicit null). Wins over card_id if both are passed.":
    "Passe true para remover o vínculo da nota com o cartão (envia um null explícito). Vence card_id se ambos forem passados.",
  "Notes with kind=\"review_verdict\" are append-only audit records — updates are rejected with a permission error.":
    "Notas com kind=\"review_verdict\" são registros de auditoria somente de acréscimo; atualizações são rejeitadas com erro de permissão.",
  "Delete a note permanently. Use when a note is obsolete or was created by mistake.":
    "Exclua uma nota permanentemente. Use quando ela estiver obsoleta ou tiver sido criada por engano.",
  "UUID of the note to delete.": "UUID da nota que será excluída.",
  "Permanent — there is no trash or undo.": "Permanente: não há lixeira nem como desfazer.",
  "Notes with kind=\"review_verdict\" cannot be deleted — the backend rejects it with a permission error (append-only audit record).":
    "Notas com kind=\"review_verdict\" não podem ser excluídas; o backend rejeita com erro de permissão (registro de auditoria somente de acréscimo).",
  "Runner pipeline stages read structural notes (e.g. kind=plan) — deleting one can strand an in-flight card's context.":
    "Etapas do pipeline do runner leem notas estruturais (por exemplo, kind=plan); excluir uma delas pode deixar um cartão em andamento sem contexto.",
  "Read a board's definition document — the scope, goals, conventions, and structured context to load before working on the board.":
    "Leia o documento de definição de um quadro: escopo, objetivos, convenções e contexto estruturado que deve ser carregado antes de trabalhar no quadro.",
  "get_project_context embeds the definition too but truncates large fields — this call returns the full text.":
    "get_project_context também inclui a definição, mas trunca campos grandes; esta chamada retorna o texto completo.",
  "Returns a 404 if the board has no definition yet — create one with update_definition (it upserts).":
    "Retorna 404 se o quadro ainda não tiver uma definição; crie uma com update_definition, que faz upsert.",
  "Create or update a board's definition (idempotent upsert). Fields you pass are merged over the existing content; everything else is preserved.":
    "Crie ou atualize a definição de um quadro (upsert idempotente). Os campos informados são mesclados ao conteúdo existente; todo o restante é preservado.",
  "High-level scope/summary paragraph for the project.":
    "Parágrafo de escopo/resumo de alto nível do projeto.",
  "Technologies/tools, as a list of strings.": "Tecnologias/ferramentas, como lista de strings.",
  "Recorded decisions, as [{\"decision\", \"rationale\"?}].":
    "Decisões registradas, no formato [{\"decision\", \"rationale\"?}].",
  "Links and docs, as [{\"url\", \"label\"?}].":
    "Links e documentos, no formato [{\"url\", \"label\"?}].",
  "Arbitrary key/values, as [{\"key\", \"value\"?}].":
    "Chaves/valores arbitrários, no formato [{\"key\", \"value\"?}].",
  "Free-text coding standards and conventions.": "Padrões e convenções de código em texto livre.",
  "Raw content dict for keys not yet exposed as dedicated params; explicit params win on conflict.":
    "Dicionário de conteúdo bruto para chaves ainda não expostas como parâmetros dedicados; parâmetros explícitos prevalecem em caso de conflito.",
  "Upsert — creates the definition if the board has none yet.":
    "Upsert: cria a definição se o quadro ainda não tiver uma.",
  "Merge is shallow and per-key: sending a list field replaces that whole list, so read-modify-write when appending.":
    "O merge é superficial e por chave: enviar um campo de lista substitui a lista inteira. Para acrescentar, leia, modifique e escreva.",
  "Explicit structured params override the same key passed inside content.":
    "Parâmetros estruturados explícitos substituem a mesma chave informada em content.",
  "Browse files and folders in a workspace or board, or search them by name, type, or tag. Use before downloading or organizing attachments.":
    "Navegue por arquivos e pastas de um espaço de trabalho ou quadro, ou busque por nome, tipo ou tag. Use antes de baixar ou organizar anexos.",
  "Board UUID to list board-scoped resources instead of workspace-level ones.":
    "UUID do quadro para listar recursos do quadro em vez dos recursos do espaço de trabalho.",
  "Folder UUID to list that folder's children.": "UUID da pasta para listar seus itens filhos.",
  "Filter resources by name.": "Filtrar recursos pelo nome.",
  "Filter by type — \"file\" or \"folder\".": "Filtrar por tipo: \"file\" ou \"folder\".",
  "Filter by metadata tag.": "Filtrar pela tag de metadados.",
  "Without filters it returns only root-level resources — pass parent_id to descend into a folder.":
    "Sem filtros, retorna apenas recursos no nível raiz; informe parent_id para entrar em uma pasta.",
  "When search/resource_type/tag filters are set, parent_id is ignored — filtered queries search the whole scope.":
    "Quando os filtros search/resource_type/tag são definidos, parent_id é ignorado; consultas filtradas pesquisam todo o escopo.",
  "Fetch one resource's record — name, type, size, MIME type, storage path, tags, description. Use before updating or downloading it.":
    "Busque o registro de um recurso: nome, tipo, tamanho, MIME type, caminho de armazenamento, tags e descrição. Use antes de atualizar ou baixar.",
  "UUID of the resource.": "UUID do recurso.",
  "Board UUID if the resource is board-scoped.": "UUID do quadro se o recurso tiver escopo de quadro.",
  "Returns the metadata record only — use get_download_url to fetch the file's contents.":
    "Retorna somente o registro de metadados; use get_download_url para buscar o conteúdo do arquivo.",
  "Register a file or folder in the resource library. For uploads: call get_upload_url, PUT the file, then pass the returned gcs_path here.":
    "Registre um arquivo ou pasta na biblioteca de recursos. Para uploads: chame get_upload_url, envie o arquivo com PUT e informe aqui o gcs_path retornado.",
  "The resource name.": "Nome do recurso.",
  "\"file\" (default) or \"folder\".": "\"file\" (padrão) ou \"folder\".",
  "Parent folder UUID for nesting.": "UUID da pasta pai para aninhamento.",
  "Optional description of the resource.": "Descrição opcional do recurso.",
  "Metadata dict — only {\"tags\": [...]} is kept (max 20 tags, 50 chars each).":
    "Dicionário de metadados; somente {\"tags\": [...]} é preservado (máximo de 20 tags, 50 caracteres cada).",
  "Storage path returned by get_upload_url; required to link an uploaded file.":
    "Caminho de armazenamento retornado por get_upload_url; obrigatório para vincular um arquivo enviado.",
  "Board UUID to scope the resource to a board instead of the workspace.":
    "UUID do quadro para dar ao recurso escopo de quadro em vez de espaço de trabalho.",
  "metadata is validated to a closed shape — only the \"tags\" key survives; any other key is silently dropped.":
    "metadata é validado com formato fechado: somente a chave \"tags\" sobrevive; qualquer outra chave é descartada silenciosamente.",
  "parent_id must reference a folder-type resource in the same workspace.":
    "parent_id deve apontar para um recurso do tipo folder no mesmo espaço de trabalho.",
  "A file created without gcs_path gets a generated storage path with no uploaded bytes behind it — get_download_url on it will not serve a file.":
    "Um arquivo criado sem gcs_path recebe um caminho de armazenamento gerado sem bytes enviados; get_download_url não servirá um arquivo.",
  "Rename, re-describe, re-tag, or move a resource to another folder. Only fields you pass are changed.":
    "Renomeie, altere a descrição ou as tags, ou mova um recurso para outra pasta. Somente os campos informados mudam.",
  "UUID of the resource to update.": "UUID do recurso que será atualizado.",
  "New resource name.": "Novo nome do recurso.",
  "Metadata dict, shallow-merged over the existing one; only tags are kept.":
    "Dicionário de metadados, mesclado superficialmente ao existente; somente tags são preservadas.",
  "Folder UUID to move the resource into.": "UUID da pasta para a qual o recurso será movido.",
  "metadata is shallow-merged per key, then validated — only the tags key survives, and a tags array you send replaces the ENTIRE existing list. To append a tag, read the resource first and send old + new tags together.":
    "metadata é mesclado superficialmente por chave e depois validado; somente a chave tags sobrevive, e um array de tags enviado SUBSTITUI toda a lista existente. Para acrescentar uma tag, leia primeiro o recurso e envie as tags antigas junto com a nova.",
  "Moves are cycle-checked: the new parent must be a folder and cannot sit inside the resource being moved.":
    "Movimentos são verificados contra ciclos: o novo pai deve ser uma pasta e não pode estar dentro do próprio recurso movido.",
  "Mint a signed URL for uploading a file. PUT the file bytes to the URL, then register it with create_resource using the returned gcs_path.":
    "Emita uma URL assinada para upload de arquivo. Envie os bytes com PUT para a URL e depois registre o arquivo com create_resource usando o gcs_path retornado.",
  "File name, e.g. \"report.pdf\".": "Nome do arquivo, por exemplo, \"report.pdf\".",
  "MIME type, e.g. \"application/pdf\" or \"image/png\".":
    "MIME type, por exemplo, \"application/pdf\" ou \"image/png\".",
  "Board UUID to scope the upload to a board.": "UUID do quadro para dar ao upload escopo de quadro.",
  "The signed URL expires after 15 minutes — upload promptly.":
    "A URL assinada expira após 15 minutos; faça o upload prontamente.",
  "Your PUT must send the same Content-Type the URL was signed for, or storage rejects it.":
    "Seu PUT deve enviar o mesmo Content-Type usado para assinar a URL, ou o armazenamento rejeitará a solicitação.",
  "Uploading alone does not create a resource — the file is invisible to the platform until create_resource registers the gcs_path.":
    "Fazer upload não cria um recurso por si só; o arquivo fica invisível para a plataforma até create_resource registrar o gcs_path.",
  "Mint a signed URL (valid 1 hour) to download a file resource's contents. Use after list_resources or get_resource identifies the file.":
    "Emita uma URL assinada (válida por 1 hora) para baixar o conteúdo de um recurso de arquivo. Use depois que list_resources ou get_resource identificar o arquivo.",
  "UUID of the file resource.": "UUID do recurso de arquivo.",
  "Errors only when the resource has no storage path — in practice, folders. A file registered without an actual upload still returns a URL; the download itself then fails because no bytes were ever written.":
    "Só retorna erro quando o recurso não tem caminho de armazenamento, na prática pastas. Um arquivo registrado sem upload real ainda retorna uma URL, mas o download falha porque nenhum byte foi gravado.",
  "The URL expires after 1 hour.": "A URL expira após 1 hora.",
  "Delete a resource record permanently. Use for obsolete files or folders.":
    "Exclua permanentemente o registro de um recurso. Use para arquivos ou pastas obsoletos.",
  "UUID of the resource to delete.": "UUID do recurso que será excluído.",
  "Permanent — no trash or undo.": "Permanente: não há lixeira nem como desfazer.",
  "Deletes only the platform record; the uploaded file stays in cloud storage.":
    "Exclui somente o registro da plataforma; o arquivo enviado permanece no armazenamento em nuvem.",
  "Deleting a folder that still has children fails — move or delete its contents first.":
    "Excluir uma pasta que ainda tem itens filhos falha; primeiro mova ou exclua seu conteúdo.",
  "List the teams in a workspace with their members and board assignments. Use to see which runner crews exist before staffing or binding one to a board.":
    "Liste as equipes de um espaço de trabalho com seus membros e quadros atribuídos. Use para ver quais grupos de runners existem antes de alocar pessoas ou vinculá-los a um quadro.",
  "The workspace slug to list teams for.": "Slug do espaço de trabalho cujas equipes serão listadas.",
  "Include deactivated teams (default false).": "Incluir equipes desativadas (padrão false).",
  "Deactivated teams are hidden unless include_inactive is true.":
    "Equipes desativadas ficam ocultas, a menos que include_inactive seja true.",
  "Fetch one team's full profile: members, their roles, and board scope. Use before changing membership so you know each member's current roles.":
    "Busque o perfil completo de uma equipe: membros, funções e escopo de quadros. Use antes de alterar membros para saber as funções atuais de cada integrante.",
  "The workspace slug the team belongs to.": "Slug do espaço de trabalho ao qual a equipe pertence.",
  "The UUID of the team to retrieve.": "UUID da equipe que será buscada.",
  "Read the current roles here before calling add_team_member — a re-add replaces a member's roles rather than appending.":
    "Leia aqui as funções atuais antes de chamar add_team_member; adicionar novamente substitui as funções do membro em vez de acrescentar.",
  "Create a team of runners in a workspace, optionally scoped to one board. Use when setting up a runner crew before assigning members and roles.":
    "Crie uma equipe de runners em um espaço de trabalho, opcionalmente restrita a um quadro. Use ao preparar um grupo de runners antes de atribuir membros e funções.",
  "The workspace slug.": "Slug do espaço de trabalho.",
  "Team name.": "Nome da equipe.",
  "What this team does (default empty).": "O que esta equipe faz (padrão vazio).",
  "Board UUID to scope the team to one board; omit for a workspace-wide team.":
    "UUID do quadro para restringir a equipe a um quadro; omita para uma equipe válida em todo o espaço de trabalho.",
  "The team starts empty — follow up with add_team_member to give it runners and roles.":
    "A equipe começa vazia; em seguida, use add_team_member para atribuir runners e funções.",
  "Rename a team, change its description, or re-scope it to a different board. Only the fields you pass are changed.":
    "Renomeie uma equipe, altere sua descrição ou mude seu escopo para outro quadro. Somente os campos informados são alterados.",
  "The UUID of the team to update.": "UUID da equipe que será atualizada.",
  "New team name.": "Novo nome da equipe.",
  "New board UUID to scope the team to.": "Novo UUID de quadro ao qual a equipe ficará restrita.",
  "You cannot un-scope a team back to workspace-wide here — a null board_id is dropped by the tool; use the UI/REST for that.":
    "Não é possível devolver uma equipe ao escopo de todo o espaço de trabalho por aqui; um board_id null é descartado pela ferramenta. Use UI/REST.",
  "Reactivating a deactivated team is also not exposed here (no is_active field) — use the UI/REST.":
    "Reativar uma equipe desativada também não está disponível aqui (não há campo is_active); use UI/REST.",
  "Soft-disable a team so it drops out of active listings. Use to retire a crew without losing its membership history — this is the off switch, not a delete.":
    "Desative uma equipe sem excluí-la para que ela deixe as listagens ativas. Use para aposentar um grupo sem perder o histórico de membros; é um desligamento, não uma exclusão.",
  "The UUID of the team to deactivate.": "UUID da equipe que será desativada.",
  "Not a delete: the team and its member records remain, hidden from list_teams unless include_inactive is true.":
    "Não é uma exclusão: a equipe e seus registros de membros permanecem, ocultos de list_teams a menos que include_inactive seja true.",
  "No MCP reactivation path — update_team does not expose is_active, so re-enabling the team needs the UI/REST.":
    "Não há reativação via MCP; update_team não expõe is_active, portanto reativar exige UI/REST.",
  "Add a runner to a team with one or more roles, or change an existing member's roles. Use when staffing a team for pipeline work.":
    "Adicione um runner a uma equipe com uma ou mais funções, ou altere as funções de um membro existente. Use ao formar uma equipe para trabalho de pipeline.",
  "The UUID of the team.": "UUID da equipe.",
  "The UUID of the runner to add.": "UUID do runner que será adicionado.",
  "Roles to grant, matched against the workspace's pipeline roles (default pipeline: planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler). Free-form strings are accepted; roles not in the pipeline are flagged not_in_pipeline in the response.":
    "Funções a conceder, comparadas com as funções do pipeline do espaço de trabalho (pipeline padrão: planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler). Strings livres são aceitas; funções fora do pipeline são marcadas como not_in_pipeline na resposta.",
  "Single role (legacy backward-compat — prefer roles).":
    "Função única (compatibilidade legada; prefira roles).",
  "Re-adding an existing member REPLACES their roles — send the union of old and new roles, not just the addition.":
    "Adicionar novamente um membro existente SUBSTITUI suas funções; envie a união das funções antigas e novas, não apenas a nova.",
  "Role uniqueness is pipeline-config-driven: roles whose stage is marked unique (all seven default pipeline roles) allow one runner per team; roles not flagged unique allow several.":
    "A unicidade de funções é determinada pela configuração do pipeline: funções cuja etapa está marcada como unique (as sete funções padrão) permitem um runner por equipe; funções não marcadas permitem vários.",
  "Omitting both roles and role defaults the member to [\"custom\"] — that is NOT role-agnostic (custom is not a pipeline role). The backend treats an empty roles list as claim-every-pipeline-role, but this tool never sends one; pass explicit roles for pipeline members.":
    "Omitir roles e role atribui [\"custom\"] ao membro; isso NÃO significa ausência de função (custom não é uma função do pipeline). O backend trata uma lista roles vazia como permissão para assumir todas as funções, mas esta ferramenta nunca envia uma; informe funções explícitas para membros do pipeline.",
  "Remove a runner from a team. Use when unstaffing a crew or freeing a unique pipeline role (planner, reviewer, ...) for another runner.":
    "Remova um runner de uma equipe. Use ao retirar alguém do grupo ou liberar uma função única do pipeline (planner, reviewer, ...) para outro runner.",
  "The UUID of the runner to remove.": "UUID do runner que será removido.",
  "Only the team membership is removed — the runner itself keeps existing and stays on its other teams.":
    "Somente o vínculo com a equipe é removido; o runner continua existindo e permanece em suas outras equipes.",
  "List a workspace's contact channels (email, Slack, phone, and more). Use to find out how to reach the humans behind a project.":
    "Liste os canais de contato de um espaço de trabalho (email, Slack, telefone e outros). Use para descobrir como falar com as pessoas por trás de um projeto.",
  "Register a contact point (email, Slack, WhatsApp, phone, website, other) in a workspace. Use during project setup so agents know how to reach people.":
    "Registre um ponto de contato (email, Slack, WhatsApp, telefone, site ou outro) em um espaço de trabalho. Use durante a configuração para que agentes saibam como contatar pessoas.",
  "Display name for the channel.": "Nome de exibição do canal.",
  "One of: email, slack, whatsapp, phone, website, other.":
    "Um de: email, slack, whatsapp, phone, website, other.",
  "The contact address or identifier (e.g. email address, phone number).":
    "Endereço ou identificador de contato (por exemplo, email ou número de telefone).",
  "What this channel is for (default empty).": "Finalidade deste canal (padrão vazio).",
  "Dict of extra metadata to attach to the channel.":
    "Dicionário de metadados adicionais que serão anexados ao canal.",
  "Change a channel's name, type, contact address, description, or metadata. Only the fields you pass are changed.":
    "Altere nome, tipo, endereço de contato, descrição ou metadados de um canal. Somente os campos informados são alterados.",
  "The UUID of the channel to update.": "UUID do canal que será atualizado.",
  "New display name for the channel.": "Novo nome de exibição do canal.",
  "New type (email, slack, whatsapp, phone, website, other).":
    "Novo tipo (email, slack, whatsapp, phone, website, other).",
  "New contact address or identifier.": "Novo endereço ou identificador de contato.",
  "Metadata dict, shallow-merged key by key with the existing metadata.":
    "Dicionário de metadados, mesclado superficialmente chave a chave com os metadados existentes.",
  "metadata_json is shallow-merged — only the keys you send are replaced; set a key to null to remove it.":
    "metadata_json é mesclado superficialmente; somente as chaves enviadas são substituídas. Defina uma chave como null para removê-la.",
  "Delete a contact channel from a workspace. Use when a contact point is obsolete or was created by mistake.":
    "Exclua um canal de contato de um espaço de trabalho. Use quando o ponto de contato estiver obsoleto ou tiver sido criado por engano.",
  "The UUID of the channel to delete.": "UUID do canal que será excluído.",
  "Permanent — there is no undo or soft-delete for channels.":
    "Permanente: não há como desfazer nem soft-delete para canais.",
  "List the git repositories linked to a board, with URLs, slugs, and branch settings. Use to see which repos cards can target before assigning work.":
    "Liste os repositórios git vinculados a um quadro, com URLs, slugs e configurações de branch. Use para ver quais repositórios os cartões podem usar antes de atribuir trabalho.",
  "The UUID of the board.": "UUID do quadro.",
  "On multi-repo boards, each repo's slug is what cards reference through their git_repo_slug field.":
    "Em quadros com vários repositórios, o slug de cada repositório é o valor referenciado pelos cartões em git_repo_slug.",
  "Link a git repository to a board so cards and runners can target real branches and PRs. Use during board setup, before launching autonomous work.":
    "Vincule um repositório git a um quadro para que cartões e runners possam usar branches e PRs reais. Faça isso ao configurar o quadro, antes de iniciar trabalho autônomo.",
  "Display name for the repository.": "Nome de exibição do repositório.",
  "The repository URL (e.g. https://github.com/org/repo).":
    "URL do repositório (por exemplo, https://github.com/org/repo).",
  "Hosting provider: github, gitlab, bitbucket, gitea, or other.":
    "Provedor de hospedagem: github, gitlab, bitbucket, gitea ou other.",
  "The default branch name (default \"main\").": "Nome da branch padrão (padrão \"main\").",
  "What this repository holds (default empty).": "O que este repositório contém (padrão vazio).",
  "When true (default), the runner ensures branch protection on default_branch at first clone.":
    "Quando true (padrão), o runner garante branch protection em default_branch no primeiro clone.",
  "Explicit URL slug (lowercase alphanum + hyphens); derived from name when omitted.":
    "Slug de URL explícito (letras minúsculas, números e hífens); derivado do nome quando omitido.",
  "require_branch_protection defaults to true so runner auto-merge has protection to arm against — set false for legacy or human-owned repos where flipping protection would disrupt workflows.":
    "require_branch_protection usa true por padrão para que o auto-merge dos runners tenha uma proteção na qual se apoiar; defina false em repositórios legados ou geridos por pessoas, onde ativá-la interromperia fluxos.",
  "On multi-repo boards, slug is the per-card selector (card.git_repo_slug); pick it deliberately.":
    "Em quadros com vários repositórios, slug é o seletor por cartão (card.git_repo_slug); escolha-o deliberadamente.",
  "integration_branch cannot be set at creation — link the repo first, then set it with update_git_repo.":
    "integration_branch não pode ser definida na criação; vincule primeiro o repositório e depois defina-a com update_git_repo.",
  "Change a linked repo's URL, branches, protection policy, or slug. Only the fields you pass are changed — and this is where integration_branch is set.":
    "Altere URL, branches, política de proteção ou slug de um repositório vinculado. Somente os campos informados mudam; é aqui que integration_branch é definida.",
  "The UUID of the git repo to update.": "UUID do repositório git que será atualizado.",
  "New display name for the repository.": "Novo nome de exibição do repositório.",
  "New repository URL.": "Nova URL do repositório.",
  "New provider (github, gitlab, bitbucket, gitea, other).":
    "Novo provedor (github, gitlab, bitbucket, gitea, other).",
  "New default branch name.": "Novo nome da branch padrão.",
  "Staging branch parallel runners base new work on instead of default_branch.":
    "Branch de staging na qual runners paralelos baseiam novo trabalho em vez de default_branch.",
  "Toggle the branch-protection policy.": "Ativar ou desativar a política de branch protection.",
  "New URL slug (lowercase alphanum + hyphens, unique within the board).":
    "Novo slug de URL (letras minúsculas, números e hífens; único no quadro).",
  "integration_branch only takes effect for pipeline stages configured with git.base_ref=\"integration_branch\"; leave it unset to keep forking from default_branch.":
    "integration_branch só é usada por etapas do pipeline configuradas com git.base_ref=\"integration_branch\"; deixe sem valor para continuar criando branches a partir de default_branch.",
  "Re-slugging a repo on a multi-repo board changes which cards' git_repo_slug resolve to it — update affected cards too.":
    "Alterar o slug de um repositório em um quadro com vários repositórios muda quais git_repo_slug de cartões apontam para ele; atualize também os cartões afetados.",
  "Unlink a git repository from a board. Use when the board should stop targeting a repo — the repository itself is never touched.":
    "Desvincule um repositório git de um quadro. Use quando o quadro não deve mais apontar para esse repositório; o repositório em si nunca é alterado.",
  "The UUID of the git repo to unlink.": "UUID do repositório git que será desvinculado.",
  "Removes only the board binding — the remote repository, its branches, and PRs are untouched.":
    "Remove somente o vínculo com o quadro; o repositório remoto, suas branches e PRs permanecem intactos.",
  "Cards whose git_repo_slug pointed at this repo stop being schedulable: on next pickup the scheduler parks them with the repo-slug-unresolved label. Re-link a repo with the same slug (or fix the cards) and remove the label to recover.":
    "Cartões cujo git_repo_slug apontava para esse repositório deixam de ser agendáveis: na próxima atribuição, o scheduler os estaciona com o rótulo repo-slug-unresolved. Vincule novamente um repositório com o mesmo slug (ou corrija os cartões) e remova o rótulo para recuperar.",
  "Subscribe an external URL to workspace events (card moves, executions, approvals, cost alerts). Use to wire Backplane into CI, chat, or monitoring systems.":
    "Inscreva uma URL externa nos eventos do espaço de trabalho (movimentos de cartões, execuções, aprovações e alertas de custo). Use para conectar o Backplane a CI, chat ou monitoramento.",
  "Delivery URL for webhook payloads (https in production).":
    "URL de entrega dos payloads de webhook (https em produção).",
  "Events to subscribe to: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed, plus the activity.* namespace (activity.card.moved, activity.note.updated, ...). Bare card.*/column.* names still work but are deprecated aliases of activity.card.*/activity.column.*.":
    "Eventos a assinar: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed, além do namespace activity.* (activity.card.moved, activity.note.updated, ...). Nomes simples card.*/column.* ainda funcionam, mas são aliases obsoletos de activity.card.*/activity.column.*.",
  "HMAC signing secret used to sign every delivery.": "Secret HMAC usado para assinar cada entrega.",
  "Payloads are signed HMAC-SHA256 with your secret: the X-Webhook-Signature-256 header carries sha256=<hex> and X-Webhook-Event names the event — verify on the receiver.":
    "Payloads são assinados com HMAC-SHA256 usando seu secret: o header X-Webhook-Signature-256 contém sha256=<hex> e X-Webhook-Event informa o evento. Verifique no receptor.",
  "The URL is SSRF-guarded at registration: https-only outside development, and hosts resolving to private/internal addresses are rejected.":
    "A URL recebe proteção contra SSRF no registro: somente https fora do desenvolvimento, e hosts resolvidos para endereços privados/internos são rejeitados.",
  "List the webhooks registered in a workspace with their URLs, subscribed events, and active state. Use to audit existing subscriptions before adding one.":
    "Liste os webhooks registrados em um espaço de trabalho com URLs, eventos assinados e estado ativo. Use para auditar assinaturas existentes antes de adicionar outra.",
  "Filter by state: true for active only, false for inactive only; omit for all.":
    "Filtrar por estado: true somente para ativos, false somente para inativos; omita para todos.",
  "Get the runner identity linked to the current API key (vs whoami, which is the calling user). Use at session start to discover your agent_id and constraints.":
    "Obtenha a identidade do runner vinculada à API key atual (diferente de whoami, que retorna o usuário chamador). Use no início da sessão para descobrir agent_id e restrições.",
  "Distinct from whoami: whoami returns the calling user; get_agent_config returns the runner bound to the API key.":
    "Diferente de whoami: whoami retorna o usuário que chama; get_agent_config retorna o runner vinculado à API key.",
  "Falls back to the user identity when no runner is linked to the key — execution tracking and approvals need a linked runner.":
    "Usa a identidade do usuário como fallback quando nenhum runner está vinculado à chave; acompanhamento de execuções e aprovações exigem um runner vinculado.",
  "Register a runner identity (an agents row) with an API key, workspace allowlist, rate limit, and optional budget cap. Use when onboarding a new runner.":
    "Registre uma identidade de runner (uma linha da tabela agents) com API key, allowlist de espaços de trabalho, rate limit e limite de orçamento opcional. Use ao integrar um novo runner.",
  "Runner display name.": "Nome de exibição do runner.",
  "One of 'coding', 'manager', 'reviewer', 'secretary', 'improver'.":
    "Um de 'coding', 'manager', 'reviewer', 'secretary' ou 'improver'.",
  "Workspace slugs the runner may access. Must contain at least one.":
    "Slugs dos espaços de trabalho que o runner pode acessar. Deve conter pelo menos um.",
  "What this runner does.": "O que este runner faz.",
  "Allowed action names; omit to allow all.":
    "Nomes das ações permitidas; omita para permitir todas.",
  "Rate limit (default 100).": "Rate limit (padrão 100).",
  "Optional spending cap in USD.": "Limite opcional de gastos em USD.",
  "The raw_api_key in the response is shown exactly once — save it immediately.":
    "A raw_api_key da resposta é exibida uma única vez; salve-a imediatamente.",
  "Re-creating an existing runner is idempotent but returns raw_api_key null (a lost key requires rotation) — and silently reactivates the runner if it had been deactivated.":
    "Recriar um runner existente é idempotente, mas retorna raw_api_key null (uma chave perdida exige rotação) e reativa silenciosamente o runner se ele estava desativado.",
  "An empty allowed_workspaces makes the runner invisible to every workspace — list each workspace it must see.":
    "Uma allowed_workspaces vazia torna o runner invisível para todos os espaços de trabalho; liste cada espaço de trabalho que ele precisa enxergar.",
  "Fetch one runner's profile — type, allowlists, limits, budget, and active state. Use when auditing a runner or before updating it.":
    "Busque o perfil de um runner: tipo, allowlists, limites, orçamento e estado ativo. Use ao auditar ou antes de atualizar o runner.",
  "UUID of the runner to retrieve.": "UUID do runner que será buscado.",
  "Never returns the API key — only its prefix. Raw keys are shown once, at create time.":
    "Nunca retorna a API key, apenas seu prefixo. Chaves brutas são exibidas uma única vez, na criação.",
  "UUID of the runner to update.": "UUID do runner que será atualizado.",
  "New workspace slug allowlist. Must be non-empty if provided.":
    "Nova allowlist de slugs de espaço de trabalho. Deve ser não vazia se informada.",
  "New action allowlist.": "Nova allowlist de ações.",
  "New rate limit.": "Novo rate limit.",
  "New spending cap in USD.": "Novo limite de gastos em USD.",
  "Changes apply on the runner's next config refresh (heartbeat cycle), not instantly.":
    "As alterações entram em vigor na próxima atualização de configuração do runner (ciclo de heartbeat), não imediatamente.",
  "You cannot clear allowed_workspaces to empty — omit it to leave it unchanged.":
    "Não é possível esvaziar allowed_workspaces; omita para mantê-la inalterada.",
  "Change a runner's profile or guardrails — name, allowlists, rate limit, budget, active flag. Only passed fields change; hard_delete=true erases the runner instead.":
    "Altere o perfil ou as proteções de um runner: nome, allowlists, rate limit, orçamento, indicador ativo. Somente os campos informados mudam; hard_delete=true apaga o runner em vez disso.",
  "hard_delete=true is irreversible. Unlike is_active=false, nothing survives to re-enable — the runner, its API key, executions, approvals and team memberships are gone.":
    "hard_delete=true é irreversível. Diferente de is_active=false, nada permanece para ser reativado: o runner, sua API key, execuções, aprovações e participações em equipes são eliminados.",
  "Set false to disable the runner — the reversible retirement.":
    "Defina false para desativar o runner: a aposentadoria reversível.",
  "True permanently erases the runner — API key, executions, approvals, team memberships. Unrecoverable; must be the only field besides agent_id.":
    "True apaga permanentemente o runner: API key, execuções, aprovações, participações em equipes. Irrecuperável; deve ser o único campo além de agent_id.",
  "hard_delete=true accepts no other field — a call mixing edits with the erase is rejected before any request is sent.":
    "hard_delete=true não aceita nenhum outro campo: uma chamada que misture edições com a exclusão é rejeitada antes de qualquer solicitação ser enviada.",
  "Prefer is_active=false for retirement; hard_delete exists to erase a runner that should never have existed.":
    "Para aposentar um runner, prefira is_active=false; hard_delete existe para apagar um runner que nunca deveria ter existido.",
  "List the runner identities you can administer, with active and paused state. The operator's inventory call — start here for the agent_id other lifecycle tools take.":
    "Liste as identidades de runners que você pode administrar, com os estados ativo e pausado. Esta é a consulta de inventário do operador; comece aqui para obter o agent_id usado pelas outras ferramentas de ciclo de vida.",
  "Also return deactivated runners; defaults to active only.":
    "Retorne também runners desativados; o padrão inclui somente os ativos.",
  "Returns only runners the calling user administers — an empty list can mean no permission, not no runners.":
    "Retorna somente os runners administrados pelo usuário que faz a chamada; uma lista vazia pode significar falta de permissão, não ausência de runners.",
  "Never returns API keys, only their prefixes.":
    "Nunca retorna API keys, somente seus prefixos.",
  "Stop a runner from picking up new cards — the primary runaway containment lever. Use the moment a runner looks stuck in a money-loop.":
    "Impeça um runner de assumir novos cartões: este é o principal mecanismo para conter uma execução descontrolada. Use assim que um runner parecer preso em um money-loop.",
  "UUID of the runner to pause.": "UUID do runner que será pausado.",
  "In-flight work is not killed — the runner finishes its current card and then idles, so spend stops after at most one more card. Pair with cancel_execution to end the running one.":
    "O trabalho em andamento não é encerrado: o runner conclui o cartão atual e depois fica ocioso, portanto o gasto para após, no máximo, mais um cartão. Combine com cancel_execution para encerrar a execução ativa.",
  "Idempotent: pausing an already-paused runner succeeds.":
    "Idempotente: pausar um runner que já está pausado funciona sem erro.",
  "Rejected for runner-linked API keys — a runner cannot pause itself or its peers; call it with an operator identity.":
    "Rejeitado para API keys vinculadas a runners: um runner não pode pausar a si mesmo nem seus pares; chame a ferramenta com uma identidade de operador.",
  "Re-enable card pickup for a paused runner. Use once the condition that caused the pause is resolved.":
    "Reative a atribuição de cartões para um runner pausado. Use depois de resolver a condição que causou a pausa.",
  "UUID of the runner to resume.": "UUID do runner que será retomado.",
  "Idempotent: resuming an active runner succeeds and changes nothing.":
    "Idempotente: retomar um runner que já está em execução funciona e não altera nada.",
  "Resuming a runner that was paused for overspend restarts the burn — check get_agent_budget_status first.":
    "Retomar um runner pausado por excesso de gastos reinicia o consumo; consulte primeiro get_agent_budget_status.",
  "Rejected for runner-linked API keys; call it with an operator identity.":
    "Rejeitado para API keys vinculadas a runners; chame a ferramenta com uma identidade de operador.",
  "Ask a running runner to finish its in-flight card and exit, so its supervisor relaunches it on fresh platform config.":
    "Peça a um runner em execução que conclua o cartão em andamento e encerre o processo, para que o supervisor o reinicie com a configuração atualizada da plataforma.",
  "UUID of the runner to restart.": "UUID do runner que será reiniciado.",
  "Requires a live WebSocket connection — an offline runner returns 503 rather than queueing the restart for later.":
    "Exige uma conexão WebSocket ativa; um runner offline retorna 503 em vez de enfileirar o reinício para mais tarde.",
  "The platform only asks; bringing the process back is the supervisor's job. On a hand-launched runner this is a stop, not a restart.":
    "A plataforma apenas faz a solicitação; cabe ao supervisor iniciar o processo novamente. Em um runner iniciado manualmente, isso é uma parada, não um reinício.",
  "In-flight work is not killed — the current card finishes first, so the exit can be minutes away.":
    "O trabalho em andamento não é encerrado: o cartão atual é concluído primeiro, portanto a saída pode levar alguns minutos.",
  "Rejected for runner-linked API keys — a runner restarting itself is a loop an operator cannot interrupt.":
    "Rejeitado para API keys vinculadas a runners: um runner que reinicia a si mesmo cria um loop que um operador não consegue interromper.",
  "Refused with 409 while the runner has a card in flight — pause it and let the card finish, or cancel_execution first.":
    "Recusado com 409 enquanto o runner tiver um cartão em andamento; pause-o e deixe o cartão ser concluído ou use cancel_execution primeiro.",
  "Rejected for runner-linked API keys — a runner cannot erase itself or its peers.":
    "Rejeitado para API keys vinculadas a runners: um runner não pode apagar a si mesmo nem seus pares.",
  "Check one runner's spend against its budget cap. The per-runner spend audit that pairs with pause_agent when containing a runaway.":
    "Verifique os gastos de um runner em relação ao seu limite de orçamento. Esta auditoria individual de gastos acompanha pause_agent na contenção de uma execução descontrolada.",
  "UUID of the runner to check.": "UUID do runner que será verificado.",
  "Per-runner only. For workspace-wide cost and per-card spend use get_workspace_metrics(view='cost').":
    "Somente por runner. Para custos de todo o espaço de trabalho e gastos por cartão, use get_workspace_metrics(view='cost').",
  "A runner with no budget_usd set has no cap to report against — it will never self-limit.":
    "Um runner sem budget_usd definido não tem limite para comparação e nunca limitará a si mesmo.",
  "Mint a new API key for a runner and invalidate the old one. The response to a leaked or compromised runner key.":
    "Emita uma nova API key para um runner e invalide a anterior. Esta é a resposta a uma chave de runner vazada ou comprometida.",
  "UUID of the runner whose key is being rotated.":
    "UUID do runner cuja chave será trocada.",
  "The new raw_api_key is shown exactly once in the result — save it immediately; a lost key needs another rotation.":
    "A nova raw_api_key é exibida exatamente uma vez no resultado; salve-a imediatamente. Uma chave perdida exige outra troca.",
  "The old key stops authenticating the moment this returns, so a runner mid-card fails until reconfigured. Pause it first if the timing matters.":
    "A chave anterior deixa de autenticar assim que esta chamada retorna; portanto, um runner no meio de um cartão falhará até ser reconfigurado. Pause-o primeiro se o momento da troca for importante.",
  "A card whose execution_count keeps climbing while it stays out of the done column is the money-loop signature — cross-check with list_executions.":
    "Um cartão cujo execution_count continua subindo enquanto permanece fora da coluna done apresenta a assinatura de um money-loop; confira com list_executions.",
  "Falling velocity with a rising reversion_rate means rework, not slowdown; report the pair together.":
    "Velocidade em queda com reversion_rate em alta significa retrabalho, não desaceleração; informe os dois dados em conjunto.",
  "reversion_rate and agent_efficiency_score are null until there is enough history to compute them.":
    "reversion_rate e agent_efficiency_score são null até existir histórico suficiente para calculá-los.",
  "Read workspace-wide velocity, quality and runner/card spend in one call; view narrows it to velocity or cost. Use for standup delivery and cost lines.":
    "Consulte em uma única chamada a velocidade, a qualidade e o gasto por runner e por cartão de todo o espaço de trabalho; view restringe a velocidade ou custo. Use nas linhas de entrega e de custo do standup.",
  "Workspace slug to read metrics from.":
    "Slug do espaço de trabalho do qual serão consultadas as métricas.",
  "'all' (default) returns velocity, quality and cost; 'velocity' returns velocity + quality only; 'cost' returns spend only.":
    "'all' (padrão) retorna velocidade, qualidade e custo; 'velocity' retorna somente velocidade + qualidade; 'cost' retorna somente o gasto.",
  "Workspace-wide only — use get_board_health for one board's velocity and get_agent_budget_status for one runner's spend.":
    "Abrange todo o espaço de trabalho; use get_board_health para a velocidade de um quadro específico e get_agent_budget_status para o gasto de um runner específico.",
  "cost.agents holds per-runner token and execution counts over 7d/30d; dollar amounts live on cost.cards (total_cost_usd) and depend on model_pricing in workspace config — without it costs read as 0.":
    "cost.agents contém as contagens de tokens e execuções por runner em 7d/30d; os valores em dólares ficam em cost.cards (total_cost_usd) e dependem de model_pricing estar definido na configuração do espaço de trabalho; sem isso, os custos aparecem como 0.",
  "Report the totals as returned rather than re-deriving them; an unknown view is rejected before any request is made.":
    "Informe os totais como foram retornados em vez de recalculá-los; um valor de view desconhecido é rejeitado antes de qualquer requisição.",
  "Clear a tripped cost circuit breaker so runners can pick up work again. Use when next_assignment returns 423 for every runner because spend crossed the threshold.":
    "Libere um circuit breaker de custos acionado para que runners voltem a assumir trabalho. Use quando next_assignment retornar 423 para todos os runners porque os gastos ultrapassaram o limite.",
  "Acknowledgement, not a mute: it clears the dedupe state, so the next cost signal over the threshold trips the breaker again.":
    "É uma confirmação, não um silenciamento: limpa o estado de deduplicação, portanto o próximo sinal de custo acima do limite aciona o disjuntor novamente.",
  "Thresholds and the breaker action are untouched — change those with update_workspace_config's cost_circuit_breaker field.":
    "Os limites e a ação do disjuntor permanecem inalterados; mude-os no campo cost_circuit_breaker de update_workspace_config.",
  "Admin-gated: a non-admin member gets a 403 straight from the backend.":
    "Restrito a admins: um membro que não seja admin recebe 403 diretamente do backend.",
  "Runners resume on their next next_assignment poll, not instantly.":
    "Runners retomam no próximo poll de next_assignment, não imediatamente.",
  "Open an execution audit record for a runner's run and get back an execution_id. Call at the start of any agentic workflow you want tracked on the platform.":
    "Abra um registro de auditoria de execução para uma rodada do runner e receba um execution_id. Chame no início de qualquer fluxo agentic que deva ser acompanhado na plataforma.",
  "Workspace slug where this execution occurs.": "Slug do espaço de trabalho onde esta execução ocorre.",
  "UUID of the runner starting the run (see get_agent_config).":
    "UUID do runner que inicia a execução (consulte get_agent_config).",
  "Short action name, e.g. 'standup', 'tdd_implement', 'review_pr'.":
    "Nome curto da ação, por exemplo, 'standup', 'tdd_implement', 'review_pr'.",
  "One-line summary of what the agent was asked to do.":
    "Resumo em uma linha do que foi solicitado ao agente.",
  "Board UUID when the work is board-scoped.":
    "UUID do quadro quando o trabalho tiver escopo de quadro.",
  "Card UUID being worked — pass it whenever the run is card-scoped.":
    "UUID do cartão trabalhado; informe sempre que a execução tiver escopo de cartão.",
  "External coding-session ID for correlation.": "ID externo da sessão de código para correlação.",
  "Execution UUID this run is a retry of.":
    "UUID da execução da qual esta rodada é uma nova tentativa.",
  "Pipeline role for this run, e.g. 'implementer', 'reviewer'.":
    "Função do pipeline nesta execução, por exemplo, 'implementer', 'reviewer'.",
  "Full rendered prompt sent to the LLM for this run.":
    "Prompt completo renderizado e enviado à LLM nesta execução.",
  "Save the returned execution_id — log_execution_update and cancel_execution need it.":
    "Salve o execution_id retornado; log_execution_update e cancel_execution precisam dele.",
  "Passing card_id flips the card to 'actively worked' presence on the board immediately — always bind it for card-scoped runs.":
    "Informar card_id marca imediatamente o cartão no quadro como 'actively worked'; sempre vincule em execuções com escopo de cartão.",
  "Record progress or the outcome of a tracked execution — status, results, cost, errors. Call when a run completes, fails, or reaches a meaningful checkpoint.":
    "Registre o progresso ou resultado de uma execução acompanhada: status, resultados, custo e erros. Chame quando a execução concluir, falhar ou atingir um ponto de controle relevante.",
  "UUID of the runner that owns the execution.": "UUID do runner responsável pela execução.",
  "The id returned by log_execution_start.": "Id retornado por log_execution_start.",
  "New status — 'completed', 'failed', or 'running'.":
    "Novo status: 'completed', 'failed' ou 'running'.",
  "What the run accomplished or produced.": "O que a execução realizou ou produziu.",
  "MCP tool names invoked during the run.":
    "Nomes das ferramentas MCP invocadas durante a execução.",
  "Card UUIDs created, updated, or moved.": "UUIDs de cartões criados, atualizados ou movidos.",
  "Error details when status is 'failed'.": "Detalhes do erro quando status é 'failed'.",
  "Total number of tool calls made.": "Número total de chamadas de ferramentas realizadas.",
  "Total input + output tokens consumed.": "Total de tokens de entrada + saída consumidos.",
  "Total cost in USD for this run.": "Custo total em USD desta execução.",
  "Wall-clock duration of the run in seconds.": "Duração da execução em segundos de relógio.",
  "Non-fatal issues captured during the stage, surfaced in the UI.":
    "Problemas não fatais capturados durante a etapa e exibidos na UI.",
  "Partial update: only the fields you pass change — omitted fields keep their values.":
    "Atualização parcial: somente os campos informados mudam; campos omitidos preservam seus valores.",
  "ship_warnings render as amber chips in the UI without flipping status to failed — use them for non-fatal issues.":
    "ship_warnings são exibidos como chips amber na UI sem mudar o status para failed; use para problemas não fatais.",
  "A late 'failed' write to an already-completed execution keeps status completed (the other fields still apply); failed → completed stays allowed — the runner's close is authoritative.":
    "Uma gravação tardia de 'failed' em uma execução já concluída mantém status completed (os demais campos ainda são aplicados); failed → completed continua permitido. O fechamento do runner é autoritativo.",
  "List runner execution history for a workspace, newest first. Use to monitor runs, audit cost and loops, read a card's full pipeline history, or find zombie rows.":
    "Liste o histórico de execuções de runners de um espaço de trabalho, mais recentes primeiro. Use para monitorar rodadas, auditar custo e loops, ler todo o histórico de pipeline de um cartão ou encontrar linhas zumbis.",
  "Workspace slug to read executions from.": "Slug do espaço de trabalho de onde ler as execuções.",
  "Only that runner's executions.": "Somente execuções desse runner.",
  "Filter: started, running, completed, failed, aborted, skipped — or virtual 'inflight'.":
    "Filtrar por started, running, completed, failed, aborted, skipped ou pelo valor virtual 'inflight'.",
  "Filter by pipeline role, e.g. 'implementer', 'reviewer'.":
    "Filtrar pela função do pipeline, por exemplo, 'implementer', 'reviewer'.",
  "Return that card's pipeline history instead of the workspace page.":
    "Retornar o histórico de pipeline desse cartão em vez da página do espaço de trabalho.",
  "Max rows (default 20, backend caps at 200).":
    "Máximo de linhas (padrão 20; backend limita a 200).",
  "Rows are heavy — each carries the full input_prompt and tool invocations. Keep limit small unless you need deep history.":
    "As linhas são pesadas: cada uma inclui input_prompt completo e invocações de ferramentas. Mantenha limit pequeno, a menos que precise do histórico detalhado.",
  "status='inflight' is virtual: every started/running row not yet completed, unbounded by limit — the zombie-hunting filter to pair with cancel_execution.":
    "status='inflight' é virtual: inclui toda linha started/running ainda não concluída, sem limite. É o filtro para caçar zumbis em conjunto com cancel_execution.",
  "card_id switches to server-side card scope: the card's history ignoring limit — but capped at the newest 200 rows, so a runaway loop card can still truncate. status/role/agent_id filter within that window.":
    "card_id muda para escopo de cartão no servidor: retorna o histórico do cartão ignorando limit, mas limitado às 200 linhas mais recentes; um cartão com loop descontrolado ainda pode truncar. status/role/agent_id filtram dentro dessa janela.",
  "Force a stuck 'running' execution to a terminal status, clearing the runner busy-guard. Use when a crashed run wedges the pipeline with 409 agent_busy errors.":
    "Force uma execução 'running' travada para um status terminal, liberando a proteção de runner ocupado. Use quando uma execução interrompida trava o pipeline com erros 409 agent_busy.",
  "UUID of the runner that owns the stuck execution.":
    "UUID do runner responsável pela execução travada.",
  "Execution UUID to force terminal.": "UUID da execução que será forçada a terminar.",
  "Terminal status to set — 'aborted' (default), 'completed', or 'failed'.":
    "Status terminal a definir: 'aborted' (padrão), 'completed' ou 'failed'.",
  "Note recorded as the execution's output_summary.":
    "Nota registrada como output_summary da execução.",
  "Non-terminal statuses are rejected — they would not clear the busy-guard.":
    "Status não terminais são rejeitados, pois não liberariam a proteção de agente ocupado.",
  "Verify the row is a real zombie first (list_executions status='inflight'); cancelling a live run lets the runner reserve new work while the old run keeps going.":
    "Primeiro confirme que a linha é realmente zumbi (list_executions status='inflight'); cancelar uma execução viva permite ao runner reservar novo trabalho enquanto a antiga continua.",
  "A typo'd execution_id may not 404: when the runner has exactly one in-flight execution, the backend applies the write to that row instead — double-check the id before cancelling.":
    "Um execution_id digitado incorretamente pode não retornar 404: quando o runner tem exatamente uma execução em andamento, o backend aplica a gravação a essa linha. Confira o id antes de cancelar.",
  "Query the audit trail of who changed what in a workspace or board, newest first. Use to review recent changes with entity-type, action, or free-text filters.":
    "Consulte a trilha de auditoria de quem alterou o quê em um espaço de trabalho ou quadro, mais recente primeiro. Use para revisar mudanças por tipo de entidade, ação ou texto livre.",
  "Workspace slug to read activity from.": "Slug do espaço de trabalho de onde ler a atividade.",
  "Board UUID to scope to one board; omit for workspace-wide.":
    "UUID do quadro para restringir a um quadro; omita para todo o espaço de trabalho.",
  "Max entries (default 50, backend caps at 100).":
    "Máximo de entradas (padrão 50; backend limita a 100).",
  "Filter: board, column, card, note, resource, definition, channel, git_repo, workspace, member, agent.":
    "Filtrar por board, column, card, note, resource, definition, channel, git_repo, workspace, member ou agent.",
  "Filter: created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed, dependencies_replaced.":
    "Filtrar por created, updated, deleted, moved, uploaded, archived, added_member, removed_member, dependency_added, dependency_removed ou dependencies_replaced.",
  "Free-text search across activity summaries.": "Busca de texto livre nos resumos de atividade.",
  "Tracks entity mutations (cards, notes, members...), not runner runs — for execution history use list_executions.":
    "Acompanha mutações de entidades (cartões, notas, membros...), não execuções de runners; para histórico de execução, use list_executions.",
  "The response carries agent_id attribution, but this MCP tool does not expose the backend's agent_id filter. entity_type='agent' returns runner lifecycle audit rows; it does not return every action performed by one runner.":
    "A resposta inclui a atribuição agent_id, mas esta ferramenta MCP não expõe o filtro agent_id do backend. entity_type='agent' retorna linhas de auditoria do ciclo de vida do runner; não retorna todas as ações realizadas por um runner.",
  "Report the MCP server's version, full tool surface, this session's allowlist, and backend reachability. Run at session start to rule out tool or version drift.":
    "Informe a versão do servidor MCP, toda a superfície de ferramentas, a allowlist desta sessão e a conectividade do backend. Execute no início da sessão para descartar divergência de ferramentas ou versão.",
  "enabled_tools is what THIS session can actually call — the registered surface intersected with the allowlist (allowlist null = unrestricted).":
    "enabled_tools é o que ESTA sessão realmente pode chamar: a interseção entre a superfície registrada e a allowlist (allowlist null = sem restrição).",
  "allowlist_unknown lists allowlisted names the server doesn't register — a sign of version drift between runner config and deployed server.":
    "allowlist_unknown lista nomes da allowlist que o servidor não registra; indica divergência de versão entre configuração do runner e servidor implantado.",
  "Backend health is best-effort: an unreachable API sets backend.reachable=false instead of failing the call.":
    "A integridade do backend é best-effort: uma API inacessível define backend.reachable=false em vez de falhar a chamada.",
  "Widen THIS session's server tool hand and request client refresh; notification delivery does not prove the client catalog updated.":
    "Amplia o conjunto de ferramentas do servidor DESTA sessão e solicita atualização do cliente; enviar a notificação não comprova que o catálogo do cliente foi atualizado.",
  "Toolset ids to add: all, default, or any group or category id listed under get_server_info.toolsets.available.":
    "Ids de toolsets a adicionar: all, default ou qualquer id de grupo ou categoria listado em get_server_info.toolsets.available.",
  "Widen-only and idempotent: a repeated call adds nothing and sends no notification. The change is per-process and never persisted — the next session starts from VALARIS_MCP_TOOLSETS again.":
    "Apenas amplia e é idempotente: uma chamada repetida não adiciona nada e não envia notificação. A mudança é por processo e nunca é persistida: a próxima sessão parte novamente de VALARIS_MCP_TOOLSETS.",
  "The runner allowlist (VALARIS_MCP_ALLOWLIST) is a ceiling this tool never lifts, so under a runner launch it is a no-op.":
    "A allowlist do runner (VALARIS_MCP_ALLOWLIST) é um teto que esta ferramenta nunca levanta, então sob um lançamento de runner ela não tem efeito.",
  "client_catalog_status is unverified: list_changed_sent and get_server_info confirm server state only. If tools remain missing, apply restart_env to the MCP server startup configuration, restart the server/connection and start a new agent session. Remote HTTP requires the server operator; preserve VALARIS_MCP_ALLOWLIST.":
    "client_catalog_status é unverified: list_changed_sent e get_server_info confirmam apenas o estado do servidor. Se faltarem ferramentas, aplique restart_env à configuração de inicialização do servidor MCP, reinicie o servidor/conexão e inicie uma nova sessão do agente. HTTP remoto exige o operador do servidor; preserve VALARIS_MCP_ALLOWLIST.",
  "Read the workspace's full config: pipeline stages, rework/cooldown knobs, templates, pricing, and cost circuit breaker. Start here before any config edit.":
    "Leia toda a configuração do espaço de trabalho: etapas do pipeline, controles de rework/cooldown, modelos, preços e circuit breaker de custos. Comece aqui antes de editar a configuração.",
  "The response includes a `version` field — pass it as `expected_version` on update_workspace_config for conflict-safe edits.":
    "A resposta inclui um campo `version`; informe-o como `expected_version` em update_workspace_config para editar com proteção contra conflitos.",
  "`pipeline_config` is never null in the response: an unconfigured workspace gets the platform-default multi-role pipeline (the read even seeds it onto a stored record whose pipeline is null).":
    "`pipeline_config` nunca é null na resposta: um espaço de trabalho sem configuração recebe o pipeline multifunção padrão da plataforma (a leitura inclusive o grava em um registro cujo pipeline é null).",
  "Patch workspace config fields: pipeline stages, rework caps, templates, pricing, circuit breaker, role labels. Use to tune how runners process work.":
    "Atualize campos da configuração do espaço de trabalho: etapas do pipeline, limites de retrabalho, modelos, preços, circuit breaker e rótulos de funções. Use para ajustar como runners processam trabalho.",
  "Per-card rework cap before the scheduler stops re-issuing the card.":
    "Limite de retrabalho por cartão antes que o scheduler pare de oferecê-lo novamente.",
  "Hours to wait before re-offering a card after release.":
    "Horas de espera antes de voltar a oferecer um cartão após sua liberação.",
  "Template for runner-authored commit messages.":
    "Modelo de mensagens de commit escritas pelo runner.",
  "Template for runner-authored PR descriptions.":
    "Modelo de descrições de PR escritas pelo runner.",
  "Per-model $/token overrides; merges over platform defaults.":
    "Substituições de $/token por modelo; mescladas sobre os padrões da plataforma.",
  "The full pipeline doc — `stages` (role, discover, claim, git, llm, on_success) plus scheduling. Replaces the stored doc wholesale.":
    "Documento completo do pipeline: `stages` (role, discover, claim, git, llm, on_success) e scheduling. Substitui integralmente o documento armazenado.",
  "{enabled, threshold_usd_per_15min, action} with action one of alert, pause, kill_runner.":
    "{enabled, threshold_usd_per_15min, action}, com action igual a alert, pause ou kill_runner.",
  "Per-role display label overrides, e.g. {\"implementer\": \"Coder\"}.":
    "Substituições do rótulo de exibição por função, por exemplo, {\"implementer\": \"Coder\"}.",
  "Optimistic concurrency: if set, the update is rejected with 409 when the stored config version differs.":
    "Concorrência otimista: se definido, a atualização é rejeitada com 409 quando a versão armazenada difere.",
  "Partial PATCH: omitted fields stay unchanged — but `pipeline_config` is replaced wholesale, not deep-merged.":
    "PATCH parcial: campos omitidos permanecem inalterados, mas `pipeline_config` é substituído integralmente, sem deep merge.",
  "Pass `expected_version` from the last read to get a 409 instead of silently clobbering a concurrent edit.":
    "Informe o `expected_version` da última leitura para receber 409 em vez de sobrescrever silenciosamente uma edição concorrente.",
  "The backend validates `pipeline_config` and returns its structured 422 error list on malformed stages; the call requires workspace admin/owner role.":
    "O backend valida `pipeline_config` e retorna sua lista estruturada de erros 422 em etapas inválidas; a chamada exige função admin/owner no espaço de trabalho.",
  "Pipeline stages drive the backend scheduler behind next_assignment — changing a role's discover/claim rules changes which cards runners are offered.":
    "As etapas do pipeline orientam o scheduler do backend por trás de next_assignment; alterar regras discover/claim de uma função muda quais cartões são oferecidos aos runners.",
  "Passing pipeline_config overwrites the workspace's ENTIRE stored pipeline in place — no history is kept beyond a version counter, and every runner's discover/claim behavior changes on its next poll. Read-modify-write: fetch with get_workspace_config, mutate locally, send back with expected_version (or export_pipeline_bundle first as a backup).":
    "Informar pipeline_config sobrescreve TODO o pipeline armazenado do espaço de trabalho no lugar; nenhum histórico é mantido além do contador de versão, e o comportamento discover/claim de cada runner muda na próxima consulta. Leia, modifique e escreva: busque com get_workspace_config, altere localmente e envie com expected_version (ou faça primeiro backup com export_pipeline_bundle).",
  "Export a portable bundle of the workspace's pipeline, derived setup contract, and workspace prompts. Use to back up or promote a proven pipeline elsewhere.":
    "Exporte um bundle portátil do pipeline do espaço de trabalho, do contrato de configuração derivado e dos prompts do espaço de trabalho. Use para backup ou para promover um pipeline comprovado em outro lugar.",
  "URL slug identifying the source workspace.": "Slug de URL que identifica o espaço de trabalho de origem.",
  "Only WORKSPACE-scoped prompt configs are included; platform defaults re-seed on the target and are deliberately excluded.":
    "Somente configurações de prompts com escopo de WORKSPACE são incluídas; os padrões da plataforma são recriados no destino e excluídos deliberadamente.",
  "`data.expected_pipeline_version` exports as null — fill it in (from the target's current version) only when round-tripping back into the same workspace.":
    "`data.expected_pipeline_version` é exportado como null; preencha com a versão atual do destino somente ao fazer round-trip de volta ao mesmo espaço de trabalho.",
  "Team-scoped prompts are exported by team slug; the import fails with 422 if the target workspace lacks a team with that slug.":
    "Prompts com escopo de equipe são exportados pelo slug da equipe; a importação falha com 422 se o espaço de trabalho de destino não tiver uma equipe com esse slug.",
  "Exports the STORED pipeline, not the effective default get_workspace_config shows — a workspace that never saved its config exports an empty pipeline_config, which import rejects with 400. Save the config once first.":
    "Exporta o pipeline ARMAZENADO, não o padrão efetivo exibido por get_workspace_config. Um espaço de trabalho que nunca salvou a configuração exporta pipeline_config vazio, rejeitado pela importação com 400. Salve a configuração uma vez primeiro.",
  "Import an exported pipeline bundle into a workspace. Previews by default; applies pipeline + prompts atomically with dry_run=false. Use to clone a proven setup.":
    "Importe um bundle de pipeline exportado em um espaço de trabalho. Por padrão mostra uma prévia; aplica pipeline + prompts atomicamente com dry_run=false. Use para clonar uma configuração comprovada.",
  "URL slug identifying the TARGET workspace.": "Slug de URL que identifica o espaço de trabalho de DESTINO.",
  "The full bundle envelope exactly as returned by export_pipeline_bundle.":
    "Envelope completo do bundle, exatamente como retornado por export_pipeline_bundle.",
  "Defaults to true: return a validation + preview report and write nothing. Set false to apply.":
    "O padrão é true: retorna relatório de validação + prévia e não grava nada. Defina false para aplicar.",
  "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false. Always inspect the preview first.":
    "`dry_run` usa TRUE por padrão; nada é gravado até chamar novamente com dry_run=false. Sempre inspecione primeiro a prévia.",
  "The version guard lives INSIDE the envelope (`bundle.data.expected_pipeline_version`); there is no top-level expected_version parameter on import. Stale version → 409, only relevant when re-importing into the source workspace.":
    "A proteção de versão fica DENTRO do envelope (`bundle.data.expected_pipeline_version`); a importação não tem parâmetro expected_version no nível superior. Versão antiga → 409, relevante apenas ao reimportar no espaço de trabalho de origem.",
  "Envelope schema_version/entity_type mismatch → 400; invalid pipeline → 422. The commit is atomic — a validation failure leaves no partial state.":
    "Divergência de schema_version/entity_type no envelope → 400; pipeline inválido → 422. O commit é atômico: uma falha de validação não deixa estado parcial.",
  "Re-importing is idempotent: prompts with identical content are skipped, differing content updates in place. Requires workspace admin/owner role.":
    "Reimportar é idempotente: prompts com conteúdo idêntico são ignorados, e conteúdo diferente é atualizado no lugar. Exige função admin/owner no espaço de trabalho.",
  "Applying with dry_run=false overwrites the target workspace's ENTIRE pipeline_config and creates/updates its prompt configs in one transaction. Export a backup bundle from the target first.":
    "Aplicar com dry_run=false sobrescreve TODO o pipeline_config do espaço de trabalho de destino e cria/atualiza suas configurações de prompts em uma transação. Exporte primeiro um bundle de backup do destino.",
  "List the sensors runners have registered in a workspace. Use before wiring sensors into pipeline stages to see which sensor names are valid.":
    "Liste os sensores registrados pelos runners em um espaço de trabalho. Use antes de conectar sensores às etapas do pipeline para saber quais nomes são válidos.",
  "The catalog is runner-reported: it stays empty until at least one runner in the workspace has reported a sensor manifest.":
    "O catálogo é informado pelos runners: permanece vazio até que pelo menos um runner do espaço de trabalho envie um manifesto de sensores.",
  "On a name conflict across runners, the first reporter wins.":
    "Em caso de conflito de nome entre runners, prevalece quem informou primeiro.",
  "This is the catalog `pipeline_config.stages[*].sensors[*].name` is validated against — but only once at least one runner has reported; with an empty catalog, sensor-name validation is skipped and unknown names pass.":
    "Este é o catálogo usado para validar `pipeline_config.stages[*].sensors[*].name`, mas somente depois que ao menos um runner tiver informado dados. Com catálogo vazio, a validação de nomes é ignorada e nomes desconhecidos passam.",
  "List prompt configs visible to a workspace — its own plus platform defaults — optionally filtered by team role. Use to see which prompt overrides are in play.":
    "Liste as configurações de prompts visíveis a um espaço de trabalho: as próprias e os padrões da plataforma, com filtro opcional por função de equipe. Use para ver quais substituições estão ativas.",
  "Filter to configs for one team role, e.g. 'orchestrator' or 'reviewer'.":
    "Filtrar configurações por uma função de equipe, por exemplo, 'orchestrator' ou 'reviewer'.",
  "Returns workspace-scoped rows PLUS platform-level defaults (no workspace) in one list — check each row's workspace scope before editing.":
    "Retorna linhas do espaço de trabalho JUNTO com padrões no nível da plataforma (sem espaço de trabalho) em uma lista; confira o escopo de cada linha antes de editar.",
  "Each item carries `resolved_content` and wiring warnings computed against the live pipeline config, so you see what agents will actually receive.":
    "Cada item inclui `resolved_content` e avisos de conexão calculados com a configuração atual do pipeline, permitindo ver o que os agentes realmente receberão.",
  "Fetch one prompt config with its resolved content and pipeline wiring warnings. Use to inspect exactly what an agent role will receive at a stage.":
    "Busque uma configuração de prompt com conteúdo resolvido e avisos de conexão com o pipeline. Use para inspecionar exatamente o que uma função de agente receberá em uma etapa.",
  "Prompt config UUID; a slug also resolves (workspace-scoped).":
    "UUID da configuração de prompt; um slug também é resolvido (no escopo do espaço de trabalho).",
  "`config_id` accepts a UUID or a slug — slug lookup is workspace-scoped and prefers workspace-owned rows over platform defaults.":
    "`config_id` aceita UUID ou slug; a busca por slug tem escopo de espaço de trabalho e prefere linhas do espaço de trabalho aos padrões da plataforma.",
  "Create a per-role prompt override for a pipeline stage. Use to customize what an agent role is told at a stage without touching the pipeline config itself.":
    "Crie uma substituição de prompt por função para uma etapa do pipeline. Use para personalizar o que uma função de agente recebe sem alterar o pipeline_config.",
  "Display name for the prompt config.": "Nome de exibição da configuração de prompt.",
  "Slug identifier, unique within its (team, role, stage) scope.":
    "Identificador slug, único dentro do escopo (team, role, stage).",
  "Pipeline stage it applies to, e.g. 'implement', 'review', 'plan'.":
    "Etapa do pipeline à qual se aplica, por exemplo, 'implement', 'review', 'plan'.",
  "The prompt template content.": "Conteúdo do modelo de prompt.",
  "Restrict to one agent type: 'coding', 'manager', 'reviewer', 'secretary', or 'improver'.":
    "Restringir a um tipo de agente: 'coding', 'manager', 'reviewer', 'secretary' ou 'improver'.",
  "Restrict to one team role, e.g. 'orchestrator' or 'reviewer'.":
    "Restringir a uma função de equipe, por exemplo, 'orchestrator' ou 'reviewer'.",
  "Scope the config to a single team by UUID.": "Restringir a configuração a uma equipe pelo UUID.",
  "Idempotent: if a config already exists with the same (team, team_role, stage, slug) scope, it is returned unchanged instead of erroring — safe to retry.":
    "Idempotente: se já existir uma configuração com o mesmo escopo (team, team_role, stage, slug), ela será retornada inalterada em vez de gerar erro. É seguro repetir.",
  "Slugs are unique per scope, not globally — several configs can share a slug across different stages or roles.":
    "Slugs são únicos por escopo, não globalmente; várias configurações podem compartilhar um slug entre etapas ou funções diferentes.",
  "Changes reach runners on their next config refresh, not instantly mid-run.":
    "As alterações chegam aos runners na próxima atualização de configuração, não no meio de uma execução.",
  "Update fields of an existing prompt config; content changes auto-bump its version. Use to iterate on what a role is told at a pipeline stage.":
    "Atualize campos de uma configuração de prompt; mudanças em content incrementam automaticamente sua versão. Use para iterar sobre o que uma função recebe em uma etapa.",
  "New slug identifier.": "Novo identificador slug.",
  "New pipeline stage.": "Nova etapa do pipeline.",
  "New prompt template content.": "Novo conteúdo do modelo de prompt.",
  "New agent type filter.": "Novo filtro de tipo de agente.",
  "New team role filter.": "Novo filtro de função de equipe.",
  "New team UUID scope.": "Novo escopo de UUID de equipe.",
  "PATCH semantics: omitted fields stay unchanged.":
    "Semântica PATCH: campos omitidos permanecem inalterados.",
  "Updating `content` bumps the stored version automatically; other fields don't.":
    "Atualizar `content` incrementa automaticamente a versão armazenada; outros campos não.",
  "Platform-level (NULL-workspace) rows pass the workspace guard: resolving one by slug or UUID rewrites the shared default for EVERY workspace, and prior content is not retained (only the version counter bumps). Verify the row's workspace scope in list_prompt_configs before updating.":
    "Linhas no nível da plataforma (espaço de trabalho NULL) passam pela proteção de espaço de trabalho: resolver uma por slug ou UUID reescreve o padrão compartilhado para TODOS os espaços de trabalho, e o conteúdo anterior não é preservado (somente a versão incrementa). Verifique o escopo em list_prompt_configs antes de atualizar.",
  "Delete a prompt config so matching runners fall back to default prompts on their next refresh. Use to retire an override you no longer want.":
    "Exclua uma configuração de prompt para que os runners correspondentes voltem aos prompts padrão na próxima atualização. Use para aposentar uma substituição desnecessária.",
  "Permanent — there is no undo; recreate with create_prompt_config if needed.":
    "Permanente: não há como desfazer; recrie com create_prompt_config se necessário.",
  "Runners that matched this config fall back to platform/stage defaults on their next config refresh.":
    "Runners que correspondiam a esta configuração voltam aos padrões da plataforma/etapa na próxima atualização.",
  "Platform-level (NULL-workspace) configs pass the workspace guard: resolving one by slug or UUID hard-deletes the shared default for EVERY workspace. Verify the row's workspace scope in list_prompt_configs before deleting.":
    "Configurações no nível da plataforma (espaço de trabalho NULL) passam pela proteção de espaço de trabalho: resolver uma por slug ou UUID exclui permanentemente o padrão compartilhado para TODOS os espaços de trabalho. Confira o escopo em list_prompt_configs antes de excluir.",
  "Initializer": "Inicializador",
  "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.":
    "Inicialize um projeto completo a partir de um briefing bruto: quadro, colunas, definição, canais, cartões iniciais, uma nota fixada de registro de decisões e repositório git. Os integrantes citados no briefing são adicionados como membros do espaço de trabalho, o que lhes concede acesso a ele. Use uma vez ao iniciar um novo projeto em um espaço de trabalho.",
  "Slug of the workspace the new board will live in.":
    "Slug do espaço de trabalho em que o novo quadro será criado.",
  "Free-text brief: goals, tech stack, constraints, timeline, team, and repos — everything the agent should extract and scaffold from.":
    "Briefing em texto livre: objetivos, stack tecnológica, restrições, cronograma, equipe e repositórios; tudo que o agente deve extrair e estruturar.",
  "Secretary": "Secretário",
  "Generate a daily standup for one board — progress, stale and overdue cards, bottlenecks — saved as a board note. Run each morning or before a team sync.":
    "Gere um standup diário de um quadro: progresso, cartões parados e atrasados e gargalos, salvo como nota do quadro. Execute todas as manhãs ou antes de uma sincronização da equipe.",
  "Slug of the workspace that owns the board.": "Slug do espaço de trabalho ao qual o quadro pertence.",
  "ID of the board to report on.": "ID do quadro sobre o qual será gerado o relatório.",
  "Audit board hygiene — missing priorities, empty descriptions, overdue or stale cards — into a health score with proposed fixes. Fixes run only after you confirm.":
    "Audite a organização do quadro: prioridades ausentes, descrições vazias e cartões atrasados ou parados. Gere uma pontuação de integridade com correções propostas. As correções só são executadas depois da sua confirmação.",
  "ID of the board to health-check.": "ID do quadro cuja integridade será verificada.",
  "Summarize every board in a workspace: completion, urgent and overdue counts, stalled boards, plus the top 3 recommended actions. Use for a weekly or executive overview.":
    "Resuma todos os quadros de um espaço de trabalho: conclusão, quantidades de itens urgentes e atrasados, quadros paralisados e as 3 principais ações recomendadas. Use para uma visão semanal ou executiva.",
  "Slug of the workspace to summarize across all of its boards.":
    "Slug do espaço de trabalho cujos quadros serão resumidos.",
  "Architect": "Arquiteto",
  "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.":
    "Decomponha um objetivo de alto nível em cartões sequenciados no backlog (1 a 3 dias cada), condicionados a um cartão de aceite ACCEPT-. Use ao planejar uma nova funcionalidade ou um bloco de trabalho.",
  "ID of the board where the cards will be created.": "ID do quadro em que os cartões serão criados.",
  "The high-level objective to break down into cards.":
    "Objetivo de alto nível que será decomposto em cartões.",
  "Split one oversized card into smaller, independently deliverable child cards that inherit its labels and priority. Use when a card is too big for 1-3 days of work.":
    "Divida um cartão grande demais em cartões filhos menores e entregáveis de forma independente, que herdam seus rótulos e sua prioridade. Use quando um cartão exceder 1 a 3 dias de trabalho.",
  "ID of the board the card lives on.": "ID do quadro ao qual o cartão pertence.",
  "ID of the oversized card to split.": "ID do cartão grande demais que será dividido.",
  "Plan a sprint: measure velocity, select backlog cards within capacity, stage them in the sprint column with due dates and owners, and pin a sprint-plan note.":
    "Planeje uma sprint: meça a velocidade, selecione cartões do backlog dentro da capacidade, posicione-os na coluna da sprint com prazos e responsáveis e fixe uma nota com o plano da sprint.",
  "ID of the board to plan the sprint on.": "ID do quadro em que a sprint será planejada.",
  "Coder": "Desenvolvedor",
  "Claim a card interactively: pick from the backlog-typed column, move it into the active-typed column, and output an implementation brief. Runners use next_assignment.":
    "Assuma um cartão de forma interativa: escolha-o na coluna do tipo backlog, mova-o para a coluna do tipo active e produza um briefing de implementação. Runners usam next_assignment.",
  "ID of the board to pick up work from.": "ID do quadro do qual o trabalho será assumido.",
  "Card to pick up. Omit to auto-select the highest-priority unassigned card in the backlog-typed column (resolved by column_type, never by column name). If no column on the board has a column_type, the prompt first types the columns via update_column rather than guessing by name.":
    "Cartão que será assumido. Omita para selecionar automaticamente o cartão sem responsável e de maior prioridade na coluna do tipo backlog (resolvida por column_type, nunca pelo nome). Se nenhuma coluna do quadro tiver column_type, o prompt primeiro define os tipos com update_column, em vez de adivinhar pelos nomes.",
  "Run the full delivery loop for one card: claim it, plan against the codebase, implement with strict TDD, verify, then move it to review with an implementation record.":
    "Execute o ciclo completo de entrega de um cartão: assuma-o, planeje com base no código, implemente com TDD rigoroso, verifique e depois mova-o para review com um registro da implementação.",
  "ID of the card to implement.": "ID do cartão que será implementado.",
  "Close out a reviewed card: move it to Done, mark it completed, write a completion note, report newly unblocked cards, and suggest the next card to pick up.":
    "Conclua um cartão revisado: mova-o para Done, marque-o como concluído, escreva uma nota de conclusão, informe os cartões recém-desbloqueados e sugira o próximo cartão a assumir.",
  "ID of the reviewed card to complete.": "ID do cartão revisado que será concluído.",
  "List of all workspaces you can access, with slugs and metadata. Read this first to discover the workspace_slug that every other call needs.":
    "Lista de todos os espaços de trabalho acessíveis, com slugs e metadados. Leia primeiro para descobrir o workspace_slug exigido pelas demais chamadas.",
  "Aggregate stats for one workspace: board, card, note, and channel counts plus recent activity. Same data as the get_workspace_summary tool.":
    "Estatísticas agregadas de um espaço de trabalho: contagens de quadros, cartões, notas e canais, além de atividade recente. Os mesmos dados da ferramenta get_workspace_summary.",
  "The board's definition document: scope plus structured content (objectives, tech stack, milestones, constraints). Same data as the get_definition tool.":
    "Documento de definição do quadro: escopo e conteúdo estruturado (objetivos, stack tecnológica, marcos e restrições). Os mesmos dados da ferramenta get_definition.",
  " tools across ": " ferramentas em ",
  " categories — searchable, filterable, and copy-ready. ":
    " categorias — pesquisáveis, filtráveis e prontas para copiar. ",
  "Loop Templates": "Templates de loop",
  "Bind the loop to a loop template — a system slug or a workspace template's row UUID. The board's prompts and tools become the render of that template and are owned by it.":
    'Vincule o loop a um template de loop — um slug "system" ou o UUID da linha de um template do espaço de trabalho. Os prompts e as ferramentas do quadro passam a ser o render desse template e pertencem a ele.',
  '"system" (default) or "workspace" — which namespace template_ref lives in.':
    '"system" (padrão) ou "workspace" — em qual namespace template_ref está.',
  "Pin the bind to a specific published version. Omit to take the newest.":
    "Fixe o vínculo em uma versão publicada específica. Omita para usar a mais recente.",
  "Values for the template's <<SLOT>> placeholders, as {\"SLOT_NAME\": value}. FULL REPLACE. Sent alone (no template_ref) it re-renders the board's existing binding.":
    'Valores para os marcadores <<SLOT>> do template, no formato {"SLOT_NAME": value}. SUBSTITUIÇÃO TOTAL. Enviado sozinho (sem template_ref), ele renderiza novamente o vínculo já existente do quadro.',
  "True drops the binding and keeps the rendered prompts as plain editable text. Wins over template_ref if both are passed.":
    "True remove o vínculo e mantém os prompts renderizados como texto editável comum. Prevalece sobre template_ref se ambos forem enviados.",
  "Optimistic lock for the config PUT — the loop config version you last read. A concurrent edit makes this 409 rather than clobbering.":
    "Trava otimista para o PUT da configuração — a versão da configuração do loop que você leu por último. Uma edição concorrente resulta em 409 em vez de sobrescrever.",
  "Binding a template makes it own system_prompt/loop_prompt/tools: sending those in the same call is 422, and sending them later on a bound board is 409 (detach first with detach_template=true).":
    "Vincular um template faz com que ele passe a ser dono de system_prompt/loop_prompt/tools: enviá-los na mesma chamada resulta em 422, e enviá-los depois em um quadro vinculado resulta em 409 (desvincule antes com detach_template=true).",
  "slot_values is a FULL REPLACE of the binding's values — read them back with get_board_loop_binding_raw and send the whole object.":
    "slot_values é uma SUBSTITUIÇÃO TOTAL dos valores do vínculo — leia-os com get_board_loop_binding_raw e envie o objeto inteiro.",
  "Browse the loop template catalog: system templates then workspace ones, as summaries. Prompts and slots live behind get_loop_template.":
    'Navegue pelo catálogo de templates de loop: primeiro os templates "system", depois os do espaço de trabalho, em forma de resumos. Os prompts e os slots ficam por trás de get_loop_template.',
  "Free-text filter over name and slug. Omit for the full catalog.":
    "Filtro de texto livre sobre o nome e o slug. Omita para ver o catálogo completo.",
  '"name" (default), "updated_at", or "boards_using".':
    '"name" (padrão), "updated_at" ou "boards_using".',
  "True to also list soft-archived workspace templates.":
    "True para listar também os templates do espaço de trabalho arquivados de forma reversível.",
  "Entries are summaries on purpose — a catalog that inlined every prompt pair would ship tens of kilobytes per call.":
    "As entradas são resumos de propósito — um catálogo que incluísse cada par de prompts enviaria dezenas de kilobytes por chamada.",
  "meta.runner_vars carries the runner's Go-template variable vocabulary, so a prompt editor never has to hardcode it.":
    "meta.runner_vars traz o vocabulário de variáveis Go-template do runner, para que um editor de prompts nunca precise escrevê-lo manualmente.",
  "Read one loop template. view picks the read: full (default), profile with track record, preview render, fit pre-flight against a board, or lint for repo facts.":
    "Lê um template de loop. view escolhe a leitura: full (padrão), profile com histórico, renderização de preview, pré-verificação fit contra um quadro, ou lint para dados do repositório.",
  '"full" (default), "profile", "preview", "fit" or "lint" — which read this is. Anything else is rejected before a request is made.':
    '"full" (padrão), "profile", "preview", "fit" ou "lint" — qual leitura é esta. Qualquer outro valor é rejeitado antes de qualquer requisição.',
  "view=\"full\" only: true also resolves a soft-archived workspace template. A board bound before the archive still runs it, so reading that board's loop needs this.":
    'Somente com view="full": true também resolve um template do espaço de trabalho arquivado de forma reversível. Um quadro vinculado antes do arquivamento ainda o executa, então ler o loop desse quadro precisa disto.',
  "UUID (or slug) of a board. Required for view=\"fit\"; optional for view=\"preview\", where the board's autofill values and rails participate in the render.":
    'UUID (ou slug) de um quadro. Obrigatório com view="fit"; opcional com view="preview", onde os valores de autofill e os rails do quadro participam da renderização.',
  'view="preview" only: false omits the rendered prompt bodies and keeps the findings, slot and rails data.':
    'Somente com view="preview": false omite os corpos de prompt renderizados e mantém os achados e os dados de slots e rails.',
  'view="full" returns everything — profile, system/loop prompts, slot specs, rails defaults and tool grants. A ref is a system slug OR a workspace row UUID: the namespaces never mix, and there is no slug@version form.':
    'view="full" retorna tudo — perfil, prompts de sistema e de loop, especificações de slots, padrões de rails e permissões de ferramentas. Uma ref é um slug "system" OU o UUID de linha do espaço de trabalho: os namespaces nunca se misturam, e não existe a forma slug@version.',
  'view="profile" is the track record — boards using it, iterations, spend and outcome tallies — that makes "does this loop actually work?" answerable before binding a board. Archived templates are included here.':
    'view="profile" é o histórico — quadros que o usam, iterações, gasto e contagem de resultados — que permite responder "este loop funciona de verdade?" antes de vincular um quadro. Templates arquivados são incluídos aqui.',
  'view="preview" renders the prompts without binding or storing anything. include_prompts defaults to true and returns three full bodies — tens of kilobytes — so an agent already running inside a loop should not call it; false keeps findings, missing_required, used_values, rails and tools.':
    'view="preview" renderiza os prompts sem vincular nem armazenar nada. include_prompts é true por padrão e retorna três corpos completos — dezenas de kilobytes — então um agente que já está em execução dentro de um loop não deve chamá-lo; false mantém findings, missing_required, used_values, rails e tools.',
  'view="fit" is a read-only board pre-flight: each check reports ok, missing or warn with its evidence, and carries a fix_id only when apply_loop_template_fixes can close it. autofill proposes slot values derived from the board, so binding never starts from an empty form.':
    'view="fit" é uma pré-verificação do quadro somente leitura: cada verificação informa ok, missing ou warn com sua evidência, e carrega um fix_id apenas quando apply_loop_template_fixes pode resolvê-la. autofill propõe valores de slot derivados do quadro, então vincular nunca começa de um formulário vazio.',
  'view="lint" flags repo-specific facts — URLs, org/repo names, commit SHAs, machine paths — left in the kernel prompts that belong in slots before sharing. Hints only, false positives expected: publish and export succeed regardless.':
    'view="lint" sinaliza dados específicos do repositório — URLs, nomes org/repo, SHAs de commit, caminhos de máquina — deixados nos prompts do kernel e que devem ir para slots antes de compartilhar. Apenas dicas, com falsos positivos esperados: publicar e exportar funcionam do mesmo jeito.',
  'A view-specific param passed outside its view, an unknown view, or view="fit" without board_id is rejected before any request. Archived templates are excluded from view="full" by default, exactly as the REST route excludes them — pass include_archived to read one a board is still bound to.':
    'Um parâmetro específico de uma view passado fora dela, uma view desconhecida, ou view="fit" sem board_id são rejeitados antes de qualquer requisição. Templates arquivados são excluídos de view="full" por padrão, exatamente como a rota REST os exclui — envie include_archived para ler um ao qual um quadro ainda está vinculado.',
  "A system template slug, or a workspace template's row UUID.":
    'Um slug de template "system" ou o UUID da linha de um template do espaço de trabalho.',
  "Create a workspace loop template as a draft (version 0, nothing published). Admin only; runner keys are refused.":
    "Crie um template de loop do espaço de trabalho como rascunho (versão 0, nada publicado). Somente admin; chaves de runner são recusadas.",
  "URL-safe identifier, unique within the workspace.":
    "Identificador seguro para URL, único dentro do espaço de trabalho.",
  "Human-readable display name.": "Nome de exibição legível para pessoas.",
  "Prompt/slot/rails body — {system_prompt, loop_prompt, slots, tools, rails_defaults}. Omit to start empty.":
    "Corpo de prompts, slots e rails — {system_prompt, loop_prompt, slots, tools, rails_defaults}. Omita para começar vazio.",
  "Presentation identity — {emoji, tagline, tags}. Omit for none.":
    "Identidade de apresentação — {emoji, tagline, tags}. Omita para não incluir nenhuma.",
  "Deliberately NOT idempotent: a repeated slug returns 409 rather than the existing row, so your content is never silently discarded.":
    "Deliberadamente NÃO idempotente: um slug repetido retorna 409 em vez da linha existente, de modo que seu conteúdo nunca é descartado silenciosamente.",
  "Large prompt bodies are better authored in the UI or over REST — MCP transports have garbled multi-kilobyte strings before.":
    "Corpos de prompt grandes são melhor escritos na UI ou via REST — transportes MCP já corromperam strings de vários kilobytes antes.",
  "Template mutations are admin + runner-caller-banned: a runner editing the prompt that governs it is the escalation this surface refuses.":
    "Mutações de template exigem admin e proíbem runners como chamadores: um runner editando o prompt que o governa é a escalada de privilégios que esta superfície recusa.",
  "Autosave the draft half of a workspace template. Publishing is a separate step. Admin only; runner keys are refused.":
    "Salve automaticamente a metade do rascunho de um template do espaço de trabalho. Publicar é uma etapa separada. Somente admin; chaves de runner são recusadas.",
  "The workspace template's row UUID (or slug).":
    "O UUID da linha do template do espaço de trabalho (ou seu slug).",
  "Full replacement prompt/slot/rails body — not a deep merge.":
    "Corpo de prompts, slots e rails de substituição total — não é um merge profundo.",
  "Full replacement presentation identity.":
    "Identidade de apresentação de substituição total.",
  "Optimistic lock — the draft_updated_at you last read. A concurrent edit makes this 409 instead of clobbering.":
    "Trava otimista — o draft_updated_at que você leu por último. Uma edição concorrente resulta em 409 em vez de sobrescrever.",
  "content and profile REPLACE their whole object when sent: read the template first and send the full object back, never a fragment.":
    "content e profile SUBSTITUEM todo o seu objeto quando enviados: leia o template primeiro e devolva o objeto completo, nunca um fragmento.",
  "System templates are code-defined and cannot be edited — duplicate one into the workspace first.":
    'Templates "system" são definidos em código e não podem ser editados — duplique um para o espaço de trabalho primeiro.',
  "Passing no field at all returns an error rather than bumping the draft timestamp for nothing.":
    "Não enviar nenhum campo retorna um erro em vez de atualizar o timestamp do rascunho à toa.",
  "Validate the draft, snapshot it as a new version, and bump the published version. Boards bound to it then see drift.":
    "Valida o rascunho, registra um snapshot dele como nova versão e avança a versão publicada. Os quadros vinculados a ele passam então a ver drift.",
  "Optimistic lock — the version you believe is current.":
    "Trava otimista — a versão que você acredita ser a atual.",
  "Short changelog line stored with the version (<= 500 chars).":
    "Linha curta de changelog armazenada com a versão (<= 500 caracteres).",
  "A draft that fails validation returns 422 with findings attached, each naming the offending field.":
    "Um rascunho que não passa na validação retorna 422 com os achados anexados, cada um nomeando o campo problemático.",
  "Publishing does not touch bound boards — they keep their rendered prompts until someone re-renders.":
    "Publicar não altera os quadros vinculados — eles mantêm seus prompts renderizados até que alguém renderize novamente.",
  "Fork any template — system or workspace — into a new workspace draft, recording lineage back to the source.":
    'Faça um fork de qualquer template — "system" ou do espaço de trabalho — em um novo rascunho do espaço de trabalho, registrando a linhagem até a origem.',
  "The template to fork — a system slug or a workspace row UUID.":
    'O template do qual fazer fork — um slug "system" ou o UUID da linha do espaço de trabalho.',
  "Slug for the copy. Omit to let the backend derive a unique one.":
    "Slug para a cópia. Omita para que o backend derive um slug único.",
  "This is how a system template gets customized: system templates are immutable, so editing one means duplicating it first.":
    'É assim que um template "system" é personalizado: templates "system" são imutáveis, portanto editar um significa duplicá-lo antes.',
  "Soft-archive a workspace template, or restore it to the listing with archived=false. There is no hard delete.":
    "Arquive de forma reversível um template do espaço de trabalho ou restaure-o à listagem com archived=false. Não existe exclusão definitiva.",
  "True to archive (default), false to restore to the listing.":
    "True para arquivar (padrão), false para restaurar à listagem.",
  "Archiving removes it from the catalog listing but keeps it serving boards already bound to it.":
    "Arquivar remove o template da listagem do catálogo, mas ele continua servindo os quadros já vinculados a ele.",
  "There is no hard delete on purpose — a board bound to a deleted template would render nothing on its next iteration.":
    "Não existe exclusão definitiva de propósito — um quadro vinculado a um template excluído não renderizaria nada na sua próxima iteração.",
  "The template's published history, newest first: version number, publish timestamp, and changelog note.":
    "O histórico publicado do template, do mais recente ao mais antigo: número da versão, timestamp da publicação e nota de changelog.",
  "Stage a published snapshot as the current draft. It does NOT republish — review, then publish separately.":
    "Prepare um snapshot publicado como o rascunho atual. Isso NÃO republica — revise e depois publique separadamente.",
  "The published version number to stage as the draft.":
    "O número da versão publicada a ser preparada como rascunho.",
  "Restoring is a draft edit, not a rollback: the published version stays put until you publish the restored draft.":
    "Restaurar é uma edição de rascunho, não um rollback: a versão publicada permanece a mesma até você publicar o rascunho restaurado.",
  "Raw view of a board's template binding: template, version, rendered slot values, and drift — the authoring state behind get_board_loop, the effective loop config.":
    "Visão bruta do vínculo de template de um quadro: template, versão, valores de slot renderizados e drift — o estado de autoria por trás de get_board_loop, a configuração efetiva do ciclo.",
  "True to also fetch the unified prompt diff and slot delta between the bound version and the current one.":
    "True para buscar também o diff unificado dos prompts e o delta de slots entre a versão vinculada e a atual.",
  'get_board_loop carries only the slim template ref — enough to render "bound to X", not enough to re-render. This is the read that answers "what would I edit?".':
    'get_board_loop traz apenas a ref reduzida do template — suficiente para exibir "vinculado a X", mas não para renderizar novamente. Esta é a leitura que responde "o que eu editaria?".',
  "Returns 404 not_bound when the board's prompts are raw rather than template-rendered.":
    "Retorna 404 not_bound quando os prompts do quadro são texto bruto em vez de renderizados a partir de um template.",
  "include_diff costs a second round-trip and is skipped entirely when the binding reports diff_available: false — a board with no drift has nothing to diff.":
    "include_diff custa uma segunda ida e volta e é totalmente ignorado quando o vínculo informa diff_available: false — um quadro sem drift não tem nada a comparar.",
  "Apply the named setup fixes from a fit report (create a missing column, add a label) and return the freshly recomputed report.":
    "Aplique as correções de configuração indicadas em um relatório de compatibilidade (criar uma coluna ausente, adicionar um rótulo) e retorne o relatório recalculado.",
  "The fix_id values from get_loop_template(view='fit'), e.g. \"create_column:done\". Only these are applied — nothing implicit.":
    "Os valores fix_id de get_loop_template(view='fit'), por exemplo \"create_column:done\". Somente esses são aplicados — nada implícito.",
  "Admin + human keys only — the backend 403s runner callers, because a loop runner reshaping the board that governs it is a privilege escalation.":
    "Somente chaves de admin e humanas — o backend retorna 403 para chamadores do tipo runner, porque um runner de loop remodelando o quadro que o governa é uma escalada de privilégios.",
  "Idempotent per fix: an already-satisfied requirement returns skipped_already_satisfied, never an error.":
    "Idempotente por correção: um requisito já satisfeito retorna skipped_already_satisfied, nunca um erro.",
  "Unknown fix ids are rejected wholesale (422) before anything is applied; a frozen board 409s.":
    "Ids de correção desconhecidos são rejeitados em bloco (422) antes que qualquer coisa seja aplicada; um quadro congelado retorna 409.",
  "Acts on the DRAFT half, like the report it consumes: a board can be prepared for a contract that has not been published yet. A column is inert until something binds to it.":
    "Age sobre a metade RASCUNHO, como o relatório que consome: um quadro pode ser preparado para um contrato que ainda não foi publicado. Uma coluna é inerte até que algo se vincule a ela.",
  "This mutates board structure — it can create columns and labels. Run get_loop_template(view='fit') first and pass only the fix_ids you intend.":
    "Isso altera a estrutura do quadro — pode criar colunas e rótulos. Execute get_loop_template(view='fit') antes e envie apenas os fix_ids que você pretende aplicar.",
  "Export one loop template as a portable envelope — profile, prompts, slots, rails. Feed it to import_loop_template to promote a proven loop elsewhere.":
    "Exporte um template de loop como um envelope portátil — perfil, prompts, slots e rails. Envie-o para import_loop_template a fim de promover um loop já comprovado em outro lugar.",
  "The URL slug identifying the SOURCE workspace.":
    "O slug de URL que identifica o espaço de trabalho de ORIGEM.",
  "Exports the DRAFT half, so work in progress is shareable — publish first if you mean to share the runnable version.":
    "Exporta a metade do RASCUNHO, de modo que o trabalho em andamento possa ser compartilhado — publique antes se pretende compartilhar a versão executável.",
  "Exporting a SYSTEM template is allowed and marked data.is_system_origin: it is the supported way to fork a shipped loop.":
    "Exportar um template SYSTEM é permitido e é marcado com data.is_system_origin: é a forma suportada de fazer fork de um loop já distribuído.",
  "data.leak_findings carries the same repo-fact hints get_loop_template(view='lint') reports, as warnings only — the export always succeeds. _hint counts them.":
    "data.leak_findings traz as mesmas dicas sobre dados de repositório que get_loop_template(view='lint') reporta, apenas como avisos — a exportação sempre é bem-sucedida. _hint faz a contagem delas.",
  "Member-gated, not admin-gated: anyone who can read the template in the manager can export it.":
    "Restrito a membros, não a admins: qualquer pessoa que possa ler o template no manager pode exportá-lo.",
  "Import a loop_template envelope as a DRAFT in this workspace. Previews by default; dry_run=false commits. Admin/human keys only — runners get 403.":
    "Importe um envelope loop_template como RASCUNHO neste espaço de trabalho. Por padrão apenas pré-visualiza; dry_run=false grava as alterações. Somente chaves de admin ou humanas — runners recebem 403.",
  "The URL slug identifying the TARGET workspace.":
    "O slug de URL que identifica o espaço de trabalho de DESTINO.",
  "The full envelope exactly as returned by export_loop_template.":
    "O envelope completo exatamente como retornado por export_loop_template.",
  "Defaults to true: report action, findings and diff_summary, and write nothing. Set false to apply.":
    "Padrão true: reporta action, findings e diff_summary, e não grava nada. Defina como false para aplicar.",
  "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false, which adds template_id.":
    "`dry_run` é TRUE por padrão — nada é gravado até você chamar novamente com dry_run=false, o que acrescenta template_id.",
  "A commit always lands UNPUBLISHED, so an import can never change what a running board executes; publish_loop_template stays a separate act.":
    "Uma gravação sempre chega NÃO PUBLICADA, de modo que uma importação nunca pode mudar o que um quadro em execução executa; publish_loop_template continua sendo um ato separado.",
  "A matching slug in the target makes this action=updated — the existing DRAFT is overwritten. Check diff_summary in the dry run first.":
    "Um slug coincidente no destino torna isto action=updated — o RASCUNHO existente é sobrescrito. Verifique antes o diff_summary no dry run.",
  "Runner callers are refused with 403 by design: a runner must not import the prompt that governs it. Envelope mismatch → 400; unrenderable template → 422.":
    "Chamadores do tipo runner são recusados com 403 por design: um runner não deve importar o prompt que o governa. Envelope incompatível → 400; template não renderizável → 422.",
  "Bundles over ~64 KB are better sent to POST /loop-templates/import directly — large JSON bodies through MCP have been seen to garble.":
    "Pacotes acima de ~64 KB é melhor enviar diretamente para POST /loop-templates/import — já se observou que corpos JSON grandes se corrompem ao passar pelo MCP.",
  "With dry_run=false a slug collision OVERWRITES the target workspace's existing draft for that slug. Export a backup bundle from the target first.":
    "Com dry_run=false, uma colisão de slug SOBRESCREVE o rascunho existente para esse slug no espaço de trabalho de destino. Exporte antes um pacote de backup a partir do destino.",
  "Skills": "Skills",
  "List the workspace skill library, or a board's effective skill set, with each skill's declared toolsets. Metadata only — file contents live behind get_skill.":
    "Lista a biblioteca de skills do espaço de trabalho, ou o conjunto efetivo de skills de um quadro, com os toolsets declarados de cada skill. Apenas metadados: o conteúdo dos arquivos fica atrás de get_skill.",
  "Board UUID or slug (backend-resolved). When given, returns the board's effective skill set instead of the full workspace library.":
    "UUID ou slug do quadro (resolvido pelo backend). Quando informado, retorna o conjunto efetivo de skills do quadro em vez da biblioteca completa do espaço de trabalho.",
  "Workspace listings hide archived skills by default; pass true to include them. Ignored when board_id is given.":
    "As listagens do espaço de trabalho ocultam as skills arquivadas por padrão; passe true para incluí-las. Ignorado quando board_id é informado.",
  "Listings never inline file contents — install a skill by calling get_skill and writing each returned file verbatim into your local skills dir.":
    "As listagens nunca incluem o conteúdo dos arquivos: instale uma skill chamando get_skill e gravando cada arquivo retornado literalmente no seu diretório local de skills.",
  "Fetch a skill version's files verbatim (SKILL.md plus support files) and its declared toolsets. Omitting version resolves the latest published one.":
    "Busca literalmente os arquivos de uma versão de uma skill (SKILL.md mais arquivos de apoio) e seus toolsets declarados. Se version for omitido, resolve a última versão publicada.",
  "The skill slug.": "O slug da skill.",
  "Explicit version number. Omit to fetch the latest published version; pass explicitly to fetch a specific version or a draft.":
    "Número de versão explícito. Omita para buscar a última versão publicada; informe explicitamente para buscar uma versão específica ou um rascunho.",
  "Path of a single file to return in full, bypassing the per-file truncation cap.":
    "Caminho de um único arquivo a retornar por completo, contornando o limite de truncamento por arquivo.",
  "Files longer than 6000 chars are truncated in the multi-file response (flagged via _files_truncated) — re-fetch each one in full with file_path.":
    "Arquivos com mais de 6000 caracteres são truncados na resposta multiarquivo (sinalizado via _files_truncated); busque cada um por completo novamente com file_path.",
  "A skill with no published version returns empty files; pass version explicitly to read a draft.":
    "Uma skill sem versão publicada retorna arquivos vazios; informe version explicitamente para ler um rascunho.",
  "Enable or disable a workspace skill on a board, optionally pinning a version. Idempotent — re-binding updates in place.":
    "Habilita ou desabilita uma skill do espaço de trabalho em um quadro, com a opção de fixar uma versão. Idempotente: revincular atualiza no lugar.",
  "The board UUID or slug (backend-resolved).": "O UUID ou slug do quadro (resolvido pelo backend).",
  "The slug of the workspace skill to bind.": "O slug da skill do espaço de trabalho a vincular.",
  "Whether the skill is active on the board. Omit to leave an existing binding's state unchanged; a newly created binding defaults to enabled.":
    "Se a skill está ativa no quadro. Omita para deixar inalterado o estado de uma vinculação existente; uma vinculação recém-criada fica ativa por padrão.",
  "Version number to pin the board to. Omit to leave any existing pin unchanged; an unpinned board tracks the latest published version.":
    "Número de versão em que fixar o quadro. Omita para deixar qualquer fixação existente inalterada; um quadro sem fixação acompanha a última versão publicada.",
  "Pass true to remove an existing version pin, returning the board to tracking the latest published version. Mutually exclusive with pinned_version.":
    "Passe true para remover uma fixação de versão existente, devolvendo o quadro ao acompanhamento da última versão publicada. Mutuamente exclusivo com pinned_version.",
  "Omitting pinned_version leaves an existing pin as-is (PUT semantics of an omitted field) — it does not clear the pin; unpin with clear_pin: true.":
    "Omitir pinned_version mantém uma fixação existente como está (semântica PUT de um campo omitido): não remove a fixação; para removê-la use clear_pin: true.",
  "pinned_version and clear_pin together is an error — pin or unpin, not both.":
    "Enviar pinned_version e clear_pin juntos é um erro: fixe ou remova a fixação, não os dois.",
  "Raw view of a board's skill binding rows, disabled ones included. list_skills(board_id) is the effective set callers actually get.":
    "Visão bruta das linhas de vinculação de skills de um quadro, incluindo as desabilitadas. list_skills(board_id) é o conjunto efetivo que quem chama realmente recebe.",
  "Rows are configuration, not what agents get: a disabled binding or one resolving to no published version appears here but never in the board's effective set (list_skills with board_id).":
    "As linhas são configuração, não o que os agentes recebem: uma vinculação desabilitada, ou que não resolve para nenhuma versão publicada, aparece aqui, mas nunca no conjunto efetivo do quadro (list_skills com board_id).",
  "Unbind a skill from a board, deleting the binding row (enabled flag and pin included). Idempotent — removing a missing binding still succeeds.":
    "Desvincula uma skill de um quadro, excluindo a linha da vinculação (incluindo o indicador enabled e a fixação). Idempotente: remover uma vinculação inexistente também tem sucesso.",
  "The slug of the bound skill to remove.": "O slug da skill vinculada a remover.",
  "Unbind destroys the row's configuration — any version pin is lost. To keep the pin but take the skill out of the effective set, disable it instead via set_skill_binding with enabled: false.":
    "Desvincular destrói a configuração da linha: qualquer fixação de versão é perdida. Para manter a fixação mas tirar a skill do conjunto efetivo, desabilite-a com set_skill_binding e enabled: false.",
  "List the built-in skill catalog: platform-curated skills not yet in the workspace library, each with its declared toolsets, ready to activate.":
    "Lista o catálogo integrado de skills: as skills curadas pela plataforma que ainda não estão na biblioteca do espaço de trabalho, cada uma com seus toolsets declarados e prontas para ativação.",
  "Catalog entries are not workspace skills yet — activate one (activate_catalog_skill) to copy it into the library before it can be bound to boards.":
    "As entradas do catálogo ainda não são skills do espaço de trabalho: ative uma (activate_catalog_skill) para copiá-la para a biblioteca antes de poder vinculá-la a quadros.",
  "Copy a catalog entry into the workspace library as a published v1. Idempotent — re-activation returns the existing copy untouched.":
    "Copia uma entrada do catálogo para a biblioteca do espaço de trabalho como uma v1 publicada. Idempotente: reativar retorna a cópia existente sem alterações.",
  "The catalog entry id, from list_skill_catalog.":
    "O id da entrada do catálogo, obtido em list_skill_catalog.",
  "Human sessions only: the backend rejects runner-bound callers (API keys linked to a runner identity) with a 403 — activation is a curation decision reserved for people.":
    "Apenas sessões humanas: o backend rejeita com 403 quem chama com identidade de runner (chaves de API vinculadas a um runner), porque a ativação é uma decisão de curadoria reservada às pessoas.",
  "Propose a new skill (or version) for the workspace library. Lands as a draft pending human approval; idempotent — re-proposing returns the existing pending proposal.":
    "Propõe uma skill nova (ou uma nova versão de uma existente) para a biblioteca do espaço de trabalho. Fica como rascunho pendente de aprovação humana; idempotente: propor de novo retorna a proposta pendente existente.",
  "The skill slug the proposal creates or versions.":
    "O slug da skill que a proposta cria ou versiona.",
  'The skill\'s files as [{"path": ..., "content": ...}] — SKILL.md plus any support files, contents sent verbatim.':
    'Os arquivos da skill como [{"path": ..., "content": ...}]: SKILL.md mais quaisquer arquivos de apoio, com o conteúdo enviado literalmente.',
  "Display name. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.":
    "Nome de exibição. Omita para que o backend o tome do frontmatter do SKILL.md, que é a fonte autoritativa.",
  "Description. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.":
    "Descrição. Omita para que o backend a tome do frontmatter do SKILL.md, que é a fonte autoritativa.",
  "Board UUID or slug (backend-resolved) to associate the proposal with — e.g. the board whose loop produced it.":
    "UUID ou slug do quadro (resolvido pelo backend) ao qual associar a proposta, por exemplo o quadro cujo loop a produziu.",
  "Nothing is published until a human approves — poll get_approval_status with the returned approval_id before relying on the skill.":
    "Nada é publicado até um humano aprovar: consulte get_approval_status com o approval_id retornado antes de depender da skill.",
  "File contents are sent verbatim on this write path — the 6000-char truncation cap only applies to reads via get_skill.":
    "O conteúdo dos arquivos é enviado literalmente neste caminho de escrita: o limite de truncamento de 6000 caracteres só se aplica a leituras via get_skill.",
  "Whether loop agents on this board may call propose_skill. Defaults to true (backend-enforced). When false the backend strips propose_skill from the loop's served tool allowlist. Omit to leave unchanged.":
    "Se os agentes de loop deste quadro podem chamar propose_skill. Padrão: true (aplicado pelo backend). Quando false, o backend remove propose_skill da lista de ferramentas servida ao loop. Omita para deixar sem alterações.",
} as const;

const PT_BR_MCP_TOOLSETS = {
  "Everyday project work: default keeps the interactive catalog compact.":
    "Trabalho diário do projeto: default mantém o catálogo interativo compacto.",
  "Loops and runners:":
    "Loops e runners:",
  " is for an interactive human connection to prepare and manage loops.":
    " serve para uma conexão humana interativa que prepara e gerencia loops.",
  "Everything: all is an explicit opt-in to a larger catalog that may exceed client tool limits.":
    "Tudo: all é uma escolha explícita de um catálogo maior que pode ultrapassar os limites de ferramentas do cliente.",
  "Presets are starting selections. Preserve custom toolset compositions and existing credentials. Actual autonomous runner launches use all intersected with their authorized allowlist; do not replace that execution configuration with the interactive loops preset.":
    "As predefinições são seleções iniciais. Preserve as composições personalizadas de toolsets e as credenciais existentes. Os runners autônomos reais usam all em interseção com sua allowlist autorizada; não substitua essa configuração de execução pela predefinição interativa de loops.",
  "Use the exact returned restart_env for recovery: it preserves every enabled group, including custom toolsets. Keep existing credentials and VALARIS_MCP_ALLOWLIST unchanged. The following fresh connection example is for interactive loops; it must not replace a wider recovered selection.":
    "Use exatamente o restart_env retornado para a recuperação: ele preserva todos os grupos habilitados, inclusive toolsets personalizados. Mantenha as credenciais existentes e VALARIS_MCP_ALLOWLIST sem alterações. O exemplo a seguir de conexão nova serve para loops interativos; ele não deve substituir uma seleção recuperada mais ampla.",
  "Remote MCP service startup environment":
    "Ambiente de inicialização do serviço MCP remoto",
  "The remote operator applies these values to the actual MCP service startup environment, retains the existing API/authentication configuration, and protects the endpoint behind authenticated access or a trusted private network. MCP_HOST=0.0.0.0 is a bind address, not access control. Local client environment cannot change a remote service.":
    "O operador remoto aplica esses valores ao ambiente de inicialização do serviço MCP real, mantém a configuração existente de API/autenticação e protege o endpoint com acesso autenticado ou uma rede privada confiável. MCP_HOST=0.0.0.0 é um endereço de escuta, não um controle de acesso. O ambiente local do cliente não pode alterar um serviço remoto.",
  "Restart the MCP server/connection, then start a fresh agent session and repeat the read-only native checks. A new chat alone may reuse a stale server or cached catalog. Repeating enable_toolsets cannot force a client refresh. If a tool is still missing, check the running version, startup toolsets and authorized allowlist before changing configuration.":
    "Reinicie o servidor/conexão MCP, abra uma nova sessão do agente e repita as verificações nativas somente de leitura. Um novo chat sozinho pode reutilizar um servidor desatualizado ou um catálogo em cache. Repetir enable_toolsets não pode forçar a atualização do cliente. Se uma ferramenta ainda estiver ausente, confira a versão em execução, os toolsets de inicialização e a allowlist autorizada antes de alterar a configuração.",
  "A toolset is a named slice of the MCP surface. Every group and every category of the tool catalog is one, addressed by its id, and the server lists and serves only the tools in the toolsets you load. A tool that is not listed cannot be called either, so the model never sees a name it may not use.":
    "Um toolset é uma fatia nomeada da superfície MCP. Cada grupo e cada categoria do catálogo de ferramentas é um, identificado pelo seu id, e o servidor lista e serve apenas as ferramentas dos toolsets que você carrega. Uma ferramenta que não está listada também não pode ser chamada, então o modelo nunca vê um nome que não pode usar.",
  "A ":
    "Uma ",
  "skill":
    "habilidade",
  " declares the toolsets its playbook plays in; that declaration is guidance, and only the loaded toolsets enforce.":
    " declara os toolsets em que seu playbook joga; essa declaração é orientação, e apenas os toolsets carregados impõem.",
  "The env contract":
    "O contrato da variável de ambiente",
  " is read once when the MCP server starts. Unset or empty it means ":
    " é lida uma única vez quando o servidor MCP inicia. Não definida ou vazia equivale a ",
  ", the interactive hand described below. ":
    ", a mão interativa descrita abaixo. ",
  " loads every tool. Anything else is a comma-separated list of toolset ids; ":
    " carrega todas as ferramentas. Qualquer outro valor é uma lista de ids de toolsets separados por vírgulas; ",
  " may appear in that list and expands to the default hand. Ids are case-sensitive and whitespace around the commas is ignored.":
    " pode aparecer nessa lista e se expande para a mão padrão. Os ids diferenciam maiúsculas de minúsculas e os espaços ao redor das vírgulas são ignorados.",
  "Unknown ids fail closed":
    "Ids desconhecidos falham de forma segura",
  "An id that is not a group id, a category id, ":
    "Um id que não seja um id de grupo, um id de categoria, ",
  ", or":
    " ou",
  " stops the server at startup with an error naming the offending ids and the valid ones. A typo never silently disables the gate.":
    " interrompe o servidor na inicialização com um erro que nomeia os ids problemáticos e os válidos. Um erro de digitação nunca desativa o controle silenciosamente.",
  "The default hand":
    "A mão padrão",
  "Unless told otherwise the server serves the interactive default hand: the union of these group toolsets minus a short exclusion list, plus a short inclusion list of read-only helpers from the other groups. It currently resolves to ":
    "Salvo indicação em contrário, o servidor serve a mão interativa padrão: a união destes toolsets de grupo menos uma breve lista de exclusões, mais uma breve lista de inclusões de auxiliares somente leitura dos outros grupos. Atualmente ela se resolve em ",
  " tools.":
    " ferramentas.",
  "Groups in the default hand:":
    "Grupos da mão padrão:",
  "Excluded from it, even though their group is loaded:":
    "Excluídas dela, mesmo com o grupo carregado:",
  "Tool":
    "Ferramenta",
  "Why it is excluded":
    "Por que é excluída",
  // Reason keys mirror mcp-server/src/valaris_mcp/toolsets.py DEFAULT_EXCLUSIONS and DEFAULT_INCLUSIONS verbatim.
  "destroys a board and every card on it":
    "destrói um quadro e todos os seus cartões",
  "destroys the whole workspace":
    "destrói o espaço de trabalho inteiro",
  "workspace admin":
    "administração do espaço de trabalho",
  "runner-only pickup path; interactive sessions claim by move_card":
    "caminho de pickup exclusivo de runners; sessões interativas reivindicam com move_card",
  "cascade-deletes every card in the column":
    "exclui em cascata todos os cartões da coluna",
  "workspace admin, pairs with remove_workspace_member":
    "administração do espaço de trabalho, forma par com remove_workspace_member",
  "workspace admin, pairs with freeze_board":
    "administração do espaço de trabalho, forma par com freeze_board",
  "read-only; boards are linked to repos":
    "somente leitura; quadros estão vinculados a repositórios",
  "the server instructions tell interactive agents to install the board's skills":
    "as instruções do servidor orientam agentes interativos a instalar as skills do quadro",
  "read-only reporting used by the standup workflow":
    "relatórios somente leitura usados pelo fluxo de standup",
  "Pulled into it from groups the default hand does not load:":
    "Trazidas para ela de grupos que a mão padrão não carrega:",
  "Why it is included":
    "Por que é incluída",
  "The other groups are opt-in:":
    "Os demais grupos são opcionais:",
  ". Add them to the list when the session needs workspace setup or runner administration.":
    ". Adicione-os à lista quando a sessão precisar configurar o espaço de trabalho ou administrar runners.",
  "Available toolsets":
    "Toolsets disponíveis",
  "One row per toolset. Group ids are slugified from the group titles of the tool catalog; category ids are the catalog's own.":
    "Uma linha por toolset. Os ids de grupo são derivados dos títulos de grupo do catálogo de ferramentas; os ids de categoria são os do próprio catálogo.",
  "Toolset":
    "Toolset",
  "Kind":
    "Tipo",
  "Title":
    "Título",
  "Group":
    "Grupo",
  "Tools":
    "Ferramentas",
  "Category":
    "Categoria",
  "Start here":
    "Comece aqui",
  "Work management":
    "Gestão do trabalho",
  "Knowledge & content":
    "Conhecimento e conteúdo",
  "Collaboration":
    "Colaboração",
  "Autonomous operations":
    "Operações autônomas",
  "Project Context":
    "Contexto do projeto",
  "Search":
    "Busca",
  "Assignments":
    "Atribuições",
  "Bulk Operations":
    "Operações em massa",
  "Board Health":
    "Integridade do quadro",
  "Server Info":
    "Informações do servidor",
  "Workspaces":
    "Espaços de trabalho",
  "Boards":
    "Quadros",
  "Columns":
    "Colunas",
  "Cards":
    "Cartões",
  "Card Dependencies":
    "Dependências de cartões",
  "Notes":
    "Notas",
  "Definitions":
    "Definições",
  "Resources":
    "Recursos",
  "Activity":
    "Atividade",
  "Teams":
    "Equipes",
  "Channels":
    "Canais",
  "Git Repos":
    "Repositórios Git",
  "Webhooks":
    "Webhooks",
  "Agents & Executions":
    "Agentes e execuções",
  "Approvals":
    "Aprovações",
  "Merge Queue":
    "Fila de merge",
  "Workspace Config":
    "Configuração do espaço de trabalho",
  "Prompt Configs":
    "Configurações de prompts",
  "Loop Templates":
    "Templates de loop",
  "Skills":
    "Skills",
  "Deprecated aliases":
    "Aliases obsoletos",
  "These names still answer for one more minor version, but they are no longer part of the documented surface and no toolset lists them. Move to the replacement before the release that removes them.":
    "Estes nomes ainda respondem por mais uma versão menor, mas já não fazem parte da superfície documentada e nenhum toolset os lista. Migre para o substituto antes da versão que os remove.",
  "Alias":
    "Alias",
  "Replacement":
    "Substituto",
  "Removed in":
    "Removido em",
  // Replacement keys mirror `deprecated_for` in mcp-server/src/valaris_mcp/catalog.py TOOL_META verbatim.
  "next_assignment (runners) or move_card + add_card_participant (interactive)":
    "next_assignment (runners) ou move_card + add_card_participant (interativo)",
  "update_note(mode='append')":
    "update_note(mode='append')",
  "remove_card_participant(pipeline_role=...)":
    "remove_card_participant(pipeline_role=...)",
  "update_note(mode='section')":
    "update_note(mode='section')",
  "update_agent(hard_delete=True)":
    "update_agent(hard_delete=True)",
  "update_webhook(delete=True)":
    "update_webhook(delete=True)",
  "get_workspace_metrics(view='velocity')":
    "get_workspace_metrics(view='velocity')",
  "get_workspace_metrics(view='cost')":
    "get_workspace_metrics(view='cost')",
  "get_loop_template(view='profile')":
    "get_loop_template(view='profile')",
  "get_loop_template(view='preview')":
    "get_loop_template(view='preview')",
  "get_loop_template(view='fit', board_id=...)":
    "get_loop_template(view='fit', board_id=...)",
  "get_loop_template(view='lint')":
    "get_loop_template(view='lint')",
  "get_board_loop_binding_raw":
    "get_board_loop_binding_raw",
  "list_skill_bindings_raw":
    "list_skill_bindings_raw",
  "Examples":
    "Exemplos",
  " loads every tool. This is what runner launches pin.":
    " carrega todas as ferramentas. É o que os lançamentos de runners fixam.",
  " loads the interactive hand, the same as leaving the variable unset.":
    " carrega a mão interativa, o mesmo que deixar a variável sem definir.",
  " loads the interactive hand plus one whole opt-in group.":
    " carrega a mão interativa mais um grupo opcional inteiro.",
  " loads just those two categories, for a session that only edits cards and notes.":
    " carrega apenas essas duas categorias, para uma sessão que só edita cartões e notas.",
  "Composition with the allowlist":
    "Composição com a allowlist",
  " and":
    " e",
  " are independent gates, and the served hand is their intersection: a tool must be in a loaded toolset and, when an allowlist is set, on that allowlist to be listed or called. Neither variable can widen what the other narrowed.":
    " são controles independentes, e a mão servida é a interseção deles: uma ferramenta precisa estar em um toolset carregado e, quando há allowlist, também nessa allowlist para ser listada ou chamada. Nenhuma das variáveis pode ampliar o que a outra restringiu.",
  "Runners pin ":
    "Os runners fixam ",
  ". The stage allowlist a runner receives from the backend is meant to be the only narrowing, so the runner's generated MCP config always sets ":
    ". A allowlist de etapa que um runner recebe do backend deve ser a única restrição, então a configuração MCP gerada pelo runner sempre define ",
  " to":
    " como",
  "; a default-hand template would clip a stage grant twice.":
    "; um template com a mão padrão cortaria duas vezes a concessão da etapa.",
  "Discovery from inside a session":
    "Descoberta de dentro de uma sessão",
  " reports which toolsets are loaded, how many tools resolved, what the default hand is, every id that exists, and a hint on how to widen the hand. A denied call to a tool outside the loaded toolsets names the loaded ids in its error, so the model can ask for a wider hand instead of guessing.":
    " informa quais toolsets estão carregados, quantas ferramentas foram resolvidas, qual é a mão padrão, todos os ids que existem e uma dica sobre como ampliar a mão. Uma chamada negada a uma ferramenta fora dos toolsets carregados nomeia os ids carregados no erro, para que o modelo possa pedir uma mão mais ampla em vez de adivinhar.",
  " picks the initial hand;": " escolhe a mão inicial;",
  " widens a running session by adding toolsets, and the server then sends":
    " amplia uma sessão em execução adicionando toolsets, e o servidor então envia",
  " to request a client refresh; delivery does not prove the agent received new tools. Widening is one-way and not persisted. If tools remain absent, use the returned restart_env in the MCP server startup configuration, restart the server/connection and start a new agent session. For remote HTTP, the server operator must update that environment. Keep the runner allowlist unchanged.":
    " para solicitar uma atualização do cliente; o envio não comprova que o agente recebeu novas ferramentas. A ampliação só cresce e não é persistida. Se faltarem ferramentas, use o restart_env retornado na configuração de inicialização do servidor MCP, reinicie o servidor/conexão e inicie uma nova sessão do agente. Com HTTP remoto, o operador do servidor deve atualizar esse ambiente. Preserve a allowlist do runner.",
} as const;

export const PT_BR_REFERENCE = {
  "mcp-tool-catalog": {
    "Searchable, filterable, copy-ready. ":
      "Pesquisável, filtrável e pronto para copiar. ",
    "Every tool id follows the ": "Todo id de ferramenta segue a convenção ",
    "convention your MCP host uses to invoke it.":
      " usada pelo seu host MCP para invocá-la.",
    ...PT_BR_MCP_TOOL_CATALOG,
  },
  "mcp-toolsets": PT_BR_MCP_TOOLSETS,
  "mcp-prompt-catalog": {
    "Prompts are server-authored multi-phase workflow templates. An MCP host (Claude Code, Claude Desktop, a runner) expands a prompt by name and gets back a long instruction block that the LLM then executes as a sequenced plan. The templates do not share one universal phase cadence or confirmation rule: ":
      "Prompts são modelos de fluxo de trabalho multifásico criados pelo servidor. Um host MCP (Claude Code, Claude Desktop ou um runner) expande um prompt pelo nome e recebe um bloco extenso de instruções, que o LLM executa como um plano sequenciado. Os modelos não compartilham uma cadência universal nem uma única regra de confirmação: ",
    " explicitly waits for confirmation before applying fixes, while":
      " espera confirmação explícita antes de aplicar correções, enquanto",
    " asks before deleting a parent card. Other prompts can present a plan and then proceed without a second confirmation gate.":
      " pergunta antes de excluir um cartão pai. Outros prompts podem apresentar um plano e depois prosseguir sem uma segunda confirmação.",
    " prompts total, organized by agent role. ":
      " prompts no total, organizados por função de agente. ",
    "Prompts are organized by agent role. ":
      "Os prompts são organizados por função de agente. ",
    "Parameters are interpolated into the prompt body at expansion time. The LLM sees the rendered string; parameter names are not visible to it. Invoking a prompt is not a transaction boundary: the host sends rendered prose to the model, and any resulting tool calls still run through normal authentication, authorization, and MCP allowlist checks.":
      "Os parâmetros são interpolados no corpo do prompt durante a expansão. O LLM vê a string renderizada, não os nomes dos parâmetros. Invocar um prompt não cria um limite transacional: o host envia texto ao modelo e todas as chamadas de ferramentas resultantes continuam sujeitas à autenticação, à autorização e à allowlist do MCP.",
    "The prompts": "Os prompts",
    Prompt: "Prompt",
    Role: "Função",
    Parameters: "Parâmetros",
    Purpose: "Finalidade",
    Initializer: "Inicializador",
    "Bootstrap a complete project from a raw brief: board, columns, definition, channels, seed cards, a pinned decision-log note, and git repo. Team members named in the brief are added as workspace members — that grants them workspace access. Use once when starting a new project in a workspace.":
      "Inicialize um projeto completo a partir de um briefing bruto: quadro, colunas, definição, canais, cartões iniciais, uma nota fixada de registro de decisões e repositório git. Os integrantes citados no briefing são adicionados como membros do espaço de trabalho, o que lhes concede acesso a esse espaço. Use uma vez ao iniciar um novo projeto em um espaço de trabalho.",
    Secretary: "Secretário",
    "Generate a daily standup for one board — progress, stale and overdue cards, bottlenecks — saved as a board note. Run each morning or before a team sync.":
      "Gere um standup diário de um quadro — progresso, cartões parados e atrasados, gargalos — salvo como nota do quadro. Execute todas as manhãs ou antes de uma sincronização da equipe.",
    "Audit board hygiene — missing priorities, empty descriptions, overdue or stale cards — into a health score with proposed fixes. Fixes run only after you confirm.":
      "Audite a organização do quadro — prioridades ausentes, descrições vazias, cartões atrasados ou parados — e gere uma pontuação de integridade com correções propostas. As correções só são executadas depois da sua confirmação.",
    "Summarize every board in a workspace: completion, urgent and overdue counts, stalled boards, plus the top 3 recommended actions. Use for a weekly or executive overview.":
      "Resuma todos os quadros de um espaço de trabalho: conclusão, quantidades de itens urgentes e atrasados, quadros paralisados e as 3 principais ações recomendadas. Use para uma visão semanal ou executiva.",
    Architect: "Arquiteto",
    "Decompose a high-level objective into sequenced backlog cards (1-3 days each) gated by an ACCEPT- acceptance card. Use when planning a new feature or chunk of work.":
      "Decomponha um objetivo de alto nível em cartões sequenciados no backlog (1 a 3 dias cada), condicionados a um cartão de aceite ACCEPT-. Use ao planejar uma nova funcionalidade ou um bloco de trabalho.",
    "Split one oversized card into smaller, independently deliverable child cards that inherit its labels and priority. Use when a card is too big for 1-3 days of work.":
      "Divida um cartão grande demais em cartões filhos menores e entregáveis de forma independente, que herdam seus rótulos e sua prioridade. Use quando um cartão exceder 1 a 3 dias de trabalho.",
    "Plan a sprint: measure velocity, select backlog cards within capacity, stage them in the sprint column with due dates and owners, and pin a sprint-plan note.":
      "Planeje uma sprint: meça a velocidade, selecione cartões do backlog dentro da capacidade, posicione-os na coluna da sprint com prazos e responsáveis e fixe uma nota com o plano da sprint.",
    Coder: "Desenvolvedor",
    "Claim a card interactively: pick from the backlog-typed column, move it into the active-typed column, and output an implementation brief. Runners use next_assignment.":
      "Assuma um cartão de forma interativa: escolha-o na coluna do tipo backlog, mova-o para a coluna do tipo active e produza um briefing de implementação. Runners usam next_assignment.",
    "Run the full delivery loop for one card: claim it, plan against the codebase, implement with strict TDD, verify, then move it to review with an implementation record.":
      "Execute o ciclo completo de entrega de um cartão: assuma-o, planeje com base no código, implemente com TDD rigoroso, verifique e depois mova-o para review com um registro da implementação.",
    "Close out a reviewed card: move it to Done, mark it completed, write a completion note, report newly unblocked cards, and suggest the next card to pick up.":
      "Conclua um cartão revisado: mova-o para Done, marque-o como concluído, escreva uma nota de conclusão, informe os cartões recém-desbloqueados e sugira o próximo cartão a assumir.",
    "How a host invokes them": "Como um host os invoca",
    "In Claude Code and Claude Desktop, prompts appear in the slash- command palette. The host fetches the prompt template, interpolates any parameters the user typed, and sends the resulting prose to the model as a user turn. The model then executes it as a plan — no different from the user typing a long, careful instruction by hand.":
      "No Claude Code e no Claude Desktop, os prompts aparecem na paleta de comandos com barra. O host busca o modelo do prompt, interpola os parâmetros digitados pelo usuário e envia o texto resultante ao modelo como uma interação do usuário. O modelo então o executa como um plano, do mesmo modo que faria se o usuário digitasse manualmente uma instrução longa e cuidadosa.",
    "The Go runner does not expand this MCP prompt catalog during stage assembly. It fetches workspace prompt configurations and pipeline assignments through REST, then gives the spawned coding-agent session its allowed MCP tools. MCP prompts are host-facing templates, separate from the platform's pipeline prompt configurations.":
      "O Runner Go não expande este catálogo de prompts MCP durante a montagem de uma etapa. Ele obtém as configurações de prompts do espaço de trabalho e as atribuições do pipeline por REST e então fornece à sessão do agente de código as ferramentas MCP permitidas. Os prompts MCP são modelos voltados aos hosts, separados das configurações de prompts do pipeline da plataforma.",
    "The slash-command name and the MCP handle disagree":
      "O nome do comando com barra e o identificador MCP são diferentes",
    "The MCP install guide's workflow overview shows prompts with dashed names —":
      "A visão geral do fluxo no guia de instalação MCP mostra prompts com nomes separados por hífen —",
    ". The MCP server registers them with underscores — ":
      ". O servidor MCP os registra com sublinhados — ",
    ". A user typing the dashed form into a host that strictly matches registered MCP names will come up empty. Use the underscore handles shown in this catalog; dashed aliases are not registered by the server.":
      ". Um usuário que digitar a forma com hífen em um host que exija correspondência exata com os nomes MCP registrados não encontrará resultados. Use os identificadores com sublinhado exibidos neste catálogo; o servidor não registra aliases com hífen.",
  },
  "event-taxonomy": {
    "Every relevant mutation publishes through the event-bus interface selected by ":
      "Toda mutação relevante é publicada pela interface do barramento de eventos selecionada por ",
    " delivers only to subscribers in the same process; ":
      " entrega apenas aos assinantes do mesmo processo; ",
    " preserves that local fan-out and adds cross-instance delivery through Postgres LISTEN/NOTIFY. Both feed WebSocket connections and the origin instance's external-webhook subscriber. Events carry a":
      " preserva essa distribuição local e adiciona entrega entre instâncias por Postgres LISTEN/NOTIFY. Ambos alimentam as conexões WebSocket e o assinante de webhooks externos da instância de origem. Os eventos carregam um",
    " and a ": " e um ",
    "; subscribers filter by ": "; os assinantes filtram pelo padrão ",
    " pattern (": " com o padrão (",
    "The authoritative surface is the ": "A superfície autoritativa é o namespace ",
    " namespace —": " —",
    " emits one of these for every entity mutation it records. The other namespaces carry events the activity fan-out doesn't cover: approvals, executions, runner lifecycle, config changes, cost alerts.":
      " emite um desses eventos para cada mutação de entidade registrada. Os demais namespaces transportam eventos que a distribuição de activity não cobre: aprovações, execuções, ciclo de vida do runner, alterações de configuração e alertas de custo.",
    "activity.* — primary fan-out": "activity.* — distribuição principal",
    "Emitted as ": "Emitido como ",
    ". The payload matches the activity-log row (entity_id, action, actor_id, optional board_id, summary, changes).":
      ". O payload corresponde à linha do log de atividade (entity_id, action, actor_id, board_id opcional, summary, changes).",
    Namespace: "Namespace",
    "Actions emitted": "Ações emitidas",
    " — lifecycle detail is carried in ":
      " — os detalhes do ciclo de vida ficam em ",
    "Service-owned event namespaces":
      "Namespaces de eventos gerenciados por serviços",
    "Events published directly by their owning services — not activity rows. These carry service-specific payload shapes.":
      "Eventos publicados diretamente pelos serviços responsáveis, e não por linhas de activity. Eles têm formatos de payload específicos de cada serviço.",
    Event: "Evento",
    Publisher: "Publicador",
    "Key payload fields": "Campos principais do payload",
    " (terminal status)": " (status terminal)",
    "; an in-flight warning, not completion":
      "; um aviso durante a execução, não uma conclusão",
    " on activate / deactivate / re- activate":
      " ao ativar / desativar / reativar",
    " (WS-gated; 503 without an active connection)":
      " (condicionado ao WS; 503 sem uma conexão ativa)",
    " for restart; ": " para restart; ",
    "for deletion": "para a exclusão",
    " after a loop-state change": " após uma alteração do estado do loop",
    " on the key's first-ever use": " no primeiro uso da chave",
    "; WebSocket delivery is restricted to that user":
      "; a entrega WebSocket é restrita a esse usuário",
    "In-app notification channel, after the outer transaction commits":
      "Canal de notificações in-app, após o commit da transação externa",
    "; WebSocket delivery is restricted to the recipient":
      "; a entrega WebSocket é restrita ao destinatário",
    " through": " até",
    ", plus outcome fields": ", além dos campos do resultado",
    " on the first stale detection":
      " na primeira detecção de que a entrada está obsoleta",
    "Queue identity plus ": "Identidade da fila mais ",
    "; latched to emit once per entry":
      "; com latch para emitir uma única vez por entrada",
    " on loop config save, enable / disable, and loop-template bind / re-render / detach":
      " ao salvar a configuração do loop, ao ativar ou desativar e ao vincular, renderizar novamente ou desvincular um loop template",
    " — deliberately thin (the NOTIFY payload cap); clients refetch rather than read state off the event":
      " — deliberadamente enxuto (pelo limite do payload do NOTIFY); os clientes buscam os dados novamente em vez de ler o estado a partir do evento",
    "Agent / team / prompt_config / workspace_config / loop_template services":
      "Serviços de agent / team / prompt_config / workspace_config / loop_template",
    " — plus": " — além de",
    " when": " quando",
    ", whose actions extend beyond created/updated/deleted to":
      ", cujas ações vão além de created/updated/deleted e incluem",
    "Deprecated — bridge events (still firing)":
      "Obsoletos — eventos de compatibilidade (ainda emitidos)",
    "Before the ": "Antes da distribuição ",
    " fan-out existed, the platform emitted un-namespaced lifecycle events directly. A small number of these still publish in parallel with their ":
      ", a plataforma emitia diretamente eventos de ciclo de vida sem namespace. Alguns deles ainda são publicados em paralelo com seu equivalente ",
    "twin so pre-migration subscribers don't break. New code should not subscribe to these.":
      " para não interromper assinantes anteriores à migração. Código novo não deve assinar esses eventos.",
    Replacement: "Substituição",
    "Delivery boundaries": "Limites de entrega",
    "The live EventBus and WebSocket surface is broader than the public webhook selector. The ":
      "A superfície ativa do EventBus e do WebSocket é mais ampla que o seletor público de webhooks. O schema ",
    " schema currently exposes the bridge events, the listed ":
      " expõe atualmente os eventos de compatibilidade, os pares de ",
    " pairs through ": " listados até ",
    ", and the original approval, execution, agent-status, config, and cost events. It does not expose":
      ", além dos eventos originais de aprovação, execução, status de agentes, configuração e custos. Não expõe",
    " or the newer direct events such as":
      " nem os eventos diretos mais recentes, como",
    ", or": ", nem",
    ". Those names cannot be selected through the webhook create or update API today.":
      ". Atualmente esses nomes não podem ser selecionados pela API de criação ou atualização de webhooks.",
    "Two additional names, ": "Outros dois nomes, ",
    " and": " e",
    ", coordinate restart discovery between backend workers. The connection manager explicitly suppresses them from client WebSockets. ":
      ", coordenam a descoberta de reinício entre workers do backend. O gerenciador de conexões os remove explicitamente dos WebSockets de clientes. ",
    " are also filtered per user rather than broadcast to every workspace member.":
      " também são filtrados por usuário, em vez de transmitidos a todos os membros do espaço de trabalho.",
    "A live notification bus is not an audit log":
      "Um barramento de notificações ao vivo não é um log de auditoria",
    "Both backends provide at-most-once delivery with no replay. The memory backend also stops at the process boundary; Postgres LISTEN/NOTIFY closes that visibility gap but is still not a durable queue. Use the persisted activity, execution, approval, notification, and merge-queue rows as the source of truth, and treat events as prompts to refetch.":
      "Ambos os backends oferecem entrega no máximo uma vez e sem replay. O backend memory também para no limite do processo; Postgres LISTEN/NOTIFY fecha essa lacuna de visibilidade, mas continua não sendo uma fila durável. Use as linhas persistidas de atividade, execução, aprovação, notificação e fila de merge como fonte de verdade e trate os eventos como sinais para buscar os dados novamente.",
  },
  "column-type-semantics": {
    "A column has two identities. Its ": "Uma coluna tem duas identidades. Seu ",
    name: "nome",
    " is what humans read on the board. Its ":
      " é o que as pessoas leem no quadro. Seu ",
    " is what pipelines and runners match against. Rename a column and nothing else changes. Retype a column and you've rewired part of the pipeline.":
      " é o que pipelines e runners usam para fazer correspondências. Renomear uma coluna não altera mais nada. Mudar seu tipo reconecta parte do pipeline.",
    "Five types exist today. The set is closed — operators can't declare new column types the way they can declare new roles. A column can also be untyped (":
      "Hoje existem cinco tipos. O conjunto é fechado: operadores não podem declarar novos tipos de coluna como podem declarar novas funções. Uma coluna também pode ficar sem tipo (",
    "), in which case pipeline stages with a ":
      "); nesse caso, as etapas do pipeline com uma estratégia de descoberta ",
    " discover strategy will simply not see it.": " simplesmente não a verão.",
    "The types": "Os tipos",
    column_type: "column_type",
    "Semantic meaning": "Significado semântico",
    "Typical pipeline stages that target it":
      "Etapas de pipeline que normalmente usam esse tipo",
    "Unstarted work. Usually unassigned, sometimes untriaged. The source of truth for \"what could be done next.\"":
      "Trabalho não iniciado. Normalmente sem responsável e, às vezes, sem triagem. É a fonte de verdade para “o que pode ser feito a seguir”.",
    "Architect stages (": "Etapas de arquitetura (",
    "), triage, decomposition.": "), triagem e decomposição.",
    "In-progress work. A runner has claimed a card here (or will). Also the destination of \"start work\" transitions.":
      "Trabalho em andamento. Um runner assumiu um cartão aqui (ou irá assumi-lo). Também é o destino das transições de “iniciar trabalho”.",
    "Implementer stages (": "Etapas de implementação (",
    "), pickup.": ") e atribuição.",
    "Work awaiting evaluation. A reviewer role looks here for cards to pull and verdict on.":
      "Trabalho aguardando avaliação. Uma função de revisão procura aqui os cartões que deve assumir e julgar.",
    "Reviewer stages, rework mediation, documentator walks.":
      "Etapas de revisão, mediação de retrabalho e passagens de documentação.",
    "Terminal success. Cards land here after a ship. Documentator stages often sweep this column for post-merge notes.":
      "Sucesso terminal. Os cartões chegam aqui após uma entrega. Etapas de documentação costumam percorrer esta coluna para criar notas pós-merge.",
    "Documentator, post-ship hooks.":
      "Documentação e hooks posteriores à entrega.",
    "Work that can't progress — missing dependency, external wait, failed sensor. Rarely a destination; usually where a stage moves a card when ":
      "Trabalho que não pode avançar: dependência ausente, espera externa ou sensor com falha. Raramente é um destino; normalmente é para onde uma etapa move um cartão quando ",
    " fires.": " é acionado.",
    "Failure paths, sensor rejections, manual operator moves.":
      "Fluxos de falha, rejeições de sensores e movimentações manuais do operador.",
    "The type is the contract, the name is cosmetic":
      "O tipo é o contrato; o nome é cosmético",
    "Pipeline ": "As estratégias ",
    " strategies and": " do pipeline e as ações",
    " actions reference": " fazem referência a",
    ", never ": ", nunca a ",
    ". A column named \"Peer Review\" with type ":
      ". Uma coluna chamada “Peer Review” com o tipo ",
    " and a column named \"Review\" with type ":
      " e uma coluna chamada “Review” com o tipo ",
    " are indistinguishable to a pipeline stage. Two columns sharing a type is supported — stages match all of them. A column with no type (":
      " são indistinguíveis para uma etapa do pipeline. É permitido que duas colunas compartilhem um tipo: as etapas correspondem a todas elas. Uma coluna sem tipo (",
    ") is invisible to type-matching stages.":
      ") fica invisível para etapas que fazem correspondência por tipo.",
    "Practical consequences": "Consequências práticas",
    "You can have multiple ": "Você pode ter várias colunas ",
    " columns (e.g., \"Ideas\" and \"Next Sprint\") and a single architect stage will treat them as one pool.":
      " (por exemplo, “Ideias” e “Próxima Sprint”), e uma única etapa de arquitetura tratará todas como um só conjunto.",
    "Renaming \"Done\" to \"Shipped\" changes what the board looks like, not what the documentator stage discovers.":
      "Renomear “Done” para “Shipped” muda a aparência do quadro, mas não o que a etapa de documentação descobre.",
    "Dropping a column's type to ": "Remover o tipo de uma coluna, deixando-o como ",
    " removes it from pipeline scope without deleting its cards — useful for staging a column out of rotation.":
      ", retira a coluna do escopo do pipeline sem excluir seus cartões, o que é útil para tirá-la temporariamente da rotação.",
    "Adding a new column-type value is a backend change (enum + migration), not a configuration change. The current five cover the kanban idioms we've needed.":
      "Adicionar um novo valor de tipo de coluna é uma alteração no backend (enum + migração), não uma mudança de configuração. Os cinco tipos atuais cobrem os padrões kanban de que precisamos até agora.",
  },
  "card-type-and-priority": {
    "Two enums on every card affect both visual styling on the board and the order in which discover strategies offer cards to runners. They are cosmetic in isolation and load-bearing in combination —":
      "Dois enums presentes em cada cartão afetam tanto o estilo visual no quadro quanto a ordem em que as estratégias de descoberta oferecem cartões aos runners. Isoladamente são cosméticos, mas em conjunto sustentam comportamento importante —",
    " in particular drives which card a polling runner sees first.":
      " em especial determina qual cartão um runner em polling vê primeiro.",
    "Card type": "Tipo de cartão",
    "Four values. Each maps to a Tailwind token in":
      "Quatro valores. Cada um corresponde a um token Tailwind em",
    " — no hex strings in the source. Type does not affect pipeline matching unless a stage filter explicitly references it; it's primarily a visual and human-filter concern.":
      " — não há strings hexadecimais no código-fonte. O tipo não afeta a correspondência do pipeline, a menos que um filtro de etapa faça referência explícita a ele; sua finalidade principal é visual e de filtragem por pessoas.",
    card_type: "card_type",
    Visual: "Visual",
    "Intended use": "Uso previsto",
    "Neutral token — the default.": "Token neutro — o padrão.",
    "The generic unit of work. Anything not obviously a bug, a new feature, or an open issue.":
      "A unidade genérica de trabalho. Tudo o que não for claramente um bug, uma nova funcionalidade ou uma questão em aberto.",
    "Rose / red-accented token.": "Token rose / com destaque vermelho.",
    "Regression, defect, broken behavior. Pipelines that run a reproduction-first TDD flow typically filter to this type.":
      "Regressão, defeito ou comportamento quebrado. Pipelines que executam um fluxo TDD começando pela reprodução normalmente filtram por esse tipo.",
    "Emerald / green-accented token.":
      "Token emerald / com destaque verde.",
    "New capability. Usually decomposed by an architect stage before an implementer claims it.":
      "Nova capacidade. Normalmente é decomposta por uma etapa de arquitetura antes de uma etapa de implementação assumi-la.",
    "Amber-accented token.": "Token com destaque amber.",
    "Open question, investigation, ambiguous report. Promoted to":
      "Questão em aberto, investigação ou relato ambíguo. É promovido a",
    " or ": " ou ",
    " once triaged.": " após a triagem.",
    Priority: "Prioridade",
    "Five values, ordered. The ordering matters: discover strategies that return \"highest priority first\" use this enum as their sort key. Ties break on fractional position within the column, so priority acts as the primary key and position acts as the secondary.":
      "Cinco valores ordenados. A ordem importa: estratégias de descoberta que retornam “maior prioridade primeiro” usam esse enum como chave de ordenação. Empates são resolvidos pela posição fracionária dentro da coluna; portanto, a prioridade é a chave primária e a posição, a secundária.",
    "The API schema and the ": "O schema da API e a ferramenta ",
    " MCP tool default to": " do MCP usam por padrão",
    ". The create-card dialog defaults to medium and does not currently offer none in its selector, although existing":
      ". O diálogo de criação usa medium por padrão e atualmente não oferece none no seletor, embora os cartões existentes com",
    " cards render correctly elsewhere in the UI. Callers that need an explicit unset priority should use the API or MCP surface.":
      " sejam exibidos corretamente no restante da interface. Para deixar a prioridade explicitamente indefinida, use a API ou o MCP.",
    priority: "priority",
    Rank: "Classificação",
    "Discover implication": "Efeito na descoberta",
    Highest: "Mais alta",
    "Pulled first by priority-ordered discover. Runners will claim an ":
      "Selecionada primeiro por uma descoberta ordenada por prioridade. Runners assumirão primeiro um cartão ",
    " card in": " em",
    " before touching a": " antes de considerar um cartão ",
    " card in the same column.": " na mesma coluna.",
    High: "Alta",
    "Second wave. The default for non-trivial work an architect stage creates via ":
      "Segunda leva. É o padrão para trabalho não trivial criado por uma etapa de arquitetura por meio de ",
    "Medium (create-dialog default)": "Média (padrão no diálogo de criação)",
    "The browser's create-card dialog preselects this value. API and MCP callers that omit priority create a":
      "O diálogo de criação no navegador pré-seleciona este valor. Clientes da API e do MCP que omitem priority criam um cartão",
    " card instead.": " em seu lugar.",
    Low: "Baixa",
    "Pulled after medium but before unprioritized ":
      "Selecionada depois de medium, mas antes dos cartões ",
    ". Useful for nice-to-haves when the runner has spare capacity.":
      ". Útil para melhorias desejáveis quando o Runner tiver capacidade disponível.",
    "Unprioritized (API and MCP default)":
      "Sem prioridade (padrão na API e no MCP)",
    "Sorted after ": "Ordenada depois de ",
    ". Use this value when priority has not been triaged yet; it is not selectable in the current create-card dialog.":
      ". Use este valor quando a prioridade ainda não tiver sido definida; ele não pode ser selecionado no diálogo de criação atual.",
    "Combined effect": "Efeito combinado",
    "A ": "Uma estratégia de descoberta ",
    " discover strategy sorts": " ordena por",
    ", then by fractional position within each bucket. A human dragging a card to the top of a column is effectively saying \"same priority, try me first\"; an operator bumping priority is saying \"jump the line across buckets.\" Both paths reach the same runner; the runner doesn't know or care which one put the card on top.":
      ", depois pela posição fracionária dentro de cada grupo. Uma pessoa que arrasta um cartão para o topo da coluna está, na prática, dizendo “mesma prioridade, tente este primeiro”; um operador que aumenta a prioridade está dizendo “passe à frente entre grupos”. Ambos os caminhos chegam ao mesmo runner; ele não sabe nem precisa saber qual deles colocou o cartão no topo.",
  },
  "api-authentication-modes": {
    "The backend accepts several auth modes, evaluated in a fixed order: API key, then the signed session cookie (in production), then dev mode (in development), then IAP, then trusted proxy. Whichever signal arrives first wins. This lets a single codebase serve dev laptops, self-hosted boxes with the built-in password login, OIDC or IAP-gated production, and API-key-bearing runners without branching logic at every router.":
      "O backend aceita vários modos de autenticação, avaliados em uma ordem fixa: API key, depois o cookie de sessão assinado (em produção), dev mode (em desenvolvimento), IAP e, por fim, trusted proxy. O primeiro sinal encontrado prevalece. Assim, uma única base de código atende notebooks de desenvolvimento, instalações self-hosted com login por senha integrado, produção protegida por OIDC ou IAP e runners com API key, sem ramificações em cada router.",
    "On the proxy-verified tiers (IAP, trusted proxy) users are auto-provisioned on first authenticated request (unless":
      "Nos níveis verificados por proxy (IAP e trusted proxy), os usuários são provisionados automaticamente na primeira solicitação autenticada, a menos que",
    "). OIDC applies the same provisioning policy during its callback. With local password login, accounts come from the first-run setup screen or from a workspace admin — there is no self-registration.":
      ". O OIDC aplica a mesma política durante seu callback. No login por senha local, as contas são criadas na tela de configuração inicial ou por um administrador do espaço de trabalho; não há cadastro autônomo.",
    "The modes": "Os modos",
    Mode: "Modo",
    "When used": "Quando é usado",
    "Header(s) expected": "Header(s) esperado(s)",
    Notes: "Observações",
    "API key": "API key",
    "Runners, MCP callers, server-to-server integrations. Preferred for any automated caller.":
      "Runners, clientes MCP e integrações server-to-server. É o modo preferencial para qualquer cliente automatizado.",
    "Backend matches the key by prefix + hash. The prefix column is stored; the full key is hashed at rest and shown to the user exactly once at creation time.":
      "O backend encontra a chave por prefixo + hash. A coluna de prefixo é armazenada; a chave completa fica protegida por hash em repouso e é exibida ao usuário uma única vez, no momento da criação.",
    "Dev mode": "Dev mode",
    "Local development only. Active when ":
      "Somente para desenvolvimento local. Fica ativo quando ",
    "and no bearer token is present.":
      "e não há bearer token.",
    "Falls back to ": "Recorre a ",
    " if the header is absent. This fallback is disabled outside development.":
      " se o header estiver ausente. Esse fallback fica desativado fora de desenvolvimento.",
    "Local password": "Senha local",
    "Browser traffic on self-hosted instances with no identity provider. On by default (":
      "Tráfego de navegador em instâncias self-hosted sem provedor de identidade. Ativo por padrão (",
    "); needs ": "); exige ",
    " to mint sessions.": " para emitir sessões.",
    " verifies an argon2id-hashed password and mints the same signed session cookie as OIDC — the cookie tier does not care how identity was proven. Every failed login is one uniform 401; attempts are throttled per IP and 5 straight failures lock the account for 15 minutes. See":
      " verifica uma senha protegida por hash argon2id e emite o mesmo cookie de sessão assinado do OIDC; a camada do cookie não depende de como a identidade foi comprovada. Toda falha de login retorna o mesmo 401; as tentativas são limitadas por IP e 5 falhas consecutivas bloqueiam a conta por 15 minutos. Consulte",
    "local password login": "login por senha local",
    " below.": " abaixo.",
    "OIDC session": "Sessão OIDC",
    "Browser traffic when you point Backplane at your own identity provider. The login affordance is active only when":
      "Tráfego de navegador quando o Backplane usa seu próprio provedor de identidade. A opção de login só fica ativa quando",
    ", and": ", e",
    " are all set.": " estão definidos.",
    "Minted by ": "Emitida por ",
    " after an authorization-code + PKCE login. Signed with":
      " após um login com authorization code + PKCE. É assinada com",
    ", httponly, and valid for": ", httponly e válida por",
    ". Outranks IAP and trusted proxy; an invalid cookie is a rejection, never a fallback to a weaker tier.":
      ". Tem precedência sobre IAP e trusted proxy; um cookie inválido é rejeitado e nunca provoca fallback para um nível mais fraco.",
    "IAP (JWT)": "IAP (JWT)",
    "Production browser traffic behind Google IAP. Active when":
      "Tráfego de navegador em produção atrás do Google IAP. Fica ativo quando",
    " is set.": " está definido.",
    "Backend verifies the JWT against Google's public keys with":
      "O backend verifica o JWT com as chaves públicas do Google usando",
    " and extracts the email claim. A missing or invalid JWT is a 403, not a fallback.":
      " e extrai o claim de email. Um JWT ausente ou inválido retorna 403, sem fallback.",
    "Trusted proxy (header)": "Trusted proxy (header)",
    "Production behind an authenticating proxy (IAP, oauth2-proxy, Authelia). Opt-in: set ":
      "Produção atrás de um proxy de autenticação (IAP, oauth2-proxy ou Authelia). Exige ativação explícita: defina ",
    ". Never automatic.": ". Nunca é automático.",
    "No signature to verify, so the header is trusted only because the proxy is the only thing that can set it. Safe only when the backend is unreachable except through that proxy and the proxy strips client-supplied copies. Optionally set":
      "Não há assinatura a verificar; portanto, o header só é confiável porque o proxy é o único componente capaz de defini-lo. Isso só é seguro quando o backend não pode ser acessado fora do proxy e o proxy remove cópias enviadas pelo cliente. Como opção, defina",
    " and have the proxy inject": " e faça o proxy injetar",
    " — requests without the matching value are rejected even if they carry the identity header. With neither this nor ":
      " — solicitações sem o valor correspondente serão rejeitadas mesmo que tragam o header de identidade. Sem isso e sem ",
    ", production refuses to start.": ", a produção se recusa a iniciar.",
    "Two provisioning knobs apply to verified browser identities (IAP, trusted proxy, and OIDC), not to API keys or dev mode:":
      "Duas configurações de provisionamento se aplicam às identidades verificadas de navegador (IAP, trusted proxy e OIDC), mas não às API keys nem ao dev mode:",
    " restricts sign-in to a comma-separated list of email domains, and":
      " restringe o login a uma lista de domínios de email separados por vírgulas, e",
    " switches to invite-only. IAP and trusted-proxy requests receive HTTP 403 when the verified email has no existing account. The OIDC callback redirects with HTTP 302 to":
      " ativa o modo somente por convite. Solicitações IAP e trusted proxy recebem HTTP 403 quando o email verificado não tem uma conta. O callback do OIDC redireciona com HTTP 302 para",
    " instead; it does not return a 403 page from the callback. Neither path creates a fresh user row. The domain allowlist also gates the local-auth paths that mint a login-capable account: first-run setup and an admin invite that grants an initial password (a plain, passwordless membership invite is a deliberate act and is not domain-checked). Rejections are logged with reason codes such as ":
      " em vez disso; o callback não retorna uma página 403. Nenhum dos caminhos cria uma nova linha de usuário. A allowlist de domínios também controla os fluxos de autenticação local que criam uma conta com login: a configuração inicial e um convite de administrador que concede uma senha inicial (um convite de membro sem senha é um ato deliberado e não passa pela verificação de domínio). As rejeições são registradas com códigos de motivo como ",
    " so an auth outage is diagnosable from logs alone.":
      " para que uma indisponibilidade de autenticação possa ser diagnosticada apenas pelos logs.",
    "Headers, by example": "Exemplos de headers",
    "API key — runners and MCP callers": "API key — runners e clientes MCP",
    "Dev mode — local laptop only": "Dev mode — somente notebook local",
    "IAP JWT — production browser traffic":
      "IAP JWT — tráfego de navegador em produção",
    "Local password login": "Login por senha local",
    "A fresh instance with an empty ": "Uma instância nova com a tabela ",
    " table serves a first-run setup screen: the first account created there becomes the instance's first user, and the setup route self-closes the moment any user exists (it reopens only if the table is ever empty again — an empty table means nobody can log in anyway). Passwords are stored as argon2id hashes with a 12-character minimum and no composition rules.":
      " vazia exibe uma tela de configuração inicial: a primeira conta criada ali se torna o primeiro usuário da instância, e a rota de configuração se fecha assim que qualquer usuário passa a existir (ela só reabre se a tabela voltar a ficar vazia — e uma tabela vazia significa que ninguém consegue entrar). As senhas são armazenadas como hashes argon2id, com no mínimo 12 caracteres e sem regras de composição.",
    "Brute-force defence is two independent layers: a 10-requests-per-minute per-IP throttle on ":
      "A proteção contra força bruta tem duas camadas independentes: um limite de 10 solicitações por minuto por IP em ",
    ", and a DB-backed account lockout — 5 consecutive failures lock the account for 15 minutes. The lockout lives on the ":
      " e um bloqueio de conta persistido no DB — 5 falhas consecutivas bloqueiam a conta por 15 minutos. O bloqueio fica na linha ",
    " row, so it holds across replicas and restarts, and it expires on its own. On the wire a locked account, a wrong password, and a nonexistent email are all the same 401; operators can tell them apart from log reason codes.":
      ", portanto persiste entre réplicas e reinicializações e expira sozinho. Na resposta HTTP, uma conta bloqueada, uma senha errada e um email inexistente retornam o mesmo 401; operadores podem distingui-los pelos códigos de motivo nos logs.",
    "Account management runs through workspace membership: a workspace":
      "O gerenciamento de contas ocorre por meio da associação ao espaço de trabalho: um ",
    "owner or admin": "owner ou admin",
    " can add a member by email with an optional initial password (applied only if the account has no password yet), and can generate a temporary password for any member of that workspace — shown exactly once, and it clears an active lockout. That temporary password is the recovery path: there is no SMTP dependency and no email-based reset. Everyone can change their own password from the sidebar, which requires the current password.":
      " do espaço de trabalho pode adicionar um membro por email com uma senha inicial opcional (aplicada somente se a conta ainda não tiver senha) e gerar uma senha temporária para qualquer membro desse espaço. Ela é exibida uma única vez e remove um bloqueio ativo. Essa senha temporária é o caminho de recuperação: não há dependência de SMTP nem redefinição por email. Qualquer pessoa pode alterar a própria senha pela barra lateral, informando a senha atual.",
    "Anyone who manages a workspace can create accounts":
      "Qualquer pessoa que gerencie um espaço de trabalho pode criar contas",
    "Instance-level authority is deliberately derived from workspace roles — there is no separate admin flag. The corollary: on an instance with several workspaces owned by different people, each of those owners (and their admins) can create instance-wide accounts and set temporary passwords for their own members. If that is too broad for your deployment, keep workspace ownership narrow. Two more honest notes: changing a password does not invalidate sessions minted earlier (the cookie is stateless), and admin-set passwords are not flagged temporary — nothing forces a rotation on first login.":
      "A autoridade no nível da instância é derivada deliberadamente das funções do espaço de trabalho; não existe um indicador de administrador separado. Como consequência, em uma instância com vários espaços de trabalho pertencentes a pessoas diferentes, cada owner e seus admins podem criar contas válidas para toda a instância e definir senhas temporárias para os próprios membros. Se isso for amplo demais para sua implantação, restrinja a propriedade dos espaços de trabalho. Mais duas observações importantes: alterar uma senha não invalida sessões emitidas anteriormente (o cookie não mantém estado), e senhas definidas por administradores não são marcadas como temporárias; nada obriga sua troca no primeiro login.",
    "Signing in with your own identity provider":
      "Login com seu próprio provedor de identidade",
    "Set ": "Defina ",
    " and Backplane runs a backend-driven authorization-code flow with PKCE against any OpenID Connect provider (Keycloak, Authentik, Google, Entra, Okta). Everything else — authorization endpoint, token endpoint, JWKS, logout — is read from the issuer's discovery document, so there are no per-endpoint settings to drift out of sync. Tokens never reach the browser: the callback verifies the ID token server-side and mints a signed session cookie.":
      " e o Backplane executará, no backend, um fluxo de authorization code com PKCE diante de qualquer provedor OpenID Connect (Keycloak, Authentik, Google, Entra ou Okta). Todo o restante — endpoint de autorização, endpoint de token, JWKS e logout — é lido do documento de descoberta do emissor, evitando configurações por endpoint que possam divergir. Os tokens nunca chegam ao navegador: o callback verifica o ID token no servidor e emite um cookie de sessão assinado.",
    "Register ": "Registre ",
    " as the redirect URI with your provider. ":
      " como redirect URI no seu provedor. ",
    " is required — without it no session can be signed, and the login button stays hidden.":
      " é obrigatório; sem ele, nenhuma sessão pode ser assinada e o botão de login permanece oculto.",
    "Keycloak — realm 'backplane'": "Keycloak — realm 'backplane'",
    "Google as the identity provider": "Google como provedor de identidade",
    "An identity provider proves identity, not membership":
      "Um provedor de identidade comprova identidade, não associação",
    "Every mainstream IdP will authenticate accounts far outside your organization — Google signs in any Gmail user, and a Keycloak realm with self-registration enabled signs in anyone who fills the form. Unless":
      "Todo IdP amplamente usado autentica contas muito além da sua organização: o Google aceita qualquer usuário do Gmail, e um realm do Keycloak com cadastro autônomo habilitado aceita qualquer pessoa que preencha o formulário. A menos que",
    " is set, any successful login auto-provisions a Backplane user. Set the domain allowlist, or run invite-only with ":
      " esteja definido, qualquer login bem-sucedido provisiona automaticamente um usuário do Backplane. Defina a allowlist de domínios ou opere somente por convite com ",
    "WebSocket auth": "Autenticação WebSocket",
    "The workspace WebSocket endpoint (":
      "O endpoint WebSocket do espaço de trabalho (",
    ") accepts the same API key via ": ") aceita a mesma API key por meio de ",
    " on the upgrade request. Browser clients are authenticated by whatever authenticates their HTTP traffic — the session cookie (browsers send cookies on the handshake) or the IAP/proxy headers — so there is no extra browser step. A legacy ":
      " na solicitação de upgrade. Clientes de navegador são autenticados pelo mesmo mecanismo que autentica seu tráfego HTTP — o cookie de sessão, enviado pelos navegadores no handshake, ou os headers de IAP/proxy — portanto não há etapa adicional no navegador. O fallback legado ",
    " fallback is still accepted for API keys, but the Authorization header is preferred because query strings can land in access logs.":
      " ainda é aceito para API keys, mas o header Authorization é preferível porque query strings podem aparecer nos logs de acesso.",
    "API key material is shown exactly once":
      "O conteúdo da API key é exibido uma única vez",
    "When an authenticated user creates an API key, the full":
      "Quando um usuário autenticado cria uma API key, a string completa",
    "string is displayed once in the \"API key created\" dialog and never again. The backend stores only the prefix and a hash. If a key is lost, there is no recovery path — revoke it and mint a new one. Don't share keys over chat, don't commit them to repos, and don't bake them into runner config files that will be checked in. Treat a leaked key as an incident: revoke first, investigate second.":
      " é exibida uma vez na caixa de diálogo “API key created” e nunca mais. O backend armazena apenas o prefixo e um hash. Se uma chave for perdida, não há recuperação: revogue-a e emita outra. Não compartilhe chaves por chat, não faça commit delas em repositórios e não as incorpore em arquivos de configuração do runner que serão versionados. Trate uma chave vazada como incidente: primeiro revogue, depois investigue.",
  },
  "environment-variables": {
    "Three processes read environment variables directly: the FastAPI backend, the MCP server, and the Go runner (":
      "Três processos leem variáveis de ambiente diretamente: o backend FastAPI, o servidor MCP e o runner Go (",
    "). None of them require a full environment to start in dev mode — the defaults described below get you a working localhost. These tables cover the supported deployment, authentication, integration, event, MCP, and runner controls in the current code; one-off test variables are not part of this operator contract.":
      "). Nenhum deles exige um ambiente completo para iniciar em dev mode: os padrões descritos abaixo produzem um localhost funcional. Estas tabelas cobrem os controles compatíveis de implantação, autenticação, integrações, eventos, MCP e runner do código atual; variáveis exclusivas de testes não fazem parte deste contrato operacional.",
    "Backend (FastAPI)": "Backend (FastAPI)",
    "Read from ": "Lidas de ",
    " via": " por meio de",
    ". Values come from": ". Os valores vêm de",
    " or the process environment; environment wins.":
      " ou do ambiente do processo; o ambiente tem precedência.",
    Variable: "Variável",
    Default: "Padrão",
    Purpose: "Finalidade",
    "Optional literal password override for DATABASE_URL. Encoding is automatic. Production Compose supplies it from POSTGRES_PASSWORD.": "Senha literal opcional que substitui a de DATABASE_URL. A codificação é automática. O Compose de produção a obtém de POSTGRES_PASSWORD.",
    "Async SQLAlchemy DSN. Deployed environments point it at their Postgres instance. Must use the asyncpg driver.":
      "DSN assíncrono do SQLAlchemy. Em ambientes implantados, deve apontar para a instância do Postgres e usar o driver asyncpg.",
    "Gates dev-mode behaviors (swagger exposure, dev-mode auth fallback). Set to ":
      "Controla comportamentos de dev mode (exposição do Swagger e fallback de autenticação de desenvolvimento). Defina como ",
    " in deployed environments.": " em ambientes implantados.",
    "Comma-separated allowlist. The frontend Cloud Run URL goes here in production.":
      "Allowlist separada por vírgulas. Em produção, inclua aqui a URL do frontend no Cloud Run.",
    "Activates IAP JWT verification. Takes precedence over":
      "Ativa a verificação de JWT do IAP. Tem precedência sobre",
    " when both are set. Prod value is the full backend-service resource path.":
      " quando ambos estão definidos. Em produção, o valor é o caminho completo do recurso do serviço de backend.",
    "Opt-in to trusting the identity header named by":
      "Ativa explicitamente a confiança no header de identidade indicado por",
    " (default": " (padrão",
    "; oauth2-proxy users set ": "; usuários de oauth2-proxy definem ",
    "). Only safe behind an authenticating proxy.":
      "). Só é seguro atrás de um proxy de autenticação.",
    "Optional handshake for trusted-proxy mode: when set, requests must also carry ":
      "Handshake opcional para trusted-proxy mode: quando definido, as solicitações também devem incluir ",
    " with this value. Configure the proxy to inject it.":
      " com esse valor. Configure o proxy para injetá-lo.",
    "Comma-separated domains for verified IAP, trusted-proxy, and OIDC identities. It also gates local setup and admin-invite paths that create a password-capable account. Empty allows any verified domain; API keys and dev mode are exempt.":
      "Domínios separados por vírgulas para identidades verificadas de IAP, trusted proxy e OIDC. Também restringe o setup local e os convites de admin que criam uma conta com senha. Vazio permite qualquer domínio verificado; API keys e dev mode não são afetados.",
    "Create user accounts on first verified sign-in. ":
      "Cria contas de usuário no primeiro login verificado. ",
    "makes the deployment invite-only: IAP and proxy requests for unknown users get 403, while the OIDC callback redirects with":
      "torna a implantação acessível somente por convite: solicitações de IAP e proxy para usuários desconhecidos recebem 403, enquanto o callback de OIDC redireciona com",
    ". Neither creates a user row.":
      ". Nenhum dos dois caminhos cria uma linha de usuário.",
    "Enables database-backed email and password login. A production instance using local login also needs":
      "Ativa o login com email e senha respaldado pelo banco de dados. Uma instância de produção com login local também precisa de",
    " to mint session cookies.": " para emitir cookies de sessão.",
    "OpenID Connect issuer URL. Empty disables OIDC; discovery supplies the authorization, token, JWKS, and logout endpoints.":
      "URL do issuer OpenID Connect. Vazia desativa o OIDC; o discovery fornece os endpoints de autorização, token, JWKS e logout.",
    "Client identifier registered at the OIDC provider. OIDC is exposed to the browser only when this, ":
      "Identificador de cliente registrado no provedor OIDC. O OIDC só é exposto ao navegador quando este valor, ",
    ", and ": ", e ",
    " are set.": " estão definidos.",
    "Confidential-client secret sent during the authorization-code exchange. Keep it out of committed files.":
      "Secret do cliente confidencial enviado durante a troca de authorization code. Não o inclua em arquivos versionados.",
    "Space-separated scopes requested from the identity provider. The verified ID token must supply an email claim.":
      "Scopes separados por espaços solicitados ao provedor de identidade. O ID token verificado deve fornecer um claim de email.",
    "Lifetime for signed browser sessions created by OIDC and local password login. Sessions are stateless and expire by age.":
      "Duração das sessões assinadas criadas pelo OIDC e pelo login local. As sessões não têm estado e expiram por idade.",
    "Signs login sessions plus OIDC and GitHub OAuth state. A production instance with local auth or OIDC enabled refuses to start when this is empty.":
      "Assina sessões de login e o state de OIDC e GitHub OAuth. Uma instância de produção com autenticação local ou OIDC se recusa a iniciar quando este valor está vazio.",
    "Public browser origin used by login and integration redirects; its scheme also decides whether session cookies are Secure.":
      "Origem pública do navegador usada nos redirecionamentos de login e integrações; seu esquema também decide se os cookies de sessão são Secure.",
    "Selects ": "Seleciona ",
    " for single-process delivery or": " para entrega em um único processo ou",
    " for cross-instance delivery over Postgres LISTEN/NOTIFY. ":
      " para entrega entre instâncias via Postgres LISTEN/NOTIFY. ",
    " is reserved but not implemented.": " está reservado, mas não implementado.",
    "Enables Tier-1 process caches. Safe on the memory bus only for a genuinely single-instance deployment; the Postgres bus distributes eviction events across instances.":
      "Ativa caches de processo Tier 1. No barramento memory, só é seguro em uma implantação realmente de instância única; o barramento Postgres distribui eventos de invalidação entre instâncias.",
    "Opt-in anonymous instance telemetry. It sends nothing unless enabled and an endpoint is configured.":
      "Telemetria anônima da instância com ativação explícita. Não envia nada sem estar habilitada e ter um endpoint configurado.",
    "Receiver for opt-in telemetry. Empty keeps telemetry a no-op even when the enable flag is true.":
      "Receptor da telemetria opcional. Vazio mantém a telemetria inativa mesmo quando o flag está habilitado.",
    "Operator-facing backend URL baked into exported runner bundles (runner YAML and MCP JSON). Set to the public URL in prod so exports are launch-ready.":
      "URL do backend voltada ao operador, incorporada aos bundles exportados do runner (YAML do runner e JSON do MCP). Defina a URL pública em produção para que as exportações fiquem prontas para iniciar.",
    "Uvicorn bind port. Cloud Run overrides to its injected":
      "Porta de bind do Uvicorn. O Cloud Run a substitui por sua variável injetada",
    "GCS bucket for resource uploads. Empty falls back to local filesystem at ":
      "Bucket GCS para upload de recursos. Vazio usa como fallback o sistema de arquivos local em ",
    "Service account email for signed-URL generation. Paired with":
      "Email da service account usada para gerar URLs assinadas. Usado junto com",
    "Local-disk path for resource uploads when GCS isn't configured. Persist this directory or volume in self-hosted deployments.":
      "Caminho em disco local para upload de recursos quando o GCS não está configurado. Preserve este diretório ou volume em implantações self-hosted.",
    "Last-resort provider tokens when a workspace has no matching stored git connection. Each credential is host-checked; there is no cross-provider fallback.":
      "Tokens de provedor de último recurso quando o espaço de trabalho não tem uma conexão git compatível armazenada. Cada credencial é validada contra o host; não há fallback entre provedores.",
    "GitHub REST base URL, including GitHub Enterprise deployments.":
      "URL base da API REST do GitHub, incluindo implantações do GitHub Enterprise.",
    "Allows Git Connections to fall back to the platform token after workspace credentials. Disable it for a strict multi-tenant posture.":
      "Permite que Git Connections recorra ao token da plataforma após as credenciais do espaço de trabalho. Desative para uma postura multi-tenant estrita.",
    "Commit identity used by the backend merge worker.":
      "Identidade de commit usada pelo worker de merge do backend.",
    "Age after which board health reports a non-terminal merge-queue entry as stale.":
      "Idade após a qual a integridade do quadro marca como obsoleta uma entrada não terminal da fila de merge.",
    "Base64-encoded 32-byte Fernet key for encrypting the tokens stored by Git Connections. Empty makes token encryption and decryption fail loudly instead of storing plaintext.":
      "Chave Fernet de 32 bytes codificada em Base64 para criptografar os tokens armazenados por Git Connections. Vazia faz a criptografia e a descriptografia falharem explicitamente em vez de armazenar texto simples.",
    "GitHub OAuth App credentials for workspace git integrations. Empty disables the OAuth start endpoint.":
      "Credenciais de GitHub OAuth App para integrações git do espaço de trabalho. Vazias desativam o endpoint de início OAuth.",
    "Seconds between server-sent WebSocket heartbeats. Tune only if you know why.":
      "Segundos entre heartbeats WebSocket enviados pelo servidor. Ajuste somente se souber por quê.",
    "Seconds to wait for a client pong before dropping the connection.":
      "Segundos de espera pelo pong do cliente antes de encerrar a conexão.",
    "MCP server": "Servidor MCP",
    ". Set these in the MCP server environment. Claude hosts use the":
      ". Defina estas variáveis no ambiente do servidor MCP. Hosts Claude usam o bloco",
    " block; exported runner configs and the runner's isolated Codex config pass the same names.":
      "; as configurações exportadas do Runner e a configuração isolada do Codex do Runner transmitem os mesmos nomes.",
    "Base URL of the Backplane backend. Production is the public backend Cloud Run URL.":
      "URL base do backend Backplane. Em produção, é a URL pública do backend no Cloud Run.",
    "Bearer API key (": "API key bearer (",
    "), either personal or linked to a registered agent. When set, all other auth paths are skipped and":
      "), pessoal ou vinculada a um agente registrado. Quando definida, todos os outros fluxos de autenticação são ignorados e",
    " is sent. The simplest production config.":
      " é enviado. É a configuração de produção mais simples.",
    "Identity sent in dev-mode auth headers. Ignored when an API key or IAP audience is configured.":
      "Identidade enviada nos headers de autenticação do dev mode. É ignorada quando há uma API key ou audience de IAP configurada.",
    "Target audience for Google ADC OIDC token minting. Set when the MCP server is talking to an IAP-gated backend without an API key.":
      "Audience de destino para emissão de token OIDC pelo Google ADC. Defina quando o servidor MCP se comunica com um backend protegido por IAP sem uma API key.",
    unset: "não definido",
    "Comma-separated tool ids enforced by the MCP server. The allowlist filters both what the model is shown (tools/list) and what it may call. Unset, empty, or ":
      "IDs de ferramentas separados por vírgulas aplicados pelo servidor MCP. A allowlist filtra tanto o que é mostrado ao modelo (tools/list) quanto o que ele pode chamar. Não definido, vazio ou ",
    " means unrestricted;": " significa sem restrições;",
    " denies every tool. Invalid names fail server startup rather than silently disabling the gate.":
      " bloqueia todas as ferramentas. Nomes inválidos impedem a inicialização do servidor em vez de desativar o controle silenciosamente.",
    "Comma-separated toolset ids (group or category ids from the tool catalog) the server lists and serves. Unset or empty means":
      "Ids de toolsets separados por vírgulas (ids de grupo ou de categoria do catálogo de ferramentas) que o servidor lista e serve. Não definida ou vazia equivale a",
    ", the interactive hand;":
      ", a mão interativa;",
    " loads every tool, which is what runner launches pin. Composes with the allowlist as an intersection; unknown ids fail server startup.":
      " carrega todas as ferramentas, que é o que os lançamentos de runners fixam. Compõe-se com a allowlist como interseção; ids desconhecidos impedem a inicialização do servidor.",
    "Switch to ": "Altere para ",
    " to serve over HTTP instead of stdio.":
      " para servir por HTTP em vez de stdio.",
    "HTTP transport bind address. Ignored for stdio.":
      "Endereço de bind do transporte HTTP. Ignorado no stdio.",
    "HTTP transport port. Ignored for stdio.":
      "Porta do transporte HTTP. Ignorada no stdio.",
    "The Go runner": "O runner Go",
    "The runner's primary config is its YAML file. A handful of env vars override YAML values at startup — useful for container deployments where the YAML is a template and the secrets arrive at runtime.":
      "A configuração principal do runner fica em seu arquivo YAML. Algumas variáveis de ambiente substituem os valores do YAML na inicialização, o que é útil em implantações com containers nas quais o YAML é um modelo e os secrets chegam em runtime.",
    "YAML field it overrides": "Campo YAML que substitui",
    "Backend URL the runner authenticates against. Same value the MCP server uses.":
      "URL do backend em que o runner se autentica. É o mesmo valor usado pelo servidor MCP.",
    "Bearer key minted for the registered runner. Prefer the env var over committing keys to YAML.":
      "Chave bearer emitida para o Runner registrado. Prefira a variável de ambiente a fazer commit de chaves no YAML.",
    "Workspace scope for the runner. Required through YAML, a named profile, or this override.":
      "Escopo do espaço de trabalho do runner. É obrigatório por YAML, perfil nomeado ou este override.",
    " or ": " ou ",
    " force-disables the runner's WebSocket client. Other values do not force-enable it.":
      " forçam a desativação do cliente WebSocket do runner. Outros valores não forçam sua ativação.",
    "(debug flag)": "(flag de depuração)",
    " disables panic recovery, matching": " desativa a recuperação de panic, como",
    ". Debug only: a panic terminates the process.":
      ". Somente para depuração: um panic encerra o processo.",
    "(MCP child identity)": "(identidade do processo MCP filho)",
    "Inherited by the spawned MCP server for development-header identity. It is not a runner YAML override and is ignored when the MCP server uses an API key or IAP.":
      "Herdada pelo servidor MCP iniciado como identidade do header de desenvolvimento. Não é um override do YAML do runner e é ignorada quando o MCP usa API key ou IAP.",
    "(not an inherited runner override)":
      "(não é um override herdado do runner)",
    "The runner deliberately does not read this env var into config and strips an inherited value before spawning":
      "O runner deliberadamente não lê esta variável em sua configuração e remove qualquer valor herdado antes de iniciar",
    ". To bill API credits, set": ". Para usar créditos de API, defina",
    " in YAML; leave it empty for Claude Max / OAuth.":
      " no YAML; deixe vazio para Claude Max / OAuth.",
    "The Codex driver also strips an inherited key before spawning":
      "O driver do Codex também remove uma chave herdada antes de iniciar",
    ". The current runner config has no general YAML field that wires this provider option, so normal runner execution must use ":
      ". A configuração atual do Runner não tem um campo YAML geral que conecte esta opção do provedor, portanto a execução normal deve usar as credenciais de ",
    " credentials.": ".",
    "API keys don't belong in committed files":
      "API keys não devem estar em arquivos versionados",
    "Every env var named ": "Toda variável de ambiente chamada ",
    " is a secret. The runner's YAML supports ":
      " é um secret. O YAML do runner aceita a interpolação ",
    " interpolation precisely so the committed config file can stay checked-in while the key flows in at process start. Don't paste a real key into a committed YAML or MCP config just because \"it's internal.\"":
      " justamente para que o arquivo de configuração possa permanecer versionado enquanto a chave entra na inicialização do processo. Não cole uma chave real em um YAML ou em uma configuração MCP versionada só porque “é interno”.",
  },
};
