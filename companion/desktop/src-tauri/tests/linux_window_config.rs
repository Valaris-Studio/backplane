// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! tauri.linux.conf.json is merged over tauri.conf.json as a JSON merge patch,
//! so its `windows` array replaces the base one whole: it must restate the
//! popover window and drop every macOS-only popover trait.

use serde_json::Value;

fn json(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn single_window(config: &Value) -> &Value {
    let windows = config["app"]["windows"].as_array().expect("app.windows");
    assert_eq!(windows.len(), 1);
    &windows[0]
}

#[test]
fn linux_window_is_the_same_popover_window() {
    let base = json("tauri.conf.json");
    let linux = json("tauri.linux.conf.json");
    for key in ["label", "title", "url", "visible"] {
        assert_eq!(
            single_window(&linux)[key],
            single_window(&base)[key],
            "{key}"
        );
    }
}

#[test]
fn linux_window_is_a_normal_decorated_resizable_window() {
    let linux = json("tauri.linux.conf.json");
    let window = single_window(&linux);
    for (key, expected) in [
        ("decorations", true),
        ("resizable", true),
        ("center", true),
        ("transparent", false),
        ("skipTaskbar", false),
        ("alwaysOnTop", false),
    ] {
        assert_eq!(window[key], Value::Bool(expected), "{key}");
    }
    assert!(window.get("windowEffects").is_none());
    assert!(window["minWidth"].as_u64().unwrap() <= window["width"].as_u64().unwrap());
    assert!(window["minHeight"].as_u64().unwrap() <= window["height"].as_u64().unwrap());
}

/// The Linux overlay may restate the window (`app.windows`) and carry the
/// packaging (`bundle`); any other key would silently diverge from the base.
fn unexpected_overrides(overlay: &Value) -> Vec<String> {
    let mut unexpected = Vec::new();
    for (key, value) in overlay.as_object().expect("an object") {
        match key.as_str() {
            "$schema" | "bundle" => {}
            "app" => unexpected.extend(
                value
                    .as_object()
                    .expect("app is an object")
                    .keys()
                    .filter(|key| *key != "windows")
                    .map(|key| format!("app.{key}")),
            ),
            other => unexpected.push(other.to_owned()),
        }
    }
    unexpected
}

#[test]
fn linux_config_overrides_only_the_window_and_packaging() {
    let linux = json("tauri.linux.conf.json");
    assert!(linux["app"]["windows"].is_array());
    assert!(linux["bundle"].is_object());
    assert_eq!(unexpected_overrides(&linux), Vec::<String>::new());
}

#[test]
fn linux_config_rejects_any_other_top_level_key() {
    let mut linux = json("tauri.linux.conf.json");
    linux["plugins"] = serde_json::json!({"updater": {}});
    assert_eq!(unexpected_overrides(&linux), ["plugins"]);
}

#[test]
fn linux_config_rejects_any_app_key_other_than_the_window() {
    let mut linux = json("tauri.linux.conf.json");
    linux["app"]["macOSPrivateApi"] = Value::Bool(false);
    linux["app"]["security"] = serde_json::json!({"csp": null});
    assert_eq!(
        unexpected_overrides(&linux),
        ["app.macOSPrivateApi", "app.security"]
    );
}
