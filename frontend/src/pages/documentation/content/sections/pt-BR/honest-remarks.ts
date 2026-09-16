// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_HONEST_REMARKS = {
  "what-works-well": {
    "Backplane's strongest parts are the boundaries that the repository can verify. The backend, frontend, MCP server, and Go Runner live together, and focused contract tests pin the payloads and names they share. That does not make every boundary automatic, but it turns important drift into a test failure instead of an operator surprise.":
      "As partes mais sólidas do Backplane são os limites que o repositório consegue verificar. O backend, o frontend, o servidor MCP e o Runner em Go convivem no mesmo lugar, e testes de contrato focados fixam os payloads e nomes que compartilham. Isso não automatiza todos os limites, mas transforma divergências importantes em falhas de teste, em vez de surpresas para o operador.",
    "The platform owns execution shape":
      "A plataforma controla a estrutura da execução",
    "The Runner fetches ": "O Runner busca ",
    " from the backend and executes the stages that the platform resolved. A registration can carry multiple ":
      " no backend e executa as etapas resolvidas pela plataforma. Um registro pode conter várias ",
    ", and assignment responses can select a provider and model for the current stage. Pipeline behavior therefore changes through platform configuration rather than a hardcoded role list in the Runner binary.":
      ", e as respostas de atribuição podem selecionar um provider e um modelo para a etapa atual. Assim, o comportamento do pipeline muda pela configuração da plataforma, e não por uma lista de funções fixada no binário do Runner.",
    "Dependencies are an end-to-end feature":
      "As dependências são uma funcionalidade de ponta a ponta",
    "The ": "A relação ",
    " relation is backed by database constraints, cycle validation, scheduler filtering, board and card APIs, frontend management surfaces, and MCP tools. A planner can build a dependency graph and a Runner can avoid work whose prerequisites are not complete without encoding the graph in prose.":
      " conta com restrições de banco de dados, validação de ciclos, filtros do scheduler, APIs de quadros e cartões, superfícies de gerenciamento no frontend e ferramentas MCP. Um planejador pode montar um grafo de dependências, e um Runner pode evitar trabalhos cujos pré-requisitos não estejam concluídos sem codificar o grafo em texto.",
    "Provider seams execute real implementations":
      "As interfaces de providers executam implementações reais",
    "The coding-agent seam has working ":
      "A interface de agentes de código tem ",
    " and": " e",
    " implementations. The forge seam exposes":
      " como implementações operacionais. A interface do forge expõe",
    " and ships GitHub and Gitea/Forgejo drivers. The registries reject unknown provider names instead of silently falling back to a different implementation.":
      " e inclui drivers para GitHub e Gitea/Forgejo. Os registros rejeitam nomes de providers desconhecidos, em vez de recorrer silenciosamente a outra implementação.",
    "Event delivery has a scale-aware backend":
      "A entrega de eventos tem um backend preparado para escala",
    "The event API keeps one subscriber contract while":
      "A API de eventos mantém um único contrato de assinatura, enquanto ",
    " selects an in-process memory bus or a":
      " seleciona um barramento em memória no processo ou uma implementação ",
    " implementation based on PostgreSQL":
      " baseada em PostgreSQL ",
    ". The health endpoint reports the selected backend and listener state, so cross-instance delivery is observable when it is enabled.":
      ". O endpoint de saúde informa o backend selecionado e o estado do listener, tornando observável a entrega entre instâncias quando ela está habilitada.",
    "The useful discipline is enforced, not aspirational":
      "A disciplina útil é aplicada, não apenas desejada",
    "Contract tests cover high-risk seams such as MCP signatures, lifecycle kinds, dependency events, localized technical tokens, and Runner wire shapes. The repository still contains ordinary maintenance debt; the strength is that critical invariants have executable checks.":
      "Os testes de contrato cobrem limites de alto risco, como assinaturas MCP, tipos de ciclo de vida, eventos de dependência, tokens técnicos localizados e estruturas de transporte do Runner. O repositório ainda contém dívida comum de manutenção; a força está no fato de que as invariantes críticas têm verificações executáveis.",
  },
  "known-rough-edges": {
    "These limitations are visible in the current code. They are not a historical audit score, a staffing claim, or a promise that a fix is scheduled. Treat them as boundaries to verify before relying on the affected capability in a production workflow.":
      "Estas limitações estão visíveis no código atual. Elas não são o resultado de uma auditoria histórica, uma afirmação sobre alocação de pessoas nem uma promessa de correção agendada. Trate-as como limites que precisam ser verificados antes de depender da capacidade afetada em um fluxo de produção.",
    "Cross-surface schemas still require vigilance":
      "Os schemas entre superfícies ainda exigem atenção",
    "Earlier gaps in Runner identity are closed: ":
      "As lacunas anteriores na identidade do Runner foram fechadas: ",
    " and": " e",
    " include ": " incluem ",
    ", and": ", e ",
    " consumes ": " consome ",
    ". Drift has not disappeared. For example, the backend workspace response exposes":
      ". A divergência não desapareceu. Por exemplo, a resposta de espaço de trabalho do backend expõe ",
    ", while the frontend's":
      ", enquanto a interface ",
    " interface does not currently declare it. Python, TypeScript, Go, and MCP payloads remain separate contracts.":
      " do frontend não o declara atualmente. Os payloads de Python, TypeScript, Go e MCP continuam sendo contratos separados.",
    "Two CLI providers, different confidence levels":
      "Dois providers CLI com níveis diferentes de confiança",
    "The Runner can execute both ":
      "O Runner pode executar tanto ",
    ", including per-stage selection. Their capability matrices differ: Codex reports tokens but not a native dollar cost or per-session dollar cap, while Claude exposes a native budget flag whose usefulness depends on the authentication mode.":
      ", inclusive com seleção por etapa. Suas matrizes de capacidades são diferentes: o Codex informa tokens, mas não um custo nativo em dólares nem um teto em dólares por sessão; o Claude expõe uma opção nativa de orçamento cuja utilidade depende do modo de autenticação.",
    "Codex execution is implemented, but live certification is limited":
      "A execução com Codex está implementada, mas a certificação ao vivo é limitada",
    "The Codex driver is covered by fixtures and fake-binary tests, and its isolated MCP configuration has been checked against a real CLI. The source still records that a complete live Valaris tool-call run has not been certified. Do not turn unit coverage into a production guarantee.":
      "O driver do Codex é coberto por fixtures e testes com um binário simulado, e sua configuração MCP isolada foi verificada com uma CLI real. O código ainda registra que uma execução completa ao vivo com uma chamada real de ferramenta do Valaris não foi certificada. Não transforme cobertura unitária em garantia de produção.",
    "The default event bus is still process-local":
      "O barramento de eventos padrão ainda é local ao processo",
    " defaults to ": " usa por padrão ",
    ". That mode is appropriate for one backend process but does not distribute events between instances. Setting it to ":
      ". Esse modo é adequado para um único processo de backend, mas não distribui eventos entre instâncias. Configurá-lo como ",
    " enables the PostgreSQL ":
      " habilita o transporte do PostgreSQL ",
    " transport and listener health reporting. A Redis backend is explicitly rejected because it is not implemented.":
      " e o relatório de saúde do listener. O backend Redis é rejeitado explicitamente porque não está implementado.",
    "Forge support is intentionally uneven":
      "O suporte a forges é intencionalmente desigual",
    " has GitHub and Gitea/Forgejo drivers. The Gitea driver is tested against HTTP fixtures, not a broad live matrix of Gitea and Forgejo releases. GitLab credentials and plain-git paths exist elsewhere in the platform, but there is no native Runner GitLab forge driver for merge requests, reviews, status rollups, or branch protection.":
      " conta com drivers para GitHub e Gitea/Forgejo. O driver do Gitea é testado com fixtures HTTP, não com uma matriz ampla e ao vivo de versões do Gitea e do Forgejo. Credenciais do GitLab e caminhos de git convencional existem em outras partes da plataforma, mas não há um driver nativo de forge para GitLab no Runner que trate merge requests, revisões, consolidação de status ou proteção de branches.",
    "The tree is not permanently spotless":
      "A árvore não permanece livre de dívida o tempo todo",
    "The repository contains targeted ":
      "O repositório contém comentários ",
    " comments and some":
      " direcionados e algumas conversões ",
    " casts. Some are explicit follow-ups or narrow type escapes; their presence still means a claim of zero debt would be false. Contract tests protect selected boundaries, but they do not prove that every component or integration path is covered.":
      ". Alguns são acompanhamentos explícitos ou escapes de tipo restritos; sua presença ainda torna falsa qualquer afirmação de dívida zero. Os testes de contrato protegem limites selecionados, mas não provam que todos os componentes ou caminhos de integração estejam cobertos.",
  },
  "actively-working-on": {
    "This route keeps its established title, but the repository cannot prove who is actively assigned to a topic or when it will ship. The sections below separate capabilities already present in the current revision from concrete validation gaps. They are not an implementation calendar or an ETA.":
      "Esta rota mantém seu título estabelecido, mas o repositório não consegue provar quem está ativamente alocado a um tema nem quando ele será entregue. As seções abaixo separam as capacidades já presentes na revisão atual das lacunas concretas de validação. Elas não são um calendário de implementação nem uma previsão de entrega.",
    "Already landed: structured dependencies":
      "Já implementado: dependências estruturadas",
    "Structured card dependencies are no longer future work. The":
      "As dependências estruturadas entre cartões não são mais trabalho futuro. O modelo ",
    " model, migrations, CRUD and bulk-set endpoints, cycle checks, scheduler exclusions, frontend controls, and MCP tools are present. Any follow-up should start from that shipped contract rather than rescoping the feature from zero.":
      ", as migrações, os endpoints CRUD e de atualização em massa, as verificações de ciclo, as exclusões do scheduler, os controles do frontend e as ferramentas MCP estão presentes. Qualquer acompanhamento deve partir desse contrato entregue, em vez de redefinir a funcionalidade do zero.",
    "Already landed: the forge abstraction":
      "Já implementado: a abstração de forge",
    "The Runner now routes change creation, review, status, comments, merge, branch protection, and open-change queries through":
      "O Runner agora direciona a criação de mudanças, revisões, status, comentários, merge, proteção de branches e consultas de mudanças abertas por meio de ",
    ". Backplane ships GitHub and Gitea/Forgejo drivers. GitLab is a documented coverage gap, not evidence that the provider seam itself is still hypothetical.":
      ". O Backplane inclui drivers para GitHub e Gitea/Forgejo. O GitLab é uma lacuna de cobertura documentada, não uma evidência de que a própria interface de providers ainda seja hipotética.",
    "Open validation gaps visible in source":
      "Lacunas abertas de validação visíveis no código",
    "The ": "O provider ",
    " provider needs a certified live run that exercises a real Valaris MCP tool call. The Gitea driver needs testing against the specific live Gitea or Forgejo version an operator plans to use. These are evidence gaps recorded by the implementations, not promises that a team is currently executing either validation.":
      " precisa de uma execução ao vivo certificada que exercite uma chamada real de ferramenta MCP do Valaris. O driver do Gitea precisa ser testado com a versão específica e ao vivo do Gitea ou do Forgejo que o operador pretende usar. Essas são lacunas de evidência registradas pelas implementações, não promessas de que uma equipe esteja executando atualmente uma dessas validações.",
    "Known coverage gaps are not roadmap commitments":
      "Lacunas de cobertura conhecidas não são compromissos de roadmap",
    "A native Runner GitLab forge driver and a Redis event-bus backend are not implemented. The frontend ":
      "Um driver nativo de forge para GitLab no Runner e um backend Redis para o barramento de eventos não estão implementados. O tipo ",
    " type also omits the backend's ":
      " do frontend também omite o campo ",
    " field. This page records those facts so planning can begin from current code; it does not assign owners, priority, or delivery dates.":
      " do backend. Esta página registra esses fatos para que o planejamento comece pelo código atual; ela não atribui responsáveis, prioridade nem datas de entrega.",
    "Read code status separately from delivery status":
      "Leia o estado do código separadamente do estado de entrega",
    "“Implemented”, “tested”, and “live-certified” are different claims. Backplane should only advance a claim when the matching evidence exists in code, automated tests, or a recorded live validation.":
      "“Implementado”, “testado” e “certificado ao vivo” são afirmações diferentes. O Backplane só deve elevar uma afirmação quando a evidência correspondente existir no código, em testes automatizados ou em uma validação ao vivo registrada.",
  },
  "the-north-star": {
    "Backplane's direction is portable, operator-defined execution with explicit evidence at every boundary. The platform defines the work, Runners execute it, and humans retain approval and direction. Provider names should select real implementations, not decorative configuration.":
      "A direção do Backplane é uma execução portátil e definida pelo operador, com evidência explícita em cada limite. A plataforma define o trabalho, os Runners o executam e os humanos mantêm a aprovação e a direção. Os nomes de providers devem selecionar implementações reais, não configurações decorativas.",
    "Configuration remains platform-authoritative":
      "A configuração continua sob a autoridade da plataforma",
    "The backend owns ":
      "O backend controla ",
    ", prompts, role scope, and the provider and model resolved for an assignment. The Runner consumes that contract and refuses invalid or unknown provider names. Adding a role or changing an execution stage should not require recompiling a hardcoded role table.":
      ", os prompts, o escopo das funções e o provider e modelo resolvidos para uma atribuição. O Runner consome esse contrato e rejeita nomes de providers inválidos ou desconhecidos. Adicionar uma função ou alterar uma etapa de execução não deve exigir a recompilação de uma tabela de funções fixada no código.",
    "Provider choice executes today":
      "A escolha de provider é executada hoje",
    " and ": " e ",
    " are concrete":
      " são implementações concretas de ",
    " implementations, and the Runner can register both and dispatch a stage to the backend-resolved provider. This is a working CLI abstraction, not universal model support: direct Anthropic, OpenAI, Gemini, and local-model providers are not implemented by that registry.":
      ", e o Runner pode registrar ambas e direcionar uma etapa ao provider resolvido pelo backend. Essa é uma abstração CLI operacional, não suporte universal a modelos: esse registro não implementa providers diretos para Anthropic, OpenAI, Gemini nem modelos locais.",
    "Portable does not mean identical":
      "Portátil não significa idêntico",
    "Provider capabilities differ. Structured output, native cost reporting, session resume, MCP wiring, and budget enforcement are declared as capabilities so the Runner can adapt. A new provider must implement the contract and prove its behavior instead of inheriting Claude-specific assumptions.":
      "As capacidades dos providers são diferentes. Saída estruturada, relatório nativo de custos, retomada de sessão, integração MCP e aplicação de orçamento são declarados como capacidades para que o Runner possa se adaptar. Um novo provider deve implementar o contrato e comprovar seu comportamento, em vez de herdar pressupostos específicos do Claude.",
    "Code-host operations use a neutral seam":
      "As operações do host de código usam uma interface neutra",
    " gives the Runner neutral change, review, status, and merge operations. GitHub and Gitea/Forgejo implement that seam today. Plain git remains separate, and the absence of a native GitLab driver is stated as a limit rather than hidden behind generic vocabulary.":
      " oferece ao Runner operações neutras de mudança, revisão, status e merge. GitHub e Gitea/Forgejo implementam essa interface hoje. O git convencional permanece separado, e a ausência de um driver nativo para GitLab é declarada como limite, em vez de ser escondida por um vocabulário genérico.",
    "Evidence advances the claim":
      "A evidência eleva a afirmação",
    "A compile-time interface check proves shape. A focused test proves a behavior under its fixtures. A live smoke proves one integrated path in a named environment. The north star is not a spotless-code claim; it is a platform where each operational promise names the strongest evidence that currently supports it.":
      "Uma verificação de interface em tempo de compilação comprova a estrutura. Um teste focado comprova um comportamento com seus fixtures. Um teste de fumaça ao vivo comprova um caminho integrado em um ambiente identificado. A direção não é afirmar que o código é impecável, mas construir uma plataforma em que cada promessa operacional nomeie a evidência mais forte que a sustenta atualmente.",
  },
};
