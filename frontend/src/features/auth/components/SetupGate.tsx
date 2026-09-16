// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { useSetupStatus } from "../api/use-setup-status";

// On a fresh instance, "/" would mount authenticated pages whose queries 403
// against an empty users table before FirstRunRedirect can navigate to /setup.
// This gate holds routes on the fallback until setup status settles, so no
// page query fires while the redirect decision is undecided. Public paths
// (login, setup itself, docs) have no authenticated queries and skip the wait.
const isPublicPath = (pathname: string) =>
  pathname === "/login" ||
  pathname === "/setup" ||
  pathname === "/documentation" ||
  pathname.startsWith("/documentation/");

export function SetupGate({ children }: { children: ReactNode }) {
  const { data, error } = useSetupStatus();
  const { pathname } = useLocation();

  // Settled means data OR error — a failed setup-status check fails open
  // rather than stranding the app on a spinner.
  const settled = data !== undefined || error !== null;
  if (!settled && !isPublicPath(pathname)) {
    return <RouteFallback />;
  }

  return <>{children}</>;
}
