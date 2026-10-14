// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

pub mod backoff;
pub mod client;
pub mod discovery;
pub mod envelope;
pub mod error;
pub mod hub;
pub mod sse;
pub mod stream;
pub mod types;
#[cfg(windows)]
mod windows_identity;

pub use client::DaemonClient;
pub use error::DaemonError;
