// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export function runnerConfigShellPath(name: string): string {
  const filename = `runner-${name}.yaml`;
  return /^[a-zA-Z0-9_./-]+$/.test(filename)
    ? filename
    : "'" + filename.replaceAll("'", "'\"'\"'") + "'";
}
