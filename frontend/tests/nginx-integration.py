# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import http.client
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

FRONTEND = Path(__file__).resolve().parents[1]


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
        config = (FRONTEND / 'nginx.conf').read_text().replace('${BACKEND_URL}', 'http://127.0.0.1:8000')
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
        connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=5)
        connection.request('GET', path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

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

    def test_missing_asset_is_not_html_and_not_cached(self):
        status, headers, body = self.request('/assets/Page-missing1.js')
        self.assertEqual(status, 404)
        self.assertIn('no-store', headers.get('Cache-Control', ''))
        self.assertNotIn(b'current app', body)

    def test_retention_metadata_is_not_public(self):
        self.assertEqual(self.request('/.asset-retention.json')[0], 404)


if __name__ == '__main__':
    unittest.main()
