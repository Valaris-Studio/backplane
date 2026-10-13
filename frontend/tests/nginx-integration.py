# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import http.client
import socket
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

FRONTEND = Path(__file__).resolve().parents[1]


def http_get(port, path, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    connection.request('GET', path, headers=headers or {})
    response = connection.getresponse()
    result = response.status, dict(response.getheaders()), response.read()
    connection.close()
    return result


class NginxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        (root / 'html/assets').mkdir(parents=True)
        (root / 'retained/assets').mkdir(parents=True)
        (root / 'html/index.html').write_text('<html>current app</html>')
        (root / 'html/assets/Page-current1.js').write_text('export const page = "current";')
        (root / 'retained/assets/Page-previous.js').write_text('export const page = "previous";')
        (root / 'html/.asset-retention.json').write_text('private manifest')
        # The image's baked history (Dockerfile `retained` stage): assets/ plus its manifest and lock.
        (root / 'html/.asset-history/assets').mkdir(parents=True)
        (root / 'html/.asset-history/assets/Page-imageonly.js').write_text('export const page = "image history";')
        (root / 'html/.asset-history/.asset-retention.json').write_text('private history manifest')
        (root / 'html/.asset-history/.asset-retention.lock').write_text('')
        config = (FRONTEND / 'nginx.conf').read_text().replace('${BACKEND_URL}', 'http://127.0.0.1:8000').replace('${EDGE_PROXY_SECRET}', '')
        (root / 'nginx.conf').write_text(config)
        cls.name = 'backplane-assets-test-' + uuid.uuid4().hex[:8]
        subprocess.run(['docker', 'run', '-d', '--name', cls.name, '-p', '127.0.0.1::8080', '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/retained:/var/lib/backplane/frontend:ro', '-v', f'{root}/nginx.conf:/etc/nginx/conf.d/default.conf:ro', 'nginx:alpine'], check=True, capture_output=True)
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'rm', '-f', cls.name], check=True, capture_output=True))
        port = subprocess.check_output(['docker', 'port', cls.name, '8080/tcp'], text=True)
        cls.port = int(port.strip().rsplit(':', 1)[1])
        for attempt in range(50):
            try:
                cls.request('/')
                break
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        else:
            raise RuntimeError('Nginx did not start')

    @classmethod
    def request(cls, path, headers=None):
        return http_get(cls.port, path, headers)

    def test_html_and_deep_links_revalidate_including_304(self):
        for path in ['/', '/index.html', '/workspace/settings']:
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertIn('no-cache', headers.get('Cache-Control', ''))
            self.assertIn(b'current app', body)
            status, headers, _ = self.request(path, {'If-None-Match': headers['ETag']})
            self.assertEqual(status, 304)
            self.assertIn('no-cache', headers.get('Cache-Control', ''))

    def test_current_and_retained_assets_are_immutable(self):
        for name in ['Page-current1.js', 'Page-previous.js']:
            status, headers, body = self.request('/assets/' + name)
            self.assertEqual(status, 200)
            self.assertIn('immutable', headers.get('Cache-Control', ''))
            self.assertIn('javascript', headers['Content-Type'])
            self.assertIn(b'export const', body)

    def test_image_history_asset_is_served_immutable_without_any_volume_copy(self):
        status, headers, body = self.request('/assets/Page-imageonly.js')
        self.assertEqual(status, 200)
        self.assertIn('immutable', headers.get('Cache-Control', ''))
        self.assertIn('javascript', headers['Content-Type'])
        self.assertIn(b'image history', body)

    def test_image_history_internals_are_not_public(self):
        for path in [
            '/.asset-history/assets/Page-imageonly.js',
            '/.asset-history/.asset-retention.json',
            '/.asset-history/.asset-retention.lock',
            '/.asset-history/',
            '/assets/.asset-retention.json',
            '/assets/../.asset-history/.asset-retention.json',
            '/assets/%2e%2e/.asset-history/.asset-retention.json',
        ]:
            with self.subTest(path=path):
                status, _, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b'private', body)

    def test_missing_asset_is_not_html_and_not_cached(self):
        status, headers, body = self.request('/assets/Page-missing1.js')
        self.assertEqual(status, 404)
        self.assertIn('no-store', headers.get('Cache-Control', ''))
        self.assertNotIn(b'current app', body)

    def test_retention_metadata_is_not_public(self):
        self.assertEqual(self.request('/.asset-retention.json')[0], 404)


