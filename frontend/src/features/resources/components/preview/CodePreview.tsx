// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import "highlight.js/styles/github-dark.min.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);

interface CodePreviewProps {
  content: string;
  language: string;
}

export function CodePreview({ content, language }: CodePreviewProps) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!codeRef.current) return;

    const lang = hljs.getLanguage(language) ? language : "plaintext";
    const highlighted = hljs.highlight(content, { language: lang });
    codeRef.current.innerHTML = highlighted.value;
  }, [content, language]);

  return (
    <div className="max-h-[70vh] overflow-auto rounded">
      <pre className="p-4 text-sm bg-[#0d1117]">
        <code ref={codeRef} className={`hljs language-${language}`} />
      </pre>
    </div>
  );
}
