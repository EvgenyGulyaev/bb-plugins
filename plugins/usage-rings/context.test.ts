import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("archived thread keeps its own machine; home uses the primary-machine fallback", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
  const hook = source.slice(source.indexOf("function useOverview()"), source.indexOf("function windowLabel"));
  const run = new Function("useBbContext", "experimental_useSidebarThreads", "experimental_useRpcQuery", "useEffect", "contract", `${hook}\nreturn useOverview();`);
  const threads = [
    { id: "current", isArchived: false, host: { id: "primary-machine" } },
    { id: "archived", isArchived: true, host: { id: "remote-machine" } },
  ];
  const sidebar = (options?: { experimental_lifecycles: string[] }) => ({
    threads: threads.filter(thread => (options?.experimental_lifecycles ?? ["active"]).includes(thread.isArchived ? "archived" : "active")),
  });
  const resolve = (threadId: string | null) => run(
    () => ({ threadId }), sidebar, () => ({ refetch: async () => {} }), () => {}, {},
  ).hostId;
  assert.equal(resolve("current"), "primary-machine");
  assert.equal(resolve("archived"), "remote-machine");
  assert.equal(resolve(null), null);
});
