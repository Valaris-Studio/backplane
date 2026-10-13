// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { use, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { FooterSlotContext } from "./footer-slot";

/** Pins content under the scrolling body (Home's totals); renders nothing outside the app shell. */
export function ShellFooter({ children }: { children: ReactNode }) {
  const slot = use(FooterSlotContext);
  return slot ? createPortal(children, slot) : null;
}
