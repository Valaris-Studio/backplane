// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// In presenter mode a call row keeps enough to read as a timeline (which file
// an edit touched, which program a shell ran) and blurs the rest. Patterns,
// MCP payloads and command arguments are where secrets and customer data sit.
const FILE_TOOL = /^(edit|write|read|view|multi_?edit|notebook_?edit|str_replace|cat)$/i;
const SHELL_TOOL = /^(bash|shell|exec|command|run|terminal)$/i;
const SINGLE_PATH = /^[^\s"'{}[\]=]+$/;

// A home folder names the person: /Users/<name>/…, /home/<name>/…, C:\Users\<name>\…
const HOME_PREFIX = /^(\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)(?=[/\\]|$)/;

export function tildeHome(path: string): string {
  return path.replace(HOME_PREFIX, "~");
}

export interface PresentedArgs {
  visible: string;
  hidden: string;
}

export function presentArgs(toolName: string | null, args: string): PresentedArgs {
  const name = toolName ?? "";
  if (FILE_TOOL.test(name) && SINGLE_PATH.test(args)) return { visible: tildeHome(args), hidden: "" };
  if (SHELL_TOOL.test(name)) {
    const verbEnd = args.search(/\s/);
    const verb = verbEnd === -1 ? args : args.slice(0, verbEnd);
    // `TOKEN=… cmd` puts the value first; never show an assignment as the verb.
    if (verb.includes("=")) return { visible: "", hidden: args };
    return { visible: tildeHome(verb), hidden: verbEnd === -1 ? "" : args.slice(verbEnd).trimStart() };
  }
  return { visible: "", hidden: args };
}
