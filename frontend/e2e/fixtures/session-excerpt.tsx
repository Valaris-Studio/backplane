// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import "../../src/index.css";
import i18n from "../../src/i18n/config";
import { api } from "../../src/lib/api";
import type { AgentSession } from "../../src/types/agent-session";
import { SessionTranscript } from "../../src/features/sessions/components/SessionTranscript";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const parameters = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = parameters.get("theme") === "dark" ? "dark" : "light";

function Fixture() {
  const session = useQuery({
    queryKey: ["session-excerpt-fixture"],
    queryFn: async () => (await api.get<AgentSession>("/workspaces/excerpt-fixture/sessions/selected-demo")).data,
  });
  return <main className="mx-auto grid max-w-5xl gap-5 p-4 sm:p-8">
    <header className="grid gap-2">
      <h1 className="text-2xl font-bold">Private session excerpt</h1>
      <p className="text-sm text-muted-foreground">Synthetic local data · actual reader and HTTP client · no uploads</p>
    </header>
    {session.data ? <SessionTranscript slug="excerpt-fixture" session={session.data} /> : <p role="status">{session.error ? "Start the local fixture API on port 8772." : "Loading synthetic session…"}</p>}
    <Toaster />
  </main>;
}

void i18n.changeLanguage(parameters.get("locale") ?? "en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={client}><BrowserRouter><Fixture /></BrowserRouter></QueryClientProvider>,
  );
});
