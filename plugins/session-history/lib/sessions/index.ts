import { listClaudeSessions, readClaudeTranscript } from "./claude.js";
import { listCodexSessions, readCodexTranscript } from "./codex.js";
import { listQwenSessions, readQwenTranscript } from "./qwen.js";
import { listPiSessions, readPiTranscript } from "./pi.js";
import type { Agent, SessionSummary, Transcript } from "./types.js";

export * from "./types.js";

const FRESH_MS = 30_000;
const scans = new Map<string, { at: number; sessions: SessionSummary[] }>();
const inFlights = new Map<string, Promise<SessionSummary[]>>();

export function clearSessionCaches(): void {
  scans.clear();
}

async function scan(log: (message: string) => void, agentFilter?: Agent): Promise<SessionSummary[]> {
  const sources: [Agent, () => Promise<SessionSummary[]>][] = [
    ["claude", listClaudeSessions],
    ["codex", listCodexSessions],
    ["qwen", listQwenSessions],
    ["pi", listPiSessions],
  ];
  const results = await Promise.all(
    sources.filter(([agent]) => agentFilter === undefined || agent === agentFilter).map(async ([agent, list]) => {
      try {
        return await list();
      } catch (error) {
        log(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }),
  );
  return results.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All sessions, newest first. Concurrent callers share one scan; results stay fresh for a few seconds. */
export async function listSessions(log: (message: string) => void, agentFilter?: Agent): Promise<SessionSummary[]> {
  const key = agentFilter ?? "*";
  const now = Date.now();
  const cached = scans.get(key);
  if (cached && now - cached.at < FRESH_MS) return cached.sessions;
  if (agentFilter !== undefined) {
    const all = scans.get("*");
    if (all && now - all.at < FRESH_MS) return all.sessions.filter((session) => session.agent === agentFilter);
  }
  let inFlight = inFlights.get(key);
  if (!inFlight) {
    inFlight = scan(log, agentFilter).then(
      (sessions) => {
        scans.set(key, { at: Date.now(), sessions });
        return sessions;
      },
    );
    inFlights.set(key, inFlight);
    void inFlight.then(
      () => inFlights.delete(key),
      () => inFlights.delete(key),
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
  }
}

export function resumeCommand(session: SessionSummary): string {
  const cd = session.cwd === "" ? "" : `cd ${JSON.stringify(session.cwd)} && `;
  switch (session.agent) {
    case "claude":
      return `${cd}claude --resume ${session.id}`;
    case "codex":
      return `${cd}codex resume ${session.id}`;
    case "qwen":
      return `${cd}qwen --resume ${session.id}`;
    case "pi":
      return `${cd}pi --session ${session.id}`;
  }
}
