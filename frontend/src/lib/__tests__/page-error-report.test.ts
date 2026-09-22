import { afterEach, expect, it } from "vitest";
import { pageErrorReport } from "../page-error-report";

afterEach(() => { window.history.replaceState({}, "", "/"); document.querySelectorAll("script[data-test-entry]").forEach((script) => script.remove()); });

it("records the actual failure and build while stripping query strings and fragments", () => {
  window.history.replaceState({}, "", "/workspace/history?token=private#draft");
  const script = document.createElement("script");
  script.src = "/assets/index-aaaaaaaa.js?credential=private";
  script.dataset.testEntry = "true";
  document.head.appendChild(script);
  const report = pageErrorReport(new TypeError("Failed to fetch dynamically imported module: https://example.test/assets/Page-aaaaaaaa.js?token=private#secret"));
  expect(report).toMatchObject({ kind: "module-load", asset: "/assets/Page-aaaaaaaa.js", entry: "/assets/index-aaaaaaaa.js", path: "/workspace/history" });
  expect(report.message).toContain("Failed to fetch dynamically imported module");
  expect(JSON.stringify(report)).not.toMatch(/private|secret|credential/);
});
