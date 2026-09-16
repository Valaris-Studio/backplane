// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RunnerArtifact {
  os: "macOS" | "Linux" | "Windows";
  arch: "arm64" | "amd64";
  filename: string;
}

// THE single frontend pin of the released runner version. Every download link
// derives from it, and the getting-started walkthrough is contract-tested to
// mention `runner/v<version>` — bump it here and the docs must move with it.
export const RUNNER_RELEASE = {
  version: "0.8.4",
  baseUrl: "https://storage.googleapis.com/backplane-artifacts/runner",
  artifacts: [
    { os: "macOS", arch: "arm64", filename: "backplane-runner-darwin-arm64" },
    { os: "macOS", arch: "amd64", filename: "backplane-runner-darwin-amd64" },
    { os: "Linux", arch: "arm64", filename: "backplane-runner-linux-arm64" },
    { os: "Linux", arch: "amd64", filename: "backplane-runner-linux-amd64" },
    { os: "Windows", arch: "arm64", filename: "backplane-runner-windows-arm64.exe" },
    { os: "Windows", arch: "amd64", filename: "backplane-runner-windows-amd64.exe" },
  ] as RunnerArtifact[],
};

export function runnerArtifactUrl(artifact: RunnerArtifact): string {
  return `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/${artifact.filename}`;
}

export function runnerChecksumsUrl(): string {
  return `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/SHA256SUMS`;
}
