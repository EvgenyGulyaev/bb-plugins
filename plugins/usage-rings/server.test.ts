import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";
import { contract } from "./contract.ts";

test("RPC returns JSON with sparse provider artwork, persists selection/order, and respects disabled providers", async () => {
  const values = new Map<string, unknown>();
  const requested: string[][] = [];
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>;
  const providers = [{ id: "codex", displayName: "Codex" }, { id: "claude", displayName: "Claude" }];
  const bb = {
    storage: { kv: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value); } } },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      providers: { list: async () => providers },
      plugins: { callRpc: async ({ input }: { input: { providerIds: string[] } }) => {
        requested.push(input.providerIds);
        return { machines: [{ id: "host-1", displayName: "Laptop", status: "connected", error: null,
          providers: providers.map(p => ({ id: `${p.id}-account`, providerId: p.id, displayName: p.displayName,
            usage: { status: "ok", accountEmail: null, planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 11, resetsAt: null }] } })) }] };
      } },
    },
    rpc: { register: (_contract: unknown, registered: typeof handlers) => { handlers = registered; }, experimental_invalidate: () => {} },
    events: { on: () => {} },
  } as unknown as BbPluginApi;
  plugin(bb);
  async function call(method: keyof typeof contract, input: unknown) {
    const parsed = contract[method].input.parse(input);
    const result = await handlers![method]!(parsed, {});
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)), "RPC output must contain no undefined fields");
    return contract[method].output.parse(result);
  }
  const initial = await call("overview", { hostId: null }) as { providers: { id: string; enabled: boolean }[] };
  assert.deepEqual(initial.providers.map(p => p.id), ["codex", "claude"]);
  await call("savePreferences", [{ id: "claude", enabled: true }, { id: "codex", enabled: false }]);
  plugin(bb);
  const after = await call("overview", { hostId: null }) as typeof initial;
  assert.deepEqual(after.providers.map(p => [p.id, p.enabled]), [["claude", true], ["codex", false]]);
  assert.deepEqual(requested.at(-1), ["claude"]);
  await assert.rejects(() => call("savePreferences", [{ id: "codex", enabled: true }, { id: "codex", enabled: false }]));
});
