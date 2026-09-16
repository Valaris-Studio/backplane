// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import "./prototype-entry.css";
import "./prototype.css";
import { PrototypeLab } from "./PrototypeLab";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrototypeLab />
  </StrictMode>,
);
