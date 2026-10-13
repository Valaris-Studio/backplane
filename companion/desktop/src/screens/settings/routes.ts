// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { registerRoute } from "../../shell/routes";
import { SettingsScreen } from "./index";

registerRoute("settings", { title: "Settings", component: SettingsScreen });
