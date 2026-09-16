// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import { downloadBlobAs } from "../download";

describe("downloadBlobAs", () => {
  let createdUrls: string[];
  let revokedUrls: string[];
  let clickedAnchors: HTMLAnchorElement[];

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    clickedAnchors = [];

    URL.createObjectURL = vi.fn((blob: Blob) => {
      const fake = `blob:fake/${createdUrls.length}-${(blob as Blob).size}`;
      createdUrls.push(fake);
      return fake;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clickedAnchors.push(this);
    };
  });

  it("creates an object URL for the blob", () => {
    const blob = new Blob(["hello"], { type: "application/json" });
    downloadBlobAs("hello.json", blob);
    expect(createdUrls).toHaveLength(1);
  });

  it("clicks an anchor with download=filename", () => {
    const blob = new Blob(["x"], { type: "application/json" });
    downloadBlobAs("ws.valaris.pipeline.json", blob);
    expect(clickedAnchors).toHaveLength(1);
    const anchor = clickedAnchors[0]!;
    expect(anchor.download).toBe("ws.valaris.pipeline.json");
    expect(anchor.href).toBe(createdUrls[0]);
  });

  it("revokes the object URL after clicking", () => {
    downloadBlobAs("a.json", new Blob(["a"]));
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("removes the anchor from the DOM", () => {
    downloadBlobAs("b.json", new Blob(["b"]));
    expect(document.querySelectorAll("a[download]").length).toBe(0);
  });
});
