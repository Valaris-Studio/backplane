// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { CodeExample } from "./callouts/CodeExample";

export type DocumentationSectionTranslations = Readonly<Record<string, string>>;

const DocumentationSectionTranslationContext =
  createContext<DocumentationSectionTranslations>({});

const TECHNICAL_TAGS = new Set(["code", "pre", "kbd", "samp"]);
const TRANSLATABLE_PROPS = new Set([
  "alt",
  "caption",
  "description",
  "eyebrow",
  "label",
  "title",
]);
const HAS_LETTER = /\p{L}/u;

export function DocumentationSectionTranslationProvider({
  translations,
  children,
}: {
  translations: DocumentationSectionTranslations;
  children: ReactNode;
}) {
  return (
    <DocumentationSectionTranslationContext.Provider value={translations}>
      {children}
    </DocumentationSectionTranslationContext.Provider>
  );
}

export function useDocumentationSectionTranslations() {
  return useContext(DocumentationSectionTranslationContext);
}

export function useDocumentationSectionTranslator() {
  const translations = useDocumentationSectionTranslations();
  return useCallback(
    (value: string) => translateDocumentationString(value, translations),
    [translations],
  );
}

export function translateDocumentationString(
  value: string,
  translations: DocumentationSectionTranslations,
) {
  return isNarrativeString(value) ? translations[value] ?? value : value;
}

export function localizeDocumentationNode(
  node: ReactNode,
  translations: DocumentationSectionTranslations,
): ReactNode {
  if (typeof node === "string") {
    return translateDocumentationString(node, translations);
  }

  if (Array.isArray(node)) {
    return Children.map(node, (child) =>
      localizeDocumentationNode(child, translations),
    );
  }

  if (!isValidElement(node)) return node;

  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "string" && TECHNICAL_TAGS.has(element.type)) {
    return element;
  }

  const nextProps: Record<string, unknown> = { ...element.props };
  for (const property of TRANSLATABLE_PROPS) {
    nextProps[property] = localizeTranslatableProp(
      element.props[property],
      translations,
    );
  }

  if (element.type !== CodeExample && element.props.children !== undefined) {
    nextProps.children = Children.map(element.props.children as ReactNode, (child) =>
      localizeDocumentationNode(child, translations),
    );
  }

  return cloneElement(element, nextProps);
}

export function collectDocumentationTranslatableStrings(
  node: ReactNode,
): string[] {
  const strings: string[] = [];
  collectStrings(node, strings);
  return strings;
}

function collectStrings(node: ReactNode, strings: string[]) {
  if (typeof node === "string") {
    if (isNarrativeString(node)) strings.push(node);
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, strings);
    return;
  }

  if (!isValidElement(node)) return;

  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "string" && TECHNICAL_TAGS.has(element.type)) {
    return;
  }

  for (const property of TRANSLATABLE_PROPS) {
    collectTranslatableProp(element.props[property], strings);
  }

  if (element.type !== CodeExample) {
    Children.forEach(element.props.children as ReactNode, (child) =>
      collectStrings(child, strings),
    );
  }
}

function localizeTranslatableProp(
  value: unknown,
  translations: DocumentationSectionTranslations,
) {
  if (typeof value === "string") {
    return translateDocumentationString(value, translations);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" && isNarrativeString(item)
        ? translateDocumentationString(item, translations)
        : item,
    );
  }
  return value;
}

function collectTranslatableProp(value: unknown, strings: string[]) {
  if (typeof value === "string" && isNarrativeString(value)) {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && isNarrativeString(item)) {
        strings.push(item);
      }
    }
  }
}

function isNarrativeString(value: string) {
  return HAS_LETTER.test(value);
}
