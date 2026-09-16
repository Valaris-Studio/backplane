// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FieldError as FieldErrorPrimitive } from "@/components/ui/field-error";
import { useTranslation } from "react-i18next";
import { resolvePipelineValidationMessage } from "@/lib/localized-errors";
import type { PipelineValidationError } from "../../api/pipelineConfig";

interface FieldErrorProps {
  errors: PipelineValidationError[] | undefined;
}

export function FieldError({ errors }: FieldErrorProps) {
  const { t, i18n } = useTranslation();
  return (
    <FieldErrorPrimitive
      messages={errors?.map((err) =>
        resolvePipelineValidationMessage(err, t, i18n),
      )}
    />
  );
}
