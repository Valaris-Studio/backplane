import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "src/ipc/bindings.ts", "playwright-report", "test-results"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // popLayout makes Motion inject a <style> element, which the production
      // CSP (style-src 'self', tauri.conf.json) blocks.
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXAttribute[name.name='mode'][value.value='popLayout']",
          "JSXAttribute[name.name='mode'] > JSXExpressionContainer > Literal[value='popLayout']",
          "JSXAttribute[name.name='mode'] > JSXExpressionContainer > TemplateLiteral[quasis.0.value.cooked='popLayout']",
        ].map((selector) => ({
          selector,
          message: "AnimatePresence mode=\"popLayout\" injects a <style> element that the style-src 'self' CSP blocks.",
        })),
      ],
    },
  },
);
