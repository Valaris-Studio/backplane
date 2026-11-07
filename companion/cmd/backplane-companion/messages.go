// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/hook"
	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

var (
	errUsage             = errors.New("usage")
	errNotConnected      = errors.New("not_connected")
	errAlreadyConnected  = errors.New("already_connected")
	errAPIKeyMissing     = errors.New("api_key_missing")
	errDaemonRunning     = errors.New("daemon_running")
	errNotARepository    = errors.New("not_a_repository")
	errNotADirectory     = errors.New("not_a_directory")
	errNoMatchingBoard   = errors.New("no_matching_board")
	errAmbiguousRepo     = errors.New("ambiguous_repo")
	errAutoMatchDisabled = errors.New("auto_match_disabled")
	errPairingDenied     = errors.New("pairing_denied")
	errPairingExpired    = errors.New("pairing_expired")
	errPairingFailed     = errors.New("pairing_failed")
	errPairingSuperseded = errors.New("pairing_superseded")
	// errSwitchInProgress: an approved switch is storing its connection.
	errSwitchInProgress = errors.New("pairing_persisting")
	errHomeOrRoot       = errors.New("home_or_root")
	errTempDir          = errors.New("temp_dir")
	errIgnoredPath      = errors.New("ignored_path")
	errExcludedPath     = errors.New("excluded_path")
	errAlreadyMapped    = errors.New("already_mapped")
	errTooManyProjects  = errors.New("too_many_projects")
)

// Headless (operator-managed) refusals and the reasons a headless daemon
// holds capture.
var (
	errCredentialSourceConflict  = errors.New("credential_source_conflict")
	errHeadlessOperatorManaged   = errors.New("headless_operator_managed")
	errHeadlessConfigInvalid     = errors.New("headless_config_invalid")
	errCredentialRejected        = errors.New("credential_rejected")
	errUpstreamUnauthorized      = errors.New("upstream_unauthorized")
	errUpstreamForbidden         = errors.New("upstream_forbidden")
	errCompanionUnavailable      = errors.New("companion_unavailable")
	errEndpointRedirected        = errors.New("endpoint_redirected")
	errIdentityMismatch          = errors.New("identity_mismatch")
	errUnboundState              = errors.New("unbound_state")
	errSwitchBlocked             = errors.New("switch_blocked")
	errTokenNotReplacedForSwitch = errors.New("token_not_replaced_for_switch")
	errTokenFileInDataRoot       = errors.New("token_file_in_data_root")
)

// errorCodes maps typed errors to stable codes. Order matters: the first
// match wins, so specific errors come before general ones.
var errorCodes = []struct {
	err  error
	code string
}{
	// Headless reasons wrap the uplink error they classify, so they come
	// before it.
	{errCredentialSourceConflict, "credential_source_conflict"},
	{errHeadlessOperatorManaged, "headless_operator_managed"},
	{errHeadlessConfigInvalid, "headless_config_invalid"},
	{errCredentialRejected, "credential_rejected"},
	{errUpstreamUnauthorized, "upstream_unauthorized"},
	{errUpstreamForbidden, "upstream_forbidden"},
	{errCompanionUnavailable, "companion_unavailable"},
	{errEndpointRedirected, "endpoint_redirected"},
	{errIdentityMismatch, "identity_mismatch"},
	{errUnboundState, "unbound_state"},
	{errSwitchBlocked, "switch_blocked"},
	{errTokenNotReplacedForSwitch, "token_not_replaced_for_switch"},
	{errTokenFileInDataRoot, "token_file_in_data_root"},
	{binding.ErrSwitchInProgress, "switch_in_progress"},
	{binding.ErrRecordInvalid, "binding_record_invalid"},
	{credentials.ErrCredentialMissing, "credential_missing"},
	{credentials.ErrCredentialUnsafe, "credential_unsafe"},
	{credentials.ErrCredentialMalformed, "credential_malformed"},
	{credentials.ErrCredentialUnreadable, "credential_unreadable"},
	{errUsage, "usage"},
	{errNotConnected, "not_connected"},
	{errAlreadyConnected, "already_connected"},
	{control.ErrAlreadyConnected, "already_connected"},
	{errSwitchInProgress, "pairing_persisting"},
	{control.ErrUnsafeDirectory, "unsafe_control_directory"},
	{control.ErrSocketInUse, "control_socket_in_use"},
	{hook.ErrUnsafeDirectory, "unsafe_hook_directory"},
	{hook.ErrSocketSubstituted, "hook_socket_substituted"},
	{hook.ErrSocketInUse, "hook_socket_in_use"},
	{hook.ErrSocketPathTooLong, "hook_socket_path_too_long"},
	{errAPIKeyMissing, "api_key_missing"},
	{errDaemonRunning, "daemon_running"},
	{service.ErrDaemonStillRunning, "daemon_running"},
	{errNotARepository, "not_a_repository"},
	{errNotADirectory, "not_a_directory"},
	{errHomeOrRoot, "home_or_root"},
	{errTempDir, "temp_dir"},
	{errIgnoredPath, "ignored_path"},
	{errExcludedPath, "excluded_path"},
	{errAlreadyMapped, "already_mapped"},
	{errTooManyProjects, "too_many_projects"},
	{errNoMatchingBoard, "no_matching_board"},
	{errAmbiguousRepo, "ambiguous_repo"},
	{errAutoMatchDisabled, "auto_match_disabled"},
	{errPairingDenied, "pairing_denied"},
	{errPairingExpired, "pairing_expired"},
	{errPairingSuperseded, "pairing_superseded"},
	{errPairingFailed, "pairing_failed"},
	{daemon.ErrAlreadyRunning, "daemon_already_running"},
	{daemon.ErrRevoked, "device_revoked"},
	{errOTelCollectorUnavailable, "otel_collector_unavailable"},
	{credentials.ErrUnavailable, "secure_credential_store_unavailable"},
	{credentials.ErrDevStoreUnavailable, "dev_credential_store_not_built"},
	{credentials.ErrUnknownStore, "unknown_credential_store"},
	{beacon.ErrUnverified, "beacon_artifact_unverified"},
	{uplink.ErrDeviceRevoked, "device_revoked"},
	{uplink.ErrUnauthorized, "unauthorized"},
	{uplink.ErrForbidden, "forbidden"},
	{uplink.ErrUnavailable, "server_unavailable"},
	{uplink.ErrInsecureEndpoint, "insecure_endpoint"},
	{uplink.ErrInvalidToken, "invalid_token"},
	{uplink.ErrInvalidResponse, "invalid_server_response"},
	{agent.ErrUnknownAgent, "unknown_agent"},
	{agent.ErrConfigSymlink, "agent_config_symlink"},
	{agent.ErrConfigInvalid, "agent_config_invalid"},
	{agent.ErrConfigChanged, "agent_config_changed"},
	{agent.ErrConfigForeign, "agent_config_not_owned"},
	{store.ErrUnsafePath, "unsafe_storage_path"},
	{service.ErrUnsupportedPlatform, "service_unsupported_platform"},
	{service.ErrUnsupportedPath, "service_unsupported_path"},
	{service.ErrForeignDefinition, "service_definition_not_owned"},
	{service.ErrNotInstalled, "service_not_installed"},
}

