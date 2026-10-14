// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type PairingState = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface PairingRequest {
  name: string | null;
  platform: string;
  arch: string;
  requested_at: string;
  expires_at: string;
  state: PairingState;
}

// The code always travels in a POST body, never in a URL (access logs).
const PAIRING = "/me/companion/pairing";
const pairingKey = (userCode: string) => ["companion-pairing", userCode] as const;

export function useCompanionPairing(userCode: string | null) {
  return useQuery({
    queryKey: pairingKey(userCode ?? ""),
    queryFn: async () => {
      const { data } = await api.post<PairingRequest>(`${PAIRING}/lookup`, {
        user_code: userCode,
      });
      return data;
    },
    enabled: userCode !== null,
    // Every lookup of a wrong code counts toward a small per-user cap.
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useDecidePairing(userCode: string, decision: "approve" | "deny") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<PairingRequest>(`${PAIRING}/${decision}`, {
        user_code: userCode,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(pairingKey(userCode), data),
  });
}