class ImageHistoryStartupTests(unittest.TestCase):
    """The real entrypoint with no volume (Cloud Run): retired assets come straight
    from the image layer. python3 is a stub that fails, so any startup copy kills the container."""

    def test_retired_asset_served_from_image_history_without_startup_copy(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / 'html/assets').mkdir(parents=True)
        (root / 'html/.asset-history/assets').mkdir(parents=True)
        (root / 'html/index.html').write_text('<html>current app</html>')
        (root / 'html/assets/Page-current1.js').write_text('export const page = "current";')
        (root / 'html/.asset-history/assets/Page-retired1.js').write_text('export const page = "retired";')
        (root / 'html/.asset-history/.asset-retention.json').write_text('private history manifest')
        (root / 'nginx.conf.template').write_text((FRONTEND / 'nginx.conf').read_text())
        stub = root / 'python3'
        stub.write_text('#!/bin/sh\necho "startup copy ran" >&2\nexit 97\n')
        stub.chmod(0o755)
        name = 'backplane-history-test-' + uuid.uuid4().hex[:8]
        subprocess.run(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-e', 'BACKEND_URL=http://127.0.0.1:8000', '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/nginx.conf.template:/etc/nginx/nginx.conf.template:ro', '-v', f'{stub}:/usr/local/bin/python3:ro', '-v', f'{FRONTEND}/scripts/start-frontend.sh:/usr/local/bin/start-frontend.sh:ro', 'nginx:alpine', '/bin/sh', '/usr/local/bin/start-frontend.sh'], check=True, capture_output=True)
        self.addCleanup(lambda: subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True))
        port = int(subprocess.check_output(['docker', 'port', name, '8080/tcp'], text=True).strip().rsplit(':', 1)[1])
        for attempt in range(50):
            try:
                status, headers, body = http_get(port, '/assets/Page-retired1.js')
                break
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        else:
            logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
            self.fail('start-frontend.sh did not bring nginx up:\n' + logs.stdout + logs.stderr)
        self.assertEqual(status, 200)
        self.assertIn('immutable', headers.get('Cache-Control', ''))
        self.assertIn(b'retired', body)
        self.assertEqual(http_get(port, '/assets/Page-current1.js')[0], 200)
        self.assertEqual(http_get(port, '/.asset-history/.asset-retention.json')[0], 404)
        status, headers, _ = http_get(port, '/assets/Page-missing1.js')
        self.assertEqual(status, 404)
        self.assertIn('no-store', headers.get('Cache-Control', ''))


ECHO_UPSTREAM = r'''server {
    listen 8081;
    location / {
        default_type text/plain;
        return 200 "secret=[$http_x_backplane_edge_secret]\nedge=[$http_x_backplane_edge_forwarded_for]\nxff=[$http_x_forwarded_for]\n";
    }
}
'''
FORGED_EDGE_HEADERS = [
    ('X-Forwarded-For', '6.6.6.6'),
    ('X-Forwarded-For', '7.7.7.7'),
    ('X-Backplane-Edge-Secret', 'forged'),
    ('x-backplane-edge-secret', 'forged-again'),
    ('X-Backplane-Edge-Forwarded-For', '9.9.9.9'),
]
# Low-entropy on purpose: the export's gitleaks gate flags realistic-looking keys.
EDGE_SECRET = 'edge-test-value'


