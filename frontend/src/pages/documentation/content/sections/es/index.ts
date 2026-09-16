// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ES_CONFIGURATION } from "./configuration";
import { ES_CORE_CONCEPTS } from "./core-concepts";
import { ES_EXTENDING } from "./extending";
import { ES_GETTING_STARTED } from "./getting-started";
import { ES_HONEST_REMARKS } from "./honest-remarks";
import { ES_INSTALLING } from "./installing";
import { ES_INTRODUCTION } from "./introduction";
import { ES_OPERATING } from "./operating";
import { ES_REFERENCE } from "./reference";
import { ES_UNDER_THE_HOOD } from "./under-the-hood";
import type { DocumentationSectionTranslationBundle } from "../types";

export const ES_SECTION_TRANSLATIONS = {
  ...ES_INTRODUCTION,
  ...ES_CORE_CONCEPTS,
  ...ES_INSTALLING,
  ...ES_GETTING_STARTED,
  ...ES_CONFIGURATION,
  ...ES_OPERATING,
  ...ES_UNDER_THE_HOOD,
  ...ES_EXTENDING,
  ...ES_REFERENCE,
  ...ES_HONEST_REMARKS,
} satisfies DocumentationSectionTranslationBundle;
