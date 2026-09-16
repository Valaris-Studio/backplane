// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import type { Activity } from "@/types/activity";
import { formatNumber } from "@/lib/format";
import activityMessageContract from "../activity-message-contract.json";

type ActivityMessageKey = keyof typeof activityMessageContract;
type ParamType = "string" | "number" | "boolean" | "nullable_string" | "string_array";
type InterpolationValue = string | number | boolean | null;

export const ACTIVITY_MESSAGE_KEYS = Object.keys(
  activityMessageContract,
) as ActivityMessageKey[];

function isActivityMessageKey(key: string): key is ActivityMessageKey {
  return Object.hasOwn(activityMessageContract, key);
}

function matchesType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "nullable_string":
      return value === null || typeof value === "string";
    case "string_array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

function interpolationParams(
  activity: Activity,
  key: ActivityMessageKey,
  t: TFunction,
): Record<string, InterpolationValue> | null {
  const rawParams = activity.message_params;
  if (!rawParams) return null;

  const contract = activityMessageContract[key];
  const params: Record<string, InterpolationValue> = {};
  for (const [name, type] of Object.entries(contract.params)) {
    const value = rawParams[name];
    if (!matchesType(value, type as ParamType)) return null;

    if (type === "string_array") {
      params[name] = (value as string[]).join(", ");
    } else if (type === "number") {
      params[name] = formatNumber(value as number);
    } else {
      params[name] = value as InterpolationValue;
    }
  }

  if (
    key === "activity.card.moved" &&
    params.from_column_known === false
  ) {
    params.from_column_name = t("timeline.unknownColumn");
  }

  return params;
}

export function resolveActivityMessage(
  activity: Activity,
  t: TFunction,
): string {
  const key = activity.message_key;
  if (!key || !isActivityMessageKey(key)) return activity.summary;

  const params = interpolationParams(activity, key, t);
  if (!params) return activity.summary;

  const contract = activityMessageContract[key] as {
    params: Record<string, ParamType>;
    pluralParam?: string;
  };
  const pluralValue = contract.pluralParam
    ? activity.message_params?.[contract.pluralParam]
    : undefined;
  const count = typeof pluralValue === "number" ? pluralValue : undefined;

  const resolved = t(key, { replace: params, count });
  return typeof resolved === "string" &&
    resolved !== key &&
    !/{{\s*[^}]+}}/.test(resolved)
    ? resolved
    : activity.summary;
}
