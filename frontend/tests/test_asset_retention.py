# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'retain-assets.py'


class AssetRetentionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('retain_assets', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'archive'

    def release(self, name, files):
        root = self.root / name
        (root / 'assets').mkdir(parents=True)
        for filename, content in files.items():
            (root / 'assets' / filename).write_text(content)
        return root

    def test_retired_chunks_get_full_grace_after_long_running_release(self):
        first = self.release('first', {'Page-aaaaaaaa.js': 'old'})
        second = self.release('second', {'Page-bbbbbbbb.js': 'new'})
        self.module.retain_assets(first, self.archive, now=0, grace=100)
        self.module.retain_assets(second, self.archive, now=1000, grace=100)
        self.assertEqual((self.archive / 'assets/Page-aaaaaaaa.js').read_text(), 'old')
        self.module.retain_assets(second, self.archive, now=1099, grace=100)
        self.assertTrue((self.archive / 'assets/Page-aaaaaaaa.js').exists())
        self.module.retain_assets(second, self.archive, now=1100, grace=100)
        self.assertFalse((self.archive / 'assets/Page-aaaaaaaa.js').exists())
        self.assertTrue((self.archive / 'assets/Page-bbbbbbbb.js').exists())

    def test_repeated_upgrades_keep_deadlines_and_shared_dependencies(self):
        first = self.release('first', {'Page-aaaaaaaa.js': 'a', 'shared-ssssssss.css': 'shared'})
        second = self.release('second', {'Page-bbbbbbbb.js': 'b', 'shared-ssssssss.css': 'shared'})
        third = self.release('third', {'Page-cccccccc.js': 'c'})
        self.module.retain_assets(first, self.archive, now=0, grace=100)
        self.module.retain_assets(second, self.archive, now=10, grace=100)
        self.module.retain_assets(third, self.archive, now=50, grace=100)
        self.module.retain_assets(third, self.archive, now=110, grace=100)
        self.assertFalse((self.archive / 'assets/Page-aaaaaaaa.js').exists())
        self.assertTrue((self.archive / 'assets/Page-bbbbbbbb.js').exists())
        self.assertTrue((self.archive / 'assets/shared-ssssssss.css').exists())
        self.module.retain_assets(third, self.archive, now=150, grace=100)
        self.assertEqual([p.name for p in (self.archive / 'assets').iterdir()], ['Page-cccccccc.js'])

    def test_only_the_most_recent_retired_releases_survive_inside_the_grace_window(self):
        releases = [self.release(f'r{index}', {f'Page-{index}aaaaaaa.js': str(index), 'shared-ssssssss.css': 'shared'}) for index in range(6)]
        for index, release in enumerate(releases):
            self.module.retain_assets(release, self.archive, now=index, grace=1000, max_retired_releases=3)
        kept = sorted(p.name for p in (self.archive / 'assets').iterdir())
        self.assertEqual(kept, ['Page-2aaaaaaa.js', 'Page-3aaaaaaa.js', 'Page-4aaaaaaa.js', 'Page-5aaaaaaa.js', 'shared-ssssssss.css'])
        manifest = json.loads((self.archive / '.asset-retention.json').read_text())
        self.assertEqual(sorted(manifest['expires']), ['Page-2aaaaaaa.js', 'Page-3aaaaaaa.js', 'Page-4aaaaaaa.js'])

    def test_release_cap_applies_to_seeded_history_and_defaults_to_five(self):
        self.assertEqual(self.module.DEFAULT_MAX_RETIRED_RELEASES, 5)
        for index in range(8):
            self.module.retain_assets(self.release(f'r{index}', {f'Page-{index}aaaaaaa.js': str(index)}), self.archive, now=index, grace=1000, max_retired_releases=10)
        self.assertEqual(len(list((self.archive / 'assets').iterdir())), 8)
        rebuilt = self.root / 'rebuilt'
        self.module.retain_assets(self.archive, rebuilt, now=10, grace=1000)
        self.module.retain_assets(self.release('next', {'Page-9aaaaaaa.js': 'next'}), rebuilt, now=10, grace=1000)
        kept = sorted(p.name for p in (rebuilt / 'assets').iterdir())
        self.assertEqual(kept, [f'Page-{index}aaaaaaa.js' for index in (3, 4, 5, 6, 7, 9)])

    def test_release_cap_must_be_positive(self):
        with self.assertRaises(ValueError):
            self.module.retain_assets(self.release('r', {'Page-aaaaaaaa.js': 'a'}), self.archive, now=0, grace=100, max_retired_releases=0)

    def test_baked_history_survives_empty_cloud_instance_without_resetting_expiry(self):
        first = self.release('first', {'Page-aaaaaaaa.js': 'a'})
        second = self.release('second', {'Page-bbbbbbbb.js': 'b'})
        self.module.retain_assets(first, self.archive, now=0, grace=100)
        self.module.retain_assets(second, self.archive, now=10, grace=100)
        cold_instance = self.root / 'cold-instance'
        self.module.retain_assets(self.archive, cold_instance, now=90, grace=100)
        self.assertTrue((cold_instance / 'assets/Page-aaaaaaaa.js').exists())
        self.module.retain_assets(self.archive, cold_instance, now=110, grace=100)
        self.assertFalse((cold_instance / 'assets/Page-aaaaaaaa.js').exists())

    def test_bootstrap_copies_only_assets_and_rejects_hash_collisions(self):
        first = self.release('first', {'Page-aaaaaaaa.js': 'a'})
        (first / 'index.html').write_text('old html')
        self.module.retain_assets(first, self.archive, now=0, grace=100)
        self.assertFalse((self.archive / 'index.html').exists())
        changed = self.release('collision', {'Page-aaaaaaaa.js': 'different'})
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.module.retain_assets(changed, self.archive, now=10, grace=100)
        self.assertEqual((self.archive / 'assets/Page-aaaaaaaa.js').read_text(), 'a')

    def test_malformed_manifest_and_symlinks_fail_closed(self):
        first = self.release('first', {'Page-aaaaaaaa.js': 'a'})
        (first / '.asset-retention.json').write_text(json.dumps({'active': ['../outside'], 'expires': {}}))
        with self.assertRaises(ValueError):
            self.module.retain_assets(first, self.archive, now=0, grace=100)
        (first / '.asset-retention.json').unlink()
        (first / 'assets/secret-aaaaaaaa.js').symlink_to(first / 'index.html')
        with self.assertRaises(ValueError):
            self.module.retain_assets(first, self.archive, now=0, grace=100)
