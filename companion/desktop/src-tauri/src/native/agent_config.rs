// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Revealing an agent's config file in the file manager. The webview names an agent,
//! never a path: the path comes from the daemon and must stay inside HOME.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::daemon::types::AgentEntry;
use crate::daemon::{DaemonClient, DaemonError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    ClaudeCode,
    CodexCli,
    PiCli,
}

impl AgentId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::CodexCli => "codex_cli",
            Self::PiCli => "pi_cli",
        }
    }
}

pub trait Revealer: Sync {
    fn reveal(&self, path: &Path) -> std::io::Result<()>;
}

/// Problems only the user can fix in the file; revealing is for them first.
const USER_FIXABLE_PROBLEMS: &[&str] = &[
    "config_invalid",
    "config_unreadable",
    "conflict_existing_otel",
    "hooks_invalid",
    "settings_invalid",
    "hook_disabled_in_codex",
];

pub fn config_path_for(agents: &[AgentEntry], agent: AgentId) -> Result<PathBuf, DaemonError> {
    let entry = agents
        .iter()
        .find(|entry| entry.id == agent.as_str())
        .ok_or_else(|| DaemonError::invalid_input("the companion does not list this agent"))?;
    let problem_path = entry.integration.as_ref().and_then(|integration| {
        let path_of = |problem: &String| {
            integration
                .problem_config_paths
                .get(problem)
                .map(String::as_str)
                .filter(|path| !path.is_empty())
        };
        let user_fixable = integration
            .problems
            .iter()
            .filter(|problem| USER_FIXABLE_PROBLEMS.contains(&problem.as_str()))
            .find_map(path_of);
        user_fixable.or_else(|| integration.problems.iter().find_map(path_of))
    });
    let integration_path = entry
        .integration
        .as_ref()
        .map(|integration| integration.config_path.as_str());
    let presence_path = entry
        .presence
        .as_ref()
        .map(|presence| presence.config_path.as_str());
    [problem_path, integration_path, presence_path]
        .into_iter()
        .flatten()
        .find(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| DaemonError::invalid_input("this agent has no config file yet"))
}

/// Canonicalizes both sides, so `..` segments and symlinks are judged by where
/// they really lead; HOME itself is refused, only files strictly inside it pass.
pub fn confine_to_home(path: &Path, home: &Path) -> Result<PathBuf, DaemonError> {
    if !path.is_absolute() {
        return Err(DaemonError::invalid_input(
            "the config path is not absolute",
        ));
    }
    let resolved = path
        .canonicalize()
        .map_err(|_| DaemonError::invalid_input("the config file does not exist"))?;
    let home = home
        .canonicalize()
        .map_err(|_| DaemonError::invalid_input("the home folder is not accessible"))?;
    if resolved == home || !resolved.starts_with(&home) {
        return Err(DaemonError::invalid_input(
            "the config file is outside your home folder",
        ));
    }
    Ok(resolved)
}

