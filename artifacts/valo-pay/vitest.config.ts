// Console tests: the real pages rendered in jsdom against an in-memory API
// built on the domain code (tests/fake-api.ts).  Separate from vite.config.ts,
// which needs the serving environment (PORT, BASE_PATH) that tests do not.
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    css: false,
    restoreMocks: true,
    // Each worker hosts jsdom and the full domain-backed API. Bound parallel
    // cold imports so a large machine's CPU count cannot overwhelm the runner.
    maxWorkers: 4,
    testTimeout: 20_000,
    // The pilot enquiry address is host configuration; tests use a documentation-reserved address.
    env: { VITE_PILOT_EMAIL: "pilots@example.test" },
  },
});
