# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Security floors apply to both the declared dependency and installed wheel."""

from importlib.metadata import version
from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version


def test_cryptography_pin_and_runtime_include_security_fixes():
    # 50.0.0 covers GHSA-g6cj-pr64-35w5; 49.0.0/48.0.1 cover the earlier
    # X509 verification and bundled OpenSSL advisories affecting this pin.
    requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
    dependency = next(
        Requirement(line.split("#", 1)[0].strip())
        for line in requirements.read_text().splitlines()
        if line.startswith("cryptography==")
    )
    declared = next(iter(dependency.specifier)).version
    assert Version(declared) >= Version("50.0.0"), "cryptography pin includes known security advisories"
    assert Version(version("cryptography")) >= Version("50.0.0"), "installed cryptography is still vulnerable"
    assert version("cryptography") in dependency.specifier, "tests must use the declared cryptography version"


def test_starlette_runtime_includes_the_file_response_security_fixes():
    assert Version(version("starlette")) >= Version("1.3.1")


def test_runtime_requirements_exclude_development_tools():
    requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
    names = {
        Requirement(line.split("#", 1)[0].strip()).name
        for line in requirements.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }
    assert not names.intersection({"pytest", "pytest-asyncio", "pytest-cov", "pytest-xdist", "pytest-timeout", "ruff"})
