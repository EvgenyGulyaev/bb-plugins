import { homedir } from "node:os";
import path from "node:path";
import {
  FileCache,
  describeToolInput,
  mapLimit,
  scanJsonl,
} from "./files.js";
import {
  TranscriptBuilder,
  clip,
  oneLine,
  toMs,
  type SessionSummary,
  type Transcript,
} from "./types.js";

const ROOT = path.join(homedir(), ".pi", "agent", "sessions");
const cache = new FileCache<SessionSummary>();

function slug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function filesIn(root: string): Promise<string[]> {
  const out: string[] = [];
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(file);
    if (entry.isDirectory()) {
      for (const child of await readdir(file, { withFileTypes: true }).catch(() => [])) {
        if (child.isFile() && child.name.endsWith(".jsonl")) out.push(path.join(file, child.name));
      }
    }
  }
  return out;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => ((part as { text?: unknown }).text as string | undefined) ?? "")
    .filter(Boolean)
    .join("\n\n");
}

interface Info { id: string; cwd: string; title: string; createdAt: number | null }

async function summarize(file: string, info: { mtimeMs: number; size: number }): Promise<SessionSummary | null> {
  let session: Info | null = null;
  await scanJsonl(file, null, (row) => {
    if (row.type === "session" && typeof row.id === "string" && typeof row.cwd === "string") {
      session = { id: row.id, cwd: row.cwd, title: "", createdAt: toMs(row.timestamp) };
      return false;
    }
  });
  const sessionInfo = session as Info | null;
  if (!sessionInfo) return null;
  let firstPrompt = "";
  let named: string | null = null;
  await scanJsonl(file, null, (row) => {
    if (row.type === "message") {
      const message = row.message as { role?: unknown; content?: unknown } | undefined;
      if (message?.role === "user" && firstPrompt === "") firstPrompt = text(message.content);
    }
    if (row.type === "session_info" && typeof row.name === "string") named = row.name.trim() || null;
  });
  const title = named ?? firstPrompt;
  if (!title) return null;
  return {
    agent: "pi",
    id: sessionInfo.id,
    title: clip(oneLine(title), 200),
    firstPrompt: clip(oneLine(firstPrompt), 300),
    cwd: sessionInfo.cwd,
    createdAt: sessionInfo.createdAt ?? info.mtimeMs,
    updatedAt: info.mtimeMs,
    gitBranch: null,
    model: null,
    archived: false,
    file,
    sizeBytes: info.size,
  };
}

export async function listPiSessions(): Promise<SessionSummary[]> {
  const files = await filesIn(ROOT);
  const stats = await mapLimit(files, 16, async (file) => {
    const { stat } = await import("node:fs/promises");
    const info = await stat(file).catch(() => null);
    return info ? { file, mtimeMs: info.mtimeMs, size: info.size } : null;
  });
  const summaries = await mapLimit(
    stats.filter((value): value is { file: string; mtimeMs: number; size: number } => value !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs),
    8,
    ({ file, mtimeMs, size }) => cache.get(file, () => summarize(file, { mtimeMs, size })),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== null);
}

function activeBranch(rows: Record<string, unknown>[], version: number): Record<string, unknown>[] {
  if (version === 1) return rows;
  const byId = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    byId.set(row.id, row);
    leaf = row;
  }
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (leaf) {
    if (typeof leaf.id !== "string" || seen.has(leaf.id)) break;
    seen.add(leaf.id);
    branch.push(leaf);
    leaf = typeof leaf.parentId === "string" ? byId.get(leaf.parentId) : undefined;
  }
  return branch.reverse();
}

export async function readPiTranscript(file: string, complete = false): Promise<Transcript> {
  const rows: Record<string, unknown>[] = [];
  await scanJsonl(file, null, (row) => { rows.push(row); });
  const header = rows.shift();
  if (!header || header.type !== "session") return { entries: [], truncated: false };
  const branch = activeBranch(rows, typeof header.version === "number" ? header.version : 1);
  const edits = new Map<string, unknown>();
  for (const row of branch) if (row.type === "context_edit" && typeof row.targetId === "string") edits.set(row.targetId, row.replacement);
  const builder = new TranscriptBuilder(complete);
  for (const row of branch) {
    if (row.type === "compaction" || row.type === "branch_summary") {
      if (typeof row.summary === "string") builder.push("assistant", row.summary, toMs(row.timestamp));
      continue;
    }
    if (row.type !== "message") continue;
    const message = row.message as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const id = typeof row.id === "string" ? row.id : "";
    if (edits.get(id) === null) continue;
    const content = edits.has(id) ? edits.get(id) : message.content;
    builder.push(message.role as "user" | "assistant", text(content), toMs(row.timestamp));
    if (message.role === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        const call = part && typeof part === "object" ? (part as { type?: unknown; name?: unknown; arguments?: unknown }) : null;
        if (call?.type === "toolCall" && typeof call.name === "string") builder.push("tool", `${call.name}: ${oneLine(describeToolInput(call.arguments))}`, toMs(row.timestamp));
      }
    }
  }
  return builder.result();
}

export function piSessionSlug(cwd: string): string { return slug(cwd); }
