// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Two-character monogram for avatar fallbacks: word initials from the display
// name, else the first two characters of the email.
export function getInitials(
  name: string | null | undefined,
  email = "",
): string {
  if (name) {
    return name
      .split(" ")
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}
