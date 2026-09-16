// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export interface AlertThreshold {
  id: string;
  workspace_id: string;
  board_id: string | null;
  name: string;
  metric: string;
  operator: string;
  value: number;
  is_active: boolean;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface AlertThresholdCreate {
  name: string;
  metric: string;
  operator: string;
  value: number;
  board_id?: string;
}

export interface AlertThresholdUpdate {
  name?: string;
  metric?: string;
  operator?: string;
  value?: number;
  is_active?: boolean;
}

export async function fetchAlertThresholds(slug: string, boardId?: string) {
  const params = boardId ? { board_id: boardId } : undefined;
  const { data } = await api.get<AlertThreshold[]>(
    `/workspaces/${slug}/alerts/thresholds`,
    { params },
  );
  return data;
}

export async function createAlertThreshold(
  slug: string,
  payload: AlertThresholdCreate,
) {
  const { data } = await api.post<AlertThreshold>(
    `/workspaces/${slug}/alerts/thresholds`,
    payload,
  );
  return data;
}

export async function updateAlertThreshold(
  slug: string,
  thresholdId: string,
  payload: AlertThresholdUpdate,
) {
  const { data } = await api.patch<AlertThreshold>(
    `/workspaces/${slug}/alerts/thresholds/${thresholdId}`,
    payload,
  );
  return data;
}

export async function deleteAlertThreshold(
  slug: string,
  thresholdId: string,
) {
  await api.delete(`/workspaces/${slug}/alerts/thresholds/${thresholdId}`);
}