class EdgeHeaderTests(unittest.TestCase):
    """The proxy as start-frontend.sh renders it (real envsubst + nginx -t),
    proxying /api and /ws to an upstream that echoes what it received."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        (root / 'html').mkdir()
        (root / 'html/index.html').write_text('<html>app</html>')
        (root / 'echo.conf').write_text(ECHO_UPSTREAM)
        (root / 'nginx.conf.template').write_text((FRONTEND / 'nginx.conf').read_text())

    @classmethod
    def start(cls, secret):
        root = Path(cls.temp.name)
        name = 'backplane-edge-test-' + uuid.uuid4().hex[:8]
        env = ['-e', 'BACKEND_URL=http://127.0.0.1:8081']
        if secret is not None:
            env += ['-e', f'EDGE_PROXY_SECRET={secret}']
        render_and_run = (
            "envsubst '${BACKEND_URL} ${EDGE_PROXY_SECRET}' "
            '< /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf '
            "&& nginx -t && exec nginx -g 'daemon off;'"
        )
        subprocess.run(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::8080', *env, '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/echo.conf:/etc/nginx/conf.d/echo.conf:ro', '-v', f'{root}/nginx.conf.template:/etc/nginx/nginx.conf.template:ro', 'nginx:alpine', 'sh', '-c', render_and_run], check=True, capture_output=True)
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True))
        port = int(subprocess.check_output(['docker', 'port', name, '8080/tcp'], text=True).strip().rsplit(':', 1)[1])
        for attempt in range(50):
            try:
                cls.send(port, '/')
                return port
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
        raise RuntimeError('Nginx did not start:\n' + logs.stdout + logs.stderr)

    @classmethod
    def run_start_script(cls, secret):
        """The production entrypoint itself. nginx:alpine has no python3, so a
        no-op stands in for retain-assets.py; the secret guard, envsubst and
        `exec nginx` are the real script."""
        root = Path(cls.temp.name)
        stub = root / 'python3'
        stub.write_text('#!/bin/sh\nexit 0\n')
        stub.chmod(0o755)
        name = 'backplane-edge-script-' + uuid.uuid4().hex[:8]
        subprocess.run(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-e', 'BACKEND_URL=http://127.0.0.1:8081', '-e', f'EDGE_PROXY_SECRET={secret}', '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/echo.conf:/etc/nginx/conf.d/echo.conf:ro', '-v', f'{root}/nginx.conf.template:/etc/nginx/nginx.conf.template:ro', '-v', f'{stub}:/usr/local/bin/python3:ro', '-v', f'{FRONTEND}/scripts/start-frontend.sh:/usr/local/bin/start-frontend.sh:ro', 'nginx:alpine', '/bin/sh', '/usr/local/bin/start-frontend.sh'], check=True, capture_output=True)
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True))
        return name

    @staticmethod
    def send(port, path, header_lines=()):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        connection.putrequest('GET', path)
        for name, value in header_lines:
            connection.putheader(name, value)
        connection.endheaders()
        response = connection.getresponse()
        result = response.status, response.getheaders(), response.read().decode()
        connection.close()
        return result

    def echoed(self, port, path):
        status, headers, body = self.send(port, path, FORGED_EDGE_HEADERS)
        self.assertEqual(status, 200, body)
        fields = dict(line.split('=', 1) for line in body.strip().splitlines())
        return headers, {key: value.strip('[]') for key, value in fields.items()}

    def assert_edge_chain_is_ours(self, fields):
        self.assertNotIn('9.9.9.9', fields['edge'])
        self.assertEqual(fields['edge'], fields['xff'])
        self.assertTrue(fields['edge'].startswith('6.6.6.6, 7.7.7.7, '), fields['edge'])

    def test_unset_or_empty_secret_sends_no_secret_and_drops_forged_copies(self):
        for secret in (None, ''):
            port = self.start(secret)
            for path in ('/api/x', '/ws/x'):
                with self.subTest(secret=secret, path=path):
                    headers, fields = self.echoed(port, path)
                    self.assertEqual(fields['secret'], '')
                    self.assert_edge_chain_is_ours(fields)
                    self.assertNotIn('forged', repr(headers))

    def test_configured_secret_replaces_forged_copies_and_never_leaks(self):
        port = self.start(EDGE_SECRET)
        for path in ('/api/x', '/ws/x'):
            with self.subTest(path=path):
                headers, fields = self.echoed(port, path)
                self.assertEqual(fields['secret'], EDGE_SECRET)
                self.assert_edge_chain_is_ours(fields)
                self.assertNotIn(EDGE_SECRET, repr(headers))
        _, spa_headers, spa_body = self.send(port, '/')
        self.assertNotIn(EDGE_SECRET, repr(spa_headers) + spa_body)

    def test_start_script_serves_a_safe_secret_and_refuses_an_unsafe_one(self):
        served = self.run_start_script(EDGE_SECRET)
        port = int(subprocess.check_output(['docker', 'port', served, '8080/tcp'], text=True).strip().rsplit(':', 1)[1])
        for attempt in range(50):
            try:
                _, fields = self.echoed(port, '/api/x')
                break
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        else:
            self.fail('start-frontend.sh did not bring nginx up')
        self.assertEqual(fields['secret'], EDGE_SECRET)

        refused = self.run_start_script('ab"cd$x')
        exit_code = subprocess.check_output(['docker', 'wait', refused], text=True).strip()
        logs = subprocess.run(['docker', 'logs', refused], capture_output=True, text=True)
        self.assertEqual(exit_code, '1')
        self.assertIn('EDGE_PROXY_SECRET may only contain', logs.stderr)
        self.assertNotIn('ab"cd', logs.stdout + logs.stderr)


def run_detached(name, *docker_args):
    subprocess.run(['docker', 'run', '-d', '--name', name, '-p', '127.0.0.1::8080', *docker_args], check=True, capture_output=True)
    return int(subprocess.check_output(['docker', 'port', name, '8080/tcp'], text=True).strip().rsplit(':', 1)[1])


def wait_until_serving(port, name):
    for attempt in range(50):
        try:
            http_get(port, '/')
            return
        except (OSError, http.client.HTTPException):
            time.sleep(0.1)
    logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
    raise RuntimeError('Nginx did not start:\n' + logs.stdout + logs.stderr)


def container_logs(name):
    logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
    return logs.stdout + logs.stderr


class VolumeAutoDetectTests(unittest.TestCase):
    """The image never creates /var/lib/backplane/frontend, so its presence means
    a mounted volume. A tmpfs there would recreate the in-memory OOM, so it is skipped."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        (root / 'html').mkdir()
        (root / 'html/index.html').write_text('<html>app</html>')
        (root / 'nginx.conf.template').write_text((FRONTEND / 'nginx.conf').read_text())
        stub = root / 'python3'
        stub.write_text('#!/bin/sh\necho "$@" > /var/lib/backplane/frontend/copy-ran\necho "startup copy ran" >&2\n')
        stub.chmod(0o755)

    def start(self, *docker_args):
        root = Path(self.temp.name)
        name = 'backplane-volume-test-' + uuid.uuid4().hex[:8]
        self.addCleanup(lambda: subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True))
        port = run_detached(name, '-e', 'BACKEND_URL=http://127.0.0.1:8000', *docker_args, '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/nginx.conf.template:/etc/nginx/nginx.conf.template:ro', '-v', f'{root}/python3:/usr/local/bin/python3:ro', '-v', f'{FRONTEND}/scripts/start-frontend.sh:/usr/local/bin/start-frontend.sh:ro', 'nginx:alpine', '/bin/sh', '/usr/local/bin/start-frontend.sh')
        wait_until_serving(port, name)
        return name

    def volume(self):
        volume = tempfile.TemporaryDirectory()
        self.addCleanup(volume.cleanup)
        return Path(volume.name)

    def test_mounted_volume_is_retained_without_the_flag(self):
        volume = self.volume()
        self.start('-v', f'{volume}:/var/lib/backplane/frontend')
        self.assertIn('/usr/share/nginx/html/.asset-history /var/lib/backplane/frontend', (volume / 'copy-ran').read_text())

    def test_explicit_false_wins_over_a_mounted_volume(self):
        volume = self.volume()
        self.start('-e', 'RETAIN_ASSETS_TO_VOLUME=false', '-v', f'{volume}:/var/lib/backplane/frontend')
        self.assertFalse((volume / 'copy-ran').exists())

    def test_in_memory_mount_is_not_auto_retained_and_says_why(self):
        name = self.start('--tmpfs', '/var/lib/backplane/frontend')
        logs = container_logs(name)
        self.assertNotIn('startup copy ran', logs)
        self.assertIn('RETAIN_ASSETS_TO_VOLUME', logs)
        self.assertIn('tmpfs', logs)


