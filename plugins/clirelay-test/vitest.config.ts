import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-clirelay-test",
    environment: "node",
    include: ["lib/*.test.ts", "server.test.ts"],
    testTimeout: 20_000,
  },
});
