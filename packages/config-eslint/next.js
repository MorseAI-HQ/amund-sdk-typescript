import { baseConfig } from "./index.js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";

// a11y baseline (2026-10-08): recommended jsx-a11y, all at "error". The four
// rules once held at "warn" were promoted back after the remaining sites were
// fixed (htmlFor/id wiring, keyboard handlers on clickable rows); intentional
// autoFocus sites carry an inline disable with a reason. Exported so the repo-root config (used by
// lint-staged) applies the same rules — otherwise disable directives for
// these rules error there as "Definition for rule ... was not found".
export const a11yPlugins = { "jsx-a11y": jsxA11yPlugin };
export const a11yRules = {
  ...jsxA11yPlugin.flatConfigs.recommended.rules,
  // Custom wrappers that render a native control, so a <label> wrapping them counts as associated.
  "jsx-a11y/label-has-associated-control": [
    "error",
    { controlComponents: ["Input", "SelectField", "Textarea"], depth: 3 },
  ],
  "jsx-a11y/click-events-have-key-events": "error",
  "jsx-a11y/no-static-element-interactions": "error",
  // Intentional focus-on-open sites carry an inline eslint-disable with the reason.
  "jsx-a11y/no-autofocus": "error",
};

export const nextConfig = tseslint.config(...baseConfig, {
  plugins: {
    react: reactPlugin,
    "react-hooks": reactHooksPlugin,
    "@next/next": nextPlugin,
    ...a11yPlugins,
  },
  rules: {
    ...reactPlugin.configs.recommended.rules,
    ...reactHooksPlugin.configs.recommended.rules,
    ...nextPlugin.configs.recommended.rules,
    ...a11yRules,
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
  },
  settings: {
    react: {
      version: "detect",
    },
  },
});