UPSTREAM_FOR_BUFFERING = r"""server {
    listen 8081;
    client_max_body_size 0;
    location = /api/large { root /srv; try_files /large.bin =404; }
    location / { return 200 "ok\n"; }
}
"""
LARGE_RESPONSE_BYTES = 16 * 1024 * 1024
UPLOAD_BYTES = 2 * 1024 * 1024


class ProxyBufferingTests(unittest.TestCase):
    """Cloud Run's filesystem is memory: nginx must stream /api/ bodies instead of
    spooling them to proxy/client temp files (nginx logs each spill at warn level)."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        (root / 'html').mkdir()
        (root / 'html/index.html').write_text('<html>app</html>')
        (root / 'srv').mkdir()
        (root / 'srv/large.bin').write_bytes(b'x' * LARGE_RESPONSE_BYTES)
        (root / 'upstream.conf').write_text(UPSTREAM_FOR_BUFFERING)
        (root / 'nginx.conf.template').write_text((FRONTEND / 'nginx.conf').read_text())
        render_and_run = (
            "envsubst '${BACKEND_URL} ${EDGE_PROXY_SECRET}' "
            '< /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf '
            "&& exec nginx -g 'daemon off;'"
        )
        cls.name = 'backplane-buffering-test-' + uuid.uuid4().hex[:8]
        cls.port = run_detached(cls.name, '-e', 'BACKEND_URL=http://127.0.0.1:8081', '-v', f'{root}/html:/usr/share/nginx/html:ro', '-v', f'{root}/srv:/srv:ro', '-v', f'{root}/upstream.conf:/etc/nginx/conf.d/upstream.conf:ro', '-v', f'{root}/nginx.conf.template:/etc/nginx/nginx.conf.template:ro', 'nginx:alpine', 'sh', '-c', render_and_run)
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'rm', '-f', cls.name], check=True, capture_output=True))
        wait_until_serving(cls.port, cls.name)

    def test_large_api_response_to_a_slow_client_is_not_spooled_to_disk(self):
        with socket.create_connection(('127.0.0.1', self.port), timeout=10) as client:
            client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            client.sendall(b'GET /api/large HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n')
            time.sleep(1.5)
            received = 0
            while chunk := client.recv(1 << 20):
                received += len(chunk)
        self.assertGreater(received, LARGE_RESPONSE_BYTES)
        self.assertNotIn('upstream response is buffered to a temporary file', container_logs(self.name))

    def test_api_upload_streams_to_the_backend_without_a_temp_file(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        connection.request('POST', '/api/upload', body=b'y' * UPLOAD_BYTES, headers={'Content-Type': 'application/octet-stream'})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        connection.close()
        self.assertNotIn('client request body is buffered to a temporary file', container_logs(self.name))

    def test_upload_cap_still_rejects_oversized_bodies(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        connection.putrequest('POST', '/api/upload')
        connection.putheader('Content-Length', str(26 * 1024 * 1024))
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 413)
        connection.close()


if __name__ == '__main__':
    unittest.main()
