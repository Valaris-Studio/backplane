# Linux build/check environment for the desktop shell. Ubuntu 22.04 is the
# glibc floor of the supported distros (DK-L1 D2). The tray uses ksni (pure
# D-Bus), so libayatana-appindicator is deliberately absent. dbus provides
# dbus-run-session for tests that need a private session bus. Node and pnpm
# build the webview and run the Tauri CLI for the deb, rpm and AppImage.
FROM ubuntu:22.04

ARG RUST_VERSION=1.98.1
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=11.5.1
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file pkg-config xz-utils \
      libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libxdo-dev \
      dbus \
 && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION" --component clippy \
 && rustc --version

# The tarball is checked against the release's published SHA256SUMS.
RUN case "$TARGETARCH" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported $TARGETARCH" >&2; exit 1 ;; esac \
 && tarball="node-v$NODE_VERSION-linux-$node_arch.tar.xz" \
 && cd /tmp \
 && curl --proto '=https' --tlsv1.2 -sSfO "https://nodejs.org/dist/v$NODE_VERSION/$tarball" \
 && curl --proto '=https' --tlsv1.2 -sSf "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c - \
 && mkdir /usr/local/node \
 && tar -xJf "$tarball" -C /usr/local/node --strip-components=1 \
 && rm "$tarball" \
 && corepack enable pnpm \
 && corepack prepare "pnpm@$PNPM_VERSION" --activate \
 && node --version && pnpm --version

WORKDIR /work
