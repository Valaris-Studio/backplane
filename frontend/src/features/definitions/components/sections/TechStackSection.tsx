// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { TagInput } from "@/components/shared/TagInput";

interface Props {
  items: string[];
  onChange: (items: string[]) => void;
}

export function TechStackSection({ items, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <TagInput
      tags={items}
      onChange={onChange}
      placeholder={t("definitions.techStackPlaceholder")}
    />
  );
}
