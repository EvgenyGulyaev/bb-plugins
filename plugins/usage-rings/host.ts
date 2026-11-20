import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.ts";
import { withCodex, readResets, consumeReset } from "./codex-resets.ts";
import { readAntigravityUsage } from "./antigravity-usage.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readResets: (input, context) => withCodex(AbortSignal.any([context.signal, context.lifecycle.signal]), client => readResets(client, input.expectedEmail)),
    consumeReset: (input, context) => withCodex(AbortSignal.any([context.signal, context.lifecycle.signal]), client => consumeReset(client, input)),
    readAntigravityUsage: (_input, context) => readAntigravityUsage(AbortSignal.any([context.signal, context.lifecycle.signal])),
  },
});
