// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Icon } from "./Icon";

export type ToastTone = "success" | "info" | "error";

const TOAST_ICON = { success: "check", info: "info", error: "alert" } as const;

export function ToastView({ message, tone = "success" }: { message: string; tone?: ToastTone }) {
  return (
    <>
      <Icon name={TOAST_ICON[tone]} />
      <span>{message}</span>
    </>
  );
}
