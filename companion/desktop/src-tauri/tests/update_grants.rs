// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The webview reaches the updater only through the five app commands; the
//! plugin's own IPC (which would let JS pick an endpoint and install) and the
//! process plugin stay ungranted, and the committed key is a real minisign key.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::Value;

const UPDATE_GRANTS: [&str; 5] = [
    "allow-check-for-update",
    "allow-install-update",
    "allow-last-update-result",
    "allow-update-channel-get",
    "allow-update-channel-set",
];

/// Data writes whose names merely contain "update"; they never reach the updater.
const DATA_GRANTS_NAMED_UPDATE: [&str; 2] = ["allow-mapping-update", "allow-update-settings"];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn json(relative: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(manifest_dir().join(relative)).unwrap()).unwrap()
}

fn popover_grants() -> BTreeSet<String> {
    json("capabilities/popover.json")["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|grant| {
            grant
                .as_str()
                .expect("grants are plain identifiers")
                .to_string()
        })
        .collect()
}

/// The command list build.rs declares in the app manifest.
fn declared_app_commands() -> BTreeSet<String> {
    let build = std::fs::read_to_string(manifest_dir().join("build.rs")).unwrap();
    let list = build
        .split_once("APP_COMMANDS: &[&str] = &[")
        .and_then(|(_, rest)| rest.split_once("];"))
        .expect("build.rs declares APP_COMMANDS")
        .0;
    list.split(',')
        .map(|item| item.trim().trim_matches('"'))
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn popover_grants_exactly_the_five_update_commands() {
    let grants = popover_grants();
    let update_grants: BTreeSet<String> = grants
        .iter()
        .filter(|grant| grant.contains("update"))
        .filter(|grant| !DATA_GRANTS_NAMED_UPDATE.contains(&grant.as_str()))
        .cloned()
        .collect();
    assert_eq!(
        update_grants,
        UPDATE_GRANTS
            .iter()
            .map(|grant| grant.to_string())
            .collect()
    );
}

#[test]
fn popover_grants_no_updater_or_process_plugin_permission() {
    for grant in popover_grants() {
        assert!(
            !grant.starts_with("updater:") && !grant.starts_with("process:"),
            "{grant}"
        );
    }
}

#[test]
fn every_app_grant_is_a_declared_command_and_every_command_is_granted() {
    let granted: BTreeSet<String> = popover_grants()
        .into_iter()
        .filter_map(|grant| {
            grant
                .strip_prefix("allow-")
                .map(|name| name.replace('-', "_"))
        })
        .collect();
    assert_eq!(granted, declared_app_commands());
}

fn committed_pubkey() -> String {
    json("tauri.conf.json")["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("tauri.conf.json pins plugins.updater.pubkey")
        .to_string()
}

fn decode_base64(text: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .unwrap()
}

#[test]
fn committed_updater_pubkey_is_blank_or_a_minisign_public_key() {
    // Blank while the release key is rotated (SECURITY HOLD): the app then
    // never checks for updates. Once set, it must be a public key.
    let pubkey = committed_pubkey();
    if pubkey.trim().is_empty() {
        return;
    }
    let key_file = String::from_utf8(decode_base64(&pubkey)).unwrap();
    minisign_verify::PublicKey::decode(&key_file).expect("a minisign public key");
    assert!(!key_file.to_lowercase().contains("secret key"));
}

#[test]
fn updater_config_leaves_endpoints_to_the_channel_and_requires_signed_versions() {
    let config = json("tauri.conf.json");
    let updater = &config["plugins"]["updater"];
    assert!(updater.get("endpoints").is_none());
    assert_eq!(updater["requireSignedVersion"], Value::Bool(true));
    assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
    // Only build_desktop.py --updater-artifacts turns it on, with the key in hand.
    assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
}

/// Run by the DK-11 gate against a real build:
/// BACKPLANE_UPDATER_ARCHIVE=<…/Backplane Companion.app.tar.gz> cargo test --test update_grants -- --ignored
#[test]
#[ignore = "needs a built .app.tar.gz; set BACKPLANE_UPDATER_ARCHIVE"]
fn built_updater_archive_verifies_against_the_committed_pubkey() {
    let archive = PathBuf::from(std::env::var("BACKPLANE_UPDATER_ARCHIVE").unwrap());
    let signature_path = PathBuf::from(format!("{}.sig", archive.display()));
    let key_file = String::from_utf8(decode_base64(&committed_pubkey())).unwrap();
    let key = minisign_verify::PublicKey::decode(&key_file).unwrap();
    let signature_file = String::from_utf8(decode_base64(
        &std::fs::read_to_string(signature_path).unwrap(),
    ))
    .unwrap();
    let signature = minisign_verify::Signature::decode(&signature_file).unwrap();
    let bytes = std::fs::read(&archive).unwrap();
    key.verify(&bytes, &signature, true)
        .expect("signed by the committed key");
    println!("trusted comment: {}", signature.trusted_comment());
    let mut tampered = bytes;
    tampered[0] ^= 0xff;
    assert!(key.verify(&tampered, &signature, true).is_err());
}
