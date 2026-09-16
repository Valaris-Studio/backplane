// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { User } from "@/types/user";

// Success needs no cache priming: the session rides an httpOnly cookie, so
// navigating into the app lets every query refetch as the signed-in user.
export function useLogin() {
  return useMutation({
    mutationFn: async (payload: { email: string; password: string }) => {
      const { data } = await api.post<User>("/auth/login", payload);
      return data;
    },
  });
}
