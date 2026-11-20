import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { isAntigravityProvider, parseAntigravityUsage, readAntigravityUsage } from "./antigravity-usage.ts";
import { remainingPercent, selectWindow } from "./limits.ts";

const samplePayload = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-27T17:12:23Z\n",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-27T17:28:31Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.4, reset_time: "2026-11-20T22:28:31Z", description: "Used." },
          ],
        },
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", description: "Used.", window: "weekly", remaining_fraction: 0.97998, reset_time: "2026-11-27T17:12:23Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", description: "Used.", window: "5h", remaining_fraction: 0.95814, reset_time: "2026-11-20T22:12:23Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-27T17:28:31Z" },
          ],
        },
      ],
    },
  },
});

test("recognizes Google Antigravity provider IDs", () => {
  assert.equal(isAntigravityProvider({ id: "acp-antigravity-acp" }), true);
  assert.equal(isAntigravityProvider({ id: "antigravity" }), true);
  assert.equal(isAntigravityProvider({ id: "codex" }), false);
  assert.equal(isAntigravityProvider({ id: "acp-opencode" }), false);
});

test("parses agy /usage JSON, orders Gemini Models first, hides untouched reset times, and selects Gemini 5h for ring", () => {
  const usage = parseAntigravityUsage(`notice line\n${samplePayload}\n`);
  assert.equal(usage.status, "ok");
  assert.equal(usage.windows.length, 5);
  assert.equal(usage.windows[0]!.group, "Gemini Models");
  assert.equal(usage.windows[0]!.label, "Weekly limit");
  assert.equal(remainingPercent(usage.windows[0]!), 98);
  assert.equal(usage.windows[0]!.resetsAt, "2026-11-27T17:12:23Z");

  assert.equal(usage.windows[1]!.group, "Gemini Models");
  assert.equal(usage.windows[1]!.label, "Five-hour limit");
  assert.equal(remainingPercent(usage.windows[1]!), 96);

  const untouchedClaudeWeekly = usage.windows.find(w => w.group === "Claude and GPT models" && w.label === "Weekly limit")!;
  assert.equal(remainingPercent(untouchedClaudeWeekly), 100);
  assert.equal(untouchedClaudeWeekly.resetsAt, null);

  const usedClaude5h = usage.windows.find(w => w.group === "Claude and GPT models" && w.label === "Five-hour limit")!;
  assert.equal(remainingPercent(usedClaude5h), 40);
  assert.equal(usedClaude5h.resetsAt, "2026-11-20T22:28:31Z");

  const argon = usage.windows.find(w => w.group === "Gemini 4 Argon")!;
  assert.equal(argon.label, "Weekly limit");
  assert.equal(argon.resetsAt, null);

  const selected = selectWindow(usage.windows)!;
  assert.equal(selected.group, "Gemini Models");
  assert.equal(selected.label, "Five-hour limit");
  assert.equal(remainingPercent(selected), 96);
});

test("classifies auth errors and redacts raw stderr diagnostics", () => {
  const unauth = parseAntigravityUsage(JSON.stringify({ status: "ERROR", error: "User is not authenticated; token=secret123" }));
  assert.equal(unauth.status, "unauthenticated");
  assert.equal(unauth.message?.includes("secret123"), false);

  const expired = parseAntigravityUsage(JSON.stringify({ status: "ERROR", error: "Session expired for user@example.com" }));
  assert.equal(expired.status, "expired");
  assert.equal(expired.message?.includes("user@example.com"), false);

  const broken = parseAntigravityUsage("not json with sensitive=xyz");
  assert.equal(broken.status, "error");
  assert.equal(broken.message?.includes("sensitive"), false);
});

test("readAntigravityUsage falls back across candidate paths and reports not_installed when missing", async () => {
  const tried: string[] = [];
  const spawnMock = (command: string) => {
    tried.push(command);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null });
    queueMicrotask(() => {
      if (command === "agy") {
        const error = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
        child.emit("error", error);
      } else {
        child.stdout.end(samplePayload);
        child.emit("close", 0);
      }
    });
    return child as unknown as ChildProcess;
  };
  const ok = await readAntigravityUsage(undefined, { spawn: spawnMock, candidates: ["agy", "/custom/agy"] });
  assert.deepEqual(tried, ["agy", "/custom/agy"]);
  assert.equal(ok.status, "ok");

  const missing = await readAntigravityUsage(undefined, {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
      return child as unknown as ChildProcess;
    },
    candidates: ["agy"],
  });
  assert.equal(missing.status, "not_installed");
});
