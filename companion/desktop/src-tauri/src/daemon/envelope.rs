// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use serde::Deserialize;
use serde_json::Value;

use super::DaemonError;

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    code: String,
    message: String,
    #[serde(default)]
    detail: Option<Value>,
}

/// Maps a non-2xx contract-A response to a typed error. A body that is not
/// the documented envelope is a protocol fault, never a guessed code.
pub fn decode_error_response(status: u16, body: &[u8]) -> DaemonError {
    match serde_json::from_slice::<ErrorEnvelope>(body) {
        Ok(ErrorEnvelope { error }) => DaemonError::Api {
            status,
            code: error.code,
            message: error.message,
            detail: error.detail.filter(|detail| !detail.is_null()),
        },
        Err(_) => DaemonError::protocol(format!("HTTP {status} without an error envelope")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decode_error_response_maps_envelope_fields() {
        let body = br#"{"error":{"code":"not_connected","message":"Not connected","detail":null}}"#;
        assert_eq!(
            decode_error_response(409, body),
            DaemonError::Api {
                status: 409,
                code: "not_connected".into(),
                message: "Not connected".into(),
                detail: None
            }
        );
    }

    #[test]
    fn decode_error_response_keeps_upstream_detail() {
        let body = br#"{"error":{"code":"server_rejected","message":"Rejected","detail":{"status":403,"error_code":"forbidden"}}}"#;
        let DaemonError::Api {
            status,
            code,
            detail,
            ..
        } = decode_error_response(502, body)
        else {
            panic!("expected api error");
        };
        assert_eq!((status, code.as_str()), (502, "server_rejected"));
        assert_eq!(detail, Some(json!({"status":403,"error_code":"forbidden"})));
    }

    #[test]
    fn decode_error_response_without_detail_field_is_none() {
        let body = br#"{"error":{"code":"internal","message":"boom"}}"#;
        assert!(matches!(
            decode_error_response(500, body),
            DaemonError::Api { detail: None, .. }
        ));
    }

    #[test]
    fn decode_error_response_rejects_non_json_body() {
        assert!(matches!(
            decode_error_response(500, b"<html>oops</html>"),
            DaemonError::Protocol { .. }
        ));
    }

    #[test]
    fn decode_error_response_rejects_json_without_envelope() {
        assert!(matches!(
            decode_error_response(400, br#"{"detail":"nope"}"#),
            DaemonError::Protocol { .. }
        ));
    }

    #[test]
    fn decode_error_response_rejects_empty_body() {
        assert!(matches!(
            decode_error_response(503, b""),
            DaemonError::Protocol { .. }
        ));
    }
}
