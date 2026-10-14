#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Build (and optionally publish) a Backplane Companion desktop release: the
notarized DMG plus the signed in-app update archive, and the channel's
latest.json the app's updater polls.

    scripts/release-companion-desktop.sh VERSION [--channel stable|beta] [--notes TEXT] [--publish]

Without --publish this is a dry run: it builds, writes latest.json next to
the artifacts and prints the planned uploads. --publish uploads everything
under gs://backplane-artifacts/companion-desktop/v$VERSION/ (public bucket),
then the channel's latest.json last, so no client ever sees a manifest
pointing at a file that is not there yet. --publish requires
BACKPLANE_RELEASE_PROJECT, the GCP project that owns the bucket; the active
gcloud project must match it.
"""

import argparse
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import build_bundle
import build_desktop
import licenses
import macos_signing

BUCKET_URL = "gs://backplane-artifacts/companion-desktop"
PUBLIC_URL = "https://storage.googleapis.com/backplane-artifacts/companion-desktop"
CHANNELS = ("stable", "beta")
# Names the GCP project that owns the bucket. Not hard-coded: a publish from
# any other active gcloud project must fail closed.
PROJECT_VARIABLE = "BACKPLANE_RELEASE_PROJECT"
# The channel manifest mutates every release; GCS would otherwise serve it
# from a 1 h edge cache and hide the update. Versioned files are immutable.
NO_CACHE = "no-cache, max-age=0"
# The updater looks up `{os}-{arch}`; one universal archive serves both.
DARWIN_PLATFORMS = ("darwin-aarch64", "darwin-x86_64")
_VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?")
DEFAULT_OUTPUT = build_bundle.COMPANION / "dist" / "desktop-release"


class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class Upload:
    source: str
    destination: str
    cache_control: str | None = None


@dataclass(frozen=True)
class ReleasePlan:
    manifest: dict
    uploads: list


def _version(text):
    if not _VERSION.fullmatch(text):
        raise argparse.ArgumentTypeError(f"{text!r} is not a version like 0.2.0 (no leading v)")
    return text


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", type=_version)
    parser.add_argument("--channel", choices=CHANNELS, default="stable")
    parser.add_argument("--notes", help="release notes shown in the app (default: 'Backplane Companion VERSION')")
    parser.add_argument("--publish", action="store_true", help="upload to GCS; without it, a dry run")
    parser.add_argument("--skip-notarize", action="store_true", help="dry runs only: sign without notarizing")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args(argv)
    if arguments.publish and arguments.skip_notarize:
        parser.error("--publish ships a notarized build; drop --skip-notarize")
    return arguments


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def artifact_name(version, suffix):
    # Object names without spaces keep the public URLs unescaped.
    return f"Backplane-Companion-{version}-universal{suffix}"


def latest_manifest(version, notes, pub_date, archive_url, signature):
    signature = signature.strip()
    if not signature:
        raise ReleaseError("the update archive's signature is empty")
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {platform: {"url": archive_url, "signature": signature} for platform in DARWIN_PLATFORMS},
    }


def manifest_text(manifest):
    return json.dumps(manifest, indent=2) + "\n"


def plan_release(built, version, channel, notes, output):
    archive_name = artifact_name(version, ".app.tar.gz")
    manifest = latest_manifest(version, notes, utc_now(), f"{PUBLIC_URL}/v{version}/{archive_name}",
                               Path(built["updater_signature"]).read_text(encoding="utf-8"))
    manifest_path = output / "latest.json"
    manifest_path.write_text(manifest_text(manifest), encoding="utf-8")
    versioned = f"{BUCKET_URL}/v{version}"
    uploads = [
        Upload(built["updater_archive"], f"{versioned}/{archive_name}"),
        Upload(built["updater_signature"], f"{versioned}/{archive_name}.sig"),
        Upload(built["dmg"], f"{versioned}/{artifact_name(version, '.dmg')}"),
        Upload(str(manifest_path), f"{versioned}/latest.json"),
        # Last: flips every client on this channel to the new release.
        Upload(str(manifest_path), f"{BUCKET_URL}/{channel}/latest.json", NO_CACHE),
    ]
    return ReleasePlan(manifest, uploads)


def _subprocess_run(*command):
    completed = subprocess.run(command, capture_output=True, encoding="utf-8")
    return completed.returncode, completed.stdout


def _checked(run, *command):
    code, stdout = run(*command)
    if code != 0:
        raise ReleaseError(f"{command[0]} {command[1] if len(command) > 1 else ''} failed with exit code {code}")
    return stdout


def publish(plan, version, channel, run, expected_project):
    project = _checked(run, "gcloud", "config", "get-value", "project").strip()
    if project != expected_project:
        raise ReleaseError(f"active gcloud project is {project!r}, expected {expected_project}; aborting")
    # A published archive and signature are a contract with every client.
    code, listing = run("gcloud", "storage", "ls", f"{BUCKET_URL}/v{version}/")
    if code == 0 and listing.strip():
        raise ReleaseError(f"v{version} is already published at {BUCKET_URL}/v{version}/; bump the version")
    for upload in plan.uploads:
        command = ["gcloud", "storage", "cp"]
        if upload.cache_control:
            command.append(f"--cache-control={upload.cache_control}")
        _checked(run, *command, upload.source, upload.destination)
        print(f"  uploaded {upload.destination}")
    # Cache-busted anonymous reads: what a client will actually get.
    nonce = f"nocache={int(time.time())}"
    live = _checked(run, "curl", "-fsS", f"{PUBLIC_URL}/{channel}/latest.json?{nonce}")
    if live != manifest_text(plan.manifest):
        raise ReleaseError(f"the live {channel}/latest.json does not match what was uploaded")
    _checked(run, "curl", "-fsS", "-I", f"{plan.manifest['platforms'][DARWIN_PLATFORMS[0]]['url']}?{nonce}")


def release(arguments, run=_subprocess_run, build=build_desktop.build, environ=os.environ):
    expected_project = environ.get(PROJECT_VARIABLE, "").strip()
    if arguments.publish and not expected_project:
        raise ReleaseError(f"--publish needs {PROJECT_VARIABLE}: the GCP project that owns {BUCKET_URL}")
    build_arguments = build_desktop.parse_arguments(
        ["--output", str(arguments.output), "--version", arguments.version, "--sign", "--updater-artifacts"]
        + (["--skip-notarize"] if arguments.skip_notarize else []))
    built = build(build_arguments)
    notes = arguments.notes or f"Backplane Companion {arguments.version}"
    plan = plan_release(built, arguments.version, arguments.channel, notes, arguments.output.resolve())
    print(f"\nlatest.json ({arguments.channel}):\n{manifest_text(plan.manifest)}")
    print("Planned uploads (in order):")
    for upload in plan.uploads:
        header = f"  [Cache-Control: {upload.cache_control}]" if upload.cache_control else ""
        print(f"  {upload.source} -> {upload.destination}{header}")
    if not arguments.publish:
        print(f"\nDry run complete. Re-run with --publish to upload to {BUCKET_URL}/v{arguments.version}/")
        return plan
    print(f"\nPublishing v{arguments.version} to the {arguments.channel} channel")
    publish(plan, arguments.version, arguments.channel, run, expected_project)
    print(f"Release v{arguments.version} live: {PUBLIC_URL}/{arguments.channel}/latest.json")
    return plan


def main(argv=None):
    release(parse_arguments(argv))


if __name__ == "__main__":
    build_bundle.exit_on_termination()
    try:
        main()
    except (ReleaseError, build_desktop.BuildError, build_bundle.BuildError, licenses.LicenseError, macos_signing.SigningError,
            subprocess.CalledProcessError) as error:
        raise SystemExit(f"release_desktop: {error}")
