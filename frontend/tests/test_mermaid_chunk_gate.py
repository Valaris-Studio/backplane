# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[2]


def verify_all_frontend_commands():
    verify = (REPO / 'scripts' / 'verify-all.sh').read_text()
    body = re.search(r'^job_frontend\(\) \{\n(.*?)^\}', verify, re.S | re.M).group(1)
    return [line.strip().removesuffix('|| exit 1').strip() for line in body.splitlines()]


# Text-parsed rather than yaml.safe_load: this suite also runs in Cloud Build's
# bare python image, which has no PyYAML.
def ci_frontend_commands():
    workflow = (REPO / '.github' / 'workflows' / 'ci.yml').read_text()
    body = re.search(r'^  frontend:\n(.*?)(?=^  \S|\Z)', workflow, re.S | re.M).group(1)
    return [match.strip() for match in re.findall(r'^\s+run: (.+)$', body, re.M)]


GATES = {
    'scripts/verify-all.sh job_frontend': verify_all_frontend_commands,
    '.github/workflows/ci.yml frontend job': ci_frontend_commands,
}


class MermaidChunkGateWiringTests(unittest.TestCase):
    def test_bundle_isolation_check_runs_on_fresh_build_output(self):
        for gate, commands_of in GATES.items():
            with self.subTest(gate=gate):
                commands = commands_of()
                self.assertIn('pnpm check:mermaid-chunk', commands)
                self.assertGreater(commands.index('pnpm check:mermaid-chunk'), commands.index('pnpm build'))

    def test_bundle_isolation_checker_has_its_own_tests_in_the_gate(self):
        for gate, commands_of in GATES.items():
            with self.subTest(gate=gate):
                commands = commands_of()
                self.assertIn('node --test scripts/check-mermaid-chunk.test.mjs', commands)
                self.assertLess(
                    commands.index('node --test scripts/check-mermaid-chunk.test.mjs'),
                    commands.index('pnpm build'),
                )


if __name__ == '__main__':
    unittest.main()
