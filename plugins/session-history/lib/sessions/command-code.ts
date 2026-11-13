import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { FileCache, describeToolInput, listDirs, listJsonl, mapLimit, scanJsonl } from "./files.js";
import { activeBranch, readPiTranscript } from "./pi.js";
import { TranscriptBuilder, clip, oneLine, toMs, type SessionSummary, type Transcript } from "./types.js";

const ROOT = path.join(homedir(), ".commandcode", "projects");
const cache = new FileCache<SessionSummary>();

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n\n");
}

export function commandCodeMetadata(summary: SessionSummary, raw: string): SessionSummary {
  try {
    const meta: unknown = JSON.parse(raw);
    if (!meta || typeof meta !== "object") return summary;
    const { title, model } = meta as { title?: unknown; model?: unknown };
    return {
      ...summary,
      title: typeof title === "string" && title.trim() ? clip(oneLine(title), 200) : summary.title,
      model: typeof model === "string" && model.trim() ? model : summary.model,
    };
  } catch {
    return summary;
  }
}

export async function summarizeCommandCode(
  file: string,
  info: { mtimeMs: number; size: number },
): Promise<SessionSummary | null> {
  let id = "";
  let cwd = "";
  let firstPrompt = "";
  let title = "";
  let createdAt: number | null = null;
  let model: string | null = null;
  let gitBranch: string | null = null;
  await scanJsonl(file, null, (row) => {
    createdAt ??= toMs(row.timestamp);
    if (row.type === "session") {
      if (typeof row.id === "string") id = row.id;
      if (typeof row.cwd === "string") cwd = row.cwd;
    }
    if (!id && typeof row.sessionId === "string") id = row.sessionId;
    if (row.type === "session_info" && typeof row.name === "string") title = row.name.trim();
    if (typeof row.model === "string") model = row.model;
    if (typeof row.gitBranch === "string") gitBranch = row.gitBranch;
    const message = row.type === "message" ? row.message as { role?: unknown; content?: unknown } | undefined : row;
    if (!firstPrompt && message?.role === "user") firstPrompt = text(message.content);
  });
  if (!id || !(title || firstPrompt)) return null;
  return {
    agent: "command-code", id, cwd, title: clip(oneLine(title || firstPrompt), 200),
    firstPrompt: clip(oneLine(firstPrompt), 300), createdAt: createdAt ?? info.mtimeMs,
    updatedAt: info.mtimeMs, model, gitBranch, archived: false, file, sizeBytes: info.size,
  };
}

export async function listCommandCodeSessions(root = ROOT, isCurrent: () => boolean = () => true): Promise<SessionSummary[]> {
  if (!isCurrent()) return [];
  const files = (await mapLimit(await listDirs(root), 8, listJsonl, isCurrent)).flat()
    .filter((file) => !file.endsWith(".checkpoints.jsonl"));
  const summaries = await mapLimit(files, 8, async (file) => {
    const summary = await cache.get(file, (info) => summarizeCommandCode(file, info), isCurrent);
    if (!summary || !isCurrent()) return null;
    // Titles can change without a transcript write, so read the small sidecar outside its cache.
    const raw = await readFile(file.replace(/\.jsonl$/, ".meta.json"), "utf8").catch(() => "");
    return commandCodeMetadata(summary, raw);
  }, isCurrent);
  return summaries.filter((summary): summary is SessionSummary => summary !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readCommandCodeTranscript(file: string, complete = false): Promise<Transcript> {
  let modern = false;
  await scanJsonl(file, null, (row) => { modern = row.type === "session"; return false; });
  if (modern) return readPiTranscript(file, complete);
  const rows: Record<string, unknown>[] = [];
  await scanJsonl(file, null, (row) => { rows.push(row); });
  const builder = new TranscriptBuilder(complete);
  for (const row of activeBranch(rows, 3)) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    builder.push(row.role, text(row.content), toMs(row.timestamp));
    if (row.role === "assistant" && Array.isArray(row.content)) {
      for (const part of row.content) {
        if (part?.type === "tool-call" && typeof part.toolName === "string") {
          builder.push("tool", `${part.toolName}: ${oneLine(describeToolInput(part.input))}`, toMs(row.timestamp));
        }
      }
    }
    if (builder.full) break;
  }
  return builder.result();
}
