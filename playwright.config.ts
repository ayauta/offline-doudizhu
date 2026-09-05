import { defineConfig } from "@playwright/test";

const visualReview = process.env.VISUAL_REVIEW === "1";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  outputDir: visualReview ? "output/playwright" : "test-results",
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { height: 360, width: 800 },
      },
    },
  ],
  reporter: [["line"]],
  retries: 0,
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: visualReview ? "on" : "only-on-failure",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:4173",
  },
  workers: 1,
});
