// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";
import { redirectToLogin } from "./redirect-to-login";

// Ends a local password session. Hard navigation: drops all in-memory state
// alongside the session. The cookie is only cleared by the response; on
// failure the user is still signed in, so stay put and leave the control for
// a retry.
export function performLocalLogout(): void {
  void api
    .post("/auth/logout")
    .then(() => redirectToLogin())
    .catch(() => undefined);
}
