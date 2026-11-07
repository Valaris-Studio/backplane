# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

# Operator-managed headless Companion (README.md, "Headless"). The build
# context is companion/, never the repository root:
#
#   docker build --platform linux/amd64 -f headless/Dockerfile \
#     --build-arg COMPANION_VERSION=0.1.0 --build-arg COMPANION_COMMIT="$(git rev-parse HEAD)" \
#     -t backplane-companion-headless:0.1.0 .
#
# headless/Dockerfile.dockerignore limits that context to the Go sources and
# the build scripts. Building fetches Go modules and the checksum-pinned
# Beacon source archive; the image itself never fetches anything.

ARG GO_IMAGE=golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
# A dedicated UID, shared with nothing else: not distroless's nonroot user
# (65532) and never a coding agent's user (10000 in the worker image).
ARG COMPANION_UID=10001

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETOS
ARG TARGETARCH
# Must equal beacon-source.json and internal/beacon.Commit; checked below.
ARG BEACON_COMMIT=b17031414618cf86f7aad2b485935e548e8a8e63
ARG BEACON_ARCHIVE_SHA256=91fea2299c43196ca88547fd28c5e96124dd3c18888ff0ee9b3e0daf6b44765c
ARG COMPANION_VERSION=0.0.0-headless
ARG COMPANION_COMMIT=
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src/companion
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ADD --checksum=sha256:${BEACON_ARCHIVE_SHA256} \
    https://codeload.github.com/Asymptote-Labs/agent-beacon/tar.gz/${BEACON_COMMIT} /src/beacon-source.tar.gz

# beacon-hooks exactly as scripts/build_beacon.py builds it (same flags, same
# artifact.json), reusing its helpers. Only its extraction differs:
# download_source passes tarfile's filter="data", which bookworm's Python
# 3.11.2 lacks, so GNU tar extracts the archive whose checksum ADD and this
# step both verified.
RUN <<'EOF' python3
import json, os, re, shutil, subprocess, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from build_beacon import collect_dependency_notices, require_go_toolchain, run, sha256

spec = json.loads(Path("beacon-source.json").read_text(encoding="utf-8"))
compiled = re.search(r'const Commit = "([0-9a-f]{40})"', Path("internal/beacon/beacon.go").read_text(encoding="utf-8"))
archive = Path("/src/beacon-source.tar.gz")
expected_url = "https://codeload.github.com/Asymptote-Labs/agent-beacon/tar.gz/" + os.environ["BEACON_COMMIT"]
if (not compiled or {spec["commit"], compiled.group(1)} != {os.environ["BEACON_COMMIT"]} or spec["archive_url"] != expected_url
        or spec["archive_sha256"] != os.environ["BEACON_ARCHIVE_SHA256"] or sha256(archive) != spec["archive_sha256"] or spec["patches"]):
    sys.exit("the Dockerfile's Beacon pins disagree with beacon-source.json")
subprocess.run(["tar", "-xzf", str(archive), "-C", "/src", "--no-same-owner", "--no-same-permissions"], check=True)

environment = dict(os.environ, GOOS=os.environ["TARGETOS"], GOARCH=os.environ["TARGETARCH"], CGO_ENABLED="0", GOTOOLCHAIN="local")
platform = json.loads(run("go", "env", "-json", "GOOS", "GOARCH", "GOVERSION", "GOROOT", env=environment))
require_go_toolchain(platform["GOVERSION"])
source_root = Path("/src/agent-beacon-" + spec["commit"])
module = source_root / spec["component"]
output = Path("/out/beacon")
notices = output / "licenses"
notices.mkdir(parents=True)
binary = output / "beacon-hooks"
run("go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", str(binary), ".", cwd=module, env=environment)
shutil.copyfile(source_root / "LICENSE", notices / "beacon-MIT.txt")
shutil.copyfile(Path(platform["GOROOT"]) / "LICENSE", notices / "go-LICENSE.txt")
dependencies = collect_dependency_notices(module, output, notices, environment)
artifact = {
    "path": binary.name, "sha256": sha256(binary),
    "source_commit": spec["commit"], "source_archive_sha256": spec["archive_sha256"],
    "goos": platform["GOOS"], "goarch": platform["GOARCH"], "go_version": platform["GOVERSION"],
    "cgo_enabled": False, "build_flags": ["-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-buildid="],
    "dependencies": dependencies,
    "notices": [{"path": "licenses/beacon-MIT.txt", "sha256": sha256(notices / "beacon-MIT.txt")}, {"path": "licenses/go-LICENSE.txt", "sha256": sha256(notices / "go-LICENSE.txt")}],
}
(output / "artifact.json").write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
EOF

