// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from "@/i18n/config";

type DateInput = Date | number | string;

export interface FormattedNumberSegments {
  prefix: string;
  number: string;
  suffix: string;
}

const NUMERIC_PART_TYPES = new Set<Intl.NumberFormatPartTypes>([
  "integer",
  "group",
  "decimal",
  "fraction",
  "nan",
  "infinity",
]);

function applicationLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? "en";
}

function splitNumberSegments(
  formatter: Intl.NumberFormat,
  value: number,
): FormattedNumberSegments {
  const parts = formatter.formatToParts(value);
  const firstNumericPart = parts.findIndex((part) =>
    NUMERIC_PART_TYPES.has(part.type),
  );
  let lastNumericPart = parts.length - 1;
  while (lastNumericPart >= 0) {
    const part = parts[lastNumericPart];
    if (part && NUMERIC_PART_TYPES.has(part.type)) break;
    lastNumericPart -= 1;
  }

  if (firstNumericPart === -1) {
    return { prefix: "", number: formatter.format(value), suffix: "" };
  }

  return {
    prefix: parts
      .slice(0, firstNumericPart)
      .map((part) => part.value)
      .join(""),
    number: parts
      .slice(firstNumericPart, lastNumericPart + 1)
      .map((part) => part.value)
      .join(""),
    suffix: parts
      .slice(lastNumericPart + 1)
      .map((part) => part.value)
      .join(""),
  };
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(applicationLocale(), options).format(value);
}

export function formatPercentage(
  ratio: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(applicationLocale(), {
    ...options,
    style: "percent",
  }).format(ratio);
}

export function formatPercentageSegments(
  ratio: number,
  options?: Intl.NumberFormatOptions,
): FormattedNumberSegments {
  const formatter = new Intl.NumberFormat(applicationLocale(), {
    ...options,
    style: "percent",
  });
  return splitNumberSegments(formatter, ratio);
}

export function formatUsd(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(applicationLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
    style: "currency",
    currency: "USD",
  }).format(value);
}

export function formatUsdSegments(
  value: number,
  options?: Intl.NumberFormatOptions,
): FormattedNumberSegments {
  const formatter = new Intl.NumberFormat(applicationLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
    style: "currency",
    currency: "USD",
  });
  return splitNumberSegments(formatter, value);
}

export function createDateTimeFormatter(
  options?: Intl.DateTimeFormatOptions,
  resolvedLocale: string = applicationLocale(),
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(resolvedLocale, options);
}

export function formatDate(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleDateString(applicationLocale(), options);
}

export function formatTime(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleTimeString(applicationLocale(), options);
}

export function formatDateTime(
  value: DateInput,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleString(applicationLocale(), options);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const unitOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (bytes < 1024 * 1024)
    return `${formatNumber(bytes / 1024, unitOptions)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${formatNumber(bytes / (1024 * 1024), unitOptions)} MB`;
  return `${formatNumber(bytes / (1024 * 1024 * 1024), unitOptions)} GB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60)
    return `${formatNumber(seconds, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${formatNumber(minutes)}m ${formatNumber(remainderSeconds)}s`;
}
