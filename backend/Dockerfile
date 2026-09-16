FROM python:3.12-slim AS deps

# git + gh are runtime prerequisites of the merge-queue worker
# (merge_executor.py shells out to both); python:3.12-slim ships neither,
# which made every merge attempt fail with "[Errno 2] No such file or
# directory" (field report 2026-08-08). gh comes from GitHub's
# apt repo — Debian carries no gh package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM deps
WORKDIR /app
COPY . .

# useradd, not adduser: Debian's adduser emits GECOS prompts/warnings into
# the non-interactive build log. useradd is silent and leaves the password
# locked, matching the old --disabled-password posture.
RUN useradd --no-create-home appuser

# A named volume mounted here inherits ownership from the image path on first
# use — without this it lands root-owned and appuser cannot write resources.
RUN mkdir -p /data/resources && chown appuser /data/resources

USER appuser

CMD ["sh", "start-prod.sh"]
