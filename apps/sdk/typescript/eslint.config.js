import { baseConfig } from "@morsehq/config-eslint";

export default [
  ...baseConfig,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "tsup.config.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
];
