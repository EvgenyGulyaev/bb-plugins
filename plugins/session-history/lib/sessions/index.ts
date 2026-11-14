import { listClaudeSessions, readClaudeTranscript } from "./claude.js";
import { listCodexSessions, readCodexTranscript } from "./codex.js";
import { listQwenSessions, readQwenTranscript } from "./qwen.js";
import { listPiSessions, readPiTranscript } from "./pi.js";
import { listCommandCodeSessions, readCommandCodeTranscript } from "./command-code.js";
import { AGENTS, type Agent, type SessionSummary, type Transcript } from "./types.js";

export * from "./types.js";

const FRESH_MS = 30_000;
const scans = new Map<string, { at: number; sessions: SessionSummary[] }>();
const inFlights = new Map<string, Promise<SessionSummary[]>>();
let cacheGeneration = 0;

export function clearSessionCaches(): void {
  scans.clear();
  inFlights.clear();
  cacheGeneration += 1;
}

async function scan(log: (message: string) => void, agentFilter: Agent | undefined, enabled: readonly Agent[], isCurrent: () => boolean): Promise<SessionSummary[]> {
  const sources: [Agent, (isCurrent: () => boolean) => Promise<SessionSummary[]>][] = [
    ["claude", listClaudeSessions],
    ["codex", listCodexSessions],
    ["qwen", listQwenSessions],
    ["pi", listPiSessions],
    ["command-code", (active) => listCommandCodeSessions(undefined, active)],
  ];
  const results = await Promise.all(
    sources.filter(([agent]) => enabled.includes(agent) && (agentFilter === undefined || agent === agentFilter)).map(async ([agent, list]) => {
      try {
        return isCurrent() ? await list(isCurrent) : [];
      } catch (error) {
        log(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }),
  );
  return results.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All sessions, newest first. Concurrent callers share one scan; results stay fresh for a few seconds. */
export async function listSessions(log: (message: string) => void, agentFilter?: Agent, enabled: readonly Agent[] = AGENTS, isCurrent: () => boolean = () => true): Promise<SessionSummary[]> {
  if (!isCurrent()) return [];
  const generation = cacheGeneration;
  const active = () => generation === cacheGeneration && isCurrent();
  const prefix = enabled.join(",");
  const key = `${prefix}|${agentFilter ?? "*"}`;
  const now = Date.now();
  const cached = scans.get(key);
  if (cached && now - cached.at < FRESH_MS) return cached.sessions;
  if (agentFilter !== undefined) {
    const all = scans.get(`${prefix}|*`);
    if (all && now - all.at < FRESH_MS) return all.sessions.filter((session) => session.agent === agentFilter);
  }
  let inFlight = inFlights.get(key);
  if (!inFlight) {
    inFlight = scan(log, agentFilter, enabled, active).then(
      (sessions) => {
        if (active()) scans.set(key, { at: Date.now(), sessions });
        return active() ? sessions : [];
      },
    );
    inFlights.set(key, inFlight);
    void inFlight.then(
      () => { if (inFlights.get(key) === inFlight) inFlights.delete(key); },
      () => { if (inFlights.get(key) === inFlight) inFlights.delete(key); },
    );
  }
  return inFlight;
}

export function isUnder(cwd: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

export async function findSession(
  agent: Agent,
  id: string,
  log: (message: string) => void,
  hostId?: string,
): Promise<SessionSummary | null> {
  const match = (sessions: SessionSummary[]) =>
    sessions.find((session) => session.agent === agent && session.id === id && (hostId === undefined || session.hostId === hostId)) ?? null;
  const found = match(await listSessions(log));
  if (found !== null) return found;
  scans.clear();
  return match(await listSessions(log));
}

export function readTranscript(session: SessionSummary, complete = false): Promise<Transcript> {
  switch (session.agent) {
    case "claude":
      return readClaudeTranscript(session.file, complete);
    case "codex":
      return readCodexTranscript(session.file, complete);
    case "qwen":
      return readQwenTranscript(session.file, complete);
    case "pi":
      return readPiTranscript(session.file, complete);
    case "command-code":
      return readCommandCodeTranscript(session.file, complete);
  }
}

export function resumeCommand(session: SessionSummary): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const cd = session.cwd === "" ? "" : `cd ${quote(session.cwd)} && `;
  switch (session.agent) {
    case "claude":
      return `${cd}claude --resume ${quote(session.id)}`;
    case "codex":
      return `${cd}codex resume ${quote(session.id)}`;
    case "qwen":
      return `${cd}qwen --resume ${quote(session.id)}`;
    case "pi":
      return `${cd}pi --session ${quote(session.id)}`;
    case "command-code":
      return `${cd}cmd --session ${quote(session.file)}`;
  }
}
