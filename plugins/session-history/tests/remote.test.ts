import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { discoveryScript, listRemoteSessions } from "../lib/remote.js";
import { resumeCommand, type SessionSummary } from "../lib/sessions/index.js";

test("remote discovery respects enabled sources and skips Command Code checkpoints", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remote-session-'fixtures-"));
  try {
    const root = path.join(home, ".commandcode/projects/project");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "session.jsonl"), "{}\n");
    await writeFile(path.join(root, "session.checkpoints.jsonl"), "{}\n");
    const run = (enabled: Parameters<typeof discoveryScript>[2]) => execFileSync("/bin/sh", ["-c", discoveryScript(home, undefined, enabled)], { encoding: "utf8" });
    assert.match(run(["command-code"]), /command-code\t.*session\.jsonl/);
    assert.doesNotMatch(run(["command-code"]), /checkpoints/);
    assert.equal(run(["pi"]), "");
    assert.equal(run([]), "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Command Code resume commands preserve shell metacharacters in paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resume-quote-"));
  try {
    const cwd = path.join(root, "space ' $(printf surprise)");
    await mkdir(cwd);
    const file = path.join(cwd, "session ' $(printf surprise).jsonl");
    const session: SessionSummary = {
      agent: "command-code", id: "id", title: "Test", firstPrompt: "Test", cwd,
      createdAt: 0, updatedAt: 0, gitBranch: null, model: null, archived: false, file, sizeBytes: 0,
    };
    const result = execFileSync("/bin/sh", ["-c", `cmd() { printf '%s' "$2"; }; ${resumeCommand(session)}`], { encoding: "utf8" });
    assert.equal(result, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a superseded remote refresh starts no transcript or metadata reads", async () => {
  let active = true;
  let commands = 0;
  const bb = {
    sdk: {
      terminals: {
        create: async () => { commands += 1; return { id: "terminal" }; },
        get: async () => ({ status: "exited" }),
        close: async () => ({}),
      },
      files: {
        read: async () => {
          active = false;
          return { content: "command-code\t1700000000|10|/home/user/.commandcode/projects/project/session.jsonl", contentEncoding: "utf8" };
        },
        remove: async () => ({}),
      },
    },
  } as unknown as BbPluginApi;
  const sessions = await listRemoteSessions(bb, { id: "host", name: "Remote", home: "/home/user" }, () => {}, undefined, undefined, ["command-code"], () => active);
  assert.deepEqual(sessions, []);
  assert.equal(commands, 1);
});
