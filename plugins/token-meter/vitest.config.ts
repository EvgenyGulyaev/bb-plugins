import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = "test";

export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: {
    name: "bb-plugin-token-meter",
    setupFiles: ["./vitest.setup.ts"],
    environment: "node",
    include: ["lib/*.test.ts", "server.test.ts", "test/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
  },
});
