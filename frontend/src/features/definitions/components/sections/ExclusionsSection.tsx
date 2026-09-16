// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { EditableList } from "@/components/shared/EditableList";

interface Props {
  items: string[];
  onChange: (items: string[]) => void;
}

export function ExclusionsSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <EditableList
      items={items}
      onChange={onChange}
      placeholder={t("definitions.exclusionPlaceholder")}
    />
  );
}
