import spawn from "cross-spawn";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { usageSchema, type Usage } from "./contract.ts";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 25_000;
const AGY_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s"] as const;

const agyBucketSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().finite(),
  reset_time: z.string().nullable().optional(),
});

const agyGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  buckets: z.array(agyBucketSchema),
});

const agyOutputSchema = z.object({
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  command: z.object({
    name: z.string(),
    data: z.object({
      groups: z.array(agyGroupSchema),
    }).optional(),
  }).optional(),
});

export function isAntigravityProvider(provider: { id: string }): boolean {
  return /^(acp-)?antigravity(-acp)?$/i.test(provider.id);
}

function classifyFailure(text: string): Usage {
  if (/session expired|token expired|re-?auth|re-?login/i.test(text)) {
    return { status: "expired", message: "Сессия Google Antigravity истекла. Войдите снова." };
  }
  if (/not logged in|not authenticated|unauthenticated|unauthorized|sign in|log in|login required|credentials/i.test(text)) {
    return { status: "unauthenticated", message: "Войдите в Google Antigravity и обновите лимиты." };
  }
  return { status: "error", message: "Не удалось получить лимиты Google Antigravity." };
}

function normalizeWindowLabel(bucket: z.infer<typeof agyBucketSchema>): string {
  if (bucket.window && /^(5h|5[- ]?hours?|five[- ]?hour)$/i.test(bucket.window)) return "Five-hour limit";
  if (bucket.window && /^(weekly|7d|week)$/i.test(bucket.window)) return "Weekly limit";
  if (/five[- ]?hour|5h/i.test(bucket.name)) return "Five-hour limit";
  if (/weekly/i.test(bucket.name)) return "Weekly limit";
  return bucket.name;
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Fall back to scanning lines for a JSON payload. */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* Keep scanning. */ }
  }
  return null;
}

export function parseAntigravityUsage(stdout: string): Usage {
  const raw = extractJson(stdout);
  const parsed = agyOutputSchema.safeParse(raw);
  if (!parsed.success) return classifyFailure(stdout);
  const data = parsed.data;
  if (data.status !== "SUCCESS") {
    return classifyFailure([data.error, data.response].filter(Boolean).join("\n"));
  }
  const groups = data.command?.name === "usage" ? data.command.data?.groups : undefined;
  if (!groups) return { status: "error", message: "Antigravity CLI не вернул данные о лимитах." };

  const orderedGroups = [...groups].sort((a, b) => {
    const aGemini = /^Gemini Models$/i.test(a.name) ? 0 : 1;
    const bGemini = /^Gemini Models$/i.test(b.name) ? 0 : 1;
    return aGemini - bGemini;
  });

  const windows = orderedGroups.flatMap(group => group.buckets.map(bucket => {
    const remaining = Math.max(0, Math.min(1, bucket.remaining_fraction));
    const usedPercent = Number(((1 - remaining) * 100).toFixed(4));
    const untouched = remaining >= 1 && !bucket.description;
    const resetsAt = untouched ? null : (bucket.reset_time?.trim() || null);
    return {
      label: normalizeWindowLabel(bucket),
      usedPercent,
      resetsAt,
      group: group.name,
    };
  }));

  return usageSchema.parse({ status: "ok", windows, accountEmail: null, planLabel: null });
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
    const kill = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1000);
    kill.unref();
    child.once("close", () => clearTimeout(kill));
  }
}

export function defaultAgyCandidates(): string[] {
  const candidates = ["agy"];
  const localBin = join(homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  if (existsSync(localBin)) candidates.push(localBin);
  return candidates;
}

type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
  overflow: boolean;
  timedOut: boolean;
  aborted: boolean;
}

function runCandidate(command: string, signal: AbortSignal | undefined, spawnFn: SpawnFn, timeoutMs: number): Promise<ExecResult> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", notFound: false, overflow: false, timedOut: false, aborted: true });
      return;
    }
    const child = spawnFn(command, AGY_ARGS, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflow = false;
    let timedOut = false;
    let aborted = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
      finish({ code: null, stdout, stderr, notFound: false, overflow, timedOut, aborted: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish({ code: null, stdout, stderr, notFound: false, overflow, timedOut: true, aborted });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        overflow = true;
        killProcessTree(child);
        finish({ code: null, stdout: "", stderr: "", notFound: false, overflow: true, timedOut, aborted });
        return;
      }
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, notFound: error.code === "ENOENT", overflow, timedOut, aborted });
    });

    child.once("close", code => {
      finish({ code, stdout, stderr, notFound: false, overflow, timedOut, aborted });
    });
  });
}

export async function readAntigravityUsage(
  signal?: AbortSignal,
  options?: { spawn?: SpawnFn; candidates?: readonly string[]; timeoutMs?: number },
): Promise<Usage> {
  const spawnFn: SpawnFn = options?.spawn ?? ((cmd, args, opts) => spawn(cmd, [...args], opts));
  const candidates = options?.candidates ?? defaultAgyCandidates();
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;

  let lastNotFound = false;
  for (const command of candidates) {
    const result = await runCandidate(command, signal, spawnFn, timeoutMs);
    if (result.aborted) throw signal?.reason instanceof Error ? signal.reason : new Error("Запрос лимитов Google Antigravity отменён.");
    if (result.notFound) { lastNotFound = true; continue; }
    if (result.overflow) return { status: "error", message: "Ответ Antigravity CLI слишком большой." };
    if (result.timedOut) return { status: "error", message: "Antigravity CLI не ответил вовремя." };
    if (result.code !== 0) {
      const parsedFromStdout = result.stdout.trim() ? parseAntigravityUsage(result.stdout) : null;
      if (parsedFromStdout && parsedFromStdout.status !== "error") return parsedFromStdout;
      return classifyFailure(`${result.stderr}\n${result.stdout}`);
    }
    return parseAntigravityUsage(result.stdout);
  }

  if (lastNotFound) {
    return { status: "not_installed", message: "Antigravity CLI (agy) не найден на этом компьютере." };
  }
  return { status: "error", message: "Не удалось получить лимиты Google Antigravity." };
}
