// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { insertAtCaret } from "../prompt-caret";

// A stand-in for the textarea the caller owns. The value must be assigned
// BEFORE the selection: jsdom (like a real browser) clamps selectionStart to
// value.length, so setting it on an empty textarea silently yields 0.
function textareaAt(
  value: string,
  start: number,
  end = start,
): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = value;
  el.selectionStart = start;
  el.selectionEnd = end;
  return el;
}

describe("insertAtCaret", () => {
  it("appends when the field was never focused, ignoring a stale selection", () => {
    // selectionStart is 0 on an untouched textarea — inserting there would put
    // the token in front of everything the operator already typed.
    const el = textareaAt("Hello world", 0);

    const { next, caret } = insertAtCaret(
      el,
      "Hello world",
      "{{.BoardID}}",
      false,
    );

    expect(next).toBe("Hello world{{.BoardID}}");
    expect(caret).toBe("Hello world{{.BoardID}}".length);
  });

  it("inserts at the caret once the field has been focused", () => {
    const el = textareaAt("Hello world", 6);

    const { next, caret } = insertAtCaret(
      el,
      "Hello world",
      "<<RUN_LABEL>>",
      true,
    );

    expect(next).toBe("Hello <<RUN_LABEL>>world");
    expect(caret).toBe(6 + "<<RUN_LABEL>>".length);
  });

  it("replaces a selected range rather than inserting beside it", () => {
    const el = textareaAt("Hello world", 6, 11);

    const { next, caret } = insertAtCaret(
      el,
      "Hello world",
      "{{.Iteration}}",
      true,
    );

    expect(next).toBe("Hello {{.Iteration}}");
    expect(caret).toBe(6 + "{{.Iteration}}".length);
  });

  it("appends when there is no element at all, whatever `touched` claims", () => {
    const { next, caret } = insertAtCaret(null, "abc", "<<X>>", true);

    expect(next).toBe("abc<<X>>");
    expect(caret).toBe("abc<<X>>".length);
  });

  it("leaves the caret behind the token, not at the end of the text", () => {
    // The distinguishing case: inserting mid-string. If the implementation
    // returned value.length the operator's next keystroke would land at the
    // far end of the prompt.
    const el = textareaAt("abcdef", 3);

    const { next, caret } = insertAtCaret(el, "abcdef", "<<S>>", true);

    expect(next).toBe("abc<<S>>def");
    expect(caret).toBe(8);
    expect(caret).not.toBe(next.length);
  });
});
