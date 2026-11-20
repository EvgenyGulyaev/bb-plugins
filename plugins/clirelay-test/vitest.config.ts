import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Шелл может экспортировать NODE_ENV=production: тогда React берёт
// production-сборку без `act`, а Testing Library на ней падает.
process.env.NODE_ENV = "test";

export default defineConfig({
  resolve: {
    // Зеркало `paths: { "@/*": ["./*"] }` из tsconfig.json: esbuild читает
    // tsconfig сам, а vitest — нет.
    alias: { "@": rootDir },
  },
  test: {
    name: "bb-plugin-clirelay-test",
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
    include: ["lib/**/*.test.ts", "*.test.ts", "test/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
  },
});
