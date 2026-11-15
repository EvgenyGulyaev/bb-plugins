import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// A shell that exports NODE_ENV=production makes React resolve to its
// production CJS build, which has no `act`; Testing Library needs it.
process.env.NODE_ENV = "test";

// Plain vitest config: this plugin lives outside the bb monorepo, so the
// workspace test config is neither available nor meaningful here.
export default defineConfig({
  resolve: {
    // Mirrors `paths: { "@/*": ["./*"] }` in tsconfig.json. esbuild reads the
    // tsconfig during `bb plugin build`, but vitest does not, so imports like
    // `@/components/ui/card` need the alias spelled out for tests.
    alias: { "@": rootDir },
  },
  test: {
    name: "bb-plugin-kanban-board",
    environment: "node",
    include: ["server.test.ts", "lib/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 20_000,
  },
});