func errorCode(err error) string {
	for _, known := range errorCodes {
		if errors.Is(err, known.err) {
			return known.code
		}
	}
	return "internal_error"
}

// messages are keyed by code: English, Spanish, Brazilian Portuguese.
var messages = map[string][3]string{
	"usage": {
		"Invalid command or arguments.",
		"Comando o argumentos no válidos.",
		"Comando ou argumentos inválidos.",
	},
	"not_connected": {
		"This device is not connected. Run: backplane-companion connect --endpoint URL",
		"Este dispositivo no está conectado. Ejecuta: backplane-companion connect --endpoint URL",
		"Este dispositivo não está conectado. Execute: backplane-companion connect --endpoint URL",
	},
	"pairing_denied": {
		"The pairing request was denied in Backplane. Nothing was connected.",
		"La solicitud de vinculación se rechazó en Backplane. No se conectó nada.",
		"A solicitação de pareamento foi recusada no Backplane. Nada foi conectado.",
	},
	"pairing_expired": {
		"The pairing code expired before it was approved. Run connect --browser again for a new code.",
		"El código de vinculación caducó antes de aprobarse. Vuelve a ejecutar connect --browser para obtener uno nuevo.",
		"O código de pareamento expirou antes de ser aprovado. Execute connect --browser novamente para obter um novo.",
	},
	"pairing_failed": {
		"Pairing could not be completed. Nothing was connected; try again.",
		"No se pudo completar la vinculación. No se conectó nada; inténtalo de nuevo.",
		"Não foi possível concluir o pareamento. Nada foi conectado; tente novamente.",
	},
	"pairing_superseded": {
		"Another pairing connected this device first. This one was revoked; nothing changed.",
		"Otra vinculación conectó este dispositivo primero. Esta se revocó; no cambió nada.",
		"Outro pareamento conectou este dispositivo primeiro. Este foi revogado; nada mudou.",
	},
	"pairing_persisting": {
		"A server switch was approved and is finishing. Wait a few seconds, then try again.",
		"Se aprobó un cambio de servidor y está terminando. Espera unos segundos y vuelve a intentarlo.",
		"Uma troca de servidor foi aprovada e está terminando. Aguarde alguns segundos e tente novamente.",
	},
	"already_connected": {
		"This device is already connected. To switch servers, run connect again with --replace; or disconnect first.",
		"Este dispositivo ya está conectado. Para cambiar de servidor, vuelve a ejecutar connect con --replace; o desconéctalo primero.",
		"Este dispositivo já está conectado. Para trocar de servidor, execute connect novamente com --replace; ou desconecte primeiro.",
	},
	"api_key_missing": {
		"Set BACKPLANE_API_KEY or run connect in an interactive terminal.",
		"Define BACKPLANE_API_KEY o ejecuta connect en una terminal interactiva.",
		"Defina BACKPLANE_API_KEY ou execute connect em um terminal interativo.",
	},
	"api_key_prompt": {
		"Backplane API key: ",
		"Clave de API de Backplane: ",
		"Chave de API do Backplane: ",
	},
	"daemon_running": {
		"The running companion did not end its capture session in time. Run: backplane-companion service stop, then run this command again.",
		"El companion en ejecución no terminó su sesión de captura a tiempo. Ejecuta: backplane-companion service stop y vuelve a ejecutar este comando.",
		"O companion em execução não encerrou a sessão de captura a tempo. Execute: backplane-companion service stop e execute este comando novamente.",
	},
	"device_revoked": {
		"Backplane revoked this device's credential and capture is stopped. Run connect to reconnect; queued data is uploaded only if the same installation is restored, and deleted otherwise.",
		"Backplane revocó la credencial de este dispositivo y la captura está detenida. Ejecuta connect para reconectar; los datos en cola solo se suben si se restaura la misma instalación y, si no, se eliminan.",
		"O Backplane revogou a credencial deste dispositivo e a captura está parada. Execute connect para reconectar; os dados na fila só são enviados se a mesma instalação for restaurada e, caso contrário, são excluídos.",
	},
	"daemon_already_running": {
		"Another companion is already running for this user.",
		"Ya hay otro companion en ejecución para este usuario.",
		"Já existe outro companion em execução para este usuário.",
	},
	"not_a_repository": {
		"That directory is not a git repository with an origin remote.",
		"Ese directorio no es un repositorio git con un remoto origin.",
		"Esse diretório não é um repositório git com um remoto origin.",
	},
	"not_a_directory": {
		"That path is not an existing directory.",
		"Esa ruta no es un directorio existente.",
		"Esse caminho não é um diretório existente.",
	},
	"home_or_root": {
		"Your home folder and the disk root are never projects. Choose the project's own folder.",
		"Tu carpeta personal y la raíz del disco nunca son proyectos. Elige la carpeta del proyecto.",
		"Sua pasta pessoal e a raiz do disco nunca são projetos. Escolha a pasta do próprio projeto.",
	},
	"temp_dir": {
		"Temporary folders are never captured.",
		"Las carpetas temporales nunca se capturan.",
		"Pastas temporárias nunca são capturadas.",
	},
	"ignored_path": {
		"That folder is ignored on this device. Stop ignoring it first.",
		"Esa carpeta está ignorada en este dispositivo. Deja de ignorarla primero.",
		"Essa pasta está ignorada neste dispositivo. Pare de ignorá-la primeiro.",
	},
	"excluded_path": {
		"That folder matches one of your never-capture rules.",
		"Esa carpeta coincide con una de tus reglas de no capturar nunca.",
		"Essa pasta corresponde a uma das suas regras de nunca capturar.",
	},
	"already_mapped": {
		"That folder is already bound to a board.",
		"Esa carpeta ya está vinculada a un tablero.",
		"Essa pasta já está vinculada a um quadro.",
	},
	"too_many_projects": {
		"Too many folders are waiting to be bound. Bind or ignore some first.",
		"Hay demasiadas carpetas esperando vinculación. Vincula o ignora algunas primero.",
		"Há pastas demais aguardando vinculação. Vincule ou ignore algumas primeiro.",
	},
	"no_matching_board": {
		"No Backplane board you can access is bound to this repository.",
		"Ningún tablero de Backplane al que tengas acceso está vinculado a este repositorio.",
		"Nenhum quadro do Backplane ao qual você tem acesso está vinculado a este repositório.",
	},
	"ambiguous_repo": {
		"This repository is bound to boards in several workspaces; map it from Backplane instead.",
		"Este repositorio está vinculado a tableros de varios espacios de trabajo; mapéalo desde Backplane.",
		"Este repositório está vinculado a quadros de vários espaços de trabalho; mapeie-o pelo Backplane.",
	},
	"auto_match_disabled": {
		"Automatic repository matching is turned off for this device in Backplane.",
		"La coincidencia automática de repositorios está desactivada para este dispositivo en Backplane.",
		"A correspondência automática de repositórios está desativada para este dispositivo no Backplane.",
	},
	"dev_credential_store_not_built": {
		"BACKPLANE_COMPANION_KEYRING=file-insecure-dev is only for development builds; this build uses the system keyring.",
		"BACKPLANE_COMPANION_KEYRING=file-insecure-dev es solo para compilaciones de desarrollo; esta compilación usa el llavero del sistema.",
		"BACKPLANE_COMPANION_KEYRING=file-insecure-dev é apenas para builds de desenvolvimento; este build usa o chaveiro do sistema.",
	},
	"unknown_credential_store": {
		"Unknown BACKPLANE_COMPANION_KEYRING value; unset it to use the system keyring.",
		"Valor de BACKPLANE_COMPANION_KEYRING desconocido; elimínalo para usar el llavero del sistema.",
		"Valor de BACKPLANE_COMPANION_KEYRING desconhecido; remova-o para usar o chaveiro do sistema.",
	},
	"secure_credential_store_unavailable": {
		"The OS credential store (Keychain, Credential Manager or Secret Service) is locked or unavailable, as it usually is in SSH and other non-desktop sessions. Run this from a desktop session. No device credential was stored.",
		"El almacén de credenciales del sistema (Llavero, Administrador de credenciales o Secret Service) está bloqueado o no disponible, como suele ocurrir en sesiones SSH u otras sin escritorio. Ejecútalo desde una sesión de escritorio. No se guardó ninguna credencial del dispositivo.",
		"O armazenamento de credenciais do sistema (Chaves, Gerenciador de Credenciais ou Secret Service) está bloqueado ou indisponível, como costuma ocorrer em sessões SSH e outras sem área de trabalho. Execute a partir de uma sessão de área de trabalho. Nenhuma credencial do dispositivo foi armazenada.",
	},
	"beacon_artifact_unverified": {
		"The bundled Beacon executable failed verification. Reinstall the companion.",
		"El ejecutable de Beacon incluido no superó la verificación. Reinstala el companion.",
		"O executável do Beacon incluído falhou na verificação. Reinstale o companion.",
	},
	"unauthorized": {
		"Backplane rejected the credential. Queued captures are kept; reconnect this device.",
		"Backplane rechazó la credencial. Las capturas en cola se conservan; vuelve a conectar este dispositivo.",
		"O Backplane rejeitou a credencial. As capturas na fila são mantidas; reconecte este dispositivo.",
	},
	"forbidden": {
		"Backplane refused this request for your account.",
		"Backplane rechazó esta solicitud para tu cuenta.",
		"O Backplane recusou esta solicitação para sua conta.",
	},
	"server_unavailable": {
		"Backplane could not be reached. Try again later.",
		"No se pudo contactar con Backplane. Inténtalo más tarde.",
		"Não foi possível contatar o Backplane. Tente novamente mais tarde.",
	},
	"insecure_endpoint": {
		"The endpoint must use HTTPS.",
		"El endpoint debe usar HTTPS.",
		"O endpoint deve usar HTTPS.",
	},
	"invalid_token": {
		"The API key or device token has an unexpected format.",
		"La clave de API o el token del dispositivo tiene un formato inesperado.",
		"A chave de API ou o token do dispositivo tem um formato inesperado.",
	},
	"invalid_server_response": {
		"Backplane returned a response this companion cannot use. Update the companion.",
		"Backplane devolvió una respuesta que este companion no puede usar. Actualiza el companion.",
		"O Backplane retornou uma resposta que este companion não consegue usar. Atualize o companion.",
	},
	"unknown_agent": {
		"Unknown agent. Run: backplane-companion agents list",
		"Agente desconocido. Ejecuta: backplane-companion agents list",
		"Agente desconhecido. Execute: backplane-companion agents list",
	},
	"agent_config_symlink": {
		"The agent settings file is a symlink; it was left unchanged.",
		"El archivo de configuración del agente es un enlace simbólico; no se modificó.",
		"O arquivo de configuração do agente é um link simbólico; ele não foi alterado.",
	},
	"agent_config_invalid": {
		"The agent settings file is not one the agent can load; it was left unchanged.",
		"El archivo de configuración del agente no es uno que el agente pueda cargar; no se modificó.",
		"O arquivo de configuração do agente não é um que o agente consiga carregar; ele não foi alterado.",
	},
	"agent_config_changed": {
		"The agent changed its settings while they were being updated; nothing was written. Try again.",
		"El agente cambió su configuración mientras se actualizaba; no se escribió nada. Inténtalo de nuevo.",
		"O agente alterou sua configuração durante a atualização; nada foi gravado. Tente novamente.",
	},
	"agent_config_not_owned": {
		"A file at the companion's path was not written by the companion; it was left unchanged.",
		"Un archivo en la ruta del companion no fue escrito por él; no se modificó.",
		"Um arquivo no caminho do companion não foi gravado por ele; ele não foi alterado.",
	},
	"unsafe_storage_path": {
		"The companion data directory is unsafe (symlink or shared permissions).",
		"El directorio de datos del companion no es seguro (enlace simbólico o permisos compartidos).",
		"O diretório de dados do companion não é seguro (link simbólico ou permissões compartilhadas).",
	},
	"service_unsupported_platform": {
		"Running as a background service is not supported on this platform.",
		"La ejecución como servicio en segundo plano no es compatible con esta plataforma.",
		"A execução como serviço em segundo plano não é compatível com esta plataforma.",
	},
	"service_unsupported_path": {
		"The companion or data directory path cannot be used in a service definition.",
		"La ruta del companion o del directorio de datos no se puede usar en una definición de servicio.",
		"O caminho do companion ou do diretório de dados não pode ser usado em uma definição de serviço.",
	},
	"service_definition_not_owned": {
		"A service definition with the companion's name exists but was not created by it; it was left unchanged.",
		"Existe una definición de servicio con el nombre del companion que no creó él; no se modificó.",
		"Existe uma definição de serviço com o nome do companion que não foi criada por ele; ela não foi alterada.",
	},
	"service_not_installed": {
		"The background service is not installed. Run: backplane-companion service install",
		"El servicio en segundo plano no está instalado. Ejecuta: backplane-companion service install",
		"O serviço em segundo plano não está instalado. Execute: backplane-companion service install",
	},
	"status_title":                 {"Backplane companion", "Backplane companion", "Backplane companion"},
	"status_connection":            {"Connection:", "Conexión:", "Conexão:"},
	"status_connected":             {"connected", "conectado", "conectado"},
	"status_not_connected":         {"not connected", "no conectado", "não conectado"},
	"status_revoked":               {"revoked by the server — run connect to reconnect", "revocado por el servidor — ejecuta connect para reconectar", "revogado pelo servidor — execute connect para reconectar"},
	"status_service":               {"Service:", "Servicio:", "Serviço:"},
	"status_service_running":       {"running", "en ejecución", "em execução"},
	"status_service_stopped":       {"installed, not running", "instalado, detenido", "instalado, parado"},
	"status_service_not_installed": {"not installed", "no instalado", "não instalado"},
	"status_capture":               {"Capture:", "Captura:", "Captura:"},
	"status_version":               {"Version:", "Versión:", "Versão:"},
	"status_retention":             {"Retention:", "Retención:", "Retenção:"},
	"status_retention_days":        {"%d days on the server", "%d días en el servidor", "%d dias no servidor"},
	"status_retention_forever":     {"kept until deleted", "se conservan hasta borrarlas", "mantidas até serem excluídas"},
	"status_daemon_version":        {"running daemon", "daemon en ejecución", "daemon em execução"},
	"status_agents":                {"Agents:", "Agentes:", "Agentes:"},
	"status_last_observation":      {"last observation", "última observación", "última observação"},
	"status_last_upload":           {"last upload", "última subida", "último envio"},
	"status_queue":                 {"Queue:", "Cola:", "Fila:"},
	"status_queue_summary":         {"%d queued, %d in inbox, %d rejected", "%d en cola, %d en la bandeja, %d rechazados", "%d na fila, %d na caixa de entrada, %d rejeitados"},
	"status_retrying_after":        {"retrying after", "reintento después de", "nova tentativa após"},
	"status_pending_projects": {
		"%d project(s) waiting for a decision: backplane-companion projects list",
		"%d proyecto(s) esperan una decisión: backplane-companion projects list",
		"%d projeto(s) aguardando uma decisão: backplane-companion projects list",
	},
	"codex_trust_instructions": {
		"Codex runs the companion's hooks only after you trust them. Start Codex in a terminal and, at \"Hooks need review\", choose \"Trust all and continue\" (or \"Review hooks\" to trust just the Backplane companion hooks); /hooks inside Codex works too. Codex Desktop reads the same configuration. Until then, Codex sessions are not captured.",
		"Codex solo ejecuta los hooks del companion después de que confíes en ellos. Inicia Codex en una terminal y, en \"Hooks need review\", elige \"Trust all and continue\" (o \"Review hooks\" para confiar solo en los hooks del companion de Backplane); también puedes usar /hooks dentro de Codex. Codex Desktop lee la misma configuración. Hasta entonces, las sesiones de Codex no se capturan.",
		"O Codex só executa os hooks do companion depois que você confiar neles. Inicie o Codex em um terminal e, em \"Hooks need review\", escolha \"Trust all and continue\" (ou \"Review hooks\" para confiar apenas nos hooks do companion do Backplane); /hooks dentro do Codex também funciona. O Codex Desktop lê a mesma configuração. Até lá, as sessões do Codex não são capturadas.",
	},
	// %s is the rejected file.
	"invalid_config": {
		"The agent rejects its own configuration file %s, so it runs none of the hooks in it, the companion's included. The companion left it unchanged; fix the file, then run agents install again.",
		"El agente rechaza su propio archivo de configuración %s, así que no ejecuta ninguno de sus hooks, incluidos los del companion. El companion no lo modificó; corrige el archivo y vuelve a ejecutar agents install.",
		"O agente rejeita o próprio arquivo de configuração %s, então não executa nenhum dos hooks nele, incluindo os do companion. O companion não o alterou; corrija o arquivo e execute agents install novamente.",
	},
	"conflict_existing_otel": {
		"Companion cannot confirm that it manages the OpenTelemetry settings in Codex's config.toml. It left those settings unchanged. Review them before making changes.",
		"Companion no puede confirmar que gestione la configuración de OpenTelemetry en config.toml de Codex. La dejó sin cambios. Revísala antes de modificarla.",
		"Companion não pode confirmar que gerencia as configurações de OpenTelemetry no config.toml do Codex. Elas foram mantidas sem alterações. Revise-as antes de modificá-las.",
	},
	"conflict_restart_required": {
		"Codex also needs to reload its settings. When convenient, quit and reopen Codex. This does not confirm that Companion manages the OpenTelemetry settings.",
		"Codex también necesita recargar su configuración. Cuando te convenga, cierra y vuelve a abrir Codex. Esto no confirma que Companion gestione la configuración de OpenTelemetry.",
		"O Codex também precisa recarregar suas configurações. Quando for conveniente, feche e reabra o Codex. Isso não confirma que o Companion gerencia as configurações de OpenTelemetry.",
	},
	"conflict_daemon_restart_required": {
		"Codex's background app server also needs to reload its settings. When convenient, run: codex app-server daemon restart. This does not confirm that Companion manages the OpenTelemetry settings.",
		"El servidor en segundo plano de Codex también necesita recargar su configuración. Cuando te convenga, ejecuta: codex app-server daemon restart. Esto no confirma que Companion gestione la configuración de OpenTelemetry.",
		"O servidor em segundo plano do Codex também precisa recarregar suas configurações. Quando for conveniente, execute: codex app-server daemon restart. Isso não confirma que o Companion gerencia as configurações de OpenTelemetry.",
	},
	"restart_required": {
		"Restart the Codex app to start capturing its sessions: it was already open when capture was set up and reads its settings only when it starts. Quit Codex (⌘Q), then open it again.",
		"Reinicia la app de Codex para empezar a capturar sus sesiones: ya estaba abierta cuando se configuró la captura y solo lee su configuración al iniciar. Cierra Codex (⌘Q) y vuelve a abrirlo.",
		"Reinicie o app do Codex para começar a capturar as sessões dele: ele já estava aberto quando a captura foi configurada e só lê as configurações ao iniciar. Feche o Codex (⌘Q) e abra-o de novo.",
	},
	"daemon_restart_required": {
		"Restart Codex's background app server to start capturing its sessions: it was already running when capture was set up and reads its settings only when it starts. In a terminal, run: codex app-server daemon restart",
		"Reinicia el servidor en segundo plano de Codex para empezar a capturar sus sesiones: ya se estaba ejecutando cuando se configuró la captura y solo lee su configuración al iniciar. En una terminal, ejecuta: codex app-server daemon restart",
		"Reinicie o servidor em segundo plano do Codex para começar a capturar as sessões dele: ele já estava em execução quando a captura foi configurada e só lê as configurações ao iniciar. Em um terminal, execute: codex app-server daemon restart",
	},
	"otel_collector_unavailable": {
		"The bundled telemetry collector is missing or failed verification; Codex sessions are not captured until it is reinstalled. Other agents are unaffected.",
		"El colector de telemetría incluido falta o no superó la verificación; las sesiones de Codex no se capturan hasta reinstalarlo. Los demás agentes no se ven afectados.",
		"O coletor de telemetria incluído está ausente ou falhou na verificação; as sessões do Codex não são capturadas até que seja reinstalado. Os demais agentes não são afetados.",
	},
	"policy_stale": {
		"Backplane has not been reached for over a day, so capture is paused until the policy refreshes. Check the network connection.",
		"No se contacta con Backplane desde hace más de un día, así que la captura está en pausa hasta que se actualice la política. Revisa la conexión de red.",
		"O Backplane não é contatado há mais de um dia, então a captura está pausada até a política ser atualizada. Verifique a conexão de rede.",
	},
	"agent_broken": {
		"The agent's companion hooks are missing or point elsewhere, so its sessions are not captured. Run agents install for this agent.",
		"Los hooks del companion en el agente faltan o apuntan a otro lugar, así que sus sesiones no se capturan. Ejecuta agents install para este agente.",
		"Os hooks do companion no agente estão ausentes ou apontam para outro lugar, então suas sessões não são capturadas. Execute agents install para este agente.",
	},
	"unsafe_hook_directory": {
		"The hook socket's directory was refused. It must be an existing directory owned by this user, writable by no one else and not a symlink, holding nothing but the hook socket.",
		"Se rechazó el directorio del socket de hooks. Debe ser un directorio existente cuyo dueño sea este usuario, que nadie más pueda modificar, que no sea un enlace simbólico y que solo contenga el socket de hooks.",
		"O diretório do socket de hooks foi recusado. Ele deve ser um diretório existente cujo dono seja este usuário, que ninguém mais possa alterar, que não seja um link simbólico e que contenha apenas o socket de hooks.",
	},
	"hook_socket_substituted": {
		"Something replaced the hook socket right after it was created. The daemon stopped serving it; check who can write its directory.",
		"Algo reemplazó el socket de hooks justo después de crearlo. El daemon dejó de servirlo; revisa quién puede escribir en su directorio.",
		"Algo substituiu o socket de hooks logo depois de ele ser criado. O daemon parou de servi-lo; verifique quem pode escrever no diretório dele.",
	},
	"hook_socket_in_use": {
		"Another process is serving the hook socket path. Stop it, or point hook_socket elsewhere.",
		"Otro proceso está sirviendo la ruta del socket de hooks. Deténlo o apunta hook_socket a otra ruta.",
		"Outro processo está servindo o caminho do socket de hooks. Pare-o ou aponte hook_socket para outro caminho.",
	},
	"hook_socket_path_too_long": {
		"The hook socket path is too long for a Unix socket. Choose a shorter hook_socket path.",
		"La ruta del socket de hooks es demasiado larga para un socket Unix. Elige una ruta hook_socket más corta.",
		"O caminho do socket de hooks é longo demais para um socket Unix. Escolha um caminho hook_socket mais curto.",
	},
	"unsafe_control_directory": {
		"The local control socket was not started: the companion data directory is accessible to other users or holds something unexpected at control.sock. The companion keeps capturing.",
		"No se inició el socket de control local: el directorio de datos del companion es accesible para otros usuarios o contiene algo inesperado en control.sock. El companion sigue capturando.",
		"O socket de controle local não foi iniciado: o diretório de dados do companion está acessível a outros usuários ou contém algo inesperado em control.sock. O companion continua capturando.",
	},
	"control_socket_in_use": {
		"Another process is serving the companion's local control socket; this daemon runs without it.",
		"Otro proceso está sirviendo el socket de control local del companion; este daemon funciona sin él.",
		"Outro processo está servindo o socket de controle local do companion; este daemon funciona sem ele.",
	},
	"credential_source_conflict": {
		"Headless mode reads its device token only from the operator's token file. Unset BACKPLANE_COMPANION_KEYRING to run it.",
		"El modo headless lee su token de dispositivo solo del archivo de token del operador. Quita BACKPLANE_COMPANION_KEYRING para ejecutarlo.",
		"O modo headless lê o token do dispositivo somente do arquivo de token do operador. Remova BACKPLANE_COMPANION_KEYRING para executá-lo.",
	},
	"headless_operator_managed": {
		"This data directory is operator-managed (headless): its connection comes from the operator's config file, so this is not available here.",
		"Este directorio de datos lo gestiona el operador (headless): su conexión viene del archivo de configuración del operador, así que esto no está disponible aquí.",
		"Este diretório de dados é gerenciado pelo operador (headless): a conexão vem do arquivo de configuração do operador, então isto não está disponível aqui.",
	},
	"headless_config_invalid": {
		"The headless config was refused. It must be an absolute path to a regular file owned by root or this user, writable by no one else, in a directory under the same rules, with only known fields and valid values.",
		"Se rechazó la configuración headless. Debe ser una ruta absoluta a un archivo normal cuyo dueño sea root o este usuario, que nadie más pueda modificar, en un directorio con las mismas reglas, solo con campos conocidos y valores válidos.",
		"A configuração headless foi recusada. Ela deve ser um caminho absoluto para um arquivo comum cujo dono seja root ou este usuário, que ninguém mais possa alterar, em um diretório com as mesmas regras, apenas com campos conhecidos e valores válidos.",
	},
	"credential_missing": {
		"The operator's device token file is missing. Capture and uploads wait until it is back; the queue is kept.",
		"Falta el archivo de token de dispositivo del operador. La captura y los envíos esperan a que vuelva; la cola se conserva.",
		"O arquivo de token do dispositivo do operador está ausente. A captura e os envios aguardam até que ele volte; a fila é mantida.",
	},
	"credential_unsafe": {
		"The operator's device token file is not safe to use (its owner, mode, links or directories). Capture and uploads wait until it is fixed; the queue is kept.",
		"El archivo de token de dispositivo del operador no es seguro (su dueño, permisos, enlaces o directorios). La captura y los envíos esperan a que se corrija; la cola se conserva.",
		"O arquivo de token do dispositivo do operador não é seguro (dono, permissões, links ou diretórios). A captura e os envios aguardam até que seja corrigido; a fila é mantida.",
	},
	"credential_malformed": {
		"The operator's device token file does not hold exactly one device token. Capture and uploads wait until it does; the queue is kept.",
		"El archivo de token de dispositivo del operador no contiene exactamente un token de dispositivo. La captura y los envíos esperan a que lo contenga; la cola se conserva.",
		"O arquivo de token do dispositivo do operador não contém exatamente um token de dispositivo. A captura e os envios aguardam até que contenha; a fila é mantida.",
	},
	"credential_unreadable": {
		"The operator's device token file cannot be read. Capture and uploads wait until it can; the queue is kept.",
		"No se puede leer el archivo de token de dispositivo del operador. La captura y los envíos esperan a que se pueda; la cola se conserva.",
		"Não é possível ler o arquivo de token do dispositivo do operador. A captura e os envios aguardam até que seja possível; a fila é mantida.",
	},
	"credential_rejected": {
		"Backplane rejected the device token (revoked or rotated). It is not sent again until the operator replaces the token file; the queue is kept.",
		"Backplane rechazó el token de dispositivo (revocado o rotado). No se vuelve a enviar hasta que el operador reemplace el archivo de token; la cola se conserva.",
		"O Backplane recusou o token do dispositivo (revogado ou rotacionado). Ele não é enviado de novo até que o operador substitua o arquivo de token; a fila é mantida.",
	},
	"upstream_unauthorized": {
		"Something in front of Backplane, such as a proxy or a sign-in page, refused the request. Capture and uploads wait and try again.",
		"Algo delante de Backplane, como un proxy o una página de inicio de sesión, rechazó la solicitud. La captura y los envíos esperan y lo vuelven a intentar.",
		"Algo na frente do Backplane, como um proxy ou uma página de login, recusou a solicitação. A captura e os envios aguardam e tentam de novo.",
	},
	"upstream_forbidden": {
		"Backplane refused this device's request. Capture and uploads wait and try again.",
		"Backplane rechazó la solicitud de este dispositivo. La captura y los envíos esperan y lo vuelven a intentar.",
		"O Backplane recusou a solicitação deste dispositivo. A captura e os envios aguardam e tentam de novo.",
	},
	"companion_unavailable": {
		"The endpoint has no Companion API: it is turned off there, or the endpoint is not the Backplane API origin. Capture and uploads wait and try again.",
		"El endpoint no tiene la API de Companion: está desactivada allí o el endpoint no es el origen de la API de Backplane. La captura y los envíos esperan y lo vuelven a intentar.",
		"O endpoint não tem a API do Companion: ela está desativada lá ou o endpoint não é a origem da API do Backplane. A captura e os envios aguardam e tentam de novo.",
	},
	"endpoint_redirected": {
		"The endpoint answered with a redirect, which is never followed. Configure the Backplane API origin itself.",
		"El endpoint respondió con una redirección, que nunca se sigue. Configura directamente el origen de la API de Backplane.",
		"O endpoint respondeu com um redirecionamento, que nunca é seguido. Configure diretamente a origem da API do Backplane.",
	},
	"identity_mismatch": {
		"Backplane reports another installation or owner for this token than the config names. Nothing is captured or uploaded until they match, and nothing was moved.",
		"Backplane indica otra instalación u otro dueño para este token que los de la configuración. No se captura ni se envía nada hasta que coincidan, y no se movió nada.",
		"O Backplane informa outra instalação ou outro dono para este token do que os da configuração. Nada é capturado nem enviado até que coincidam, e nada foi movido.",
	},
	"unbound_state": {
		"This data directory holds a desktop connection's state, which headless mode never adopts. Use an empty data directory or move that state aside.",
		"Este directorio de datos contiene el estado de una conexión de escritorio, que el modo headless nunca adopta. Usa un directorio de datos vacío o aparta ese estado.",
		"Este diretório de dados contém o estado de uma conexão de desktop, que o modo headless nunca adota. Use um diretório de dados vazio ou mova esse estado para outro lugar.",
	},
	"switch_in_progress": {
		"A switch to the identity the config now names has not finished. Nothing is sent until it does.",
		"No terminó el cambio a la identidad que ahora indica la configuración. No se envía nada hasta que termine.",
		"A troca para a identidade que a configuração agora indica não terminou. Nada é enviado até que termine.",
	},
	"switch_blocked": {
		"A switch cannot finish: the data directory entry named in blocked_by is in its way, and is never merged into or replaced. Nothing is sent. Move that entry out of the data directory and the switch finishes.",
		"Un cambio no puede terminar: la entrada del directorio de datos indicada en blocked_by está en medio, y nunca se fusiona ni se reemplaza. No se envía nada. Saca esa entrada del directorio de datos y el cambio termina.",
		"Uma troca não pode terminar: a entrada do diretório de dados indicada em blocked_by está no caminho, e nunca é mesclada nem substituída. Nada é enviado. Retire essa entrada do diretório de dados e a troca termina.",
	},
	"token_not_replaced_for_switch": {
		"The config names another identity, but the token file is the one verified for the current binding, which is never presented to another server. Nothing is sent or moved until the operator replaces the token file.",
		"La configuración indica otra identidad, pero el archivo de token es el verificado para el vínculo actual, que nunca se presenta a otro servidor. No se envía ni se mueve nada hasta que el operador reemplace el archivo de token.",
		"A configuração indica outra identidade, mas o arquivo de token é o verificado para o vínculo atual, que nunca é apresentado a outro servidor. Nada é enviado nem movido até que o operador substitua o arquivo de token.",
	},
	"token_file_in_data_root": {
		"The headless config's token_file is inside the data directory. Keep the token file outside it.",
		"El token_file de la configuración headless está dentro del directorio de datos. Mantén el archivo de token fuera de él.",
		"O token_file da configuração headless está dentro do diretório de dados. Mantenha o arquivo de token fora dele.",
	},
	"binding_record_invalid": {
		"binding.json in the data directory is unreadable or damaged. Capture and uploads wait until it is repaired.",
		"No se puede leer binding.json en el directorio de datos o está dañado. La captura y los envíos esperan a que se repare.",
		"O binding.json no diretório de dados está ilegível ou danificado. A captura e os envios aguardam até que seja reparado.",
	},
	"internal_error": {
		"Unexpected error.",
		"Error inesperado.",
		"Erro inesperado.",
	},
}

func locale(getenv func(string) string) string {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := getenv(key); value != "" {
			return value
		}
	}
	return ""
}

func languageIndex(locale string) int {
	normalized := strings.ToLower(strings.ReplaceAll(locale, "-", "_"))
	switch {
	case strings.HasPrefix(normalized, "es"):
		return 1
	case strings.HasPrefix(normalized, "pt"):
		return 2
	}
	return 0
}

func message(code, locale string) string {
	translations, ok := messages[code]
	if !ok {
		translations = messages["internal_error"]
	}
	return translations[languageIndex(locale)]
}

// localizedError keeps the stable code first so automation never has to
// parse a translated sentence, and appends the technical detail.
func localizedError(err error, locale string) string {
	code := errorCode(err)
	return code + ": " + message(code, locale) + " (" + err.Error() + ")"
}
