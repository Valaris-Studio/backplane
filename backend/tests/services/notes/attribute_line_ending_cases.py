# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One block per attribute-borne string that reaches serialized markdown, each
carrying a bare CR. The frontend twin lists the same eight in
noteToMarkdown.lineEndings.test.ts."""

PAYLOAD = "a\r# h"


def _paragraph(*inline: dict) -> dict:
    return {"type": "paragraph", "content": list(inline)}


ATTRIBUTE_CR_BLOCKS = {
    "mention-label": _paragraph(
        {"type": "mention", "attrs": {"id": "u1", "label": PAYLOAD}}
    ),
    "image-alt": {"type": "image", "attrs": {"src": "https://x/i.png", "alt": PAYLOAD}},
    "image-title": {
        "type": "image",
        "attrs": {"src": "https://x/i.png", "title": PAYLOAD},
    },
    "image-src": {"type": "image", "attrs": {"src": f"https://x/{PAYLOAD}"}},
    "attachment-filename": {
        "type": "fileAttachment",
        "attrs": {"src": "https://x/f", "filename": PAYLOAD},
    },
    "attachment-filename-no-src": {
        "type": "fileAttachment",
        "attrs": {"filename": PAYLOAD},
    },
    "attachment-src": {
        "type": "fileAttachment",
        "attrs": {"src": f"https://x/{PAYLOAD}", "filename": "f"},
    },
    "link-href": _paragraph(
        {
            "type": "text",
            "text": "t",
            "marks": [{"type": "link", "attrs": {"href": f"https://x/{PAYLOAD}"}}],
        }
    ),
}


def quoted(block: dict) -> dict:
    return {"type": "blockquote", "content": [block]}
