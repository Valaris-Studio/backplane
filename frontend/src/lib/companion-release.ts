// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// THE single frontend pin of the public Companion release. Contract-tested
// against companion/README.md, so bumping one without the other fails.
// Only macOS ships a packaged desktop app; Linux and Windows build from source.
export const COMPANION_RELEASE = {
  version: "0.1.1-preview.2",
  macDownloadUrl:
    "https://storage.googleapis.com/backplane-artifacts/companion-desktop/v0.1.1-preview.2/Backplane-Companion-0.1.1-preview.2-universal.dmg",
  sourceUrl: "https://github.com/Valaris-Studio/backplane/tree/main/companion",
  docsSlug: "capturing-sessions-with-companion",
} as const;
