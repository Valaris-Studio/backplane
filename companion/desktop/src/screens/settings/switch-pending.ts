// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

/** The code the daemon holds for an open Switch server sheet; closing the sheet while it waits cancels it. */
export class PendingCode {
  private current: string | null = null;

  hold(id: string): void {
    this.current = id;
  }

  holds(id: string): boolean {
    return this.current === id;
  }

  /** Forgets the code (approved, settled by the daemon, or cancelled) and returns what was held. */
  release(): string | null {
    const id = this.current;
    this.current = null;
    return id;
  }
}
