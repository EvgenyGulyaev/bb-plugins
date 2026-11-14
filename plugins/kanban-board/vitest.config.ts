import { defineConfig } from "vitest/config";

// Plain vitest config: this plugin lives outside the bb monorepo, so the
// workspace test config is neither available nor meaningful here.
export default defineConfig({
  test: {
    name: "bb-plugin-kanban-board",
    environment: "node",
    include: ["server.test.ts"],
    testTimeout: 20_000,
  },
});
