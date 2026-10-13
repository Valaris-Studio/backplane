// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The only way the webview can open a URL: an https link on the connected
//! Backplane origin. JS gets no opener permission; this command is the gate.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use url::Url;

use crate::daemon::types::{CompanionStatus, PairingTicket};
use crate::daemon::DaemonError;

/// A backstop past the server's 10-minute code lifetime, in case the
/// settling event is never seen.
pub const MAX_PAIRING_WINDOW: Duration = Duration::from_secs(15 * 60);

struct PendingPairing {
    pairing_id: String,
    origin: String,
    /// Fixed when the pairing is first remembered; remembering it again
    /// (pair_current after a relaunch) never moves it.
    deadline: Instant,
}

/// The approval page's origin, openable before the device is connected
/// while its pairing is pending (the connected origin does not exist yet).
#[derive(Default)]
pub struct PairingOrigin(Mutex<Option<PendingPairing>>);

fn origin_of(raw: &str) -> Option<Url> {
    Url::parse(raw).ok().filter(|url| {
        url.host_str().is_some() && url.username().is_empty() && url.password().is_none()
    })
}

impl PairingOrigin {
    pub fn remember(&self, ticket: &PairingTicket, endpoint: &str) {
        self.remember_at(ticket, endpoint, Instant::now(), SystemTime::now());
    }

    /// Only an https page on the pairing endpoint's own origin is remembered;
    /// anything else forgets the older pairing too.
    pub fn remember_at(
        &self,
        ticket: &PairingTicket,
        endpoint: &str,
        now: Instant,
        wall_now: SystemTime,
    ) {
        let page =
            origin_of(&ticket.verification_uri_complete).filter(|url| url.scheme() == "https");
        let bound = page
            .zip(origin_of(endpoint))
            .filter(|(page, endpoint)| page.origin() == endpoint.origin());
        let mut pending = self.lock();
        let Some((page, _)) = bound else {
            *pending = None;
            return;
        };
        if let Some(existing) = pending
            .as_ref()
            .filter(|existing| existing.pairing_id == ticket.pairing_id)
        {
            let keep = existing.deadline;
            *pending = Some(PendingPairing {
                pairing_id: ticket.pairing_id.clone(),
                origin: page.origin().ascii_serialization(),
                deadline: keep,
            });
            return;
        }
        let window = now + MAX_PAIRING_WINDOW;
        let expiry = OffsetDateTime::parse(&ticket.expires_at, &Rfc3339)
            .ok()
            .map(|expires_at| {
                let remaining = SystemTime::from(expires_at)
                    .duration_since(wall_now)
                    .unwrap_or(Duration::ZERO);
                now + remaining
            });
        *pending = Some(PendingPairing {
            pairing_id: ticket.pairing_id.clone(),
            origin: page.origin().ascii_serialization(),
            deadline: expiry.map_or(window, |expiry| expiry.min(window)),
        });
    }

    pub fn settle(&self, pairing_id: &str) {
        let mut pending = self.lock();
        if pending
            .as_ref()
            .is_some_and(|pairing| pairing.pairing_id == pairing_id)
        {
            *pending = None;
        }
    }

