// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FileAttachmentView } from "./FileAttachmentView";

export interface FileAttachmentAttrs {
  src: string | null;
  filename: string;
  fileSize: number;
  mimeType: string;
  uploading: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileAttachment: {
      setFileAttachment: (attrs: Partial<FileAttachmentAttrs>) => ReturnType;
    };
  }
}

export const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      filename: { default: "" },
      fileSize: { default: 0 },
      mimeType: { default: "application/octet-stream" },
      uploading: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-attachment]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-file-attachment": "" }),
    ];
  },

  addCommands() {
    return {
      setFileAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },
});
