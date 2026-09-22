// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const frontend = resolve(import.meta.dirname, "..");
const image = process.argv[2];
if (!image) throw new Error("Usage: node tests/deployment-browser.mjs <built-frontend-image>");
const prefix = `backplane-upgrade-${process.pid}`;
const temporary = mkdtempSync(join(tmpdir(), prefix));
const containers = new Set();
const volumes = new Set();
const images = [];
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 });
const browser = await chromium.launch({ headless: true });

function start(name, selectedImage, port = "", volume) {
  const args = ["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:8080`, "-e", "BACKEND_URL=http://127.0.0.1:8000"];
  if (volume) args.push("-v", `${volume}:/var/lib/backplane/frontend`);
  args.push(selectedImage);
  docker(...args);
  containers.add(name);
  return Number(docker("port", name, "8080/tcp").trim().split(":").at(-1));
}
function stop(name) { docker("rm", "-f", name); containers.delete(name); }
async function ready(port) {
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/`)).status; }
    catch { return 0; }
  }).toBe(200);
}

try {
  mkdirSync(join(temporary, "site/assets"), { recursive: true });
  writeFileSync(join(temporary, "site/index.html"), '<h1>Old release</h1><button id="navigate">Open section</button><p id="result"></p><script>document.querySelector("button").onclick = async () => { const page = await import("/assets/Page-previous.js"); document.querySelector("#result").textContent = page.message; };</script>');
  writeFileSync(join(temporary, "site/assets/Page-previous.js"), 'export const message = "Previously unloaded section works";');
  writeFileSync(join(temporary, "Dockerfile"), `FROM ${image}\nRUN rm -rf /usr/share/nginx/html\nCOPY site /usr/share/nginx/html\nRUN python3 /usr/local/bin/retain-assets.py /usr/share/nginx/html /usr/share/nginx/html/.asset-history\n`);
  const previous = `${prefix}:previous`;
  docker("build", "-q", "-t", previous, temporary);
  images.push(previous);

  for (const mode of ["persistent-volume", "image-history"]) {
    let replacement = image;
    let volume;
    if (mode === "persistent-volume") {
      volume = `${prefix}-assets`;
      docker("volume", "create", volume);
      volumes.add(volume);
    } else {
      replacement = `${prefix}:replacement`;
      docker("build", "-q", "--build-arg", `PREVIOUS_FRONTEND_IMAGE=${previous}`, "-t", replacement, frontend);
      images.push(replacement);
    }
    const oldName = `${prefix}-old`;
    const newName = `${prefix}-new`;
    const port = start(oldName, previous, "", volume);
    await ready(port);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByRole("heading")).toHaveText("Old release");
    stop(oldName);
    start(newName, replacement, String(port), volume);
    await ready(port);
    await page.getByRole("button", { name: "Open section" }).click();
    await expect(page.locator("#result")).toHaveText("Previously unloaded section works");
    console.log(`PASS: open tab loads an unfetched old chunk after ${mode} replacement`);
    await page.close();
    stop(newName);
  }

  const port = start(`${prefix}-recovery`, image);
  await ready(port);
  const page = await browser.newPage();
  await page.addInitScript(() => { localStorage.setItem("i18n-lang", "en"); });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/auth/modes") ? { password_enabled: true, oidc_enabled: false, signup_enabled: false } : { needs_setup: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${port}/login`);
  await expect(page.locator("input[type=password]")).toBeVisible();
  let documentRequests = 0;
  page.on("request", (request) => { if (request.resourceType() === "document") documentRequests++; });
  await page.route("**/assets/*.js", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
  await page.evaluate(() => { history.pushState({}, "", "/documentation"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "This page could not load" })).toBeVisible();
  await expect(page.getByText(/Reloading may discard unsaved changes/)).toBeVisible();
  await page.getByText("Error details", { exact: true }).click();
  const report = JSON.parse(await page.getByRole("textbox", { name: "Error details" }).inputValue());
  expect(report.kind).toBe("module-load");
  expect(report.entry).toMatch(/\/assets\/index-/);
  expect(report.asset).toMatch(/\/assets\//);
  expect(documentRequests).toBe(0);
  if (process.env.BACKPLANE_EVIDENCE_DIR) {
    await page.screenshot({ path: join(process.env.BACKPLANE_EVIDENCE_DIR, "recovery-screen.png"), fullPage: true });
  }
  await page.unroute("**/assets/*.js");
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect(page.getByRole("heading", { name: "This page could not load" })).toHaveCount(0);
  await expect(page.getByRole("banner", { name: "Backplane" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documentation", exact: true })).toBeVisible();
  expect(documentRequests).toBe(1);
  console.log("PASS: production app catches chunk 404, reports build/asset, waits for explicit reload and recovers");
  await page.close();

  const localePage = await browser.newPage();
  await localePage.addInitScript(() => { localStorage.setItem("i18n-lang", "es"); });
  await localePage.route("**/assets/es-*.js", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await localePage.goto(`http://127.0.0.1:${port}/login`);
  await expect(localePage.getByRole("heading", { name: "This page could not load" })).toBeVisible();
  await expect(localePage.getByRole("button", { name: "Reload page" })).toBeVisible();
  console.log("PASS: failed initial locale download shows recovery instead of an empty root");
  await localePage.close();
} finally {
  await browser.close();
  for (const name of containers) docker("rm", "-f", name);
  for (const volume of volumes) docker("volume", "rm", volume);
  for (const selectedImage of images.reverse()) docker("image", "rm", selectedImage);
  rmSync(temporary, { recursive: true, force: true });
}
