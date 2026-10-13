# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Developer ID signing and notarization of a darwin bundle's binaries.

The identity and the App Store Connect API key come from the environment.
The key id, issuer and identity are identifiers: notarytool's argv and the
signature itself show them. Only the private key is secret, and every tool
failure is reported with it redacted.

    DEVELOPER_ID_APP   "Developer ID Application: NAME (TEAMID)", in the keychain
    AC_API_KEY_ID      App Store Connect API key id
    AC_API_ISSUER      its issuer id
    AC_API_KEY_P8      base64 of the key's .p8 file
"""

import base64
import contextlib
import json
import re
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

IDENTITY_VARIABLE = "DEVELOPER_ID_APP"
DEVELOPER_ID_PREFIX = "Developer ID Application:"
_IDENTITY_SHA1 = re.compile(r"[0-9A-Fa-f]{40}")
NOTARY_VARIABLES = ("AC_API_KEY_ID", "AC_API_ISSUER", "AC_API_KEY_P8")
# A bare Mach-O cannot be stapled, so spctl asks Apple for the ticket online;
# right after acceptance that lookup can briefly still miss.
NOTARIZED_SOURCE = "source=Notarized Developer ID"
GATEKEEPER_ATTEMPTS = 5
GATEKEEPER_RETRY_SECONDS = 15
NOTARY_TIMEOUT = "1h"
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


class SigningError(RuntimeError):
    pass


@dataclass(frozen=True)
class NotaryKey:
    key_id: str
    issuer: str
    p8: bytes = field(repr=False)


@dataclass(frozen=True)
class Signing:
    identity: str
    notary: NotaryKey | None = None

    def secrets(self):
        if not self.notary:
            return []
        return [base64.b64encode(self.notary.p8).decode("ascii"), self.notary.p8.decode("utf-8", errors="replace")]


def tool(*command):
    """Every codesign, notarytool, spctl and security call goes through here."""
    return subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace")


def from_environment(environment, *, notarize, system):
    if system != "Darwin":
        raise SigningError("--sign-macos needs a macOS host (codesign and notarytool)")
    identity = environment.get(IDENTITY_VARIABLE, "")
    if not identity:
        raise SigningError(f"--sign-macos needs {IDENTITY_VARIABLE} set to a 'Developer ID Application: NAME (TEAMID)' identity")
    if not notarize:
        return Signing(identity)
    missing = [name for name in NOTARY_VARIABLES if not environment.get(name)]
    if missing:
        raise SigningError(f"notarization needs {', '.join(missing)} (pass --skip-notarize to sign only, for a local test)")
    try:
        # base64 tools wrap lines; strict decoding would refuse the newlines.
        p8 = base64.b64decode("".join(environment["AC_API_KEY_P8"].split()), validate=True)
    except ValueError:
        # binascii.Error and non-ASCII input both; suppress the cause, it may quote the value.
        raise SigningError("AC_API_KEY_P8 is not valid base64 (it should be base64 of the .p8 file)") from None
    return Signing(identity, NotaryKey(environment["AC_API_KEY_ID"], environment["AC_API_ISSUER"], p8))


def _redact(text, signing):
    for secret in sorted(filter(None, signing.secrets()), key=len, reverse=True):
        text = text.replace(secret, "<redacted>")
    return text


def _checked(signing, what, *command):
    result = tool(*command)
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise SigningError(_redact(f"{what} failed (exit {result.returncode}): {output}", signing))
    return output


def preflight(signing):
    """Fail before a long build when the identity is not a Developer ID in the keychain."""
    by_sha1 = _IDENTITY_SHA1.fullmatch(signing.identity) is not None
    if not by_sha1 and not signing.identity.startswith(DEVELOPER_ID_PREFIX):
        raise SigningError(f"{IDENTITY_VARIABLE} must be a '{DEVELOPER_ID_PREFIX} NAME (TEAMID)' identity or its SHA-1; "
                           "other certificates cannot be notarized")
    identities = _checked(signing, "security find-identity", "security", "find-identity", "-v", "-p", "codesigning")
    listed = f" {signing.identity.upper()} " in identities if by_sha1 else f'"{signing.identity}"' in identities
    if not listed:
        raise SigningError(f"{IDENTITY_VARIABLE} names no valid code-signing identity in the keychain (security find-identity -v -p codesigning)")


def sign(binaries, signing):
    # --options runtime is the hardened runtime notarization requires; never
    # --deep, which signs nested code with the outer code's options.
    for binary in binaries:
        _checked(signing, f"codesign {binary.name}",
                 "codesign", "--force", "--options", "runtime", "--timestamp", "--sign", signing.identity, str(binary))


def scrub_notary_environment(environment):
    """Drop the notary credentials so no child process (go, the collector
    builder, codesign) inherits them; notarytool gets them as arguments."""
    for name in NOTARY_VARIABLES:
        environment.pop(name, None)


@contextlib.contextmanager
def private_key_file(signing):
    """The notary key as an owner-only .p8 in a private temporary directory,
    deleted on exit however the block ends; None when not notarizing."""
    if not signing.notary:
        yield None
        return
    with tempfile.TemporaryDirectory(prefix="backplane-notary-key-") as directory:
        key = Path(directory) / "AuthKey.p8"
        key.touch(mode=0o600, exist_ok=False)
        key.write_bytes(signing.notary.p8)
        yield key


def _submit(submission, signing):
    with private_key_file(signing) as key:
        # The key's path (never its content) is visible in argv; notarytool takes no other form.
        credentials = ["--key", str(key), "--key-id", signing.notary.key_id, "--issuer", signing.notary.issuer]
        result = tool("xcrun", "notarytool", "submit", str(submission), "--wait", "--timeout", NOTARY_TIMEOUT,
                      "--output-format", "json", *credentials)
        try:
            verdict = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise SigningError(_redact(f"notarytool submit failed (exit {result.returncode}): {(result.stdout + result.stderr).strip()}", signing)) from None
        submission_id, status = verdict.get("id"), verdict.get("status")
        if status != "Accepted":
            log = tool("xcrun", "notarytool", "log", submission_id, *credentials) if submission_id else None
            details = (log.stdout + log.stderr).strip() if log else verdict.get("message", "")
            raise SigningError(_redact(f"notarization {submission_id} ended {status}: {details}", signing))
    return {"id": submission_id, "status": status}


def notarize(binaries, signing):
    """Submit the signed binaries as one zip (notarytool takes no tar.gz) and
    wait for the verdict. Nothing is stapled: a bare Mach-O cannot hold a ticket."""
    with tempfile.TemporaryDirectory(prefix="backplane-notary-") as directory:
        submission = Path(directory) / "submission.zip"
        with zipfile.ZipFile(submission, "w", zipfile.ZIP_DEFLATED) as archive:
            for binary in binaries:
                info = zipfile.ZipInfo(binary.name, _ZIP_EPOCH)
                info.external_attr = 0o100755 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, binary.read_bytes())
        return _submit(submission, signing)


def notarize_file(path, signing):
    """Submit a DMG, pkg or zip as it is and wait for the verdict."""
    return _submit(path, signing)


def staple(path, signing):
    _checked(signing, f"stapler staple {Path(path).name}", "xcrun", "stapler", "staple", str(path))


def validate_staple(path, signing):
    _checked(signing, f"stapler validate {Path(path).name}", "xcrun", "stapler", "validate", str(path))


def verify(binaries, signing, notarized):
    for binary in binaries:
        _checked(signing, f"codesign --verify {binary.name}", "codesign", "--verify", "--strict", "--verbose=2", str(binary))
    if notarized:
        for binary in binaries:
            # --check-notarization alone passes an unnotarized binary; the
            # explicit "notarized" requirement is what fails it.
            _checked(signing, f"codesign --check-notarization {binary.name}", "codesign", "--verify", "--strict", "--check-notarization",
                     "--test-requirement==notarized", "--verbose=2", str(binary))
            _assess(binary, signing)


def _assess(binary, signing):
    # --type install, not execute: execute assesses only app bundles and
    # rejects a notarized CLI as "does not seem to be an app".
    for attempt in range(GATEKEEPER_ATTEMPTS):
        result = tool("spctl", "--assess", "--type", "install", "-vv", str(binary))
        output = (result.stdout + result.stderr).strip()
        if result.returncode == 0 and NOTARIZED_SOURCE in output:
            return
        if attempt + 1 < GATEKEEPER_ATTEMPTS:
            time.sleep(GATEKEEPER_RETRY_SECONDS)
    raise SigningError(_redact(f"Gatekeeper does not accept {binary.name} as notarized (spctl exit {result.returncode}): {output}", signing))


def release(binaries, signing):
    """Sign, notarize unless skipped, and verify; the notarization record or None."""
    sign(binaries, signing)
    notarization = notarize(binaries, signing) if signing.notary else None
    verify(binaries, signing, notarized=notarization is not None)
    return notarization
