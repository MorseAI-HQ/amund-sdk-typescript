import { baseConfig } from "@morsehq/config-eslint";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import { a11yPlugins, a11yRules } from "@morsehq/config-eslint/next";

/**
 * Root ESLint config for monorepo
 * Each package/app has its own eslint.config.js that extends this
 *
 * lint-staged's pre-commit hook runs `eslint --fix` from the repo root
 * (see package.json), which resolves this root config instead of each app's
 * own eslint.config.js. Apps (e.g. apps/web via
 * @morsehq/config-eslint/next.js) enable react-hooks's recommended rules
 * and rely on `// eslint-disable-next-line react-hooks/exhaustive-deps` in a
 * handful of intentional cases. Registering just the plugin without the
 * rule made those directives "unused" (and `--fix` stripped them); mirroring
 * the app-level recommended rules here — same severity, ts/tsx-scoped —
 * keeps root-context linting consistent with what apps/web already enforces,
 * so the directives resolve correctly instead of erroring or being stripped.
 */
export default [
  ...baseConfig,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooksPlugin,
      ...a11yPlugins,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      // Same reason as react-hooks above: app-level jsx-a11y disable
      // directives must resolve in root-context (lint-staged) linting.
      ...a11yRules,
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.expo/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/build/**",
      "**/.venv/**",
      "**/next-env.d.ts",
    ],
  },
];
