// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { presentSheet } from "../../shell/layers";
import type { BindTarget } from "./bind-flow";
import { BindSheet } from "./BindSheet";

export function openBindSheet(target: BindTarget, opener: HTMLElement | null, onBound: () => void = () => {}): void {
  presentSheet(({ close }) => <BindSheet target={target} close={close} opener={opener} onBound={onBound} />);
}
