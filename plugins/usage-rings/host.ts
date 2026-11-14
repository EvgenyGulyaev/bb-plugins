import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { resetHostContract } from "./contract.ts";
import { withCodex, readResets, consumeReset } from "./codex-resets.ts";

export default experimental_defineHostEntry({
  contract: resetHostContract,
  handlers: {
    readResets: (input, context) => withCodex(AbortSignal.any([context.signal, context.lifecycle.signal]), client => readResets(client, input.expectedEmail)),
    consumeReset: (input, context) => withCodex(AbortSignal.any([context.signal, context.lifecycle.signal]), client => consumeReset(client, input)),
  },
});
