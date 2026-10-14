// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use serde::Serialize;
use serde_json::Value;
use specta::Type;

/// Every failure a daemon command can reject with. The `kind` tag is what the
/// webview switches on; `Api.code` carries the contract-A stable error code.
#[derive(Debug, Clone, PartialEq, Serialize, Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DaemonError {
    #[error("the companion daemon is not reachable ({reason})")]
    Unreachable { reason: String },
    #[error("{message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        #[specta(type = Option<specta_typescript::Unknown>)]
        detail: Option<Value>,
    },
    #[error("unexpected daemon response: {message}")]
    Protocol { message: String },
    #[error("the companion daemon did not answer in time")]
    Timeout,
    #[error("{message}")]
    InvalidInput { message: String },
    #[error("the daemon response exceeded {limit_bytes} bytes")]
    ResponseTooLarge { limit_bytes: u32 },
    // A native step on this Mac failed (a dialog, Finder, a file write, the
    // login item); the daemon was not involved.
    #[error("{message}")]
    Local { message: String },
}

impl DaemonError {
    pub fn unreachable(reason: impl Into<String>) -> Self {
        Self::Unreachable {
            reason: reason.into(),
        }
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol {
            message: message.into(),
        }
    }

    pub fn local(message: impl Into<String>) -> Self {
        Self::Local {
            message: message.into(),
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }
}
