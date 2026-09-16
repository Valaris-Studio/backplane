// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment } from "react";
import { useDocumentationSectionTranslator } from "../section-localization";
import { useDocumentationCopy } from "../use-documentation-copy";
import type { ToolParamDoc } from "./data";

export function ParamsGrid({ params }: { params: ToolParamDoc[] }) {
  const { copy } = useDocumentationCopy();
  const translate = useDocumentationSectionTranslator();
  if (params.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {copy.mcpReference.noParameters}
      </p>
    );
  }
  return (
    <div data-doc-table-columns="3" className="grid grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-sm">
      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {copy.mcpReference.parameterName}
      </span>
      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {copy.mcpReference.parameterRequired}
      </span>
      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {copy.mcpReference.parameterDescription}
      </span>
      {params.map((param) => (
        <Fragment key={param.name}>
          <code className="font-mono text-[0.82rem] text-foreground">
            {param.name}
          </code>
          <span className="text-xs text-muted-foreground">
            {param.required
              ? copy.mcpReference.requiredValue
              : copy.mcpReference.optionalValue}
          </span>
          <span className="text-foreground/85">
            {translate(param.description)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
