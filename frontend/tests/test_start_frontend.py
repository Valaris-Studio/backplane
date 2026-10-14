# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'start-frontend.sh'
REPO = SCRIPT.parents[2]


class StartFrontendAssetCopyTests(unittest.TestCase):
    """Cloud Run has no volume: a startup copy lands in the in-memory filesystem
    and OOM-killed the 256Mi frontend, so only a mounted volume opts in."""

    def run_script(self, extra_env):
        with tempfile.TemporaryDirectory() as temporary:
            stubs = Path(temporary)
            marker = stubs / 'copy-ran'
            python_stub = stubs / 'python3'
            python_stub.write_text(f'#!/bin/sh\necho "$@" > "{marker}"\nexit 0\n')
            python_stub.chmod(0o755)
            # Outside the image the script stops at envsubst (no template); the copy decision comes first.
            env = {'PATH': f'{stubs}:/usr/bin:/bin', **extra_env}
            result = subprocess.run(['/bin/sh', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30, check=False)
            return (marker.read_text() if marker.exists() else None), result

    def copy_arguments(self, extra_env):
        return self.run_script(extra_env)[0]

    def test_copy_is_skipped_by_default_without_a_volume(self):
        # This host has no /var/lib/backplane/frontend; the volume auto-detect is covered in nginx-integration.py.
        self.assertIsNone(self.copy_arguments({}))
        self.assertIsNone(self.copy_arguments({'RETAIN_ASSETS_TO_VOLUME': ''}))

    def test_explicit_false_disables_the_copy(self):
        for value in ('false', 'FALSE', 'False', '0', 'no', 'NO'):
            with self.subTest(value=value):
                self.assertIsNone(self.copy_arguments({'RETAIN_ASSETS_TO_VOLUME': value}))

    def test_truthy_values_enable_the_copy_case_insensitively(self):
        for value in ('true', 'TRUE', 'True', '1', 'yes', 'YES'):
            with self.subTest(value=value):
                arguments = self.copy_arguments({'RETAIN_ASSETS_TO_VOLUME': value})
                self.assertIsNotNone(arguments)
                self.assertIn('/usr/local/bin/retain-assets.py /usr/share/nginx/html/.asset-history /var/lib/backplane/frontend', arguments)

    def test_unrecognized_value_refuses_to_start(self):
        marker, result = self.run_script({'RETAIN_ASSETS_TO_VOLUME': 'maybe'})
        self.assertIsNone(marker)
        self.assertEqual(result.returncode, 1)
        self.assertIn('RETAIN_ASSETS_TO_VOLUME must be', result.stderr)


class ComposeVolumeOptInTests(unittest.TestCase):
    def test_every_compose_file_mounting_the_asset_volume_opts_in(self):
        mounting = [path for path in REPO.glob('docker-compose*.yml') if ':/var/lib/backplane/frontend' in path.read_text()]
        if not mounting:
            self.skipTest('compose files are not part of this checkout')
        for path in mounting:
            with self.subTest(compose=path.name):
                self.assertRegex(path.read_text(), r'RETAIN_ASSETS_TO_VOLUME:\s*"true"')


if __name__ == '__main__':
    unittest.main()
