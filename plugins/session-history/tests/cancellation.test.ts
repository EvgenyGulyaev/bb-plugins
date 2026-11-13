import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileCache, mapLimit } from "../lib/sessions/files.js";

test("cancelled scan workers do not start queued files", async () => {
  let active = true;
  const visited: number[] = [];
  const result = await mapLimit([1, 2, 3], 1, async (value) => {
    visited.push(value);
    active = false;
    return value;
  }, () => active);
  assert.deepEqual(visited, [1]);
  assert.deepEqual(result, [1]);
});

test("a cancelled file summary is not cached after its in-flight read completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-cache-cancel-"));
  try {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "{}\n");
    const cache = new FileCache<string>();
    let active = true;
    const result = await cache.get(file, async () => { active = false; return "stale"; }, () => active);
    assert.equal(result, null);
    assert.equal(await cache.get(file, async () => "fresh"), "fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
