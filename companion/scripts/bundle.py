# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Bundle pieces that need no toolchain: checksums, license files, the
manifest, the notices file and reproducible archives."""

import gzip
import hashlib
import io
import tarfile
import zipfile
from pathlib import Path

from licenses import FLAGGED

CHECKSUMS = "SHA256SUMS"
MANIFEST = "manifest.json"
# Archive entries carry no build-time metadata, so equal inputs give equal bytes.
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _files(stage):
    return sorted(path for path in stage.rglob("*") if path.is_file() and path.relative_to(stage).as_posix() != CHECKSUMS)


def write_checksums(stage):
    """SHA256SUMS in `sha256sum -c` format for every file but itself."""
    sums = {path.relative_to(stage).as_posix(): sha256(path) for path in _files(stage)}
    (stage / CHECKSUMS).write_text("".join(f"{digest}  {name}\n" for name, digest in sums.items()), encoding="utf-8")
    return sums


def verify_checksums(stage):
    """Problems found against SHA256SUMS; empty when the bundle is intact."""
    listed = {}
    for line in (stage / CHECKSUMS).read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        listed[name] = digest
    problems = []
    for name, digest in listed.items():
        path = stage / name
        if not path.is_file():
            problems.append(f"{name}: missing")
        elif sha256(path) != digest:
            problems.append(f"{name}: checksum mismatch")
    for path in _files(stage):
        if path.relative_to(stage).as_posix() not in listed:
            problems.append(f"{path.relative_to(stage).as_posix()}: not listed")
    return problems


def copy_licenses(entries, stage, preset):
    """Copy each module's license and notice files into LICENSES/ under a
    flat, unique name; files in preset already have a bundle path."""
    placed = dict(preset)
    for entry in entries:
        for source in entry.files:
            if source in placed:
                continue
            name = f"LICENSES/{entry.module.replace('/', '_')}@{entry.version}-{source.name}"
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
            placed[source] = name
    return placed


def component(stage, name, path, license_id, notices, **extra):
    return {"name": name, "path": path, "sha256": sha256(stage / path), "license": license_id, "notices": notices, **extra}


def manifest(*, version, commit, source_dirty, goos, goarch, go_version, components, entries, placed, macos_signing=None):
    """macos_signing, for a darwin bundle: whether it is signed and its notarization."""
    return {
        "schema": 1,
        "name": "backplane-companion",
        "version": version,
        "commit": commit,
        "source_dirty": source_dirty,
        "target": {"goos": goos, "goarch": goarch},
        "go_version": go_version,
        "components": components,
        "third_party": [
            {"module": entry.module, "version": entry.version, "license": entry.expression, "licenses": entry.licenses,
             "notices": [placed[path] for path in entry.files], "used_by": entry.used_by}
            for entry in entries
        ],
        "license_flags": [
            {"module": entry.module, "version": entry.version, "license": spdx, "note": FLAGGED[spdx]}
            for entry in entries for spdx in entry.licenses if spdx in FLAGGED
        ],
        **({"macos_signing": macos_signing} if macos_signing is not None else {}),
    }


def notices(header, entries, placed):
    parts = ["\n".join(header), ""]
    for entry in entries:
        parts += [
            "=" * 78,
            f"{entry.module} {entry.version}",
            f"License: {entry.expression}",
            f"Used by: {', '.join(entry.used_by)}",
        ]
        for path in entry.files:
            parts += ["-" * 78, placed[path], "", path.read_text(encoding="utf-8", errors="replace").rstrip(), ""]
    return "\n".join(parts) + "\n"


def _mode(path):
    return 0o755 if path.stat().st_mode & 0o100 else 0o644


def archive(stage, destination, goos):
    """A tar.gz (a zip for Windows) of stage under its own directory name."""
    destination.mkdir(parents=True, exist_ok=True)
    prefix = stage.name
    if goos == "windows":
        target = destination / (prefix + ".zip")
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    info = zipfile.ZipInfo(f"{prefix}/{path.relative_to(stage).as_posix()}", _ZIP_EPOCH)
                    info.external_attr = (0o100000 | _mode(path)) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    output.writestr(info, path.read_bytes())
        return target
    target = destination / (prefix + ".tar.gz")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as output:
        for path in sorted(stage.rglob("*")):
            name = f"{prefix}/{path.relative_to(stage).as_posix()}"
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            if path.is_dir():
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                output.addfile(info)
            else:
                data = path.read_bytes()
                info.size, info.mode = len(data), _mode(path)
                output.addfile(info, io.BytesIO(data))
    with target.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
        compressed.write(buffer.getvalue())
    return target
