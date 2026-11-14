import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { availableCredits, contract } from "./contract.ts";
import { CodexSession, readResets, consumeReset } from "./codex-resets.ts";

const credit = { id: "first", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: 4102444800, title: "Full reset", description: null };
function fixture(overrides = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const client = { async call(method: string, params: unknown) {
    calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", email: "user@example.com" } };
    if (method === "account/rateLimits/read") return {
      accountId: "workspace-1", rateLimits: { primary: null, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 2000000000 } },
      rateLimitResetCredits: { availableCount: 5, credits: [credit, { ...credit, id: "expired", expiresAt: 1 }, { ...credit, id: "never", expiresAt: null }] }, ...overrides,
    };
    if (method === "account/rateLimitResetCredit/consume") return { outcome: "reset" };
    throw new Error("unexpected method");
  } };
  return { client, calls };
}

test("reads count independently of partial detail rows, keeps zero usage and sorts non-expiring credits last", async () => {
  const { client } = fixture();
  const data = await readResets(client, "USER@example.com");
  assert.equal(data.availableCount, 5);
  assert.deepEqual(availableCredits(data).map(c => c.id), ["first", "never"]);
  assert.equal(data.windows[0]!.remaining, 100);
  const sparse = await readResets(fixture({ rateLimitResetCredits: { availableCount: 2, credits: null } }).client, "user@example.com");
  assert.equal(sparse.availableCount, 2);
  assert.deepEqual(availableCredits(sparse), []);
});

test("explicit credit and idempotency key survive retry; account switch, expiry and missing details never redeem", async () => {
  const input = { expectedEmail: "user@example.com", expectedAccountId: "workspace-1", creditId: "first", idempotencyKey: "e904b213-73fb-4eeb-8b14-c7e037403b5c" };
  const { client, calls } = fixture();
  assert.equal(await consumeReset(client, input), "reset");
  assert.equal(await consumeReset(client, input), "reset");
  const writes = calls.filter(c => c.method.endsWith("/consume"));
  assert.deepEqual(writes.map(w => w.params), [
    { creditId: input.creditId, idempotencyKey: input.idempotencyKey },
    { creditId: input.creditId, idempotencyKey: input.idempotencyKey },
  ]);
  for (const change of [{ expectedEmail: "other@example.com" }, { expectedAccountId: "workspace-2" }, { creditId: "expired" }, { creditId: "not-returned" }]) {
    const blocked = fixture();
    await assert.rejects(() => consumeReset(blocked.client, { ...input, ...change }));
    assert.equal(blocked.calls.some(c => c.method.endsWith("/consume")), false);
  }
  const unknown = fixture({ rateLimitResetCredits: null });
  await assert.rejects(() => readResets(unknown.client, input.expectedEmail), /недоступны/);
  assert.equal(contract.consumeReset.input.safeParse({ hostId: "host-1", accountId: "account-1", ...input, confirmed: false }).success, false);
});

test("stdio client handles split frames, initialization and redacted errors; close cancels pending calls", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on("data", chunk => { sent.push(JSON.parse(String(chunk))); });
  const session = new CodexSession(child as unknown as ChildProcessWithoutNullStreams);
  const init = session.initialize();
  const reply = JSON.stringify({ id: 1, result: { userAgent: "test" } }) + "\n";
  child.stdout.write(reply.slice(0, 8)); child.stdout.write(reply.slice(8));
  await init;
  assert.deepEqual(sent.map(s => s.method), ["initialize", "initialized"]);
  const result = session.call("account/rateLimits/read", null);
  child.stdout.write(JSON.stringify({ id: 2, error: { code: -32601, message: "sensitive server error" } }) + "\n");
  await assert.rejects(result, error => error instanceof Error && /Обновите/.test(error.message) && !error.message.includes("sensitive"));
  const cancelled = session.call("account/read", {});
  session.close();
  await assert.rejects(cancelled, /отменён/);
});
