// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n/supported-languages";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import {
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
  resolveDocumentationSection,
} from "../section-registry";
import { collectDocumentationTechnicalContract } from "../technical-contract";

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));

const SETUP = "installing-the-mcp-server";
const TOOLSETS = "mcp-toolsets";

function section(slug: string, locale: SupportedLanguage = "en") {
  const resolved = resolveDocumentationSection(locale, slug);
  if (!resolved) throw new Error(`Missing ${locale}:${slug}`);
  const Component = resolved.Component;
  const { container } = render(
    <MemoryRouter>
      <DocumentationSectionTranslationProvider translations={resolved.translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return { container, status: resolved.status, text: normalized(container.textContent) };
}

function normalized(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ");
}

function block(container: HTMLElement, anchor: string) {
  const heading = container.querySelector(`h2#${anchor}`);
  expect(heading, `Stable documentation anchor #${anchor}`).not.toBeNull();
  const fragment = document.createElement("div");
  for (let node = heading?.nextElementSibling; node && node.tagName !== "H2"; node = node.nextElementSibling) {
    fragment.append(node.cloneNode(true));
  }
  return { container: fragment, text: normalized(fragment.textContent) };
}

afterEach(cleanup);

describe("MCP onboarding canonical documentation", () => {
  it.each([SETUP, TOOLSETS])("%s maps human presets without narrowing actual runners", (slug) => {
    const { container, text } = section(slug);
    const rows = [...container.querySelectorAll("li, tr, p")].map((node) => normalized(node.textContent));
    expect(rows.some((row) => /everyday/i.test(row) && /\bdefault\b/.test(row))).toBe(true);
    expect(rows.some((row) => /loops/i.test(row) && row.includes("default,autonomous-operations"))).toBe(true);
    expect(rows.some((row) => /everything/i.test(row) && /\ball\b/.test(row))).toBe(true);
    expect(text).toMatch(/interactive.*(?:prepar|manag).*loops|loops.*interactive/i);
    expect(text).toMatch(/(?:larger|limits|size).*catalog|catalog.*(?:larger|limits|size)/i);
    expect(text).toMatch(/runner.*\ball\b.*allowlist/i);
    expect(text).toMatch(/custom.*(?:compos|toolset|select)|(?:compos|toolset|select).*custom/i);
  });

  it("makes the default explicit in the copyable local launch configuration", () => {
    const { container } = section(SETUP);
    const configs = [...container.querySelectorAll("pre code")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.includes('"mcpServers"'))
      .map((text) => JSON.parse(text));
    expect(configs.length).toBeGreaterThan(0);
    const local = configs[0].mcpServers.valaris;
    expect(local.command).toBe("uvx");
    expect(local.args).toContain("backplane-mcp");
    expect(local.env.VALARIS_MCP_TOOLSETS).toBe("default");
    expect(local.env.VALARIS_API_URL).toBe("https://your-backplane-host");
  });

  it("distinguishes a local stdio process using a remote API from remote MCP HTTP", () => {
    const { text } = section(SETUP);
    expect(text).toMatch(/local.*stdio.*remote.*(?:API|Backplane)/i);
    expect(text).toMatch(/remote.*(?:HTTP|MCP).*operator/i);
    expect(text).toMatch(/client.*(?:env|environment).*(?:cannot|does not|do not).*remote/i);
  });

  it("provides a deployment-agnostic remote operator environment at the recovery anchor", () => {
    const { container } = section(TOOLSETS);
    const recovery = block(container, "discovery");
    const env = [...recovery.container.querySelectorAll("pre code")]
      .map((node) => node.textContent ?? "")
      .find((text) => /MCP_TRANSPORT\s*=\s*["']?streamable-http/.test(text));
    expect(env, "Copyable remote MCP service environment").toBeDefined();
    expect(env).toMatch(/MCP_HOST\s*=\s*["']?0\.0\.0\.0/);
    expect(env).toMatch(/VALARIS_MCP_TOOLSETS\s*=\s*["']?default,autonomous-operations/);
    expect(env).not.toMatch(/gcloud|kubectl|aws |az /);
    expect(recovery.text).toMatch(/(?:fresh|example).*connection|connection.*(?:fresh|example)/i);
    expect(recovery.text).toMatch(/protect|authenticated|authentication/i);
    expect(recovery.text).toMatch(/restart.*server.*connection.*(?:new|fresh).*session/i);
    expect(recovery.text).toMatch(/new chat alone.*(?:reuse|cached|stale)/i);
  });

  it("preserves the exact returned recovery environment and every configured group", () => {
    const recovery = block(section(TOOLSETS).container, "discovery").text;
    expect(recovery).toMatch(/(?:exact|unchanged).{0,70}restart_env|restart_env.{0,70}(?:exact|unchanged)/i);
    expect(recovery).toMatch(/(?:all|every).*enabled.*(?:group|toolset)/i);
    expect(recovery).toContain("VALARIS_MCP_ALLOWLIST");
    expect(recovery).toMatch(/(?:preserv|keep|unchanged).*allowlist|allowlist.*unchanged/i);
  });

  it("separates authentication, server state and successful native tool checks", () => {
    const verify = block(section(SETUP).container, "verify").text;
    expect(verify).toContain("whoami");
    expect(verify).toContain("list_changed_sent");
    expect(verify).toContain("get_server_info");
    expect(verify).toMatch(/(?:API.key|authentication).*(?:does not|not proof|not verify)/i);
    expect(verify).toMatch(/native.*(?:call|tool)/i);
    expect(verify).toMatch(/empty.*(?:success|callable)|success.*empty/i);
  });

  it("uses schema-correct read-only checks and inspects propose_skill without invoking it", () => {
    const verify = block(section(SETUP).container, "verify");
    const code = [...verify.container.querySelectorAll("code")].map((node) => node.textContent ?? "").join("\n");
    expect(code).toMatch(/whoami\(\s*\)/);
    expect(code).toMatch(/list_agents\(\s*\)/);
    expect(code).toMatch(/list_loop_templates\(\s*workspace_slug\s*=\s*["'][^"']+["']\s*\)/);
    expect(code).not.toMatch(/list_agents\([^)]*workspace_slug/);
    if (code.includes("list_executions(")) {
      expect(code).toMatch(/list_executions\([^)]*workspace_slug\s*=.*limit\s*=\s*1\s*\)/);
    }
    expect(verify.text).toMatch(/schema/i);
    expect(verify.text).toMatch(/authorized workspace/i);
    expect(verify.text).toMatch(/propose_skill.*(?:presence|without|do not|never)|(?:presence|without|do not|never).*propose_skill/i);
    expect(code).not.toMatch(/(?:propose_skill|register_agent|bind_loop|start_loop|create_card)\(/);
  });

  it("offers distinct missing-tool, authorization, network and version recovery", () => {
    const verify = block(section(SETUP).container, "verify");
    expect(verify.text).toMatch(/missing.*tool|tool.*missing/i);
    expect(verify.text).toContain("401");
    expect(verify.text).toContain("403");
    expect(verify.text).toMatch(/network/i);
    expect(verify.text).toMatch(/version/i);
    expect(verify.text).toContain("VALARIS_MCP_ALLOWLIST");
    expect([...verify.container.querySelectorAll("a")].map((a) => a.getAttribute("href")))
      .toContain("../documentation/mcp-toolsets#discovery");
  });

  it("resolves authorized workspaces before everyday native board and context checks", () => {
    const verify = block(section(SETUP).container, "verify");
    const code = [...verify.container.querySelectorAll("code")]
      .map((node) => node.textContent ?? "").join("\n");
    expect(code).toMatch(/whoami\(\s*\)/);
    expect(code).toMatch(/list_workspaces\(\s*\)/);
    expect(verify.text).toMatch(/(?:resolve|select|choose).{0,120}authorized workspace|authorized workspace.{0,120}(?:resolve|select|choose)/i);
    expect(verify.text).toMatch(/(?:ambiguous|multiple).{0,120}(?:ask|confirm)|(?:ask|confirm).{0,120}(?:ambiguous|multiple)/i);
    expect(verify.text).toMatch(/(?:no|without) authorized workspace.{0,140}(?:stop|skip)/i);
    expect(verify.text).toMatch(/(?:everyday|default).{0,300}list_boards/i);
    expect(code).toMatch(/list_boards\([^)]*workspace_slug\s*=/);
    expect(code).toMatch(/get_project_context\([^)]*workspace_slug\s*=[^)]*board_id\s*=/);
    expect(verify.text).toMatch(/(?:existing|returned).{0,70}board.{0,30}(?:ID|identifier)|board.{0,30}(?:ID|identifier).{0,70}(?:existing|returned)/i);
    expect(verify.text).toMatch(/(?:no boards|empty.{0,40}(?:board|list)).{0,180}skip.{0,60}(?:project.context|get_project_context)/i);
  });

  it("labels Everything checks as representative coverage of everyday and loop reads", () => {
    const verify = block(section(SETUP).container, "verify").text;
    expect(verify).toMatch(/Everything.{0,300}(?:everyday|default).{0,150}loops|Everything.{0,300}loops.{0,150}(?:everyday|default)/i);
    expect(verify).toMatch(/Everything.{0,400}representative|representative.{0,400}Everything/i);
    expect(verify).toMatch(/(?:not|does not|do not).{0,80}(?:every tool|full.catalog)|(?:every tool|full.catalog).{0,80}(?:not verified|not certified)/i);
  });

  it("distinguishes released installs from an unpublished candidate", () => {
    const install = block(section(SETUP).container, "install").text;
    expect(install).toContain("uvx backplane-mcp");
    expect(install).toContain("@<commit>#subdirectory=mcp-server");
    expect(install).toMatch(/unpublished|unreleased/i);
    expect(install).toMatch(/candidate/i);
    expect(install).toMatch(/(?:wheel|checkout|source)/i);
  });

  describe.each(SUPPORTED_LANGUAGES)("%s public documentation", (locale) => {
    it.each([SETUP, TOOLSETS])("%s preserves all technical examples and translated prose", (slug) => {
      const english = collectDocumentationTechnicalContract(section(slug).container);
      cleanup();
      const localized = section(slug, locale);
      expect(collectDocumentationTechnicalContract(localized.container)).toEqual(english);
      if (locale !== "en") {
        expect(localized.status).toBe("translated");
        expect(getMissingDocumentationStrings(locale, slug)).toEqual([]);
        expect(getUnexpectedDocumentationStrings(locale, slug)).toEqual([]);
      }
      expect(localized.text).not.toMatch(/intern\.valaris\.studio|runner-laptop-seba/);
    });
  });
});
