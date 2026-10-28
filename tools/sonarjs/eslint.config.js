import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/public/**", "**/coverage/**"],
  },
  sonarjs.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      parser: tsParser,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 15],
    },
  },
];
