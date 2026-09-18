// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_BR_INSTALLING = {
  "install-with-docker-compose": {
    "The documented production core is three core containers: Postgres, the FastAPI backend, and the nginx frontend. The optional runner is a fourth service behind a Compose profile, but that profile is not part of the first successful platform boot.":
      "O núcleo de produção documentado tem três contêineres principais: Postgres, o backend FastAPI e o frontend nginx. O runner opcional é um quarto serviço disponível por um perfil do Compose, mas esse perfil não faz parte da primeira inicialização bem-sucedida da plataforma.",
    "What the default stack contains": "O que a stack padrão contém",
    "Postgres 16 stores boards, cards, users, executions, and events in the postgres-data named volume.":
      "O Postgres 16 armazena quadros, cartões, usuários, execuções e eventos no volume nomeado postgres-data.",
    "The backend waits for Postgres, runs Alembic migrations, and then starts gunicorn. It has no host port.":
      "O backend aguarda o Postgres, executa as migrações do Alembic e depois inicia o gunicorn. Ele não publica porta no host.",
    "The frontend serves the SPA on the only published port and proxies /api and /ws to the backend.":
      "O frontend serve a SPA na única porta publicada e encaminha /api e /ws ao backend.",
    "Uploaded resources use the backplane-storage volume when GCS_BUCKET is empty. runner-repos exists for the optional runner profile, not for the three-service core.":
      "Os recursos enviados usam o volume backplane-storage quando GCS_BUCKET está vazio. runner-repos existe para o perfil opcional do runner, não para o núcleo de três serviços.",
    "Before you start": "Antes de começar",
    "Use a recent Docker installation with the Compose v2 command, written as docker compose. The repository does not declare a tested minimum Docker version or RAM requirement, so verify capacity for your own host rather than treating an undocumented number as a guarantee.":
      "Use uma instalação recente do Docker com o comando do Compose v2, escrito como docker compose. O repositório não declara uma versão mínima testada do Docker nem um requisito de RAM; verifique a capacidade do seu host em vez de tratar um número não documentado como garantia.",
    "Create and review .env": "Crie e revise o .env",
    "Copy the tracked example, then replace the existing values in .env. Do not append duplicate keys: which duplicate wins depends on the parser and makes the resulting deployment hard to audit.":
      "Copie o exemplo versionado e substitua os valores existentes no .env. Não acrescente chaves duplicadas: qual delas prevalece depende do parser e torna a implantação resultante difícil de auditar.",
    "Fetch the source and generate secrets": "Obtenha o código-fonte e gere segredos",
    "The minimum decisions for a local production boot are:":
      "As decisões mínimas para uma inicialização local de produção são:",
    "POSTGRES_PASSWORD is required. POSTGRES_USER and POSTGRES_DB both default to backplane.":
      "POSTGRES_PASSWORD é obrigatória. POSTGRES_USER e POSTGRES_DB usam backplane por padrão.",
    "OAUTH_STATE_SIGNING_KEY is required by docker-compose.prod.yml. The backend uses it for built-in local or OIDC login sessions and for OAuth and OIDC state.":
      "docker-compose.prod.yml exige OAUTH_STATE_SIGNING_KEY. O backend a usa para as sessões do login local integrado ou OIDC e para o estado do OAuth e do OIDC.",
    "BACKPLANE_URL defaults to http://localhost:8080 and feeds the frontend, API, CORS, and callback URLs. BACKPLANE_HTTP_PORT defaults to 8080.":
      "BACKPLANE_URL usa http://localhost:8080 por padrão e alimenta as URLs do frontend, da API, do CORS e dos callbacks. BACKPLANE_HTTP_PORT usa 8080 por padrão.",
    "LOCAL_AUTH_ENABLED defaults to true. A fresh database presents the first-run administrator setup before the workspace picker. Configure OIDC, IAP, or trusted-proxy authentication before exposing the host beyond localhost.":
      "LOCAL_AUTH_ENABLED usa true por padrão. Um banco de dados novo apresenta a configuração inicial do administrador antes do seletor de espaços de trabalho. Configure OIDC, IAP ou autenticação por proxy confiável antes de expor o host além de localhost.",
    "The application services build from this checkout":
      "Os serviços da aplicação são compilados a partir deste checkout",
    "docker-compose.prod.yml declares build contexts and pull_policy: build for backend and frontend. The repository explicitly says those two application images are not yet published, even though image names are present in the file. Your checkout is therefore the version you run; do not expect a tag change or docker compose pull to upgrade it.":
      "docker-compose.prod.yml declara contextos de compilação e pull_policy: build para o backend e o frontend. O repositório informa expressamente que essas duas imagens ainda não são publicadas, embora o arquivo contenha nomes de imagem. Portanto, o checkout define a versão executada; não espere que uma mudança de tag ou docker compose pull faça a atualização.",
    "Build and start the platform": "Compile e inicie a plataforma",
    "Start and verify the core stack": "Inicie e verifique a stack principal",
    "A successful backend boot logs Running database migrations... and Starting production server.... The readiness request must return successfully; a zero exit code from Compose alone does not prove that the application is usable. Open http://localhost:8080, complete the first-run administrator setup, and then create or select a workspace.":
      "Uma inicialização correta do backend registra Running database migrations... e Starting production server.... A solicitação de prontidão precisa responder com sucesso; apenas um código de saída zero do Compose não comprova que a aplicação pode ser usada. Abra http://localhost:8080, conclua a configuração inicial do administrador e depois crie ou selecione um espaço de trabalho.",
    "Demo data is optional and requires an explicit account email:":
      "Os dados de demonstração são opcionais e exigem o e-mail explícito de uma conta:",
    "Optionally seed a demo workspace": "Opcional: carregue um espaço de trabalho de demonstração",
    "Only the frontend port is published": "Somente a porta do frontend é publicada",
    "Keep the backend and Postgres private on the Compose network. Every browser request should enter through nginx on the frontend. Publishing port 8000 creates a path around the intended front door and its authentication topology.":
      "Mantenha o backend e o Postgres privados na rede do Compose. Toda solicitação do navegador deve entrar pelo nginx no frontend. Publicar a porta 8000 cria um caminho que contorna a entrada prevista e sua topologia de autenticação.",
    "Never expose the development Compose stack": "Nunca exponha a stack de desenvolvimento do Compose",
    "docker-compose.yml is for local development and trusts X-User-Email as identity. Production self-hosting uses docker-compose.prod.yml, which sets ENV=production and refuses to start when every production authentication verifier is disabled.":
      "docker-compose.yml serve para desenvolvimento local e confia em X-User-Email como identidade. A hospedagem própria em produção usa docker-compose.prod.yml, que define ENV=production e se recusa a iniciar quando todos os verificadores de autenticação de produção estão desabilitados.",
    "The bundled runner profile is not turnkey": "O perfil incluído do runner não está pronto para uso",
    "The current runner profile mounts one YAML file at /etc/backplane/runner.yaml. The example YAML points to mcp-config.json, but Compose does not provide the second mount for that MCP file. As shipped, starting the profile can therefore leave the runner without its required MCP configuration. This limitation does not prevent the three core services from being installed and verified.":
      "O perfil atual do runner monta um arquivo YAML em /etc/backplane/runner.yaml. O YAML de exemplo aponta para mcp-config.json, mas o Compose não fornece a segunda montagem para esse arquivo MCP. Assim, no estado em que é distribuído, iniciar o perfil pode deixar o runner sem a configuração MCP obrigatória. Essa limitação não impede a instalação e a verificação dos três serviços principais.",
    "Register a runner in the UI and follow the two-file, explicit -config flow in the Registering a Runner and Your First Pipeline Run pages. Do not treat docker compose --profile runner up as a complete runner installation until your deployment supplies both files at matching in-container paths.":
      "Registre um runner na interface e siga o fluxo explícito com -config e dois arquivos nas páginas Como registrar um runner e Sua primeira execução de pipeline. Não trate docker compose --profile runner up como uma instalação completa do runner até que sua implantação forneça os dois arquivos em caminhos correspondentes dentro do contêiner.",
    "Verify persisted behavior, not only health": "Verifique o comportamento persistido, não apenas a saúde",
    "After the readiness check, create a workspace, board, and card, reload the page, and restart the three core services normally. Confirm the card still exists. That covers authentication, migrations, Postgres, nginx proxying, and basic persistence in one small smoke test.":
      "Depois da verificação de prontidão, crie um espaço de trabalho, um quadro e um cartão, recarregue a página e reinicie normalmente os três serviços principais. Confirme que o cartão continua existindo. Esse pequeno teste de fumaça cobre autenticação, migrações, Postgres, proxy do nginx e persistência básica.",
  },
  "securing-a-self-hosted-deployment": {
    "Backplane ships with built-in email and password login and built-in OIDC. It can also verify Google IAP assertions or trust an identity header from a proxy you operate. Choose one browser authentication topology, keep the backend private, and preserve its signing keys.":
      "O Backplane inclui login integrado por e-mail e senha e OIDC integrado. Ele também pode verificar asserções do Google IAP ou confiar em um cabeçalho de identidade enviado por um proxy que você opera. Escolha uma topologia de autenticação do navegador, mantenha o backend privado e preserve suas chaves de assinatura.",
    "How a request is authenticated": "Como uma solicitação é autenticada",
    "API bearer keys are checked first for runners and MCP clients. Browser users authenticate through a signed Backplane session created by local login or OIDC. Development identity, Google IAP, and trusted-proxy headers are then evaluated according to the configured environment. Local login and OIDC are login methods for the same session model, not competing per-request verifier tiers.":
      "As API keys bearer são verificadas primeiro para runners e clientes MCP. Usuários do navegador se autenticam por uma sessão assinada do Backplane, criada pelo login local ou pelo OIDC. A identidade de desenvolvimento, o Google IAP e os cabeçalhos de proxy confiável são então avaliados conforme o ambiente configurado. Login local e OIDC são métodos de entrada para o mesmo modelo de sessão, não níveis verificadores concorrentes em cada solicitação.",
    "See the internal API Authentication Modes reference for the current":
      "Consulte a referência interna Modos de autenticação da API para ver os contratos atuais de",
    "local login": "login local",
    and: "e",
    "OIDC login": "login OIDC",
    "contracts.": ".",
    "Production fails closed when every verifier is disabled":
      "A produção falha de forma segura quando todos os verificadores estão desabilitados",
    "With ENV=production, startup requires local login, OIDC, Google IAP, or trusted-proxy authentication. Local login or OIDC also requires OAUTH_STATE_SIGNING_KEY. If no production verifier is available, the backend exits instead of serving unauthenticated traffic.":
      "Com ENV=production, a inicialização exige login local, OIDC, Google IAP ou autenticação por proxy confiável. O login local ou OIDC também exige OAUTH_STATE_SIGNING_KEY. Se nenhum verificador de produção estiver disponível, o backend encerra em vez de servir tráfego sem autenticação.",
    "Built-in local login": "Login local integrado",
    "LOCAL_AUTH_ENABLED=true is the default. A fresh database opens the first-run administrator setup, and later accounts are managed through the product. Login attempts are rate-limited and repeated failures can lock an account. Use a long random OAUTH_STATE_SIGNING_KEY and HTTPS before exposing this mode beyond localhost.":
      "LOCAL_AUTH_ENABLED=true é o padrão. Um banco de dados novo abre a configuração inicial do administrador, e as contas posteriores são gerenciadas pelo produto. As tentativas de login têm limitação de frequência, e falhas repetidas podem bloquear uma conta. Use uma OAUTH_STATE_SIGNING_KEY aleatória e longa, além de HTTPS, antes de expor este modo além de localhost.",
    "Built-in OIDC": "OIDC integrado",
    "OIDC is implemented today. Backplane discovers the issuer, uses the authorization-code flow with PKCE, validates the response, and mints its signed HTTP-only session cookie. A separate authentication proxy is not required for this mode.":
      "O OIDC está implementado hoje. O Backplane descobre o emissor, usa o fluxo de código de autorização com PKCE, valida a resposta e emite sua cookie de sessão assinada e somente HTTP. Este modo não exige um proxy de autenticação separado.",
    "Minimum built-in OIDC settings": "Configurações mínimas do OIDC integrado",
    "The callback is built from API_URL and ends in /api/auth/oidc/callback. In the production Compose file, BACKPLANE_URL supplies API_URL, so the public URL and the provider's registered redirect must agree exactly.":
      "O callback é construído a partir de API_URL e termina em /api/auth/oidc/callback. No arquivo de produção do Compose, BACKPLANE_URL fornece API_URL; portanto, a URL pública e o redirecionamento registrado no provedor precisam coincidir exatamente.",
    "Google IAP and trusted proxy": "Google IAP e proxy confiável",
    "IAP_AUDIENCE enables verification of the signed X-Goog-IAP-JWT-Assertion and its email claim.":
      "IAP_AUDIENCE habilita a verificação de X-Goog-IAP-JWT-Assertion assinado e de sua claim de e-mail.",
    "TRUSTED_PROXY_AUTH=true trusts the header named by TRUSTED_PROXY_AUTH_HEADER. The default header is X-Goog-Authenticated-User-Email and has no application-level signature, so network isolation and header replacement are required.":
      "TRUSTED_PROXY_AUTH=true confia no cabeçalho indicado por TRUSTED_PROXY_AUTH_HEADER. O cabeçalho padrão é X-Goog-Authenticated-User-Email e não tem assinatura no nível da aplicação; por isso, isolamento de rede e substituição do cabeçalho são obrigatórios.",
    "TRUSTED_PROXY_SECRET adds X-Backplane-Proxy-Secret as a shared defense, and AUTH_ALLOWED_EMAIL_DOMAINS narrows accepted identities.":
      "TRUSTED_PROXY_SECRET adiciona X-Backplane-Proxy-Secret como defesa compartilhada, e AUTH_ALLOWED_EMAIL_DOMAINS restringe as identidades aceitas.",
    "AUTH_AUTO_PROVISION controls whether a verified new email becomes a user. When false, unknown identities receive 403 user_not_provisioned instead of an account.":
      "AUTH_AUTO_PROVISION controla se um novo e-mail verificado se torna usuário. Quando é false, identidades desconhecidas recebem 403 user_not_provisioned em vez de uma conta.",
    "A trusted header is safe only behind an enforced proxy":
      "Um cabeçalho confiável só é seguro atrás de um proxy obrigatório",
    "When AUTH_AUTO_PROVISION=true, a verified IAP or trusted-proxy email can create its user on first request. If clients can reach the backend around that verifier, or can preserve their own identity header, the security boundary is broken. Publish only the intended frontend or proxy entry point and strip incoming identity headers before setting the trusted value.":
      "Quando AUTH_AUTO_PROVISION=true, um e-mail verificado pelo IAP ou por um proxy confiável pode criar seu usuário na primeira solicitação. Se os clientes conseguirem alcançar o backend contornando esse verificador ou preservar o próprio cabeçalho de identidade, o limite de segurança estará rompido. Publique apenas o ponto de entrada previsto do frontend ou proxy e remova os cabeçalhos de identidade recebidos antes de definir o valor confiável.",
    "An external OIDC proxy remains an alternative": "Um proxy OIDC externo continua sendo uma alternativa",
    "oauth2-proxy, Authelia, or a similar gateway can own browser login and forward a verified email to Backplane. This is useful when one gateway already protects several applications, but it is not required merely to obtain OIDC support.":
      "oauth2-proxy, Authelia ou um gateway semelhante podem controlar o login do navegador e encaminhar um e-mail verificado ao Backplane. Isso é útil quando um único gateway já protege várias aplicações, mas não é necessário apenas para obter suporte a OIDC.",
    "Trust an oauth2-proxy email header": "Confie no cabeçalho de e-mail do oauth2-proxy",
    "Protect and restore secrets": "Proteja e restaure os segredos",
    "OAUTH_STATE_SIGNING_KEY signs login sessions and OAuth or OIDC state. INTEGRATIONS_TOKEN_KEY encrypts stored git-provider tokens. Provider credentials and forge tokens can authorize external actions. Keep .env out of git, restrict access, back it up encrypted, and rotate exposed values deliberately.":
      "OAUTH_STATE_SIGNING_KEY assina as sessões de login e o estado do OAuth ou OIDC. INTEGRATIONS_TOKEN_KEY criptografa os tokens armazenados de provedores git. Credenciais de provedores e tokens do forge podem autorizar ações externas. Mantenha o .env fora do git, restrinja o acesso, faça backup criptografado e rotacione deliberadamente os valores expostos.",
    "Test both the login path and the bypass path": "Teste tanto o caminho de login quanto o caminho de contorno",
    "Confirm a permitted identity can log in and a disallowed identity is rejected. Then try to reach backend and frontend ports outside the intended proxy path from another host. A working login page does not compensate for a direct unauthenticated route.":
      "Confirme que uma identidade permitida consegue entrar e que uma identidade não permitida é rejeitada. Depois, tente alcançar de outro host as portas do backend e do frontend fora do caminho previsto do proxy. Uma página de login funcional não compensa uma rota direta sem autenticação.",
  },
  "upgrading-backplane": {
    "Upgrading the production Compose deployment means choosing a reviewed source revision, rebuilding backend and frontend from that checkout, and recreating the services. Those application services are not currently upgraded by pulling published Backplane image tags.":
      "Atualizar a implantação de produção com Compose significa escolher uma revisão de código analisada, recompilar o backend e o frontend a partir desse checkout e recriar os serviços. Atualmente, esses serviços da aplicação não são atualizados baixando tags de imagens publicadas do Backplane.",
    "Take a complete backup before changing the checkout": "Faça um backup completo antes de mudar o checkout",
    "Follow Backup and Restore for the Postgres dump, uploaded files or GCS bucket, and .env secrets. A database dump alone is not a complete rollback point.":
      "Siga Backup e restauração para o dump do Postgres, os arquivos enviados ou o bucket do GCS e os segredos do .env. Um dump do banco de dados, sozinho, não é um ponto completo de reversão.",
    "Build the reviewed revision": "Compile a revisão analisada",
    "Start from a clean deployment checkout. Fetch the repository, inspect the target commit or release, and check out that exact revision. Do not use an unreviewed moving branch as a production version.":
      "Comece com um checkout de implantação limpo. Busque o repositório, inspecione o commit ou release de destino e selecione essa revisão exata. Não use uma branch móvel não analisada como versão de produção.",
    "Rebuild and recreate": "Recompile e recrie",
    "backend/start-prod.sh runs python -m alembic upgrade head before gunicorn. It tries the migration up to five times with a five-second pause. A backend that never reaches Starting production server... has not completed the upgrade.":
      "backend/start-prod.sh executa python -m alembic upgrade head antes do gunicorn. Ele tenta a migração até cinco vezes, com uma pausa de cinco segundos. Um backend que nunca alcança Starting production server... não concluiu a atualização.",
    "Compose recreation can interrupt requests": "A recriação com Compose pode interromper solicitações",
    "This deployment is not documented as zero-downtime. Recreating the backend or frontend can cause a brief interruption, and a long migration can extend it. Schedule a maintenance window when downtime matters, especially for an old database or an untested migration gap.":
      "Esta implantação não é documentada como sem indisponibilidade. Recriar o backend ou o frontend pode causar uma breve interrupção, e uma migração longa pode prolongá-la. Programe uma janela de manutenção quando a indisponibilidade importar, especialmente para um banco antigo ou um salto de migrações não testado.",
    "Alembic handles missing revisions in order": "O Alembic aplica em ordem as revisões ausentes",
    "Alembic upgrades from the database's current revision to head through every missing migration. You do not need to boot every intervening application release. For a large version gap, rehearse the exact upgrade against a restored copy first so duration and data-dependent failures are known before production.":
      "O Alembic atualiza da revisão atual do banco até head, passando por todas as migrações ausentes. Não é preciso iniciar cada release intermediário da aplicação. Para um salto grande de versões, ensaie primeiro a atualização exata em uma cópia restaurada, para conhecer a duração e as falhas dependentes dos dados antes da produção.",
    "Verify the result": "Verifique o resultado",
    "Check services, readiness, and schema": "Verifique serviços, prontidão e esquema",
    "Confirm the Alembic output marks the current revision as head. Then log in, open an existing board, reload it, and inspect backend logs for migration, startup, authentication, or WebSocket errors. If you operate a separately configured runner, verify it independently after the platform is healthy.":
      "Confirme que a saída do Alembic marca a revisão atual como head. Depois, entre, abra um quadro existente, recarregue-o e inspecione os logs do backend em busca de erros de migração, inicialização, autenticação ou WebSocket. Se você opera um runner configurado separadamente, verifique-o de forma independente quando a plataforma estiver saudável.",
    "A forward migration is not undone by old source": "O código antigo não desfaz uma migração para a frente",
    "Checking out an older commit does not reverse a schema migration and may start incompatible code against the newer schema. Recover by restoring the complete pre-upgrade backup into a controlled stack, or by applying a reviewed forward fix. Do not edit an applied migration or assume alembic downgrade is a safe production rollback.":
      "Selecionar um commit anterior não reverte uma migração do esquema e pode iniciar código incompatível contra o esquema mais novo. Recupere restaurando o backup completo anterior à atualização em uma stack controlada ou aplicando uma correção para a frente analisada. Não edite uma migração já aplicada nem suponha que alembic downgrade seja uma reversão segura em produção.",
    "Record the source SHA beside every backup": "Registre o SHA do código junto de cada backup",
    "Store the exact git commit, Compose project name, and backup timestamp together. A restore is reproducible only when the database, files, secrets, and source revision can be matched.":
      "Armazene juntos o commit exato do git, o nome do projeto do Compose e o horário do backup. Uma restauração só é reproduzível quando o banco de dados, os arquivos, os segredos e a revisão do código podem ser associados.",
  },
  "backup-and-restore": {
    "A recoverable self-hosted backup includes the Postgres database, every uploaded resource, and the complete .env file. Record the source commit and Compose project name with those artifacts.":
      "Um backup recuperável de uma instalação própria inclui o banco de dados Postgres, todos os recursos enviados e o arquivo .env completo. Registre com esses artefatos o commit do código e o nome do projeto do Compose.",
    "Dump Postgres": "Faça o dump do Postgres",
    "Create a custom-format dump": "Crie um dump em formato personalizado",
    "The custom format is compressed and can be restored selectively. Running pg_dump against the live database is transactionally consistent; -T prevents a TTY from corrupting the binary stream.":
      "O formato personalizado é compactado e pode ser restaurado seletivamente. Executar pg_dump contra o banco ativo é transacionalmente consistente; -T impede que uma TTY corrompa o fluxo binário.",
    "Back up the active resource store": "Faça backup do armazenamento de recursos ativo",
    "When GCS_BUCKET is empty, uploads live in the backplane-storage named volume at /data/resources. Docker prefixes the volume with the Compose project name. Confirm the real name with docker volume ls before using it; do not copy the example prefix blindly.":
      "Quando GCS_BUCKET está vazio, os arquivos enviados ficam no volume nomeado backplane-storage, em /data/resources. O Docker prefixa o volume com o nome do projeto do Compose. Confirme o nome real com docker volume ls antes de usá-lo; não copie o prefixo do exemplo sem verificar.",
    "Archive local uploaded resources": "Arquive os recursos locais enviados",
    "GCS deployments need a bucket backup instead": "Implantações com GCS precisam de backup do bucket",
    "When GCS_BUCKET is set, the bucket is the authoritative upload store; archiving the local named volume does not protect those objects. Use your cloud provider's versioning or backup procedure and verify that the bucket recovery point matches the database dump.":
      "Quando GCS_BUCKET está definido, o bucket é o armazenamento autoritativo dos arquivos enviados; arquivar o volume local não protege esses objetos. Use o versionamento ou procedimento de backup do provedor de nuvem e verifique se o ponto de recuperação do bucket corresponde ao dump do banco.",
    "Protect .env as a credential backup": "Proteja o .env como backup de credenciais",
    "Store .env in an encrypted secrets system away from the deployment disk. It contains database credentials, OAUTH_STATE_SIGNING_KEY, INTEGRATIONS_TOKEN_KEY, and any configured provider secrets.":
      "Armazene o .env em um sistema de segredos criptografado e separado do disco da implantação. Ele contém credenciais do banco, OAUTH_STATE_SIGNING_KEY, INTEGRATIONS_TOKEN_KEY e todos os segredos de provedores configurados.",
    "Lost encryption and signing keys cannot be reconstructed": "Chaves de criptografia e assinatura perdidas não podem ser reconstruídas",
    "INTEGRATIONS_TOKEN_KEY decrypts stored git-connection OAuth tokens; without it those database values are unusable. Changing OAUTH_STATE_SIGNING_KEY invalidates signed login sessions and OAuth or OIDC state. Restore the original keys deliberately instead of generating replacements during recovery.":
      "INTEGRATIONS_TOKEN_KEY descriptografa os tokens OAuth armazenados das conexões git; sem ela, esses valores do banco são inutilizáveis. Alterar OAUTH_STATE_SIGNING_KEY invalida sessões de login assinadas e o estado do OAuth ou OIDC. Restaure deliberadamente as chaves originais em vez de gerar substitutas durante a recuperação.",
    "Restore into a controlled stack": "Restaure em uma stack controlada",
    "Put the backed-up .env and the intended source revision in place first. Keep backend and frontend stopped while replacing the database and files. The example below assumes local volume storage.":
      "Coloque primeiro o .env do backup e a revisão de código pretendida. Mantenha backend e frontend parados enquanto substitui o banco e os arquivos. O exemplo abaixo pressupõe armazenamento em volume local.",
    "Run the whole block as a Bash script. It stops on the first error. This example uses a separate project and localhost port; choose an unused port. Preserve archive ownership so the backend can write restored files.":
      "Execute o bloco inteiro como um script Bash. Ele para no primeiro erro. Este exemplo usa um projeto separado e uma porta de localhost; escolha uma porta livre. Preserve a propriedade dos arquivos no backup para que o backend possa gravar nos arquivos restaurados.",
    "Restore database and local resources": "Restaure o banco de dados e os recursos locais",
    "Newer source automatically upgrades an older dump": "Código mais novo atualiza automaticamente um dump antigo",
    "If you intentionally start a newer checkout, backend startup applies every missing Alembic revision before serving requests. To inspect the old schema unchanged, use the recorded source commit in an isolated environment and do not start a newer backend against it.":
      "Se você iniciar intencionalmente um checkout mais novo, o backend aplicará durante a inicialização todas as revisões ausentes do Alembic antes de servir solicitações. Para inspecionar o esquema antigo sem alterações, use o commit registrado em um ambiente isolado e não inicie contra ele um backend mais novo.",
    "Test recovery regularly": "Teste a recuperação regularmente",
    "Restore into a separate Compose project and port. Verify readiness, login, an existing board and card, and at least one uploaded resource. For GCS, verify an object restored from the matching bucket recovery point. A backup is not proven until this drill succeeds.":
      "Restaure em um projeto do Compose e uma porta separados. Verifique a prontidão, o login, um quadro e um cartão existentes e pelo menos um recurso enviado. Para GCS, verifique um objeto restaurado do ponto de recuperação correspondente do bucket. Um backup não está comprovado até que esse exercício funcione.",
    "Verify artifacts, retention, and source identity": "Verifique artefatos, retenção e identidade do código",
    "Automate size and checksum checks, retain more than one recovery point, and record git rev-parse HEAD. A fresh zero-byte dump or an unlabeled archive is not a usable backup.":
      "Automatize verificações de tamanho e checksum, mantenha mais de um ponto de recuperação e registre git rev-parse HEAD. Um dump recente de zero byte ou um arquivo sem identificação não é um backup utilizável.",
  },
} as const;
