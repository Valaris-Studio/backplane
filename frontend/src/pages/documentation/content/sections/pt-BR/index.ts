// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PT_BR_CONFIGURATION } from "./configuration";
import { PT_BR_CORE_CONCEPTS } from "./core-concepts";
import { PT_BR_EXTENDING } from "./extending";
import { PT_BR_GETTING_STARTED } from "./getting-started";
import { PT_BR_HONEST_REMARKS } from "./honest-remarks";
import { PT_BR_INSTALLING } from "./installing";
import { PT_BR_INTRODUCTION } from "./introduction";
import { PT_BR_OPERATING } from "./operating";
import { PT_BR_REFERENCE } from "./reference";
import { PT_BR_UNDER_THE_HOOD } from "./under-the-hood";
import type { DocumentationSectionTranslationBundle } from "../types";

export const PT_BR_SECTION_TRANSLATIONS = {
  ...PT_BR_INTRODUCTION,
  ...PT_BR_CORE_CONCEPTS,
  ...PT_BR_INSTALLING,
  ...PT_BR_GETTING_STARTED,
  ...PT_BR_CONFIGURATION,
  ...PT_BR_OPERATING,
  ...PT_BR_UNDER_THE_HOOD,
  ...PT_BR_EXTENDING,
  ...PT_BR_REFERENCE,
  ...PT_BR_HONEST_REMARKS,
} satisfies DocumentationSectionTranslationBundle;
