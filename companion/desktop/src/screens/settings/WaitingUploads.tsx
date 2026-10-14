// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";

/** The live count of uploads a sign-out or removal would delete. */
export function WaitingUploads() {
  // null once the daemon is gone (Remove stops it): the count is unknown, so nothing is claimed.
  const waiting = useStoreSelector(statusStore, (status) => status?.queue.records ?? null);
  if (waiting === null) return null;
  if (waiting === 0) return <>Nothing is waiting to upload.</>;
  return <>{waiting === 1 ? "1 upload hasn’t been sent yet and will be deleted." : `${waiting} uploads haven’t been sent yet and will be deleted.`}</>;
}
