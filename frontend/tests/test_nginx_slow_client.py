# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import http.client
import importlib.util
import io
from pathlib import Path
import socket
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'nginx_integration', Path(__file__).with_name('nginx-integration.py'))
NGINX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NGINX)
BODY_BYTES = 4096
SPOOL_WARNING = 'upstream response is buffered to a temporary file'


class ResponseSocket:
    def __init__(self, wire):
        self.wire = io.BytesIO(wire)
        self.receive_buffer = 262144
        self.phases = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.wire.close()

    def getsockopt(self, level, option):
        assert (level, option) == (socket.SOL_SOCKET, socket.SO_RCVBUF)
        return self.receive_buffer

    def setsockopt(self, level, option, value):
        assert (level, option) == (socket.SOL_SOCKET, socket.SO_RCVBUF)
        self.receive_buffer = value

    def sendall(self, request):
        self.phases.append(('request', self.receive_buffer))
        assert request.startswith(b'GET /api/large HTTP/1.1\r\n')

    def pause(self, seconds):
        self.phases.append(('pause', self.receive_buffer, seconds))

    def recv(self, size):
        self.phases.append(('read', self.receive_buffer))
        return self.wire.read(size)

    def makefile(self, *_):
        self.phases.append(('read', self.receive_buffer))
        return self.wire


def http_response(body, status='200 OK', declared_size=BODY_BYTES):
    return (f'HTTP/1.1 {status}\r\nContent-Length: {declared_size}\r\n'
            'Connection: close\r\n\r\n').encode() + body


class SlowClientOracleTests(unittest.TestCase):
    def run_probe(self, wire, logs=''):
        client = ResponseSocket(wire)
        case = NGINX.ProxyBufferingTests(
            'test_large_api_response_to_a_slow_client_is_not_spooled_to_disk')
        case.port = 12345
        case.name = 'offline-synthetic-response'
        with patch.object(NGINX.socket, 'create_connection', return_value=client), \
                patch.object(NGINX.time, 'sleep', side_effect=client.pause), \
                patch.object(NGINX, 'container_logs', return_value=logs), \
                patch.object(NGINX, 'LARGE_RESPONSE_BYTES', BODY_BYTES):
            case.test_large_api_response_to_a_slow_client_is_not_spooled_to_disk()
        return client

    def test_complete_expected_response_is_accepted(self):
        self.run_probe(http_response(b'x' * BODY_BYTES))

    def test_error_response_with_full_length_body_is_rejected(self):
        with self.assertRaises(AssertionError):
            self.run_probe(http_response(b'x' * BODY_BYTES, status='503 Unavailable'))

    def test_headers_cannot_hide_a_one_byte_truncated_body(self):
        with self.assertRaises((AssertionError, http.client.IncompleteRead)):
            self.run_probe(http_response(b'x' * (BODY_BYTES - 1)))

    def test_equal_length_wrong_body_is_rejected(self):
        with self.assertRaises(AssertionError):
            self.run_probe(http_response(b'y' * BODY_BYTES))

    def test_declared_body_length_must_match_fixture(self):
        with self.assertRaises((AssertionError, http.client.IncompleteRead)):
            self.run_probe(http_response(b'x' * BODY_BYTES, declared_size=BODY_BYTES + 1))

    def test_large_truncation_is_rejected(self):
        with self.assertRaises((AssertionError, http.client.IncompleteRead)):
            self.run_probe(http_response(b'x' * (BODY_BYTES // 2)))

    def test_spooling_warning_is_rejected_for_complete_response(self):
        with self.assertRaises(AssertionError):
            self.run_probe(http_response(b'x' * BODY_BYTES), logs=SPOOL_WARNING)

    def test_backpressure_pause_preserves_ordinary_socket_buffering(self):
        client = self.run_probe(http_response(b'x' * BODY_BYTES))
        pause = next(phase for phase in client.phases if phase[0] == 'pause')
        first_read = next(phase for phase in client.phases if phase[0] == 'read')
        self.assertEqual(client.phases[0][0], 'request')
        self.assertLess(client.phases.index(pause), client.phases.index(first_read))
        self.assertEqual(pause[2], 1.5)
        self.assertTrue(all(phase[1] == 262144 for phase in client.phases),
                        'request, pause and drain must retain the ordinary receive buffer')


if __name__ == '__main__':
    unittest.main()
