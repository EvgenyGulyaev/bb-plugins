import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// A shell that exports NODE_ENV=production makes React resolve to its
// production CJS build, which has no `act`; Testing Library needs it.
process.env.NODE_ENV = "test";

export default defineConfig({
  resolve: {
    // Mirrors `paths: { "@/*": ["./*"] }` in tsconfig.json; esbuild reads the
    // tsconfig during `bb plugin build`, but vitest does not.
    alias: { "@": rootDir },
  },
  test: {
    name: "bb-plugin-clirelay-test",
    environment: "node",
    include: ["lib/*.test.ts", "server.test.ts", "test/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
  },
});
