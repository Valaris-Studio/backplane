// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  // Null until the key's first authenticated call. The MCP connection wizard
  // reads this to decide whether a user still needs to be walked through the
  // connection or has already made it.
  last_used_at: string | null;
}

export interface ApiKeyCreated extends ApiKey {
  raw_key: string;
}
