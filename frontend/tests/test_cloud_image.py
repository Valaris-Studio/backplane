# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/resolve-cloud-image.py'


class CloudImageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('cloud_image', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_bootstrap_has_no_predecessor(self):
        self.assertIsNone(self.module.serving_revision([]))

    def test_uses_serving_revision_not_latest_ready_candidate(self):
        service = {'status': {'latestReadyRevisionName': 'not-serving', 'traffic': [{'revisionName': 'serving', 'percent': 100}, {'revisionName': 'candidate', 'tag': 'preview'}]}}
        self.assertEqual(self.module.serving_revision([service]), 'serving')

    def test_refuses_ambiguous_traffic_instead_of_silently_dropping_history(self):
        for traffic in [[], [{'revisionName': 'first', 'percent': 50}, {'revisionName': 'second', 'percent': 50}]]:
            with self.assertRaises(ValueError):
                self.module.serving_revision([{'status': {'traffic': traffic}}])

    def test_requires_immutable_image_identity(self):
        with self.assertRaises(ValueError):
            self.module.image_digest({'status': {'imageDigest': 'example/image:latest'}})
        digest = 'example/image@sha256:' + 'a' * 64
        self.assertEqual(self.module.image_digest({'status': {'imageDigest': digest}}), digest)

    def test_deploy_refuses_a_predecessor_that_changed_during_the_build(self):
        self.module.check_predecessor('same', 'same')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.module.check_predecessor('newly-serving', 'built-from')
