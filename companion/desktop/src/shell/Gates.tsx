// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect } from "react";

import { Button } from "../components/Button";
import { autoStartCompanionServiceOnce, serviceStartStore, startCompanionService, type ServiceStartFailure } from "../stores/companion-service";
import { platformCopy } from "../platform/copy";
import { useStoreSelector } from "../stores/external-store";
import { removalFailureSentence } from "./removal-copy";

function failureCopy(failure: ServiceStartFailure): string {
  switch (failure) {
    case "not_in_applications":
      return platformCopy().installFirst;
    case "not_bundled":
      return removalFailureSentence("not_bundled");
    case "failed":
      return "The background service didn't start. Try again in a moment.";
  }
}

export function NotRunning() {
  const start = useStoreSelector(serviceStartStore, (current) => current);

  useEffect(() => {
    void autoStartCompanionServiceOnce();
  }, []);

  return (
    <section data-window-drag className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-title font-semibold">Companion isn't running</h1>
      <p className="text-muted-foreground">The background service will be picked up as soon as it starts.</p>
      {start.state === "failed" ? (
        <p role="alert" className="text-muted-foreground">
          {failureCopy(start.reason)}
        </p>
      ) : null}
      <Button size="sm" loading={start.state === "starting"} onClick={() => void startCompanionService()}>
        Retry
      </Button>
    </section>
  );
}

export function Connecting() {
  return (
    <div data-window-drag className="flex flex-1">
      <p className="m-auto text-muted-foreground">Connecting to Companion…</p>
    </div>
  );
}
