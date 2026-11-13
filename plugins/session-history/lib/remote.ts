import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readClaudeTranscript } from "./sessions/claude.js";
import { readCodexTranscript } from "./sessions/codex.js";
import { readPiTranscript } from "./sessions/pi.js";
import { readQwenTranscript } from "./sessions/qwen.js";
import { commandCodeMetadata, readCommandCodeTranscript } from "./sessions/command-code.js";
import { AGENTS, isAgent, clip, oneLine, toMs, type Agent, type SessionSummary, type Transcript } from "./sessions/types.js";

export interface RemoteHost { id: string; name: string; home: string }

export interface RemoteFile { agent: Agent; mtimeMs: number; sizeBytes: number; file: string }

/** Persistent summary cache supplied by the server layer. */
export interface RemoteSummaryCache {
  get(file: RemoteFile, host: RemoteHost): SessionSummary | null;
  set(file: RemoteFile, host: RemoteHost, summary: SessionSummary): void;
  list(hostIds?: readonly string[], agentFilter?: Agent): SessionSummary[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sequence = 0;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Execute a short POSIX command on an enrolled machine without exposing its output in a terminal. */
export async function hostExec(bb: BbPluginApi, hostId: string, script: string, timeoutMs = 120_000): Promise<string | null> {
  sequence += 1;
  const out = `/tmp/bb-session-history-${Date.now()}-${sequence}.out`;
  const command = `/bin/sh -c ${shellQuote(`{ ${script} ; } > ${shellQuote(`${out}.part`)} 2>/dev/null; mv ${shellQuote(`${out}.part`)} ${shellQuote(out)}`)}`;
  let terminalId: string | null = null;
  try {
    const terminal = await bb.sdk.terminals.create({
      cols: 120,
      rows: 30,
      scope: { kind: "host_path", hostId, cwd: null },
      start: { mode: "command", command },
      title: "session-history: read remote sessions",
    });
    terminalId = terminal.id;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await bb.sdk.terminals.get({ terminalId: terminal.id });
      if (current.status === "exited") break;
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
    const file = await bb.sdk.files.read({ hostId, path: out });
    return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  } catch {
    return null;
  } finally {
    if (terminalId) await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
    await bb.sdk.files.remove({ hostId, path: out }).catch(() => {});
    await bb.sdk.files.remove({ hostId, path: `${out}.part` }).catch(() => {});
  }
}

export async function resolveRemoteHost(bb: BbPluginApi, hostId: string, name: string): Promise<RemoteHost | null> {
  const home = (await hostExec(bb, hostId, `printf '%s' "$HOME"`))?.trim();
  return home ? { id: hostId, name, home } : null;
}

export function discoveryScript(home: string, agentFilter?: Agent, enabled: readonly Agent[] = AGENTS): string {
  const stat = 'if stat -f %m . >/dev/null 2>&1; then S="-f %m|%z|%N"; else S="-c %Y|%s|%n"; fi; emit() { stat $S "$1"; }';
  const emit = (agent: Agent, root: string, pattern: string) =>
    `r=${shellQuote(root)}; if [ -d "$r" ]; then find "$r" -type f ${pattern} 2>/dev/null | while IFS= read -r f; do printf '%s\\t' ${shellQuote(agent)}; emit "$f"; done; fi`;
  const scripts: [Agent, string][] = [
    ["claude", emit("claude", `${home}/.claude`, `-path '*/projects/*/*.jsonl'`)],
    ["codex", emit("codex", `${home}/.codex/sessions`, `-name 'rollout-*.jsonl'`)],
    ["qwen", emit("qwen", `${home}/.qwen/projects`, `-path '*/chats/*.jsonl'`)],
    ["pi", `r=${shellQuote(`${home}/.pi/agent/sessions`)}; if [ -d "$r" ]; then for d in "$r"/*; do [ -d "$d" ] || continue; for f in "$d"/*.jsonl; do [ -f "$f" ] || continue; printf '%s\\t' 'pi'; emit "$f"; done; done; fi`],
    ["command-code", emit("command-code", `${home}/.commandcode/projects`, `-name '*.jsonl' ! -name '*.checkpoints.jsonl'`)],
  ];
  return [stat, ...scripts.filter(([agent]) => enabled.includes(agent) && (agentFilter === undefined || agent === agentFilter)).map(([, script]) => script)].join("; ");
}

async function remoteFiles(bb: BbPluginApi, host: RemoteHost, agentFilter: Agent | undefined, enabled: readonly Agent[]): Promise<RemoteFile[]> {
  const output = await hostExec(bb, host.id, discoveryScript(host.home, agentFilter, enabled));
  if (!output) return [];
  const rows: RemoteFile[] = [];
  for (const line of output.split("\n")) {
    const [agent, statText] = line.split("\t", 2);
    if (!agent || !statText) continue;
    const first = statText.indexOf("|");
    const second = statText.indexOf("|", first + 1);
    if (first === -1 || second === -1) continue;
    const mtimeText = statText.slice(0, first);
    const sizeText = statText.slice(first + 1, second);
    const file = statText.slice(second + 1);
    if (!file || !isAgent(agent) || !enabled.includes(agent)) continue;
    const mtimeMs = Number(mtimeText) * 1000;
    const sizeBytes = Number(sizeText);
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(sizeBytes)) continue;
    rows.push({ agent, mtimeMs, sizeBytes, file: file.trim() });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}

function jsonLines(raw: string): Record<string, unknown>[] {
  return raw.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; text?: unknown };
    return (item.type === undefined || item.type === "text") && typeof item.text === "string" ? [item.text] : [];
  }).join("\n\n");
}

