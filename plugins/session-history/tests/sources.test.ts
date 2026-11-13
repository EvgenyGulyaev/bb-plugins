import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enabledAgents } from "../lib/sessions/settings.js";
import { listSessions } from "../lib/sessions/index.js";
import { AGENTS } from "../lib/sessions/types.js";

test("source settings default to all and permit disabling every CLI", async () => {
  assert.deepEqual(enabledAgents({}), AGENTS);
  assert.deepEqual(enabledAgents({ showQwen: false }), AGENTS.filter((agent) => agent !== "qwen"));
  assert.deepEqual(enabledAgents({ showClaude: false, showCodex: false, showQwen: false, showPi: false, showCommandCode: false }), []);
  assert.deepEqual(await listSessions((message) => assert.fail(message), undefined, []), []);
});

test("scanner caches do not leak results across enabled source selections", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-sources-"));
  try {
    for (const dir of [".pi/agent/sessions/project", ".commandcode/projects/project"]) {
      await mkdir(path.join(home, dir), { recursive: true });
      await writeFile(path.join(home, dir, "session.jsonl"), [
        { type: "session", version: 3, id: dir, cwd: "/workspace", timestamp: "2026-11-14T00:00:00Z" },
        { type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: dir }] } },
      ].map((row) => JSON.stringify(row)).join("\n"));
    }
    const moduleUrl = new URL("../lib/sessions/index.js", import.meta.url).href;
    const script = `import {listSessions} from ${JSON.stringify(moduleUrl)};
      const log=()=>{}; const groups=[];
      for (const agents of [['pi','command-code'],['pi'],['command-code'],[]]) {
        groups.push((await listSessions(log,undefined,agents)).map(s=>s.agent).sort());
      }
      console.log(JSON.stringify(groups));`;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual(JSON.parse(result), [["command-code", "pi"], ["pi"], ["command-code"], []]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
