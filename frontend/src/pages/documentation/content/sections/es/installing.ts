// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ES_INSTALLING = {
  "install-with-docker-compose": {
    "The documented production core is three core containers: Postgres, the FastAPI backend, and the nginx frontend. The optional runner is a fourth service behind a Compose profile, but that profile is not part of the first successful platform boot.":
      "El núcleo de producción documentado consta de tres contenedores principales: Postgres, el backend FastAPI y el frontend nginx. El runner opcional es un cuarto servicio disponible mediante un perfil de Compose, pero ese perfil no forma parte del primer inicio correcto de la plataforma.",
    "What the default stack contains": "Qué contiene el stack predeterminado",
    "Postgres 16 stores boards, cards, users, executions, and events in the postgres-data named volume.":
      "Postgres 16 almacena tableros, tarjetas, usuarios, ejecuciones y eventos en el volumen con nombre postgres-data.",
    "The backend waits for Postgres, runs Alembic migrations, and then starts gunicorn. It has no host port.":
      "El backend espera a Postgres, ejecuta las migraciones de Alembic y después inicia gunicorn. No publica ningún puerto en el host.",
    "The frontend serves the SPA on the only published port and proxies /api and /ws to the backend.":
      "El frontend sirve la SPA en el único puerto publicado y redirige /api y /ws al backend.",
    "Uploaded resources use the backplane-storage volume when GCS_BUCKET is empty. runner-repos exists for the optional runner profile, not for the three-service core.":
      "Los recursos subidos usan el volumen backplane-storage cuando GCS_BUCKET está vacío. runner-repos existe para el perfil opcional del runner, no para el núcleo de tres servicios.",
    "Before you start": "Antes de comenzar",
    "Use a recent Docker installation with the Compose v2 command, written as docker compose. The repository does not declare a tested minimum Docker version or RAM requirement, so verify capacity for your own host rather than treating an undocumented number as a guarantee.":
      "Usa una instalación reciente de Docker con el comando de Compose v2, escrito como docker compose. El repositorio no declara una versión mínima de Docker ni un requisito de RAM que hayan sido probados; verifica la capacidad de tu host en lugar de tratar una cifra no documentada como garantía.",
    "Create and review .env": "Crea y revisa .env",
    "Copy the tracked example, then replace the existing values in .env. Do not append duplicate keys: which duplicate wins depends on the parser and makes the resulting deployment hard to audit.":
      "Copia el ejemplo versionado y reemplaza los valores existentes en .env. No agregues claves duplicadas: cuál prevalece depende del parser y hace que el despliegue resultante sea difícil de auditar.",
    "Fetch the source and generate secrets": "Obtén el código fuente y genera secretos",
    "The minimum decisions for a local production boot are:":
      "Las decisiones mínimas para un inicio local de producción son:",
    "POSTGRES_PASSWORD is required. POSTGRES_USER and POSTGRES_DB both default to backplane.":
      "POSTGRES_PASSWORD es obligatoria. POSTGRES_USER y POSTGRES_DB usan backplane de forma predeterminada.",
    "OAUTH_STATE_SIGNING_KEY is required by docker-compose.prod.yml. The backend uses it for built-in local or OIDC login sessions and for OAuth and OIDC state.":
      "docker-compose.prod.yml exige OAUTH_STATE_SIGNING_KEY. El backend la usa para las sesiones del acceso local integrado u OIDC y para el estado de OAuth y OIDC.",
    "BACKPLANE_URL defaults to http://localhost:8080 and feeds the frontend, API, CORS, and callback URLs. BACKPLANE_HTTP_PORT defaults to 8080.":
      "BACKPLANE_URL usa http://localhost:8080 de forma predeterminada y alimenta las URLs del frontend, la API, CORS y los callbacks. BACKPLANE_HTTP_PORT usa 8080 de forma predeterminada.",
    "LOCAL_AUTH_ENABLED defaults to true. A fresh database presents the first-run administrator setup before the workspace picker. Configure OIDC, IAP, or trusted-proxy authentication before exposing the host beyond localhost.":
      "LOCAL_AUTH_ENABLED usa true de forma predeterminada. Una base de datos nueva muestra la configuración inicial del administrador antes del selector de espacios de trabajo. Configura OIDC, IAP o la autenticación mediante proxy de confianza antes de exponer el host fuera de localhost.",
    "The application services build from this checkout":
      "Los servicios de la aplicación se compilan desde este checkout",
    "docker-compose.prod.yml declares build contexts and pull_policy: build for backend and frontend. The repository explicitly says those two application images are not yet published, even though image names are present in the file. Your checkout is therefore the version you run; do not expect a tag change or docker compose pull to upgrade it.":
      "docker-compose.prod.yml declara contextos de compilación y pull_policy: build para el backend y el frontend. El repositorio indica expresamente que esas dos imágenes aún no están publicadas, aunque el archivo incluya nombres de imagen. Por tanto, el checkout define la versión que ejecutas; no esperes que un cambio de tag o docker compose pull la actualice.",
    "Build and start the platform": "Compila e inicia la plataforma",
    "Start and verify the core stack": "Inicia y verifica el stack principal",
    "A successful backend boot logs Running database migrations... and Starting production server.... The readiness request must return successfully; a zero exit code from Compose alone does not prove that the application is usable. Open http://localhost:8080, complete the first-run administrator setup, and then create or select a workspace.":
      "Un inicio correcto del backend registra Running database migrations... y Starting production server.... La solicitud de disponibilidad debe responder correctamente; un código de salida cero de Compose por sí solo no demuestra que la aplicación sea utilizable. Abre http://localhost:8080, completa la configuración inicial del administrador y después crea o selecciona un espacio de trabajo.",
    "Demo data is optional and requires an explicit account email:":
      "Los datos de demostración son opcionales y requieren indicar el correo de una cuenta:",
    "Optionally seed a demo workspace": "Opcional: carga un espacio de trabajo de demostración",
    "Only the frontend port is published": "Solo se publica el puerto del frontend",
    "Keep the backend and Postgres private on the Compose network. Every browser request should enter through nginx on the frontend. Publishing port 8000 creates a path around the intended front door and its authentication topology.":
      "Mantén privados el backend y Postgres dentro de la red de Compose. Todas las solicitudes del navegador deben entrar por nginx en el frontend. Publicar el puerto 8000 crea una ruta que evita la entrada prevista y su topología de autenticación.",
    "Never expose the development Compose stack": "Nunca expongas el stack de Compose de desarrollo",
    "docker-compose.yml is for local development and trusts X-User-Email as identity. Production self-hosting uses docker-compose.prod.yml, which sets ENV=production and refuses to start when every production authentication verifier is disabled.":
      "docker-compose.yml es para desarrollo local y confía en X-User-Email como identidad. El autoalojamiento de producción usa docker-compose.prod.yml, que define ENV=production y se niega a iniciar cuando todos los verificadores de autenticación de producción están deshabilitados.",
    "The bundled runner profile is not turnkey": "El perfil incluido del runner no está listo para usar",
    "The current runner profile mounts one YAML file at /etc/backplane/runner.yaml. The example YAML points to mcp-config.json, but Compose does not provide the second mount for that MCP file. As shipped, starting the profile can therefore leave the runner without its required MCP configuration. This limitation does not prevent the three core services from being installed and verified.":
      "El perfil actual del runner monta un archivo YAML en /etc/backplane/runner.yaml. El YAML de ejemplo apunta a mcp-config.json, pero Compose no proporciona el segundo montaje para ese archivo MCP. Por ello, tal como se distribuye, iniciar el perfil puede dejar al runner sin la configuración MCP obligatoria. Esta limitación no impide instalar y verificar los tres servicios principales.",
    "Register a runner in the UI and follow the two-file, explicit -config flow in the Registering a Runner and Your First Pipeline Run pages. Do not treat docker compose --profile runner up as a complete runner installation until your deployment supplies both files at matching in-container paths.":
      "Registra un runner en la interfaz y sigue el flujo explícito con -config y dos archivos de las páginas Registrar un runner y Tu primera ejecución de pipeline. No trates docker compose --profile runner up como una instalación completa del runner hasta que tu despliegue proporcione ambos archivos en rutas coherentes dentro del contenedor.",
    "Verify persisted behavior, not only health": "Verifica el comportamiento persistido, no solo el estado",
    "After the readiness check, create a workspace, board, and card, reload the page, and restart the three core services normally. Confirm the card still exists. That covers authentication, migrations, Postgres, nginx proxying, and basic persistence in one small smoke test.":
      "Después de comprobar la disponibilidad, crea un espacio de trabajo, un tablero y una tarjeta, recarga la página y reinicia normalmente los tres servicios principales. Confirma que la tarjeta siga existiendo. Esta prueba mínima cubre autenticación, migraciones, Postgres, el proxy de nginx y la persistencia básica.",
  },
  "securing-a-self-hosted-deployment": {
    "Backplane ships with built-in email and password login and built-in OIDC. It can also verify Google IAP assertions or trust an identity header from a proxy you operate. Choose one browser authentication topology, keep the backend private, and preserve its signing keys.":
      "Backplane incluye acceso integrado con correo y contraseña, además de OIDC integrado. También puede verificar aserciones de Google IAP o confiar en un encabezado de identidad enviado por un proxy bajo tu control. Elige una topología de autenticación para el navegador, mantén privado el backend y conserva sus claves de firma.",
    "How a request is authenticated": "Cómo se autentica una solicitud",
    "API bearer keys are checked first for runners and MCP clients. Browser users authenticate through a signed Backplane session created by local login or OIDC. Development identity, Google IAP, and trusted-proxy headers are then evaluated according to the configured environment. Local login and OIDC are login methods for the same session model, not competing per-request verifier tiers.":
      "Las API keys bearer se comprueban primero para runners y clientes MCP. Los usuarios del navegador se autentican mediante una sesión firmada de Backplane creada por el acceso local u OIDC. Después se evalúan la identidad de desarrollo, Google IAP y los encabezados de proxy de confianza según el entorno configurado. El acceso local y OIDC son métodos de inicio de sesión para el mismo modelo de sesión, no niveles verificadores que compitan en cada solicitud.",
    "See the internal API Authentication Modes reference for the current":
      "Consulta la referencia interna Modos de autenticación de la API para conocer los contratos actuales de",
    "local login": "acceso local",
    and: "y",
    "OIDC login": "acceso OIDC",
    "contracts.": ".",
    "Production fails closed when every verifier is disabled":
      "Producción falla de forma segura cuando todos los verificadores están deshabilitados",
    "With ENV=production, startup requires local login, OIDC, Google IAP, or trusted-proxy authentication. Local login or OIDC also requires OAUTH_STATE_SIGNING_KEY. If no production verifier is available, the backend exits instead of serving unauthenticated traffic.":
      "Con ENV=production, el inicio requiere acceso local, OIDC, Google IAP o autenticación mediante proxy de confianza. El acceso local u OIDC también requieren OAUTH_STATE_SIGNING_KEY. Si no hay ningún verificador de producción disponible, el backend termina en lugar de servir tráfico sin autenticar.",
    "Built-in local login": "Acceso local integrado",
    "LOCAL_AUTH_ENABLED=true is the default. A fresh database opens the first-run administrator setup, and later accounts are managed through the product. Login attempts are rate-limited and repeated failures can lock an account. Use a long random OAUTH_STATE_SIGNING_KEY and HTTPS before exposing this mode beyond localhost.":
      "LOCAL_AUTH_ENABLED=true es el valor predeterminado. Una base de datos nueva abre la configuración inicial del administrador y las cuentas posteriores se gestionan desde el producto. Los intentos de acceso tienen limitación de frecuencia y los fallos repetidos pueden bloquear una cuenta. Usa una OAUTH_STATE_SIGNING_KEY aleatoria y larga, además de HTTPS, antes de exponer este modo fuera de localhost.",
    "Built-in OIDC": "OIDC integrado",
    "OIDC is implemented today. Backplane discovers the issuer, uses the authorization-code flow with PKCE, validates the response, and mints its signed HTTP-only session cookie. A separate authentication proxy is not required for this mode.":
      "OIDC está implementado actualmente. Backplane descubre el emisor, usa el flujo de código de autorización con PKCE, valida la respuesta y emite su cookie de sesión firmada y solo HTTP. Este modo no requiere un proxy de autenticación independiente.",
    "Minimum built-in OIDC settings": "Configuración mínima del OIDC integrado",
    "The callback is built from API_URL and ends in /api/auth/oidc/callback. In the production Compose file, BACKPLANE_URL supplies API_URL, so the public URL and the provider's registered redirect must agree exactly.":
      "El callback se construye a partir de API_URL y termina en /api/auth/oidc/callback. En el archivo de Compose de producción, BACKPLANE_URL proporciona API_URL; por eso, la URL pública y la redirección registrada en el proveedor deben coincidir exactamente.",
    "Google IAP and trusted proxy": "Google IAP y proxy de confianza",
    "IAP_AUDIENCE enables verification of the signed X-Goog-IAP-JWT-Assertion and its email claim.":
      "IAP_AUDIENCE habilita la verificación de X-Goog-IAP-JWT-Assertion firmado y de su claim de correo.",
    "TRUSTED_PROXY_AUTH=true trusts the header named by TRUSTED_PROXY_AUTH_HEADER. The default header is X-Goog-Authenticated-User-Email and has no application-level signature, so network isolation and header replacement are required.":
      "TRUSTED_PROXY_AUTH=true confía en el encabezado indicado por TRUSTED_PROXY_AUTH_HEADER. El encabezado predeterminado es X-Goog-Authenticated-User-Email y no tiene firma en la aplicación; por eso se requieren aislamiento de red y reemplazo del encabezado.",
    "TRUSTED_PROXY_SECRET adds X-Backplane-Proxy-Secret as a shared defense, and AUTH_ALLOWED_EMAIL_DOMAINS narrows accepted identities.":
      "TRUSTED_PROXY_SECRET añade X-Backplane-Proxy-Secret como defensa compartida y AUTH_ALLOWED_EMAIL_DOMAINS restringe las identidades aceptadas.",
    "AUTH_AUTO_PROVISION controls whether a verified new email becomes a user. When false, unknown identities receive 403 user_not_provisioned instead of an account.":
      "AUTH_AUTO_PROVISION controla si un correo nuevo verificado se convierte en usuario. Cuando es false, las identidades desconocidas reciben 403 user_not_provisioned en lugar de una cuenta.",
    "A trusted header is safe only behind an enforced proxy":
      "Un encabezado de confianza solo es seguro detrás de un proxy obligatorio",
    "When AUTH_AUTO_PROVISION=true, a verified IAP or trusted-proxy email can create its user on first request. If clients can reach the backend around that verifier, or can preserve their own identity header, the security boundary is broken. Publish only the intended frontend or proxy entry point and strip incoming identity headers before setting the trusted value.":
      "Cuando AUTH_AUTO_PROVISION=true, un correo verificado por IAP o por un proxy de confianza puede crear su usuario en la primera solicitud. Si los clientes pueden llegar al backend evitando ese verificador o conservar su propio encabezado de identidad, el límite de seguridad queda roto. Publica únicamente el punto de entrada previsto del frontend o proxy y elimina los encabezados de identidad entrantes antes de definir el valor confiable.",
    "An external OIDC proxy remains an alternative": "Un proxy OIDC externo sigue siendo una alternativa",
    "oauth2-proxy, Authelia, or a similar gateway can own browser login and forward a verified email to Backplane. This is useful when one gateway already protects several applications, but it is not required merely to obtain OIDC support.":
      "oauth2-proxy, Authelia o un gateway similar pueden gestionar el acceso del navegador y reenviar a Backplane un correo verificado. Es útil cuando un único gateway ya protege varias aplicaciones, pero no es necesario solo para disponer de OIDC.",
    "Trust an oauth2-proxy email header": "Confía en el encabezado de correo de oauth2-proxy",
    "Protect and restore secrets": "Protege y restaura los secretos",
    "OAUTH_STATE_SIGNING_KEY signs login sessions and OAuth or OIDC state. INTEGRATIONS_TOKEN_KEY encrypts stored git-provider tokens. Provider credentials and forge tokens can authorize external actions. Keep .env out of git, restrict access, back it up encrypted, and rotate exposed values deliberately.":
      "OAUTH_STATE_SIGNING_KEY firma las sesiones de acceso y el estado de OAuth u OIDC. INTEGRATIONS_TOKEN_KEY cifra los tokens almacenados de proveedores git. Las credenciales del proveedor y los tokens del forge pueden autorizar acciones externas. Mantén .env fuera de git, restringe su acceso, respáldalo cifrado y rota de forma deliberada los valores expuestos.",
    "Test both the login path and the bypass path": "Prueba tanto la ruta de acceso como la ruta de evasión",
    "Confirm a permitted identity can log in and a disallowed identity is rejected. Then try to reach backend and frontend ports outside the intended proxy path from another host. A working login page does not compensate for a direct unauthenticated route.":
      "Confirma que una identidad permitida pueda iniciar sesión y que una identidad no permitida sea rechazada. Después intenta acceder desde otro host a los puertos del backend y frontend fuera de la ruta prevista del proxy. Una página de acceso funcional no compensa una ruta directa sin autenticar.",
  },
  "upgrading-backplane": {
    "Upgrading the production Compose deployment means choosing a reviewed source revision, rebuilding backend and frontend from that checkout, and recreating the services. Those application services are not currently upgraded by pulling published Backplane image tags.":
      "Actualizar el despliegue de Compose de producción significa elegir una revisión de código examinada, recompilar el backend y el frontend desde ese checkout y recrear los servicios. Actualmente, esos servicios de la aplicación no se actualizan descargando tags de imágenes publicadas de Backplane.",
    "Take a complete backup before changing the checkout": "Haz un respaldo completo antes de cambiar el checkout",
    "Follow Backup and Restore for the Postgres dump, uploaded files or GCS bucket, and .env secrets. A database dump alone is not a complete rollback point.":
      "Sigue Respaldo y restauración para el dump de Postgres, los archivos subidos o el bucket de GCS y los secretos de .env. Un dump de la base de datos por sí solo no es un punto de reversión completo.",
    "Build the reviewed revision": "Compila la revisión examinada",
    "Start from a clean deployment checkout. Fetch the repository, inspect the target commit or release, and check out that exact revision. Do not use an unreviewed moving branch as a production version.":
      "Parte de un checkout de despliegue limpio. Obtén el repositorio, inspecciona el commit o release de destino y selecciona esa revisión exacta. No uses como versión de producción una rama móvil que no haya sido examinada.",
    "Rebuild and recreate": "Recompila y recrea",
    "backend/start-prod.sh runs python -m alembic upgrade head before gunicorn. It tries the migration up to five times with a five-second pause. A backend that never reaches Starting production server... has not completed the upgrade.":
      "backend/start-prod.sh ejecuta python -m alembic upgrade head antes de gunicorn. Intenta la migración hasta cinco veces, con una pausa de cinco segundos. Un backend que nunca llega a Starting production server... no ha completado la actualización.",
    "Compose recreation can interrupt requests": "La recreación con Compose puede interrumpir solicitudes",
    "This deployment is not documented as zero-downtime. Recreating the backend or frontend can cause a brief interruption, and a long migration can extend it. Schedule a maintenance window when downtime matters, especially for an old database or an untested migration gap.":
      "Este despliegue no está documentado como sin tiempo de inactividad. Recrear el backend o el frontend puede causar una interrupción breve, y una migración larga puede prolongarla. Programa una ventana de mantenimiento cuando el tiempo de inactividad importe, especialmente para una base de datos antigua o un salto de migraciones no probado.",
    "Alembic handles missing revisions in order": "Alembic aplica en orden las revisiones que faltan",
    "Alembic upgrades from the database's current revision to head through every missing migration. You do not need to boot every intervening application release. For a large version gap, rehearse the exact upgrade against a restored copy first so duration and data-dependent failures are known before production.":
      "Alembic actualiza desde la revisión actual de la base de datos hasta head aplicando cada migración pendiente. No necesitas iniciar todas las versiones intermedias de la aplicación. Ante un salto grande, ensaya primero la actualización exacta sobre una copia restaurada para conocer la duración y los fallos dependientes de los datos antes de producción.",
    "Verify the result": "Verifica el resultado",
    "Check services, readiness, and schema": "Comprueba servicios, disponibilidad y esquema",
    "Confirm the Alembic output marks the current revision as head. Then log in, open an existing board, reload it, and inspect backend logs for migration, startup, authentication, or WebSocket errors. If you operate a separately configured runner, verify it independently after the platform is healthy.":
      "Confirma que la salida de Alembic marque la revisión actual como head. Después inicia sesión, abre un tablero existente, recárgalo e inspecciona los logs del backend en busca de errores de migración, inicio, autenticación o WebSocket. Si operas un runner configurado por separado, verifícalo de forma independiente cuando la plataforma esté saludable.",
    "A forward migration is not undone by old source": "El código anterior no deshace una migración hacia delante",
    "Checking out an older commit does not reverse a schema migration and may start incompatible code against the newer schema. Recover by restoring the complete pre-upgrade backup into a controlled stack, or by applying a reviewed forward fix. Do not edit an applied migration or assume alembic downgrade is a safe production rollback.":
      "Seleccionar un commit anterior no revierte una migración del esquema y puede iniciar código incompatible contra el esquema más nuevo. Recupérate restaurando el respaldo completo previo a la actualización en un stack controlado o aplicando una corrección hacia delante examinada. No edites una migración aplicada ni supongas que alembic downgrade es una reversión segura en producción.",
    "Record the source SHA beside every backup": "Registra el SHA del código junto a cada respaldo",
    "Store the exact git commit, Compose project name, and backup timestamp together. A restore is reproducible only when the database, files, secrets, and source revision can be matched.":
      "Guarda juntos el commit exacto de git, el nombre del proyecto de Compose y la marca temporal del respaldo. Una restauración solo es reproducible cuando se pueden asociar la base de datos, los archivos, los secretos y la revisión del código.",
  },
  "backup-and-restore": {
    "A recoverable self-hosted backup includes the Postgres database, every uploaded resource, and the complete .env file. Record the source commit and Compose project name with those artifacts.":
      "Un respaldo recuperable de una instalación autoalojada incluye la base de datos Postgres, todos los recursos subidos y el archivo .env completo. Registra con esos artefactos el commit del código y el nombre del proyecto de Compose.",
    "Dump Postgres": "Crea un dump de Postgres",
    "Create a custom-format dump": "Crea un dump en formato personalizado",
    "The custom format is compressed and can be restored selectively. Running pg_dump against the live database is transactionally consistent; -T prevents a TTY from corrupting the binary stream.":
      "El formato personalizado está comprimido y permite una restauración selectiva. Ejecutar pg_dump contra la base de datos activa es transaccionalmente consistente; -T evita que una TTY corrompa el flujo binario.",
    "Back up the active resource store": "Respalda el almacenamiento de recursos activo",
    "When GCS_BUCKET is empty, uploads live in the backplane-storage named volume at /data/resources. Docker prefixes the volume with the Compose project name. Confirm the real name with docker volume ls before using it; do not copy the example prefix blindly.":
      "Cuando GCS_BUCKET está vacío, los archivos subidos residen en el volumen con nombre backplane-storage, en /data/resources. Docker antepone al volumen el nombre del proyecto de Compose. Confirma el nombre real con docker volume ls antes de usarlo; no copies a ciegas el prefijo del ejemplo.",
    "Archive local uploaded resources": "Archiva los recursos locales subidos",
    "GCS deployments need a bucket backup instead": "Los despliegues con GCS necesitan un respaldo del bucket",
    "When GCS_BUCKET is set, the bucket is the authoritative upload store; archiving the local named volume does not protect those objects. Use your cloud provider's versioning or backup procedure and verify that the bucket recovery point matches the database dump.":
      "Cuando GCS_BUCKET está definido, el bucket es el almacenamiento autoritativo de los archivos subidos; archivar el volumen local no protege esos objetos. Usa el versionado o procedimiento de respaldo de tu proveedor cloud y verifica que el punto de recuperación del bucket coincida con el dump de la base de datos.",
    "Protect .env as a credential backup": "Protege .env como un respaldo de credenciales",
    "Store .env in an encrypted secrets system away from the deployment disk. It contains database credentials, OAUTH_STATE_SIGNING_KEY, INTEGRATIONS_TOKEN_KEY, and any configured provider secrets.":
      "Guarda .env en un sistema de secretos cifrado y separado del disco del despliegue. Contiene credenciales de la base de datos, OAUTH_STATE_SIGNING_KEY, INTEGRATIONS_TOKEN_KEY y los secretos de proveedores que hayas configurado.",
    "Lost encryption and signing keys cannot be reconstructed": "Las claves de cifrado y firma perdidas no se pueden reconstruir",
    "INTEGRATIONS_TOKEN_KEY decrypts stored git-connection OAuth tokens; without it those database values are unusable. Changing OAUTH_STATE_SIGNING_KEY invalidates signed login sessions and OAuth or OIDC state. Restore the original keys deliberately instead of generating replacements during recovery.":
      "INTEGRATIONS_TOKEN_KEY descifra los tokens OAuth almacenados de conexiones git; sin ella, esos valores de la base de datos son inutilizables. Cambiar OAUTH_STATE_SIGNING_KEY invalida las sesiones de acceso firmadas y el estado de OAuth u OIDC. Restaura deliberadamente las claves originales en lugar de generar reemplazos durante la recuperación.",
    "Restore into a controlled stack": "Restaura en un stack controlado",
    "Put the backed-up .env and the intended source revision in place first. Keep backend and frontend stopped while replacing the database and files. The example below assumes local volume storage.":
      "Coloca primero el .env respaldado y la revisión de código prevista. Mantén detenidos el backend y el frontend mientras reemplazas la base de datos y los archivos. El ejemplo siguiente supone almacenamiento en un volumen local.",
    "Restore database and local resources": "Restaura la base de datos y los recursos locales",
    "Newer source automatically upgrades an older dump": "El código más nuevo actualiza automáticamente un dump anterior",
    "If you intentionally start a newer checkout, backend startup applies every missing Alembic revision before serving requests. To inspect the old schema unchanged, use the recorded source commit in an isolated environment and do not start a newer backend against it.":
      "Si inicias intencionalmente un checkout más nuevo, el backend aplica durante el inicio todas las revisiones pendientes de Alembic antes de servir solicitudes. Para inspeccionar el esquema antiguo sin modificarlo, usa el commit registrado en un entorno aislado y no inicies contra él un backend más nuevo.",
    "Test recovery regularly": "Prueba la recuperación con regularidad",
    "Restore into a separate Compose project and port. Verify readiness, login, an existing board and card, and at least one uploaded resource. For GCS, verify an object restored from the matching bucket recovery point. A backup is not proven until this drill succeeds.":
      "Restaura en un proyecto de Compose y un puerto separados. Verifica la disponibilidad, el acceso, un tablero y una tarjeta existentes y al menos un recurso subido. Para GCS, verifica un objeto restaurado desde el punto de recuperación correspondiente del bucket. Un respaldo no está probado hasta que este ejercicio funcione.",
    "Verify artifacts, retention, and source identity": "Verifica los artefactos, la retención y la identidad del código",
    "Automate size and checksum checks, retain more than one recovery point, and record git rev-parse HEAD. A fresh zero-byte dump or an unlabeled archive is not a usable backup.":
      "Automatiza las comprobaciones de tamaño y checksum, conserva más de un punto de recuperación y registra git rev-parse HEAD. Un dump reciente de cero bytes o un archivo sin identificar no es un respaldo utilizable.",
  },
} as const;