function summarize(agent: Agent, file: RemoteFile, raw: string, host: RemoteHost): SessionSummary | null {
  const rows = jsonLines(raw);
  let id = path.basename(file.file, ".jsonl");
  let cwd = "";
  let title = "";
  let firstPrompt = "";
  let createdAt: number | null = null;
  let gitBranch: string | null = null;
  let model: string | null = null;
  let archived = file.file.includes("archived");
  for (const row of rows) {
    createdAt ??= toMs(row.timestamp);
    if (agent === "command-code" && typeof row.role === "string") {
      if (typeof row.sessionId === "string") id = row.sessionId;
      if (typeof row.gitBranch === "string") gitBranch = row.gitBranch;
      if (row.role === "user" && !firstPrompt) firstPrompt = contentText(row.content);
    } else if (agent === "claude") {
      if (typeof row.cwd === "string") cwd ||= row.cwd;
      if (typeof row.gitBranch === "string") gitBranch ??= row.gitBranch;
      if (typeof row.aiTitle === "string") title = row.aiTitle;
      if (typeof row.customTitle === "string") title = row.customTitle;
      const message = row.message as { content?: unknown; model?: unknown } | undefined;
      if (typeof message?.model === "string") model ??= message.model;
      if (row.type === "user" && !row.isMeta && !row.isSidechain && !firstPrompt) firstPrompt = contentText(message?.content);
    } else if (agent === "codex") {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (row.type === "session_meta" && payload) {
        if (typeof payload.id === "string") id = payload.id;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        const git = payload.git as Record<string, unknown> | undefined;
        if (typeof git?.branch === "string") gitBranch = git.branch;
      }
      if (row.type === "response_item" && payload?.type === "message" && payload.role === "user" && !firstPrompt) {
        firstPrompt = contentText(payload.content);
      }
    } else if (agent === "qwen") {
      if (typeof row.cwd === "string") cwd ||= row.cwd;
      if (typeof row.gitBranch === "string") gitBranch ??= row.gitBranch;
      if (row.type === "user" && row.provenance === "real_user" && !firstPrompt) {
        const message = row.message as { parts?: unknown } | undefined;
        firstPrompt = contentText(message?.parts);
      }
    } else {
      if (row.type === "session" && typeof row.id === "string") id = row.id;
      if (row.type === "session" && typeof row.cwd === "string") cwd = row.cwd;
      if (row.type === "message") {
        const message = row.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role === "user" && !firstPrompt) firstPrompt = contentText(message.content);
      }
      if (row.type === "session_info" && typeof row.name === "string") title = row.name.trim();
    }
    if (agent === "command-code" && typeof row.model === "string") model = row.model;
  }
  if (!title) title = firstPrompt;
  if (!title || !id) return null;
  return {
    agent,
    id,
    title: clip(oneLine(title), 200),
    firstPrompt: clip(oneLine(firstPrompt), 300),
    cwd,
    createdAt: createdAt ?? file.mtimeMs,
    updatedAt: file.mtimeMs,
    gitBranch,
    model,
    archived,
    file: file.file,
    sizeBytes: file.sizeBytes,
    hostId: host.id,
    hostName: host.name,
  };
}

export async function listRemoteSessions(
  bb: BbPluginApi,
  host: RemoteHost,
  log: (message: string) => void,
  agentFilter?: Agent,
  cache?: RemoteSummaryCache,
  enabled: readonly Agent[] = AGENTS,
  isCurrent: () => boolean = () => true,
): Promise<SessionSummary[]> {
  if (!isCurrent() || enabled.length === 0 || (agentFilter !== undefined && !enabled.includes(agentFilter))) return [];
  const files = await remoteFiles(bb, host, agentFilter, enabled);
  if (!isCurrent()) return [];
  const rows: SessionSummary[] = [];
  let index = 0;
  const worker = async () => {
    while (isCurrent() && index < files.length) {
      const file = files[index++];
      let row = cache?.get(file, host);
      if (row === null || row === undefined) {
        const head = await hostExec(bb, host.id, `head -c 262144 ${shellQuote(file.file)}`);
        if (!isCurrent()) break;
        if (!head) continue;
        row = summarize(file.agent, file, head, host);
        if (row) cache?.set(file, host, row);
      }
      if (row) {
        if (file.agent === "command-code") {
          const metadata = await bb.sdk.files.read({ hostId: host.id, path: file.file.replace(/\.jsonl$/, ".meta.json") }).catch(() => null);
          if (!isCurrent()) break;
          if (metadata) row = commandCodeMetadata(row, metadata.contentEncoding === "base64" ? Buffer.from(metadata.content, "base64").toString("utf8") : metadata.content);
        }
        rows.push(row);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  if (isCurrent() && files.length > 0 && rows.length === 0) log(`${host.name}: session files were found but could not be read`);
  return rows;
}

export async function readRemoteTranscript(
  bb: BbPluginApi,
  session: SessionSummary,
): Promise<Transcript> {
  if (!session.hostId) throw new Error("Remote session is missing its machine");
  const file = await bb.sdk.files.read({ hostId: session.hostId, path: session.file });
  const raw = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  const dir = await mkdtemp(path.join(os.tmpdir(), "bb-session-history-"));
  const local = path.join(dir, `${session.id}.jsonl`);
  try {
    await writeFile(local, raw, "utf8");
    switch (session.agent) {
      case "claude": return await readClaudeTranscript(local, true);
      case "codex": return await readCodexTranscript(local, true);
      case "qwen": return await readQwenTranscript(local, true);
      case "pi": return await readPiTranscript(local, true);
      case "command-code": return await readCommandCodeTranscript(local, true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeRemoteSession(bb: BbPluginApi, session: SessionSummary): Promise<void> {
  if (!session.hostId) throw new Error("Remote session is missing its machine");
  await bb.sdk.files.remove({ hostId: session.hostId, path: session.file });
}
