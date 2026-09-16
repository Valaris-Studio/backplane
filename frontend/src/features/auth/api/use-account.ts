// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useChangePassword() {
  return useMutation({
    mutationFn: async (payload: {
      current_password: string;
      new_password: string;
    }) => {
      await api.post("/auth/change-password", payload);
    },
  });
}
