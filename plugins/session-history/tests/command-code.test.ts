import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCommandCodeSessions, readCommandCodeTranscript } from "../lib/sessions/command-code.js";

const user = (text: string) => [{ type: "text", text }];

test("Command Code discovers v2 and v3, ignores checkpoints and refreshes sidecar titles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "command-code-fixtures-"));
  try {
    const project = path.join(root, "project");
    await mkdir(project);
    const modern = path.join(project, "modern.jsonl");
    const legacy = path.join(project, "legacy.jsonl");
    await writeFile(modern, [
      { type: "session", version: 3, id: "modern", cwd: "/workspace/app", timestamp: "2026-11-14T00:00:00Z" },
      { type: "message", id: "u", parentId: null, message: { role: "user", content: user("Modern prompt") } },
      { type: "message", id: "a", parentId: "u", model: "test-model", message: { role: "assistant", content: user("Modern answer") } },
    ].map((row) => JSON.stringify(row)).join("\n"));
    await writeFile(legacy, [
      { sessionId: "legacy", id: "u", role: "user", content: user("Legacy prompt"), gitBranch: "feature", metadata: { version: 2 } },
      { sessionId: "legacy", id: "a", parentId: "u", role: "assistant", content: user("Legacy answer") },
    ].map((row) => JSON.stringify(row)).join("\n"));
    await writeFile(path.join(project, "legacy.checkpoints.jsonl"), await readFile(legacy));
    const meta = path.join(project, "modern.meta.json");
    await writeFile(meta, JSON.stringify({ title: "Named session", model: "sidecar-model" }));
    const before = await readFile(modern, "utf8");
    let sessions = await listCommandCodeSessions(root);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((session) => session.agent === "command-code"));
    assert.equal(sessions.find((session) => session.id === "modern")?.title, "Named session");
    assert.equal(sessions.find((session) => session.id === "modern")?.model, "sidecar-model");
    assert.equal(sessions.find((session) => session.id === "legacy")?.cwd, "");
    assert.equal(sessions.find((session) => session.id === "legacy")?.gitBranch, "feature");
    await writeFile(meta, JSON.stringify({ title: "Renamed" }));
    sessions = await listCommandCodeSessions(root);
    assert.equal(sessions.find((session) => session.id === "modern")?.title, "Renamed");
    await writeFile(meta, "invalid json");
    sessions = await listCommandCodeSessions(root);
    assert.equal(sessions.find((session) => session.id === "modern")?.title, "Modern prompt");
    assert.equal(sessions.find((session) => session.id === "modern")?.model, "test-model");
    assert.deepEqual((await readCommandCodeTranscript(modern)).entries.map((entry) => entry.text), ["Modern prompt", "Modern answer"]);
    assert.deepEqual((await readCommandCodeTranscript(legacy)).entries.map((entry) => entry.text), ["Legacy prompt", "Legacy answer"]);
    assert.equal(await readFile(modern, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy transcripts follow the active branch and omit reasoning and tool results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "command-code-branch-"));
  try {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, [
      { id: "u", parentId: null, role: "user", content: user("Question") },
      { id: "old", parentId: "u", role: "assistant", content: user("Abandoned answer") },
      { id: "new", parentId: "u", role: "assistant", content: [
        { type: "reasoning", text: "Private reasoning" },
        { type: "tool-call", toolName: "read_file", input: { path: "/workspace/app.ts" } },
        { type: "text", text: "Current answer" },
      ] },
      { id: "result", parentId: "new", role: "tool", content: [{ type: "tool-result", output: "Raw tool data" }] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const result = await readCommandCodeTranscript(file);
    assert.deepEqual(result.entries.filter((entry) => entry.role !== "tool").map((entry) => entry.text), ["Question", "Current answer"]);
    assert.match(result.entries.find((entry) => entry.role === "tool")?.text ?? "", /read_file.*app\.ts/);
    assert.doesNotMatch(result.entries.map((entry) => entry.text).join("\n"), /Abandoned|Private|Raw tool/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