pub async fn reveal_agent_config(
    client: &DaemonClient,
    agent: AgentId,
    home: Option<&Path>,
    revealer: &dyn Revealer,
) -> Result<(), DaemonError> {
    let home = home.ok_or_else(|| DaemonError::local("the home folder is unknown"))?;
    let agents = client.agents().await?;
    let confined = confine_to_home(&config_path_for(&agents, agent)?, home)?;
    revealer.reveal(&confined).map_err(|error| {
        DaemonError::local(format!("the file manager could not show the file: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::{AgentIntegration, AgentPresence};

    fn entry(id: &str, integration_path: Option<&str>, presence_path: Option<&str>) -> AgentEntry {
        AgentEntry {
            id: id.into(),
            presence: presence_path.map(|path| AgentPresence {
                installed: true,
                version: None,
                config_path: path.into(),
            }),
            integration: integration_path.map(|path| AgentIntegration {
                state: "configured".into(),
                config_path: path.into(),
                ..AgentIntegration::default()
            }),
            action: None,
            telemetry: None,
        }
    }

    #[test]
    fn agent_id_accepts_only_the_three_daemon_ids() {
        for (raw, id) in [
            ("\"claude_code\"", AgentId::ClaudeCode),
            ("\"codex_cli\"", AgentId::CodexCli),
            ("\"pi_cli\"", AgentId::PiCli),
        ] {
            assert_eq!(serde_json::from_str::<AgentId>(raw).unwrap(), id);
            assert_eq!(format!("\"{}\"", id.as_str()), raw);
        }
        for raw in ["\"claude\"", "\"../etc\"", "\"\"", "\"CLAUDE_CODE\""] {
            assert!(serde_json::from_str::<AgentId>(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn config_path_for_prefers_the_integration_path() {
        let agents = [
            entry(
                "claude_code",
                Some("/h/.claude/settings.json"),
                Some("/h/.claude"),
            ),
            entry("codex_cli", None, Some("/h/.codex/config.toml")),
        ];
        assert_eq!(
            config_path_for(&agents, AgentId::ClaudeCode),
            Ok(PathBuf::from("/h/.claude/settings.json"))
        );
        assert_eq!(
            config_path_for(&agents, AgentId::CodexCli),
            Ok(PathBuf::from("/h/.codex/config.toml"))
        );
    }

    fn codex_with_problems(problems: &[(&str, Option<&str>)]) -> AgentEntry {
        let mut codex = entry("codex_cli", Some("/h/.codex/hooks.json"), None);
        let integration = codex.integration.as_mut().unwrap();
        for (problem, path) in problems {
            integration.problems.push(problem.to_string());
            if let Some(path) = path {
                integration
                    .problem_config_paths
                    .insert(problem.to_string(), path.to_string());
            }
        }
        codex
    }

    #[test]
    fn config_path_for_reveals_the_file_a_user_fixable_problem_concerns() {
        let agents = [codex_with_problems(&[
            ("Stop:stale", Some("/h/.codex/hooks.json")),
            ("conflict_existing_otel", Some("/h/.codex/config.toml")),
        ])];
        assert_eq!(
            config_path_for(&agents, AgentId::CodexCli),
            Ok(PathBuf::from("/h/.codex/config.toml"))
        );
    }

    #[test]
    fn config_path_for_falls_back_to_the_first_problem_with_a_path() {
        let agents = [codex_with_problems(&[
            ("companion_executable_missing", None),
            ("otel:stale", Some("/h/.codex/config.toml")),
        ])];
        assert_eq!(
            config_path_for(&agents, AgentId::CodexCli),
            Ok(PathBuf::from("/h/.codex/config.toml"))
        );
    }

    #[test]
    fn config_path_for_ignores_problem_paths_that_are_not_current_problems_or_empty() {
        let mut stray = codex_with_problems(&[("config_invalid", Some(""))]);
        stray
            .integration
            .as_mut()
            .unwrap()
            .problem_config_paths
            .insert("conflict_existing_otel".into(), "/etc/passwd".into());
        assert_eq!(
            config_path_for(&[stray], AgentId::CodexCli),
            Ok(PathBuf::from("/h/.codex/hooks.json"))
        );
    }

    #[test]
    fn integration_decodes_problem_config_paths_and_defaults_to_none() {
        let with: AgentIntegration = serde_json::from_str(
            r#"{"state":"broken","config_path":"/h/.codex/hooks.json","problems":["config_invalid"],"problem_config_paths":{"config_invalid":"/h/.codex/config.toml"},"trust":null}"#,
        )
        .unwrap();
        assert_eq!(
            with.problem_config_paths
                .get("config_invalid")
                .map(String::as_str),
            Some("/h/.codex/config.toml")
        );
        let without: AgentIntegration = serde_json::from_str(
            r#"{"state":"installed","config_path":"/h/.claude/settings.json","trust":null}"#,
        )
        .unwrap();
        assert!(without.problem_config_paths.is_empty());
    }

    #[test]
    fn config_path_for_refuses_an_agent_the_daemon_does_not_list() {
        let agents = [entry("claude_code", Some("/h/.claude/settings.json"), None)];
        assert!(matches!(
            config_path_for(&agents, AgentId::PiCli),
            Err(DaemonError::InvalidInput { .. })
        ));
    }

    #[test]
    fn config_path_for_refuses_an_agent_without_a_config_path() {
        let agents = [entry("pi_cli", Some(""), Some(""))];
        assert!(matches!(
            config_path_for(&agents, AgentId::PiCli),
            Err(DaemonError::InvalidInput { .. })
        ));
    }

    #[test]
    fn confine_to_home_accepts_an_existing_file_under_home() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".claude/settings.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "{}").unwrap();
        let confined = confine_to_home(&config, home.path()).unwrap();
        assert_eq!(confined, config.canonicalize().unwrap());
    }

    #[test]
    fn confine_to_home_refuses_paths_outside_home() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join("config.toml");
        std::fs::write(&outside, "").unwrap();
        std::fs::create_dir_all(home.path().join("sub")).unwrap();
        let dotted = home.path().join("sub/../../").join(
            elsewhere
                .path()
                .strip_prefix(elsewhere.path().parent().unwrap())
                .unwrap(),
        );
        for candidate in [
            outside.clone(),
            dotted.join("config.toml"),
            home.path().to_path_buf(),
            PathBuf::from("relative/config.toml"),
        ] {
            assert!(
                matches!(
                    confine_to_home(&candidate, home.path()),
                    Err(DaemonError::InvalidInput { .. })
                ),
                "{candidate:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn confine_to_home_refuses_a_symlink_that_escapes_home() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("secret");
        std::fs::write(&target, "").unwrap();
        let link = home.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(
            confine_to_home(&link, home.path()),
            Err(DaemonError::InvalidInput { .. })
        ));
    }

    #[test]
    fn confine_to_home_refuses_a_missing_file() {
        let home = tempfile::tempdir().unwrap();
        assert!(matches!(
            confine_to_home(&home.path().join("absent.json"), home.path()),
            Err(DaemonError::InvalidInput { .. })
        ));
    }

    struct PanickingRevealer;

    impl Revealer for PanickingRevealer {
        fn reveal(&self, path: &Path) -> std::io::Result<()> {
            panic!("must not reveal {path:?}");
        }
    }

    #[tokio::test]
    async fn reveal_agent_config_without_home_or_daemon_reveals_nothing() {
        let data_dir = tempfile::tempdir().unwrap();
        let client = DaemonClient::new(data_dir.path().to_path_buf());
        let home = tempfile::tempdir().unwrap();
        assert!(matches!(
            reveal_agent_config(
                &client,
                AgentId::ClaudeCode,
                Some(home.path()),
                &PanickingRevealer
            )
            .await,
            Err(DaemonError::Unreachable { .. })
        ));
        assert!(matches!(
            reveal_agent_config(&client, AgentId::ClaudeCode, None, &PanickingRevealer).await,
            Err(DaemonError::Local { .. })
        ));
    }
}
