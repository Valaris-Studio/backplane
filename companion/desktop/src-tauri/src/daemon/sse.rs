// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Incremental `text/event-stream` parser (WHATWG "event stream
//! interpretation"). Bytes arrive in arbitrary transport chunks, so a line,
//! a CRLF pair or a multi-byte UTF-8 character may straddle two pushes.

/// One event (a line, or all its data lines together) larger than this is a
/// hostile or broken stream: the parser refuses it instead of buffering.
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("an event-stream event exceeded {MAX_EVENT_BYTES} bytes")]
pub struct SseOverflow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    pending_line: Vec<u8>,
    event_type: Option<String>,
    data_lines: Vec<String>,
    data_bytes: usize,
    skip_next_line_feed: bool,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, SseOverflow> {
        let mut dispatched = Vec::new();
        for &byte in chunk {
            if std::mem::take(&mut self.skip_next_line_feed) && byte == b'\n' {
                continue;
            }
            match byte {
                b'\r' | b'\n' => {
                    self.skip_next_line_feed = byte == b'\r';
                    let line = std::mem::take(&mut self.pending_line);
                    if let Some(event) = self.process_line(&line)? {
                        dispatched.push(event);
                    }
                }
                _ if self.pending_line.len() >= MAX_EVENT_BYTES => return Err(self.overflow()),
                _ => self.pending_line.push(byte),
            }
        }
        Ok(dispatched)
    }

    fn overflow(&mut self) -> SseOverflow {
        *self = Self::default();
        SseOverflow
    }

    fn process_line(&mut self, line: &[u8]) -> Result<Option<SseEvent>, SseOverflow> {
        if line.is_empty() {
            return Ok(self.dispatch());
        }
        if line[0] == b':' {
            return Ok(None);
        }
        let line = String::from_utf8_lossy(line);
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line.as_ref(), ""),
        };
        match field {
            "event" => self.event_type = Some(value.to_string()),
            "data" => {
                self.data_bytes += value.len() + 1;
                if self.data_bytes > MAX_EVENT_BYTES {
                    return Err(self.overflow());
                }
                self.data_lines.push(value.to_string());
            }
            _ => {}
        }
        Ok(None)
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event_type = self.event_type.take();
        if self.data_lines.is_empty() {
            return None;
        }
        self.data_bytes = 0;
        let data = std::mem::take(&mut self.data_lines).join("\n");
        Some(SseEvent {
            event: event_type
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "message".into()),
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::default();
        chunks
            .iter()
            .flat_map(|chunk| parser.push(chunk).unwrap())
            .collect()
    }

    fn event(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.into(),
            data: data.into(),
        }
    }

    #[test]
    fn push_parses_a_complete_event() {
        assert_eq!(
            parse_all(&[b"event: status\ndata: {\"a\":1}\n\n"]),
            vec![event("status", "{\"a\":1}")]
        );
    }

    #[test]
    fn push_reassembles_events_split_at_every_byte_boundary() {
        let stream =
            "event: status\ndata: {\"state\":\"active\"}\n\nevent: agents\ndata: []\n\n".as_bytes();
        for split in 0..=stream.len() {
            let (head, tail) = stream.split_at(split);
            assert_eq!(
                parse_all(&[head, tail]),
                vec![
                    event("status", "{\"state\":\"active\"}"),
                    event("agents", "[]")
                ],
                "split at {split}"
            );
        }
    }

    #[test]
    fn push_handles_crlf_split_across_chunks() {
        assert_eq!(
            parse_all(&[b"event: a\r", b"\ndata: 1\r\n\r", b"\n"]),
            vec![event("a", "1")]
        );
    }

    #[test]
    fn push_accepts_bare_carriage_return_line_endings() {
        assert_eq!(
            parse_all(&[b"event: a\rdata: 1\r\r"]),
            vec![event("a", "1")]
        );
    }

    #[test]
    fn push_ignores_ping_comments() {
        assert_eq!(
            parse_all(&[b": ping\n\n", b"event: a\ndata: 1\n\n: ping\n\n"]),
            vec![event("a", "1")]
        );
    }

    #[test]
    fn push_joins_multi_line_data_with_newlines() {
        assert_eq!(
            parse_all(&[b"event: a\ndata: line one\ndata: line two\n\n"]),
            vec![event("a", "line one\nline two")]
        );
    }

    #[test]
    fn push_does_not_dispatch_an_event_without_data() {
        assert_eq!(parse_all(&[b"event: a\n\n"]), vec![]);
    }

    #[test]
    fn push_defaults_event_type_to_message() {
        assert_eq!(parse_all(&[b"data: x\n\n"]), vec![event("message", "x")]);
    }

    #[test]
    fn push_resets_event_type_after_dispatch() {
        assert_eq!(
            parse_all(&[b"event: a\ndata: 1\n\ndata: 2\n\n"]),
            vec![event("a", "1"), event("message", "2")]
        );
    }

    #[test]
    fn push_strips_only_one_leading_space() {
        assert_eq!(
            parse_all(&[b"data:  two\ndata:none\n\n"]),
            vec![event("message", " two\nnone")]
        );
    }

    #[test]
    fn push_ignores_id_retry_and_unknown_fields() {
        assert_eq!(
            parse_all(&[b"id: 7\nretry: 100\nfoo: bar\ndata: x\n\n"]),
            vec![event("message", "x")]
        );
    }

    #[test]
    fn push_reassembles_utf8_split_inside_a_character() {
        let stream = "data: café ✓\n\n".as_bytes();
        let split = stream.iter().position(|b| *b == 0xC3).unwrap() + 1;
        let (head, tail) = stream.split_at(split);
        assert_eq!(parse_all(&[head, tail]), vec![event("message", "café ✓")]);
    }

    #[test]
    fn push_holds_an_incomplete_event_until_the_blank_line() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(b"event: a\ndata: 1\n"), Ok(vec![]));
        assert_eq!(parser.push(b"\n"), Ok(vec![event("a", "1")]));
    }

    #[test]
    fn push_rejects_a_line_longer_than_the_event_cap() {
        let mut parser = SseParser::default();
        let mut oversized = b"data: ".to_vec();
        oversized.resize(MAX_EVENT_BYTES + 16, b'x');
        assert_eq!(parser.push(&oversized), Err(SseOverflow));
    }

    #[test]
    fn push_rejects_an_unterminated_line_growing_across_chunks() {
        let mut parser = SseParser::default();
        let chunk = vec![b'x'; 64 * 1024];
        let overflowed = (0..=MAX_EVENT_BYTES / chunk.len()).any(|_| parser.push(&chunk).is_err());
        assert!(overflowed);
    }

    #[test]
    fn push_rejects_an_event_whose_data_lines_sum_past_the_cap() {
        let mut parser = SseParser::default();
        let line = format!("data: {}\n", "y".repeat(1000));
        let lines = MAX_EVENT_BYTES / 1000 + 2;
        assert_eq!(parser.push(line.repeat(lines).as_bytes()), Err(SseOverflow));
    }

    #[test]
    fn push_accepts_an_event_just_under_the_cap() {
        let payload = "z".repeat(MAX_EVENT_BYTES - 1024);
        let stream = format!("event: status\ndata: {payload}\n\n");
        assert_eq!(
            parse_all(&[stream.as_bytes()]),
            vec![event("status", &payload)]
        );
    }
}
