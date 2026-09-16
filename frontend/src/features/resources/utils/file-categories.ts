// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type FileCategory =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "csv"
  | "spreadsheet"
  | "document"
  | "unknown";

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".bmp", ".ico",
]);

// Formats browsers can play natively via <video>/<audio>. Codec support
// varies by browser, but the container extensions below cover the common
// web-deliverable cases; unsupported codecs degrade to the element's own
// "can't play" state, with the download fallback always available.
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".webm", ".ogv", ".mov", ".m4v",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac",
]);

const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb",
  ".php", ".c", ".cpp", ".h", ".cs", ".swift", ".kt", ".scala",
  ".sh", ".bash", ".zsh", ".sql", ".html", ".css", ".scss", ".sass",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".graphql", ".vue",
  ".dart", ".lua", ".r", ".ex", ".exs", ".erl",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".env", ".gitignore", ".editorconfig", ".dockerignore",
  ".cfg", ".ini", ".conf",
]);

// SheetJS reads the legacy .xls binary format as well as OOXML.
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xls"]);

// mammoth only understands OOXML — pre-2007 .doc would convert to an empty
// document, so it stays on the download-only path.
const DOCUMENT_EXTENSIONS = new Set([".docx"]);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".sql": "sql",
  ".html": "xml",
  ".css": "css",
  ".scss": "scss",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".graphql": "graphql",
  ".vue": "xml",
  ".dart": "dart",
  ".lua": "lua",
  ".r": "r",
};

export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(lastDot).toLowerCase() : "";
}

export function categorizeFile(filename: string): FileCategory {
  const ext = getExtension(filename);
  if (!ext) return "unknown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".csv") return "csv";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

export function getLanguage(filename: string): string {
  const ext = getExtension(filename);
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}
