# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import base64
import json
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import macos_signing  # noqa: E402

IDENTITY = "Developer ID Application: Test Person (TEAM123456)"
KEY_ID = "KEYID12345"
ISSUER = "11111111-2222-3333-4444-555555555555"
P8 = b"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n"
P8_BASE64 = base64.b64encode(P8).decode("ascii")
ENVIRONMENT = {"DEVELOPER_ID_APP": IDENTITY, "AC_API_KEY_ID": KEY_ID, "AC_API_ISSUER": ISSUER, "AC_API_KEY_P8": P8_BASE64}
# The key id, issuer and identity are identifiers (notarytool's argv and the
# signature show them); only the private key is secret.
SECRETS = [P8_BASE64, P8.decode("ascii")]
SUBMISSION = "0a1b2c3d-0000-4000-8000-000000000001"
IDENTITY_SHA1 = "0123456789ABCDEF0123456789ABCDEF01234567"


def completed(command, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(command, returncode, stdout, stderr)


class FakeTools:
    """Stands in for codesign, notarytool, spctl and security; codesign
    appends a marker so a test can tell signed bytes from unsigned ones."""

    def __init__(self, status="Accepted", spctl_source="Notarized Developer ID", verify_exit=0, notarized_requirement_exit=0, echo_secrets=False):
        self.commands = []
        self.status, self.spctl_source, self.verify_exit, self.echo_secrets = status, spctl_source, verify_exit, echo_secrets
        self.notarized_requirement_exit = notarized_requirement_exit
        self.submitted = None
        self.key_seen = None

    def __call__(self, *command):
        self.commands.append(list(command))
        echoed = " ".join(SECRETS) if self.echo_secrets else ""
        if command[0] == "codesign" and "--check-notarization" in command:
            return completed(command, self.notarized_requirement_exit,
                             stderr=f"{command[-1]}: test-requirement: code failed to satisfy specified code requirement(s)\n{echoed}")
        if command[0] == "codesign" and "--verify" in command:
            return completed(command, self.verify_exit, stderr=f"{command[-1]}: valid on disk\n{echoed}")
        if command[0] == "codesign":
            path = Path(command[-1])
            path.write_bytes(path.read_bytes() + b"-signed")
            return completed(command, stderr=f"{path}: replacing existing signature\n")
        if command[:3] == ("xcrun", "notarytool", "submit"):
            archive = Path(command[3])
            with zipfile.ZipFile(archive) as submitted:
                self.submitted = {name: submitted.read(name) for name in submitted.namelist()}
            key = Path(command[command.index("--key") + 1])
            self.key_seen = (key, key.read_bytes(), stat.S_IMODE(key.stat().st_mode))
            return completed(command, 0 if self.status == "Accepted" else 1,
                             stdout=json.dumps({"id": SUBMISSION, "status": self.status, "message": f"Processing complete {echoed}"}))
        if command[:3] == ("xcrun", "notarytool", "log"):
            return completed(command, stdout=json.dumps({"issues": [{"message": "The binary is not signed."}], "echo": echoed}))
        if command[0] == "spctl":
            accepted = self.spctl_source == "Notarized Developer ID"
            return completed(command, 0 if accepted else 3,
                             stderr=f"{command[-1]}: {'accepted' if accepted else 'rejected'}\nsource={self.spctl_source}\n{echoed}")
        if command[0] == "security":
            return completed(command, stdout=f'  1) {IDENTITY_SHA1} "{IDENTITY}"\n     1 valid identities found\n')
        raise AssertionError(f"unexpected tool call {command}")


class EnvironmentTest(unittest.TestCase):
    def test_refuses_off_macos(self):
        with self.assertRaisesRegex(macos_signing.SigningError, "macOS host"):
            macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Linux")

    def test_refuses_without_an_identity(self):
        with self.assertRaisesRegex(macos_signing.SigningError, "DEVELOPER_ID_APP"):
            macos_signing.from_environment({**ENVIRONMENT, "DEVELOPER_ID_APP": ""}, notarize=True, system="Darwin")

    def test_refuses_without_notary_credentials_and_names_only_the_missing_ones(self):
        environment = {"DEVELOPER_ID_APP": IDENTITY, "AC_API_KEY_ID": KEY_ID}
        with self.assertRaises(macos_signing.SigningError) as raised:
            macos_signing.from_environment(environment, notarize=True, system="Darwin")
        message = str(raised.exception)
        self.assertIn("AC_API_ISSUER", message)
        self.assertIn("AC_API_KEY_P8", message)
        self.assertNotIn("AC_API_KEY_ID", message)
        self.assertIn("--skip-notarize", message)
        for secret in SECRETS:
            self.assertNotIn(secret, message)

    def test_refuses_a_key_that_is_not_base64_without_quoting_it(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            macos_signing.from_environment({**ENVIRONMENT, "AC_API_KEY_P8": "not base64!"}, notarize=True, system="Darwin")
        self.assertIn("AC_API_KEY_P8", str(raised.exception))
        self.assertNotIn("not base64!", str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)

    def test_accepts_a_line_wrapped_key(self):
        wrapped = "\n".join(P8_BASE64[i:i + 16] for i in range(0, len(P8_BASE64), 16)) + "\n"
        signing = macos_signing.from_environment({**ENVIRONMENT, "AC_API_KEY_P8": wrapped}, notarize=True, system="Darwin")
        self.assertEqual(signing.notary.p8, P8)

    def test_refuses_a_non_ascii_key_without_quoting_it(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            macos_signing.from_environment({**ENVIRONMENT, "AC_API_KEY_P8": "clé"}, notarize=True, system="Darwin")
        self.assertIn("AC_API_KEY_P8", str(raised.exception))
        self.assertNotIn("clé", str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)

    def test_skipping_notarization_needs_only_the_identity(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": IDENTITY}, notarize=False, system="Darwin")
        self.assertEqual(signing.identity, IDENTITY)
        self.assertIsNone(signing.notary)

    def test_the_configuration_never_shows_its_secrets(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        for text in (repr(signing), str(signing), repr(signing.notary)):
            for secret in SECRETS:
                self.assertNotIn(secret, text)

    def test_preflight_refuses_an_identity_missing_from_the_keychain(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": "Developer ID Application: Someone Else (OTHER)"},
                                                 notarize=False, system="Darwin")
        with mock.patch.object(macos_signing, "tool", FakeTools()):
            with self.assertRaises(macos_signing.SigningError) as raised:
                macos_signing.preflight(signing)
        self.assertIn("DEVELOPER_ID_APP", str(raised.exception))
        self.assertNotIn("Someone Else", str(raised.exception))

    def test_preflight_refuses_an_identity_that_is_not_developer_id(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": "Apple Development: Test Person (TEAM123456)"},
                                                 notarize=False, system="Darwin")
        tools = FakeTools()
        with mock.patch.object(macos_signing, "tool", tools):
            with self.assertRaisesRegex(macos_signing.SigningError, "Developer ID Application"):
                macos_signing.preflight(signing)
        self.assertEqual(tools.commands, [])

    def test_preflight_accepts_an_identity_by_its_sha1(self):
        signing = macos_signing.from_environment({"DEVELOPER_ID_APP": IDENTITY_SHA1.lower()}, notarize=False, system="Darwin")
        with mock.patch.object(macos_signing, "tool", FakeTools()):
            macos_signing.preflight(signing)

    def test_preflight_accepts_a_keychain_identity(self):
        signing = macos_signing.from_environment(ENVIRONMENT, notarize=True, system="Darwin")
        with mock.patch.object(macos_signing, "tool", FakeTools()):
            macos_signing.preflight(signing)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "beacon").mkdir()
        self.binaries = [self.root / "backplane-companion", self.root / "beacon" / "beacon-hooks", self.root / "beacon" / "beacon-otelcol"]
        for binary in self.binaries:
            binary.write_bytes(binary.name.encode("ascii"))
        self.sleep = mock.patch.object(macos_signing.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def release(self, tools, environment=ENVIRONMENT, notarize=True):
        signing = macos_signing.from_environment(environment, notarize=notarize, system="Darwin")
        with mock.patch.object(macos_signing, "tool", tools):
            return macos_signing.release(self.binaries, signing)

    def test_signs_each_binary_with_hardened_runtime_and_a_timestamp_never_deep(self):
        tools = FakeTools()
        self.release(tools)
        signs = [command for command in tools.commands if command[0] == "codesign" and "--verify" not in command]
        self.assertEqual([command[-1] for command in signs], [str(binary) for binary in self.binaries])
        for command in signs:
            self.assertEqual(command[:-1], ["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", IDENTITY])
        self.assertFalse(any("--deep" in command for command in tools.commands))

    def test_notarizes_a_zip_of_the_signed_binaries_with_a_private_key_file_it_then_deletes(self):
        tools = FakeTools()
        notarization = self.release(tools)
        self.assertEqual(notarization, {"id": SUBMISSION, "status": "Accepted"})
        self.assertEqual(sorted(tools.submitted), ["backplane-companion", "beacon-hooks", "beacon-otelcol"])
        self.assertEqual(tools.submitted["beacon-hooks"], b"beacon-hooks-signed")
        key, content, mode = tools.key_seen
        self.assertEqual((content, mode), (P8, 0o600))
        self.assertFalse(key.exists())
        submit = next(command for command in tools.commands if command[:3] == ["xcrun", "notarytool", "submit"])
        self.assertIn("--wait", submit)
        self.assertEqual(submit[submit.index("--key-id") + 1], KEY_ID)
        self.assertEqual(submit[submit.index("--issuer") + 1], ISSUER)
        self.assertNotIn(P8_BASE64, submit)

    def test_verifies_signature_and_gatekeeper_after_notarization(self):
        tools = FakeTools()
        self.release(tools)
        names = [command[0] if command[0] != "xcrun" else command[1] for command in tools.commands]
        self.assertLess(max(i for i, name in enumerate(names) if name == "notarytool"), names.index("spctl"))
        verifies = [command for command in tools.commands if "--verify" in command and "--check-notarization" not in command]
        self.assertEqual([command[:-1] for command in verifies], [["codesign", "--verify", "--strict", "--verbose=2"]] * 3)
        notarized = [command for command in tools.commands if "--check-notarization" in command]
        self.assertEqual([command[:-1] for command in notarized],
                         [["codesign", "--verify", "--strict", "--check-notarization", "--test-requirement==notarized", "--verbose=2"]] * 3)
        self.assertEqual(len([command for command in tools.commands if command[0] == "spctl"]), 3)

    def test_codesign_must_find_the_notarization(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            self.release(FakeTools(notarized_requirement_exit=3, echo_secrets=True))
        self.assertIn("check-notarization", str(raised.exception))
        for secret in SECRETS:
            self.assertNotIn(secret, str(raised.exception))

    def test_without_notarization_skips_gatekeeper_but_still_verifies(self):
        tools = FakeTools()
        self.assertIsNone(self.release(tools, environment={"DEVELOPER_ID_APP": IDENTITY}, notarize=False))
        self.assertFalse(any(command[0] in ("xcrun", "spctl") or "--check-notarization" in command for command in tools.commands))
        self.assertEqual(len([command for command in tools.commands if "--verify" in command]), 3)

    def test_a_rejected_submission_fails_with_the_notary_log_and_no_secret(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            self.release(FakeTools(status="Invalid", echo_secrets=True))
        message = str(raised.exception)
        self.assertIn(SUBMISSION, message)
        self.assertIn("The binary is not signed.", message)
        for secret in SECRETS:
            self.assertNotIn(secret, message)

    def test_gatekeeper_must_see_a_notarized_developer_id(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            self.release(FakeTools(spctl_source="Unnotarized Developer ID", echo_secrets=True))
        self.assertIn("Unnotarized Developer ID", str(raised.exception))
        for secret in SECRETS:
            self.assertNotIn(secret, str(raised.exception))

    def test_a_signature_that_does_not_verify_fails_the_build(self):
        with self.assertRaises(macos_signing.SigningError) as raised:
            self.release(FakeTools(verify_exit=1, echo_secrets=True))
        self.assertIn("codesign --verify", str(raised.exception))
        for secret in SECRETS:
            self.assertNotIn(secret, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
