import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/worker/**/*.test.ts", "apps/web/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
  },
});
