// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ResourceType = "file" | "folder";

export interface ResourceMetadata {
  tags: string[];
}

export interface Resource {
  id: string;
  workspace_id: string;
  board_id: string | null;
  parent_id: string | null;
  resource_type: ResourceType;
  name: string;
  gcs_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
  metadata: ResourceMetadata;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceCreate {
  name: string;
  resource_type: ResourceType;
  parent_id?: string;
  mime_type?: string;
  size_bytes?: number;
  gcs_path?: string;
  metadata?: ResourceMetadata;
  description?: string;
}

export interface ResourceUpdate {
  name?: string;
  parent_id?: string | null;
  metadata?: ResourceMetadata;
  description?: string | null;
}

export interface ResourceSearchParams {
  q?: string;
  resource_type?: string;
  tag?: string;
}

export interface UploadUrlRequest {
  filename: string;
  content_type: string;
}

export interface UploadUrlResponse {
  upload_url: string;
  gcs_path: string;
}

export interface DownloadUrlResponse {
  download_url: string;
}
