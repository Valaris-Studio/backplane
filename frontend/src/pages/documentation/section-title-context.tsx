// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext, type ReactNode } from "react";

interface DocumentationSectionHeadingCopy {
  title: string;
  eyebrow?: string;
}

const DocumentationSectionTitleContext =
  createContext<DocumentationSectionHeadingCopy | undefined>(undefined);

export function DocumentationSectionTitleProvider({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <DocumentationSectionTitleContext.Provider value={{ title, eyebrow }}>
      {children}
    </DocumentationSectionTitleContext.Provider>
  );
}

export function useDocumentationSectionTitle(sourceTitle: string) {
  return useContext(DocumentationSectionTitleContext)?.title ?? sourceTitle;
}

export function useDocumentationSectionEyebrow(sourceEyebrow?: ReactNode) {
  return useContext(DocumentationSectionTitleContext)?.eyebrow ?? sourceEyebrow;
}
