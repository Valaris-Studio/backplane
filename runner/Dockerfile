FROM golang:1.26.8-bookworm AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=dev
# Empty by default so a plain `docker build` still stamps from git/clock; the
# release pipeline passes them explicitly because its context has no .git.
ARG GIT_COMMIT=
ARG BUILD_TIME=
RUN GIT_COMMIT=${GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)} && \
    BUILD_TIME=${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)} && \
    CGO_ENABLED=0 go build \
      -ldflags "-X github.com/Valaris-Studio/backplane/runner/internal/version.Version=${VERSION} \
                -X github.com/Valaris-Studio/backplane/runner/internal/version.GitCommit=${GIT_COMMIT} \
                -X github.com/Valaris-Studio/backplane/runner/internal/version.BuildTime=${BUILD_TIME}" \
      -o /backplane-runner ./cmd/backplane-runner/

# Runtime image: needs git, ssh, python/uv (MCP server), claude CLI (Node.js)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# uv for MCP server — system-wide, so the non-root runner user can exec it
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Coding-agent CLIs via Node.js. CODING_AGENTS picks which npm packages land in
# the image — "claude" (default), "codex", or "claude codex" for both.
ARG CODING_AGENTS="claude"
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s -- lts \
    && for agent in ${CODING_AGENTS}; do \
         case "$agent" in \
           claude) npm install -g @anthropic-ai/claude-code ;; \
           codex)  npm install -g @openai/codex ;; \
           *) echo "unknown coding agent: $agent" >&2; exit 1 ;; \
         esac; \
       done

# gh CLI for PR creation
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

COPY --from=builder /backplane-runner /usr/local/bin/backplane-runner

# runner needs a real home: uvx (MCP server) caches envs under ~/.cache.
# useradd, not adduser: Debian's adduser emits GECOS prompts/warnings into
# the non-interactive build log; useradd is silent and leaves the password
# locked, matching the old --disabled-password posture.
RUN useradd --create-home runner
USER runner

ENTRYPOINT ["backplane-runner"]
CMD ["-config", "/etc/backplane/runner.yaml"]
