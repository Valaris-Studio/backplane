// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::future::Future;
use std::path::{Path, PathBuf};

use tokio::sync::oneshot;

use crate::daemon::types::DiscoveredProject;
use crate::daemon::DaemonError;

/// Resolves to None when the user cancels. The dialogs answer through a
/// callback, so no tokio worker is parked while a sheet is open.
pub type DialogChoice = oneshot::Receiver<Option<PathBuf>>;

pub trait NativeDialogs: Send + Sync {
    fn pick_folder(&self) -> DialogChoice;
    fn choose_save_path(&self, directory: Option<&Path>, file_name: &str) -> DialogChoice;
}

pub async fn pick_folder(dialogs: &dyn NativeDialogs) -> Result<Option<String>, DaemonError> {
    let Some(folder) = dialogs.pick_folder().await.ok().flatten() else {
        return Ok(None);
    };
    if !folder.is_absolute() {
        return Err(DaemonError::local(
            "the folder picker returned a relative path",
        ));
    }
    folder
        .into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| DaemonError::local("the folder path is not valid UTF-8"))
}

/// Projects "Add a folder…": the chosen path goes to the daemon, which
/// records it as found; the webview gets only that found project back.
pub async fn pick_project_folder<Discover, Discovered>(
    dialogs: &dyn NativeDialogs,
    discover: Discover,
) -> Result<Option<DiscoveredProject>, DaemonError>
where
    Discover: FnOnce(String) -> Discovered,
    Discovered: Future<Output = Result<DiscoveredProject, DaemonError>>,
{
    let Some(folder) = pick_folder(dialogs).await? else {
        return Ok(None);
    };
    discover(folder).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Answering(Option<PathBuf>);

    impl NativeDialogs for Answering {
        fn pick_folder(&self) -> DialogChoice {
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(self.0.clone());
            receiver
        }
        fn choose_save_path(&self, _: Option<&Path>, _: &str) -> DialogChoice {
            unreachable!()
        }
    }

    struct Vanishing;

    impl NativeDialogs for Vanishing {
        fn pick_folder(&self) -> DialogChoice {
            oneshot::channel().1
        }
        fn choose_save_path(&self, _: Option<&Path>, _: &str) -> DialogChoice {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn pick_folder_returns_the_chosen_absolute_path() {
        let chosen = Answering(Some(PathBuf::from("/home/me/code/app")));
        assert_eq!(
            pick_folder(&chosen).await,
            Ok(Some("/home/me/code/app".to_string()))
        );
    }

    #[tokio::test]
    async fn pick_folder_returns_none_when_cancelled() {
        assert_eq!(pick_folder(&Answering(None)).await, Ok(None));
        assert_eq!(pick_folder(&Vanishing).await, Ok(None));
    }

    fn discovered_at(root: &str) -> DiscoveredProject {
        DiscoveredProject {
            root: root.into(),
            reason: Some("no_origin".into()),
            ..DiscoveredProject::default()
        }
    }

    #[tokio::test]
    async fn pick_project_folder_hands_the_chosen_path_to_the_daemon() {
        let asked = std::sync::Mutex::new(Vec::new());
        let chosen = Answering(Some(PathBuf::from("/home/me/code/app/web")));
        let found = pick_project_folder(&chosen, |path| {
            asked.lock().unwrap().push(path);
            async { Ok(discovered_at("/home/me/code/app")) }
        })
        .await;
        assert_eq!(found, Ok(Some(discovered_at("/home/me/code/app"))));
        assert_eq!(*asked.lock().unwrap(), ["/home/me/code/app/web"]);
    }

    #[tokio::test]
    async fn pick_project_folder_asks_nothing_when_cancelled() {
        for cancelled in [&Answering(None) as &dyn NativeDialogs, &Vanishing] {
            let found = pick_project_folder(cancelled, |_| async {
                unreachable!("a cancelled picker reached the daemon")
            })
            .await;
            assert_eq!(found, Ok(None));
        }
    }

    #[tokio::test]
    async fn pick_project_folder_never_sends_a_relative_path() {
        let found = pick_project_folder(&Answering(Some(PathBuf::from("code/app"))), |_| async {
            unreachable!("a relative path reached the daemon")
        })
        .await;
        assert!(matches!(found, Err(DaemonError::Local { .. })));
    }

    #[tokio::test]
    async fn pick_project_folder_passes_the_daemon_refusal_through() {
        let refusal = DaemonError::Api {
            status: 409,
            code: "ignored_path".into(),
            message: "ignored".into(),
            detail: None,
        };
        let expected = refusal.clone();
        let found = pick_project_folder(
            &Answering(Some(PathBuf::from("/home/me/code/app"))),
            |_| async move { Err(refusal) },
        )
        .await;
        assert_eq!(found, Err(expected));
    }

    #[tokio::test]
    async fn pick_folder_refuses_a_relative_path() {
        assert!(matches!(
            pick_folder(&Answering(Some(PathBuf::from("code/app")))).await,
            Err(DaemonError::Local { .. })
        ));
    }
}