    pub fn current(&self, now: Instant) -> Option<String> {
        self.lock()
            .as_ref()
            .filter(|pairing| now <= pairing.deadline)
            .map(|pairing| pairing.origin.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PendingPairing>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The connected origin first; the pending pairing's origin otherwise.
pub fn validate_opener_url(
    candidate: &str,
    connected_origin: Option<&str>,
    pairing_origin: Option<&str>,
) -> Result<Url, DaemonError> {
    match validate_backplane_url(candidate, connected_origin) {
        Ok(url) => Ok(url),
        Err(error) => match pairing_origin {
            Some(origin) => validate_backplane_url(candidate, Some(origin)).map_err(|_| error),
            None => Err(error),
        },
    }
}

/// The origin links may open on (contract v1.3): the account's web origin,
/// else the API endpoint; nothing while the device is not connected.
pub fn allowed_web_origin(status: Option<&CompanionStatus>) -> Option<&str> {
    let status = status.filter(|status| status.connected)?;
    let web_origin = status
        .account
        .as_ref()
        .and_then(|account| account.web_origin.as_deref());
    Some(web_origin.unwrap_or(&status.endpoint)).filter(|origin| !origin.is_empty())
}

pub fn validate_backplane_url(
    candidate: &str,
    allowed_origin: Option<&str>,
) -> Result<Url, DaemonError> {
    let endpoint = allowed_origin
        .filter(|endpoint| !endpoint.is_empty())
        .ok_or_else(|| DaemonError::invalid_input("not connected to Backplane"))?;
    let allowed = Url::parse(endpoint)
        .map_err(|_| DaemonError::invalid_input("the connected endpoint is not a URL"))?;
    if allowed.scheme() != "https" {
        return Err(DaemonError::invalid_input(
            "the connected endpoint is not https",
        ));
    }
    let target = Url::parse(candidate).map_err(|_| DaemonError::invalid_input("not a URL"))?;
    if target.scheme() != "https" {
        return Err(DaemonError::invalid_input("only https links can be opened"));
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err(DaemonError::invalid_input(
            "links with credentials are refused",
        ));
    }
    if target.origin() != allowed.origin() {
        return Err(DaemonError::invalid_input(
            "only links on the connected Backplane can be opened",
        ));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: Option<&str> = Some("https://intern.example.dev/api");
    const ENDPOINT_ORIGIN: &str = "https://app.pair.example";

    fn ticket(pairing_id: &str, verification: &str) -> PairingTicket {
        PairingTicket {
            pairing_id: pairing_id.into(),
            user_code: "BCDF-GHJK".into(),
            verification_uri: verification.into(),
            verification_uri_complete: format!("{verification}#code=BCDF-GHJK"),
            expires_at: "2099-01-01T00:00:00Z".into(),
            interval: 5,
            endpoint: None,
        }
    }

    fn remembered(verification: &str) -> PairingOrigin {
        let pairing = PairingOrigin::default();
        pairing.remember(&ticket("p1", verification), ENDPOINT_ORIGIN);
        pairing
    }

    const PAIR_PAGE: &str = "https://app.pair.example/companion/pair#code=BCDF-GHJK";

    #[test]
    fn pairing_origin_is_allowed_while_the_pairing_is_pending() {
        let pairing = remembered("https://app.pair.example/companion/pair");
        let origin = pairing.current(Instant::now());
        assert!(validate_opener_url(PAIR_PAGE, None, origin.as_deref()).is_ok());
    }

    #[test]
    fn pairing_origin_never_allows_another_origin() {
        let pairing = remembered("https://app.pair.example/companion/pair");
        let origin = pairing.current(Instant::now());
        for candidate in [
            "https://evil.example/companion/pair",
            "http://app.pair.example/companion/pair",
            "https://app.pair.example:8443/x",
            "https://user@app.pair.example/x",
        ] {
            assert!(
                validate_opener_url(candidate, None, origin.as_deref()).is_err(),
                "{candidate}"
            );
        }
    }

    #[test]
    fn pairing_origin_is_not_remembered_when_the_page_is_not_on_the_endpoint() {
        let pairing = PairingOrigin::default();
        for endpoint in [
            "https://api.pair.example",
            "https://app.pair.example:8443",
            "http://app.pair.example",
            "not a url",
        ] {
            pairing.remember(
                &ticket("p1", "https://app.pair.example/companion/pair"),
                endpoint,
            );
            assert_eq!(pairing.current(Instant::now()), None, "{endpoint}");
        }
        pairing.remember(
            &ticket("p1", "https://evil.example/companion/pair"),
            ENDPOINT_ORIGIN,
        );
        assert_eq!(pairing.current(Instant::now()), None);
    }

    #[test]
    fn pairing_origin_matches_an_endpoint_with_a_path_or_default_port() {
        let pairing = PairingOrigin::default();
        pairing.remember(
            &ticket("p1", "https://app.pair.example/companion/pair"),
            "https://APP.pair.example:443/api/",
        );
        assert_eq!(
            pairing.current(Instant::now()).as_deref(),
            Some("https://app.pair.example")
        );
    }

    #[test]
    fn pairing_origin_is_refused_after_the_pairing_settles_or_is_cancelled() {
        let pairing = remembered("https://app.pair.example/companion/pair");
        pairing.settle("p1");
        assert_eq!(pairing.current(Instant::now()), None);
        pairing.remember(
            &ticket("p2", "https://app.pair.example/companion/pair"),
            ENDPOINT_ORIGIN,
        );
        pairing.settle("p2");
        assert!(
            validate_opener_url(PAIR_PAGE, None, pairing.current(Instant::now()).as_deref())
                .is_err()
        );
    }

    #[test]
    fn pairing_origin_ignores_the_settling_of_another_pairing() {
        let pairing = PairingOrigin::default();
        pairing.remember(
            &ticket("p2", "https://app.pair.example/companion/pair"),
            ENDPOINT_ORIGIN,
        );
        pairing.settle("p1");
        assert_eq!(
            pairing.current(Instant::now()).as_deref(),
            Some(ENDPOINT_ORIGIN)
        );
    }

    #[test]
    fn pairing_origin_expires_after_the_pairing_window() {
        let pairing = remembered("https://app.pair.example/companion/pair");
        let later = Instant::now() + MAX_PAIRING_WINDOW + Duration::from_secs(1);
        assert_eq!(pairing.current(later), None);
    }

    #[test]
    fn pairing_origin_ends_at_expires_at_when_that_is_earlier() {
        let pairing = PairingOrigin::default();
        let now = Instant::now();
        let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let mut soon = ticket("p1", "https://app.pair.example/companion/pair");
        soon.expires_at = "2027-01-15T08:01:00Z".into(); // 1_800_000_060
        pairing.remember_at(&soon, ENDPOINT_ORIGIN, now, wall);
        assert!(pairing.current(now + Duration::from_secs(59)).is_some());
        assert_eq!(pairing.current(now + Duration::from_secs(61)), None);
    }

    #[test]
    fn repeated_remembering_of_the_same_pairing_never_extends_the_allowance() {
        let pairing = PairingOrigin::default();
        let start = Instant::now();
        let wall = SystemTime::now();
        let page = ticket("p1", "https://app.pair.example/companion/pair");
        pairing.remember_at(&page, ENDPOINT_ORIGIN, start, wall);
        let almost = start + MAX_PAIRING_WINDOW - Duration::from_secs(10);
        pairing.remember_at(&page, ENDPOINT_ORIGIN, almost, wall + (almost - start));
        assert_eq!(
            pairing.current(start + MAX_PAIRING_WINDOW + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn pairing_origin_is_not_remembered_for_a_non_https_page() {
        let pairing = PairingOrigin::default();
        for verification in [
            "http://127.0.0.1:5173/companion/pair",
            "javascript:alert(1)",
            "not a url",
        ] {
            pairing.remember(&ticket("p1", verification), "http://127.0.0.1:5173");
            assert_eq!(pairing.current(Instant::now()), None, "{verification}");
        }
    }

    #[test]
    fn a_newer_pairing_replaces_the_remembered_origin() {
        let pairing = PairingOrigin::default();
        pairing.remember(
            &ticket("p1", "https://old.example/companion/pair"),
            "https://old.example",
        );
        pairing.remember(
            &ticket("p2", "https://app.pair.example/companion/pair"),
            ENDPOINT_ORIGIN,
        );
        let origin = pairing.current(Instant::now());
        assert!(validate_opener_url("https://old.example/x", None, origin.as_deref()).is_err());
        assert!(validate_opener_url(PAIR_PAGE, None, origin.as_deref()).is_ok());
    }

    #[test]
    fn the_connected_origin_still_opens_with_or_without_a_pairing() {
        let connected = Some("https://intern.example.dev");
        assert!(validate_opener_url("https://intern.example.dev/w", connected, None).is_ok());
        assert!(validate_opener_url(
            "https://intern.example.dev/w",
            connected,
            Some("https://app.pair.example")
        )
        .is_ok());
        assert!(validate_opener_url("https://evil.example/w", connected, None).is_err());
    }

    #[test]
    fn validate_backplane_url_accepts_same_origin_https() {
        let url =
            validate_backplane_url("https://intern.example.dev/w/acme/kanban?card=1", ENDPOINT)
                .unwrap();
        assert_eq!(
            url.as_str(),
            "https://intern.example.dev/w/acme/kanban?card=1"
        );
    }

    #[test]
    fn validate_backplane_url_rejects_plain_http() {
        assert!(validate_backplane_url("http://intern.example.dev/w", ENDPOINT).is_err());
    }

    #[test]
    fn validate_backplane_url_rejects_another_host() {
        assert!(validate_backplane_url("https://evil.example.dev/w", ENDPOINT).is_err());
        assert!(validate_backplane_url("https://intern.example.dev.evil.io/w", ENDPOINT).is_err());
    }

    #[test]
    fn validate_backplane_url_rejects_another_port() {
        assert!(validate_backplane_url("https://intern.example.dev:8443/w", ENDPOINT).is_err());
    }

    #[test]
    fn validate_backplane_url_rejects_credentials_in_the_url() {
        assert!(
            validate_backplane_url("https://user:pass@intern.example.dev/w", ENDPOINT).is_err()
        );
    }

    #[test]
    fn validate_backplane_url_rejects_non_web_schemes() {
        for candidate in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "backplane://x",
            "not a url",
        ] {
            assert!(
                validate_backplane_url(candidate, ENDPOINT).is_err(),
                "{candidate}"
            );
        }
    }

    #[test]
    fn validate_backplane_url_rejects_everything_when_not_connected() {
        assert!(validate_backplane_url("https://intern.example.dev/w", None).is_err());
        assert!(validate_backplane_url("https://intern.example.dev/w", Some("")).is_err());
    }

    #[test]
    fn validate_backplane_url_rejects_an_http_endpoint_origin() {
        assert!(
            validate_backplane_url("http://localhost:8000/w", Some("http://localhost:8000"))
                .is_err()
        );
    }

    #[test]
    fn validate_backplane_url_matches_an_idn_origin_by_its_punycode_form() {
        let origin = Some("https://bücher.example");
        assert!(validate_backplane_url("https://xn--bcher-kva.example/w", origin).is_ok());
        assert!(validate_backplane_url("https://BÜCHER.example/w", origin).is_ok());
    }

    #[test]
    fn validate_backplane_url_rejects_a_homograph_of_the_origin() {
        // Cyrillic "а" (U+0430) in place of the Latin "a".
        assert!(validate_backplane_url("https://intern.ex\u{0430}mple.dev/w", ENDPOINT).is_err());
        assert!(validate_backplane_url("https://xn--intern-exmple-7kg.dev/w", ENDPOINT).is_err());
    }

    #[test]
    fn validate_backplane_url_rejects_a_trailing_dot_host() {
        assert!(validate_backplane_url("https://intern.example.dev./w", ENDPOINT).is_err());
    }

    #[test]
    fn validate_backplane_url_normalises_host_case() {
        assert!(validate_backplane_url("https://INTERN.Example.DEV/w", ENDPOINT).is_ok());
    }

    fn connected(endpoint: &str, web_origin: Option<&str>, with_account: bool) -> CompanionStatus {
        CompanionStatus {
            connected: true,
            endpoint: endpoint.into(),
            account: with_account.then(|| crate::daemon::types::AccountInfo {
                email: "owner@example.dev".into(),
                display_name: None,
                web_origin: web_origin.map(Into::into),
                device_name: None,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn allowed_web_origin_prefers_the_account_web_origin() {
        let status = connected(
            "https://api.example.dev",
            Some("https://app.example.dev"),
            true,
        );
        assert_eq!(
            allowed_web_origin(Some(&status)),
            Some("https://app.example.dev")
        );
    }

    #[test]
    fn allowed_web_origin_falls_back_to_the_endpoint_when_web_origin_is_null() {
        let status = connected("https://api.example.dev", None, true);
        assert_eq!(
            allowed_web_origin(Some(&status)),
            Some("https://api.example.dev")
        );
        let no_account = connected("https://api.example.dev", None, false);
        assert_eq!(
            allowed_web_origin(Some(&no_account)),
            Some("https://api.example.dev")
        );
    }

    #[test]
    fn allowed_web_origin_is_none_when_not_connected() {
        assert_eq!(allowed_web_origin(None), None);
        let mut status = connected(
            "https://api.example.dev",
            Some("https://app.example.dev"),
            true,
        );
        status.connected = false;
        assert_eq!(allowed_web_origin(Some(&status)), None);
    }

    #[test]
    fn validate_backplane_url_rejects_the_api_origin_once_a_web_origin_is_known() {
        let status = connected(
            "https://api.example.dev",
            Some("https://app.example.dev"),
            true,
        );
        let origin = allowed_web_origin(Some(&status));
        assert!(validate_backplane_url("https://api.example.dev/w", origin).is_err());
        assert!(validate_backplane_url("https://app.example.dev/w", origin).is_ok());
    }
}
