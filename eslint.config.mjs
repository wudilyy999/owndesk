import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// Baseline lint setup. Rules that the existing code base violates widely are
// downgraded to warnings (or disabled for tests) so `npm run lint` can gate new
// errors without a mass rewrite. Tighten them back to "error" as code is cleaned up.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // ~15 existing uses in lib/ and worker/; clean up gradually.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "prefer-const": "warn",
      // React Compiler rule added in eslint-plugin-react-hooks 6+; 13 existing component hits.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // Test fixtures and integration scripts use `any` heavily for stubs and DB rows.
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "data/**",
    "docs/**",
    "next-env.d.ts",
    "workstation/**",
  ]),
])
