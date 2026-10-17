# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest


FRONTEND = Path(__file__).resolve().parents[1]
SCRIPT = FRONTEND / 'scripts' / 'retain-assets.py'
DOCKERFILE = FRONTEND / 'Dockerfile'
MANIFEST = '.asset-retention.json'
GRACE_SECONDS = 7 * 24 * 60 * 60
SHARED = 'shared-ssssssss.css'
OLD_ACTIVE = 'Page-aaaaaaaa.js'
FIRST_ACTIVE = 'Page-bbbbbbbb.js'
SECOND_ACTIVE = 'Page-cccccccc.js'
EXPIRED = 'expired-eeeeeeee.js'
REVIVED = 'revived-rrrrrrrr.js'


class AssetRetentionCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = time.time()

    def release(self, name, files):
        root = self.root / name
        (root / 'assets').mkdir(parents=True)
        for filename, body in files.items():
            (root / 'assets' / filename).write_bytes(body)
        (root / 'index.html').write_text('<html>current entry</html>')
        return root

    def predecessor(self, name='previous', nested=False):
        expiry = {f'History-{index:08d}.js': self.now + (index + 1) * 3600 for index in range(7)}
        files = {filename: f'historical bytes {filename}'.encode() for filename in expiry}
        files.update({OLD_ACTIVE: b'previous active', SHARED: b'shared bytes', EXPIRED: b'expired bytes', REVIVED: b'revived bytes'})
        root = self.release(name + ('/.asset-history' if nested else ''), files)
        (root / MANIFEST).write_text(json.dumps({
            'active': [OLD_ACTIVE, SHARED],
            'expires': {**expiry, EXPIRED: self.now - 3600, REVIVED: self.now - 3600},
        }))
        return (root.parent if nested else root), root, expiry, files

    def run_cli(self, source, destination, *options):
        return subprocess.run(
            [sys.executable, '-B', str(SCRIPT), str(source), str(destination), *map(str, options)],
            text=True, capture_output=True, timeout=10, check=False,
        )

    def image_options(self, previous):
        # Execute the actual image-assembly option list, so missing Docker opt-in
        # reaches real retention behavior rather than only argparse rejection.
        instructions = DOCKERFILE.read_text().replace('\\\n', ' ').splitlines()
        commands = [shlex.split(line)[1:] for line in instructions if line.startswith('RUN python /retain-assets.py ')]
        self.assertEqual(len(commands), 1, 'Expected one image retention command')
        command = commands[0]
        self.assertEqual(command[:4], ['python', '/retain-assets.py', '/current', '/retained'])
        return [str(previous) if token == '/previous' else token for token in command[4:]]

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_preserved(self, destination, expiries, files):
        manifest = json.loads((destination / MANIFEST).read_text())
        for name, expiry in expiries.items():
            with self.subTest(asset=name):
                self.assertIn(name, manifest['expires'], f'Unexpired predecessor URL was removed: {name}')
                self.assertEqual(manifest['expires'][name], expiry, f'Inherited deadline changed: {name}')
                self.assertEqual((destination / 'assets' / name).read_bytes(), files[name])
        return manifest

    def snapshot(self, root):
        result = {}
        for path in [root, *root.rglob('*')] if root.is_dir() and not root.is_symlink() else [root]:
            name = str(path.relative_to(root))
            if path.is_symlink():
                result[name] = ('symlink', os.readlink(path))
            elif path.is_file():
                result[name] = ('file', hashlib.sha256(path.read_bytes()).hexdigest())
            elif path.is_dir():
                result[name] = ('directory',)
        return result

    def assert_refused_without_destination(self, result, destination, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('unrecognized arguments', result.stderr, 'The option must be recognized before its input contract is tested')
        self.assertRegex(result.stderr.lower(), message)
        self.assertFalse(os.path.lexists(destination), 'Refused inputs must not create the destination')

    def test_two_fresh_image_assemblies_preserve_every_unexpired_group_and_deadline(self):
        previous, history, expiries, files = self.predecessor(nested=True)
        # A nested history is authoritative over the predecessor's direct root.
        (previous / 'assets').mkdir()
        (previous / 'assets' / 'decoy-dddddddd.js').write_bytes(b'not history')
        before = self.snapshot(previous)
        first = self.release('first', {FIRST_ACTIVE: b'first active', SHARED: files[SHARED], REVIVED: files[REVIVED]})
        destination = self.root / 'image-one' / '.asset-history'
        began = time.time()
        self.assert_success(self.run_cli(first, destination, *self.image_options(previous)))
        ended = time.time()
        manifest = self.assert_preserved(destination, expiries, files)
        self.assertEqual(set(manifest['active']), {FIRST_ACTIVE, SHARED, REVIVED})
        self.assertGreaterEqual(manifest['expires'][OLD_ACTIVE], began + GRACE_SECONDS)
        self.assertLessEqual(manifest['expires'][OLD_ACTIVE], ended + GRACE_SECONDS)
        self.assertEqual((destination / 'assets' / OLD_ACTIVE).read_bytes(), files[OLD_ACTIVE])
        self.assertNotIn(SHARED, manifest['expires'])
        self.assertNotIn(REVIVED, manifest['expires'])
        self.assertFalse((destination / 'assets' / EXPIRED).exists())
        self.assertFalse((destination / 'assets' / 'decoy-dddddddd.js').exists())
        self.assertFalse((destination / 'index.html').exists())
        self.assertEqual(self.snapshot(previous), before)

        second = self.release('second', {SECOND_ACTIVE: b'second active', SHARED: files[SHARED]})
        second_destination = self.root / 'image-two' / '.asset-history'
        first_before = self.snapshot(destination)
        self.assert_success(self.run_cli(second, second_destination, *self.image_options(destination)))
        inherited = {**expiries, OLD_ACTIVE: manifest['expires'][OLD_ACTIVE]}
        second_manifest = self.assert_preserved(second_destination, inherited, files)
        self.assertEqual(set(second_manifest['active']), {SECOND_ACTIVE, SHARED})
        self.assertEqual(set(second_manifest['expires']), {*inherited, FIRST_ACTIVE, REVIVED})
        self.assertEqual(second_manifest['expires'][FIRST_ACTIVE], second_manifest['expires'][REVIVED])
        self.assertEqual((second_destination / 'assets' / FIRST_ACTIVE).read_bytes(), b'first active')
        self.assertEqual((second_destination / 'assets' / REVIVED).read_bytes(), files[REVIVED])
        self.assertEqual((second_destination / 'assets' / SHARED).read_bytes(), files[SHARED])
        self.assertEqual(self.snapshot(destination), first_before)

    def test_explicit_preservation_keeps_direct_history_with_shorter_new_grace(self):
        previous, _, expiries, files = self.predecessor()
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        destination = self.root / 'retained'
        self.assert_success(self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired', '--max-retired-releases', '2', '--grace-seconds', '60'))
        manifest = self.assert_preserved(destination, expiries, files)
        self.assertIn(OLD_ACTIVE, manifest['expires'])
        self.assertLess(manifest['expires'][OLD_ACTIVE], min(expiries.values()))
        self.assertNotIn(EXPIRED, manifest['expires'])

    def test_preservation_accepts_an_empty_nginx_bootstrap_predecessor(self):
        previous = self.root / 'nginx'
        previous.mkdir()
        (previous / 'index.html').write_text('Welcome to nginx')
        (previous / '50x.html').write_text('nginx error page')
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        destination = self.root / 'retained'
        self.assert_success(self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired'))
        self.assertEqual(json.loads((destination / MANIFEST).read_text()), {'active': [FIRST_ACTIVE], 'expires': {}})
        self.assertEqual((destination / 'assets' / FIRST_ACTIVE).read_bytes(), b'current')
        self.assertFalse((destination / 'index.html').exists())

    def test_unflagged_cli_still_caps_retired_groups_at_five(self):
        previous, _, expiries, _ = self.predecessor()
        current = self.release('current', {FIRST_ACTIVE: b'current', SHARED: b'shared bytes'})
        destination = self.root / 'retained'
        self.assert_success(self.run_cli(current, destination, '--previous', previous))
        manifest = json.loads((destination / MANIFEST).read_text())
        self.assertEqual(len(set(manifest['expires'].values())), 5)
        self.assertEqual(set(manifest['expires']), {OLD_ACTIVE, *list(expiries)[-4:]})
        self.assertEqual(set(p.name for p in (destination / 'assets').iterdir()), {FIRST_ACTIVE, SHARED, *manifest['expires']})

    def test_docker_image_assembly_explicitly_opts_in(self):
        options = self.image_options('/reviewed-predecessor')
        self.assertEqual(options.count('--preserve-unexpired'), 1)
        self.assertIn('--previous', options)

    def test_preservation_requires_previous_before_creating_destination(self):
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        destination = self.root / 'retained'
        result = self.run_cli(current, destination, '--preserve-unexpired')
        self.assert_refused_without_destination(result, destination, r'previous')

    def test_preservation_refuses_every_existing_destination_unchanged(self):
        previous, _, _, _ = self.predecessor()
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        for kind in ['directory', 'file', 'symlink', 'dangling-symlink']:
            with self.subTest(kind=kind):
                destination = self.root / ('destination-' + kind)
                target = self.root / ('target-' + kind)
                if kind == 'directory':
                    destination.mkdir()
                    (destination / 'owned.txt').write_text('preserve me')
                elif kind == 'file':
                    destination.write_text('preserve me')
                elif kind == 'symlink':
                    target.mkdir()
                    (target / 'owned.txt').write_text('preserve me')
                    destination.symlink_to(target, target_is_directory=True)
                else:
                    destination.symlink_to(target, target_is_directory=True)
                before = self.snapshot(destination)
                target_before = self.snapshot(target)
                result = self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired')
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('unrecognized arguments', result.stderr)
                self.assertRegex(result.stderr.lower(), r'destination|exist|fresh')
                self.assertEqual(self.snapshot(destination), before)
                self.assertEqual(self.snapshot(target), target_before)

    def test_preservation_refuses_current_source_history_including_manifest_symlink(self):
        previous, _, _, _ = self.predecessor()
        for kind in ['manifest', 'dangling-symlink']:
            with self.subTest(kind=kind):
                current = self.release('current-' + kind, {FIRST_ACTIVE: b'current'})
                if kind == 'manifest':
                    (current / MANIFEST).write_text(json.dumps({'active': [FIRST_ACTIVE], 'expires': {}}))
                else:
                    (current / MANIFEST).symlink_to(current / 'missing.json')
                before = self.snapshot(current)
                destination = self.root / ('retained-' + kind)
                result = self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired')
                self.assert_refused_without_destination(result, destination, r'source|current|manifest')
                self.assertEqual(self.snapshot(current), before)

    def test_original_nonpositive_cap_and_grace_are_refused_before_mutation(self):
        previous, _, _, _ = self.predecessor()
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        for option in ['--max-retired-releases', '--grace-seconds']:
            for value in ['0', '-1']:
                with self.subTest(option=option, value=value):
                    destination = self.root / (option + value)
                    result = self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired', option, value)
                    self.assert_refused_without_destination(result, destination, r'positive')

    def test_malformed_predecessor_inventory_is_refused_before_mutation(self):
        current = self.release('current', {FIRST_ACTIVE: b'current'})
        for kind in ['wrong-active-type', 'unsafe-name', 'missing-file', 'symlink-file', 'nonfinite-expiry']:
            with self.subTest(kind=kind):
                previous, history, _, _ = self.predecessor('previous-' + kind, nested=True)
                state = json.loads((history / MANIFEST).read_text())
                if kind == 'wrong-active-type':
                    state['active'] = OLD_ACTIVE
                elif kind == 'unsafe-name':
                    state['active'] = ['../outside.js']
                elif kind == 'missing-file':
                    (history / 'assets' / OLD_ACTIVE).unlink()
                elif kind == 'symlink-file':
                    (history / 'assets' / OLD_ACTIVE).unlink()
                    (history / 'assets' / OLD_ACTIVE).symlink_to(history / 'assets' / SHARED)
                else:
                    state['expires'][OLD_ACTIVE] = float('inf')
                (history / MANIFEST).write_text(json.dumps(state))
                before = self.snapshot(previous)
                destination = self.root / ('retained-' + kind)
                result = self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired')
                self.assert_refused_without_destination(result, destination, r'invalid')
                self.assertEqual(self.snapshot(previous), before)

    def test_hashed_asset_collision_refuses_new_bytes_and_preserves_inputs(self):
        previous = self.release('previous', {OLD_ACTIVE: b'original immutable bytes'})
        current = self.release('current', {OLD_ACTIVE: b'colliding replacement'})
        before = (self.snapshot(previous), self.snapshot(current))
        destination = self.root / 'retained'
        result = self.run_cli(current, destination, '--previous', previous, '--preserve-unexpired')
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.lower(), r'collision')
        self.assertEqual((self.snapshot(previous), self.snapshot(current)), before)
        if (destination / 'assets' / OLD_ACTIVE).exists():
            self.assertEqual((destination / 'assets' / OLD_ACTIVE).read_bytes(), b'original immutable bytes')


if __name__ == '__main__':
    unittest.main()
