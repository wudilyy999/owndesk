// Placeholder environment for the unit tests (`npm test`).
// lib/env.ts validates the process environment when it is first imported, so the
// tests need these values even though they never connect to a database or Docker.
// Values already present in the environment win; nothing here is a real secret.
const placeholders = {
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  APP_URL: "http://localhost:6797",
  BETTER_AUTH_SECRET: "unit-test-placeholder-secret-0123456789abcdef",
  MASTER_KEY: "0".repeat(64),
  INSTALL_ID: "00000000-0000-4000-8000-000000000000",
}
for (const [key, value] of Object.entries(placeholders)) process.env[key] ??= value