# The companion with build_bundle.py's flags: no build tags, so the
# devkeyring file store is not compiled in.
RUN GOOS="$TARGETOS" GOARCH="$TARGETARCH" GOFLAGS=-mod=readonly go build -trimpath -buildvcs=false \
      -ldflags="-buildid= -X github.com/Valaris-Studio/backplane/companion/internal/buildinfo.Version=${COMPANION_VERSION} -X github.com/Valaris-Studio/backplane/companion/internal/buildinfo.Commit=${COMPANION_COMMIT}" \
      -o /out/backplane-companion ./cmd/backplane-companion \
 && go version -m /out/backplane-companion > /tmp/companion.buildinfo \
 && grep -q 'CGO_ENABLED=0' /tmp/companion.buildinfo \
 && ! grep -q -e '-tags' /tmp/companion.buildinfo

# Every linked module's license, through the same allowlist gate as bundles.
RUN <<'EOF' python3
import os, sys
from pathlib import Path
sys.path.insert(0, "scripts")
import bundle, licenses
from build_beacon import run

stage = Path("/out")
beacon_license = Path("/src/agent-beacon-" + os.environ["BEACON_COMMIT"]) / "LICENSE"
infos = {"backplane-companion": licenses.read_build_info(stage / "backplane-companion"),
         "beacon-hooks": licenses.read_build_info(stage / "beacon" / "beacon-hooks")}
(stage / "LICENSES").mkdir()
preset = {Path("LICENSE").resolve(): "LICENSES/backplane-companion-MIT.txt", beacon_license: "LICENSES/beacon-MIT.txt",
          Path(run("go", "env", "GOROOT")) / "LICENSE": "LICENSES/go-BSD-3-Clause.txt"}
for source, name in preset.items():
    (stage / name).write_bytes(source.read_bytes())
entries = licenses.inventory(infos, run("go", "env", "GOMODCACHE"), beacon_license=beacon_license)
placed = bundle.copy_licenses(entries, stage, preset)
header = ["Backplane companion headless image: third-party notices", "",
          "backplane-companion: MIT (LICENSES/backplane-companion-MIT.txt)",
          "beacon-hooks: MIT, Asymptote Labs agent-beacon " + os.environ["BEACON_COMMIT"] + " (LICENSES/beacon-MIT.txt)",
          "Go standard library and runtime: BSD-3-Clause (LICENSES/go-BSD-3-Clause.txt)", "",
          "Every Go module linked into these binaries follows, with its license text."]
(stage / "THIRD_PARTY_NOTICES.txt").write_text(bundle.notices(header, entries, placed), encoding="utf-8")
EOF

# The image's files, staged with the owners and modes they ship with (COPY
# keeps them; a COPY into a new directory would not keep that directory's
# mode). Everything installed is root-owned and unwritable for the
# companion, even on a writable root. The data root is 0700 for the
# companion's UID, which a new named volume copies; the token mount point
# is readable by that group only.
ARG COMPANION_UID
RUN install -d -m 0755 /rootfs/opt /rootfs/var/lib /rootfs/run/backplane-companion \
 && cp -R /out /rootfs/opt/backplane-companion \
 && find /rootfs/opt/backplane-companion -type d -exec chmod 0555 {} + \
 && find /rootfs/opt/backplane-companion -type f -exec chmod 0444 {} + \
 && chmod 0555 /rootfs/opt/backplane-companion/backplane-companion /rootfs/opt/backplane-companion/beacon/beacon-hooks \
 && install -d -o "$COMPANION_UID" -g "$COMPANION_UID" -m 0700 /rootfs/var/lib/backplane-companion \
 && install -d -o 0 -g "$COMPANION_UID" -m 0750 /rootfs/run/backplane-companion/token \
 && chown -R 0:0 /rootfs/opt

FROM ${RUNTIME_IMAGE}
ARG COMPANION_UID
COPY --from=build /rootfs/ /
ENV BACKPLANE_COMPANION_HOME=/var/lib/backplane-companion \
    HOME=/var/empty
USER ${COMPANION_UID}:${COMPANION_UID}
ENTRYPOINT ["/opt/backplane-companion/backplane-companion"]
CMD ["run", "--headless-config", "/etc/backplane-companion/config.json"]
