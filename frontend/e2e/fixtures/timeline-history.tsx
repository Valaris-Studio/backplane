// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "../../src/index.css";
import "../../src/i18n/config";
import { TimelineSimulator } from "../../src/features/timeline/components/TimelineSimulator";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><BrowserRouter><main className="p-4"><TimelineSimulator slug="test-ws" boardId="development" /></main></BrowserRouter></QueryClientProvider>,
);
