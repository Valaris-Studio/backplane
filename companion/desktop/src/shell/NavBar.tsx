// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Icon } from "../components/Icon";
import { pop } from "./navigation";

export function NavBar({ title }: { title: string }) {
  return (
    <div className="bp-navbar">
      <button type="button" className="bp-navbar-back" data-nav-back onClick={pop}>
        <Icon name="chev-left" />
        Back
      </button>
      <h1>{title}</h1>
    </div>
  );
}
