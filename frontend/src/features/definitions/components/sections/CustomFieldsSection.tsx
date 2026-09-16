// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { KeyValueList } from "@/components/shared/KeyValueList";
import type { CustomField } from "@/types/definition";

interface Props {
  items: CustomField[];
  onChange: (items: CustomField[]) => void;
}

export function CustomFieldsSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <KeyValueList
      items={items}
      onChange={onChange}
      keyPlaceholder={t("definitions.customFieldKeyPlaceholder")}
      valuePlaceholder={t("definitions.customFieldValuePlaceholder")}
    />
  );
}
