import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    // Tests must never touch the real Groq API or a real Turso database. A dummy
    // key satisfies env validation; an in-memory database keeps runs isolated
    // and leaves no local.db artefacts behind.
    env: {
      NODE_ENV: "test",
      GROQ_API_KEY: "gsk_test_key_not_a_real_credential",
      TURSO_DATABASE_URL: "file::memory:",
      LOG_LEVEL: "silent",
    },
  },
});
