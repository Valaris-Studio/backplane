// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const server = setupServer();

export { http, HttpResponse };
