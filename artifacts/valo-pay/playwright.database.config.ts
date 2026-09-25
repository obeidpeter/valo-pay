import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e/database",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-database-report" }],
      ]
    : "list",
  outputDir: "test-results-database",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "database-chromium",
      use: {
        ...devices["Desktop Chrome"],
        // As the other browser suites: a host without Playwright's own download names its Chromium.
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        },
      },
    },
  ],
  webServer: {
    command:
      "node ../../scripts/node_modules/tsx/dist/cli.mjs ../api-server/tests/browser-server.ts",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      VALOPAY_BROWSER_DATABASE_TEST: "1",
      VALOPAY_RUN_INTEGRATION: "1",
      NODE_ENV: "test",
    },
  },
});
