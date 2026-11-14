// bb-plugin-session-history — lists past CLI agent sessions
// sessions from their local stores, with the titles those agents show
// themselves, renders a read-only transcript, and continues a session as a BB
// thread that receives the transcript as agent-only context. Session files are
// only read.
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENTS,
  clearSessionCaches,
  isUnder,
  listSessions,
  readTranscript,
  resumeCommand,
  type Agent,
  type SessionSummary,
} from "./lib/sessions/index.js";
import { CONTEXT_BUDGET, continuationContext, fullTranscript, transcriptParts } from "./lib/sessions/context.js";
import { enabledAgents } from "./lib/sessions/settings.js";
import {
  listRemoteSessions,
  removeRemoteSession,
  readRemoteTranscript,
  resolveRemoteHost,
  type RemoteFile,
  type RemoteHost,
  type RemoteSummaryCache,
} from "./lib/remote.js";

const agentSchema = z.enum(AGENTS);

const sessionSchema = z.object({
  agent: agentSchema,
  id: z.string(),
  title: z.string(),
  firstPrompt: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  gitBranch: z.string().nullable(),
  model: z.string().nullable(),
  archived: z.boolean(),
  sizeBytes: z.number(),
  hostId: z.string(),
  hostName: z.string(),
  resumeCommand: z.string(),
});
export type SessionRow = z.infer<typeof sessionSchema>;

const entrySchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  timestamp: z.number().nullable(),
});
export type TranscriptRow = z.infer<typeof entrySchema>;

export const rpcContract = defineRpcContract({
  sessions_list: {
    input: z
      .object({
        /** Limit to sessions whose cwd is inside this BB project's sources. */
        projectId: z.string().nullable().optional(),
        /** Limit the list to one enrolled machine. */
        hostId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      sessions: z.array(sessionSchema),
      roots: z.array(z.string()),
      /** True while a full local and remote refresh is running in the background. */
      refreshing: z.boolean(),
    }),
  },
  session_transcript: {
    input: z.object({ agent: agentSchema, id: z.string().min(1).max(200), hostId: z.string().optional() }).strict(),
    output: z.object({
      session: sessionSchema,
      entries: z.array(entrySchema),
      truncated: z.boolean(),
      /** The BB thread that already continues this session, if any. */
      threadId: z.string().nullable(),
      /** Seeds for the continuation composer. */
      suggestedProjectId: z.string().nullable(),
      suggestedProviderId: z.string().nullable(),
      suggestedCwd: z.string().nullable(),
      suggestedHostId: z.string().nullable(),
    }),
  },
  session_continue: {
    input: z
      .object({
        agent: agentSchema,
        id: z.string().min(1).max(200),
        hostId: z.string().optional(),
        /** The composer's NewThreadRequest, forwarded to threads.spawn. */
        request: z
          .object({ projectId: z.string(), input: z.array(z.record(z.string(), z.unknown())).min(1) })
          .passthrough(),
      })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
  session_delete: {
    input: z.object({ agent: agentSchema, id: z.string().min(1).max(200), hostId: z.string().optional() }).strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  session_delete_folder: {
    input: z.object({ hostId: z.string(), cwd: z.string().max(1000) }).strict(),
    output: z.object({ deleted: z.number().int().nonnegative() }),
  },
});

/** BB provider that continues each agent's sessions. */
const PROVIDER_FOR: Record<Agent, string> = {
  claude: "claude-code",
  codex: "codex",
  qwen: "qwen",
  pi: "pi",
  "command-code": "command-code",
};

const linkKey = (agent: Agent, id: string, hostId?: string) => `link:${hostId ?? "primary"}:${agent}:${id}`;

const HOME = homedir();

/** Shows the home directory as `~` so paths stay readable and screenshots stay anonymous. */
function tildify(cwd: string): string {
  return isUnder(cwd, HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
}

function untildify(cwd: string): string {
  if (cwd === "~") return HOME;
  if (cwd.startsWith("~/")) return `${HOME}/${cwd.slice(2)}`;
  return cwd;
}

function toRow(session: SessionSummary): SessionRow {
  const { file: _file, ...rest } = session;
  return {
    ...rest,
    cwd: tildify(session.cwd),
    hostId: session.hostId ?? "primary",
    hostName: session.hostName ?? "Primary",
    resumeCommand: resumeCommand(session),
  };
}

const AGENT_LABELS: Record<SessionSummary["agent"], string> = {
  claude: "Claude",
  codex: "Codex",
  qwen: "Qwen",
  pi: "Pi",
  "command-code": "Command Code",
};

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    showClaude: { type: "boolean", default: true, label: "Claude Code" },
    showCodex: { type: "boolean", default: true, label: "Codex" },
    showQwen: { type: "boolean", default: true, label: "Qwen Code" },
    showPi: { type: "boolean", default: true, label: "Pi" },
    showCommandCode: { type: "boolean", default: true, label: "Command Code" },
  });
  const warn = (message: string) => bb.log.warn(message);
  let primaryHostId = "primary";
  let primaryHostName = "Primary";
  const combinedCache = new Map<string, { at: number; sessions: SessionSummary[] }>();
  let settingsGeneration = 0;
  settings.onChange(() => {
    settingsGeneration += 1;
    combinedCache.clear();
    clearSessionCaches();
  });
  const refreshing = new Map<string, Promise<void>>();
  let remoteHostsCache: { at: number; hosts: RemoteHost[] } | null = null;
  let hostDirectoryCache: {
    at: number;
    connected: { id: string; name: string }[];
  } | null = null;

  async function readHostDirectory(): Promise<{ id: string; name: string }[]> {
    if (hostDirectoryCache && Date.now() - hostDirectoryCache.at < 60_000) return hostDirectoryCache.connected;
    try {
      const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config()]);
      primaryHostId = config.primaryHostId ?? hosts[0]?.id ?? "primary";
      primaryHostName = hosts.find((host) => host.id === primaryHostId)?.name ?? "Primary";
      const connected = hosts.filter((host) => host.status === "connected" && host.id !== primaryHostId);
      hostDirectoryCache = { at: Date.now(), connected: connected.map((host) => ({ id: host.id, name: host.name })) };
      return hostDirectoryCache.connected;
    } catch (error) {
      warn(`machines: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async function refreshHosts(): Promise<RemoteHost[]> {
    if (remoteHostsCache && Date.now() - remoteHostsCache.at < 60_000) return remoteHostsCache.hosts;
    try {
      const connected = await readHostDirectory();
      const resolved = await Promise.all(connected.map((host) => resolveRemoteHost(bb, host.id, host.name)));
      const ready = resolved.filter((host): host is RemoteHost => host !== null);
      remoteHostsCache = { at: Date.now(), hosts: ready };
      return ready;
    } catch (error) {
      warn(`machines: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  function hostMatches(host: { id: string; name: string }, hostFilter?: string): boolean {
    return hostFilter === undefined || host.id === hostFilter || host.name === hostFilter;
  }

  async function listCachedSessions(agentFilter: Agent | undefined, hostFilter: string | undefined, enabled: readonly Agent[], generation: number): Promise<SessionSummary[]> {
    const connected = await readHostDirectory();
    if (generation !== settingsGeneration) return [];
    const remoteHostIds = connected.filter((host) => hostMatches(host, hostFilter)).map((host) => host.id);
    const hostNames = new Map(connected.map((host) => [host.id, host.name]));
    const local = (await listSessions(warn, agentFilter, enabled, () => generation === settingsGeneration))
      .filter(() => hostFilter === undefined || hostFilter === primaryHostId || hostFilter === primaryHostName)
      .map((session) => ({ ...session, hostId: primaryHostId, hostName: primaryHostName }));
    const remote = remoteSummaryCache
      .list(remoteHostIds, agentFilter)
      .filter((session) => enabled.includes(session.agent))
      .map((session) => ({ ...session, hostName: hostNames.get(session.hostId ?? "") ?? session.hostName }));
    return [...local, ...remote].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function refreshSessionCache(agentFilter: Agent | undefined, hostFilter: string | undefined, enabled: readonly Agent[], generation: number): Promise<void> {
    const isCurrent = () => generation === settingsGeneration;
    if (!isCurrent()) return;
    const cacheKey = `${generation}|${enabled.join(",")}|${agentFilter ?? "*"}|${hostFilter ?? "*"}`;
    const local = (await listSessions(warn, agentFilter, enabled, isCurrent))
      .filter(() => hostFilter === undefined || hostFilter === primaryHostId || hostFilter === primaryHostName)
      .map((session) => ({
        ...session,
        hostId: primaryHostId,
        hostName: primaryHostName,
      }));
    if (!isCurrent()) return;
    const remotes = (await refreshHosts()).filter((host) => hostFilter === undefined || host.id === hostFilter || host.name === hostFilter);
    if (!isCurrent()) return;
    const remote = (await Promise.all(remotes.map((host) => listRemoteSessions(bb, host, warn, agentFilter, remoteSummaryCache, enabled, isCurrent)))).flat();
    const sessions = [...local, ...remote].sort((a, b) => b.updatedAt - a.updatedAt);
    if (isCurrent()) combinedCache.set(cacheKey, { at: Date.now(), sessions });
  }

  function scheduleSessionRefresh(agentFilter: Agent | undefined, hostFilter: string | undefined, enabled: readonly Agent[], generation: number): boolean {
    const cacheKey = `${generation}|${enabled.join(",")}|${agentFilter ?? "*"}|${hostFilter ?? "*"}`;
    if (refreshing.has(cacheKey)) return true;
    const promise = refreshSessionCache(agentFilter, hostFilter, enabled, generation).catch((error) => {
      warn(`session refresh: ${error instanceof Error ? error.message : String(error)}`);
    });
    refreshing.set(cacheKey, promise);
    void promise.finally(() => refreshing.delete(cacheKey));
    return true;
  }

  async function listAllSessions(agentFilter?: Agent, hostFilter?: string): Promise<{ sessions: SessionSummary[]; refreshing: boolean }> {
    const generation = settingsGeneration;
    const enabled = enabledAgents(await settings.get());
    if (generation !== settingsGeneration || enabled.length === 0 || (agentFilter !== undefined && !enabled.includes(agentFilter))) return { sessions: [], refreshing: false };
    const cacheKey = `${generation}|${enabled.join(",")}|${agentFilter ?? "*"}|${hostFilter ?? "*"}`;
    let cached = combinedCache.get(cacheKey);
    if (!cached || Date.now() - cached.at >= 15_000) {
      const sessions = await listCachedSessions(agentFilter, hostFilter, enabled, generation);
      if (generation !== settingsGeneration) return { sessions: [], refreshing: false };
      cached = { at: Date.now(), sessions };
      combinedCache.set(cacheKey, cached);
    }
    if (generation !== settingsGeneration) return { sessions: [], refreshing: false };
    scheduleSessionRefresh(agentFilter, hostFilter, enabled, generation);
    return { sessions: cached.sessions, refreshing: refreshing.has(cacheKey) };
  }

  async function findAllSession(agent: Agent, id: string, hostId?: string): Promise<SessionSummary | null> {
    const sessions = (await listAllSessions(undefined, hostId)).sessions;
    return sessions.find((session) => session.agent === agent && session.id === id && (hostId === undefined || session.hostId === hostId || session.hostName === hostId)) ?? null;
  }

  async function readSessionTranscript(session: SessionSummary, complete = false) {
    if (session.hostId && session.hostId !== primaryHostId) return readRemoteTranscript(bb, session);
    return readTranscript(session, complete);
  }

  async function projectRoots(projectId: string | null | undefined): Promise<{ path: string; hostId?: string }[]> {
    if (!projectId) return [];
    try {
      const project = await bb.sdk.projects.get({ projectId });
      return project.sources.map((source) => ({ path: source.path, hostId: source.hostId }));
    } catch (error) {
      warn(`project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** The BB project whose source contains `cwd`, preferring the deepest match. */
  async function projectForCwd(cwd: string, hostId?: string): Promise<string | null> {
    if (cwd === "") return null;
    try {
      const projects = await bb.sdk.projects.list();
      let best: { id: string; depth: number } | null = null;
      for (const project of projects) {
        for (const source of project.sources) {
          if ((source.hostId === undefined || source.hostId === hostId) && isUnder(cwd, source.path) && (best === null || source.path.length > best.depth)) {
            best = { id: project.id, depth: source.path.length };
          }
        }
      }
      return best?.id ?? null;
    } catch (error) {
      warn(`projects: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function availableProvider(agent: Agent, sessionHostId?: string): Promise<string | null> {
    try {
      const providers = await bb.sdk.providers.list(sessionHostId ? { hostId: sessionHostId } : undefined);
      const id = PROVIDER_FOR[agent];
      return providers.some((provider) => provider.id === id && provider.available) ? id : null;
    } catch {
      return null;
    }
  }

  /** The live thread linked to a session; a deleted thread drops the link. */
  async function linkedThread(agent: Agent, id: string, hostId?: string): Promise<string | null> {
    const link = await bb.storage.kv.get<{ threadId: string }>(linkKey(agent, id, hostId));
    if (!link) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId: link.threadId });
      if (thread.deletedAt === null) return thread.id;
    } catch {
      // Missing thread: forget the link below.
    }
    await bb.storage.kv.delete(linkKey(agent, id, hostId));
    return null;
  }

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS session_contexts (id TEXT PRIMARY KEY, thread_id TEXT)",
    "CREATE TABLE IF NOT EXISTS session_context_parts (context_id TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(context_id, part))",
    "CREATE TABLE IF NOT EXISTS remote_session_summaries (host_id TEXT NOT NULL, agent TEXT NOT NULL, file TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, summary_json TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(host_id, agent, file))",
  ]);
  const remoteSummaryCache: RemoteSummaryCache = {
    get(file: RemoteFile, host: RemoteHost): SessionSummary | null {
      // File listings obtained through the file API do not include metadata;
      // without it we cannot safely decide that an old summary is still valid.
      if (file.mtimeMs <= 0 || file.sizeBytes <= 0) return null;
      const row = db
        .prepare("SELECT mtime_ms, size_bytes, summary_json FROM remote_session_summaries WHERE host_id = ? AND agent = ? AND file = ?")
        .get(host.id, file.agent, file.file) as { mtime_ms: number; size_bytes: number; summary_json: string } | undefined;
      if (!row || row.mtime_ms !== file.mtimeMs || row.size_bytes !== file.sizeBytes) return null;
      try {
        const summary = JSON.parse(row.summary_json) as SessionSummary;
        return { ...summary, hostId: host.id, hostName: host.name, file: file.file, sizeBytes: file.sizeBytes };
      } catch {
        return null;
      }
    },
    set(file: RemoteFile, host: RemoteHost, summary: SessionSummary): void {
      if (file.mtimeMs <= 0 || file.sizeBytes <= 0) return;
      db.prepare(
        "INSERT INTO remote_session_summaries (host_id, agent, file, mtime_ms, size_bytes, summary_json, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(host_id, agent, file) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, summary_json = excluded.summary_json, seen_at = excluded.seen_at",
      ).run(host.id, file.agent, file.file, file.mtimeMs, file.sizeBytes, JSON.stringify(summary), Date.now());
    },
    list(hostIds, agentFilter): SessionSummary[] {
      const allowed = hostIds === undefined ? null : new Set(hostIds);
      const rows = db.prepare("SELECT host_id, agent, summary_json FROM remote_session_summaries").all() as {
        host_id: string;
        agent: string;
        summary_json: string;
      }[];
      const result: SessionSummary[] = [];
      for (const row of rows) {
        if (allowed !== null && !allowed.has(row.host_id)) continue;
        if (agentFilter !== undefined && row.agent !== agentFilter) continue;
        try {
          const summary = JSON.parse(row.summary_json) as SessionSummary;
          result.push({ ...summary, hostId: row.host_id });
        } catch {
          // Ignore a corrupt cache row; the background scan will rebuild it.
        }
      }
      return result;
    },
  };
  db.prepare("DELETE FROM remote_session_summaries WHERE seen_at < ?").run(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const removeContext = (id: string) => {
    db.prepare("DELETE FROM session_context_parts WHERE context_id = ?").run(id);
    db.prepare("DELETE FROM session_contexts WHERE id = ?").run(id);
  };
  bb.events.on("thread.deleted", ({ thread }) => {
    const rows = db.prepare("SELECT id FROM session_contexts WHERE thread_id = ?").all(thread.id) as { id: string }[];
    for (const row of rows) removeContext(row.id);
  });
  bb.agents.registerTool({
    name: "session_history_read_context",
    description: "Read one part of this continuation's complete original conversation. Read all parts in order before answering the first message.",
    parameters: z.object({ part: z.number().int().min(1) }).strict(),
    async execute({ part }, { threadId }) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId });
      const id = metadata.sessionContextId;
      if (typeof id !== "string") throw new Error("This thread has no session context");
      const row = db.prepare("SELECT body FROM session_context_parts WHERE context_id = ? AND part = ?").get(id, part) as { body: string } | undefined;
      if (!row) throw new Error("Session context part not found");
      const { total } = db.prepare("SELECT COUNT(*) AS total FROM session_context_parts WHERE context_id = ?").get(id) as { total: number };
      bb.log.info(`context ${id} part ${part}/${total} read by ${threadId}`);
      return `Part ${part}/${total}${part < total ? `; next part: ${part + 1}` : "; end of original conversation"}\n\n${row.body}`;
    },
  });
  bb.agents.configure((context) => ({
    tools: typeof context.pluginMetadata.sessionContextId === "string" ? ["session_history_read_context"] : [],
    skills: [],
  }));

  const creating = new Map<string, Promise<{ threadId: string }>>();

  async function deleteSessionFile(session: SessionSummary): Promise<void> {
    if (session.hostId && session.hostId !== primaryHostId) {
      await removeRemoteSession(bb, session);
      db.prepare("DELETE FROM remote_session_summaries WHERE host_id = ? AND agent = ? AND file = ?").run(session.hostId, session.agent, session.file);
    } else {
      await rm(session.file, { force: true });
    }
    await bb.storage.kv.delete(linkKey(session.agent, session.id, session.hostId));
  }

  function clearSessionListCaches(): void {
    clearSessionCaches();
    combinedCache.clear();
  }

  bb.rpc.register(rpcContract, {
    async sessions_list({ projectId, hostId }) {
      const roots = await projectRoots(projectId);
      const result = await listAllSessions(undefined, hostId);
      const all = result.sessions;
      const sessions =
        roots.length === 0 ? all : all.filter((s) => roots.some((root) => (root.hostId === undefined || root.hostId === s.hostId) && isUnder(s.cwd, root.path)));
      return { sessions: sessions.map(toRow), roots: roots.map((root) => root.path), refreshing: result.refreshing };
    },
    async session_transcript({ agent, id, hostId }) {
      const session = await findAllSession(agent, id, hostId);
      if (session === null) throw new Error(`Session ${agent}/${id} not found`);
      const [transcript, threadId, suggestedProjectId, suggestedProviderId] = await Promise.all([
        readSessionTranscript(session),
        linkedThread(agent, id, session.hostId),
        projectForCwd(session.cwd, session.hostId),
        availableProvider(agent, session.hostId),
      ]);
      return {
        session: toRow(session),
        ...transcript,
        threadId,
        suggestedProjectId,
        suggestedProviderId,
        suggestedCwd: session.cwd || null,
        suggestedHostId: session.hostId ?? null,
      };
    },
    async session_continue({ agent, id, hostId, request }) {
      const key = linkKey(agent, id, hostId);
      const pending = creating.get(key);
      if (pending) return pending;
      const create = async () => {
        const session = await findAllSession(agent, id, hostId);
        if (session === null) throw new Error(`Session ${agent}/${id} not found`);
        const existing = await linkedThread(agent, id, session.hostId);
        if (existing !== null) {
          // A stale composer must not silently discard a newly submitted message.
          await bb.sdk.threads.send({ threadId: existing, input: request.input } as Parameters<typeof bb.sdk.threads.send>[0]);
          return { threadId: existing };
        }
        const text = fullTranscript(session, await readSessionTranscript(session, true));
        const parts = text.length > CONTEXT_BUDGET ? transcriptParts(text) : [];
        const contextId = parts.length > 0 ? randomUUID() : null;
        if (contextId !== null) {
          db.transaction(() => {
            db.prepare("INSERT INTO session_contexts (id) VALUES (?)").run(contextId);
            const insert = db.prepare("INSERT INTO session_context_parts (context_id, part, body) VALUES (?, ?, ?)");
            parts.forEach((body, index) => insert.run(contextId, index + 1, body));
          })();
        }
        let threadId: string | null = null;
        try {
          const spawnRequest = session.hostId && session.hostId !== primaryHostId
            ? { ...request, environment: { type: "host", hostId: session.hostId, workspace: { type: "unmanaged", path: session.cwd } } }
            : request;
          const thread = await bb.sdk.threads.spawn({
            ...spawnRequest,
            title: session.title,
            pluginMetadata: { sessionAgent: agent, sessionId: id, ...(contextId ? { sessionContextId: contextId } : {}) },
            input: [
              { type: "text", text: continuationContext(session, text, parts.length), mentions: [], visibility: "agent-only" },
              ...request.input,
            ],
          } as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
          threadId = thread.id;
          if (contextId) db.prepare("UPDATE session_contexts SET thread_id = ? WHERE id = ?").run(thread.id, contextId);
          await bb.storage.kv.set(linkKey(agent, id, session.hostId), { threadId: thread.id });
          bb.log.info(`continued ${agent}/${id} as ${thread.id} (${text.length} characters, ${parts.length} context parts)`);
          return { threadId: thread.id };
        } catch (error) {
          if (contextId !== null && threadId === null) removeContext(contextId);
          throw error;
        }
      };
      const promise = create();
      creating.set(key, promise);
      try {
        return await promise;
      } finally {
        creating.delete(key);
      }
    },
    async session_delete({ agent, id, hostId }) {
      const session = await findAllSession(agent, id, hostId);
      if (session === null) throw new Error(`Session ${agent}/${id} not found`);
      await deleteSessionFile(session);
      clearSessionListCaches();
      return { deleted: true as const };
    },
    async session_delete_folder({ hostId, cwd }) {
      const folder = untildify(cwd);
      const sessions = (await listAllSessions(undefined, hostId)).sessions.filter((session) => session.hostId === hostId && session.cwd === folder);
      await Promise.all(sessions.map((session) => deleteSessionFile(session)));
      clearSessionListCaches();
      return { deleted: sessions.length };
    },
  });

  const usage = [
    "Usage:",
    "  bb session-history list [--agent claude|codex|qwen|pi|command-code] [--host <id>] [--cwd <path>] [--limit <n>] [--json]",
    "  bb session-history show <agent> <session-id> [--host <id>] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "session-history",
    summary: "List past CLI agent sessions and read their transcripts",
    commands: [
      {
        name: "list",
        summary: "List past sessions, newest first",
        usage: "bb session-history list [--agent claude|codex|qwen|pi|command-code] [--host <id>] [--cwd <path>] [--limit <n>] [--json]",
      },
      {
        name: "show",
        summary: "Print a session transcript",
        usage: "bb session-history show <agent> <session-id> [--host <id>] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const option = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
      };
      const [command] = args;
      if (command === "list") {
        const agent = option("--agent");
        const host = option("--host");
        const cwd = option("--cwd");
        const limit = Math.max(1, Math.min(500, Number(option("--limit") ?? 30) || 30));
        let sessions = (await listAllSessions(agentSchema.safeParse(agent).success ? agentSchema.parse(agent) : undefined, host)).sessions;
        if (host) sessions = sessions.filter((s) => s.hostId === host || s.hostName === host);
        if (cwd) sessions = sessions.filter((s) => isUnder(s.cwd, cwd));
        const rows = sessions.slice(0, limit).map(toRow);
        if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
        const lines = rows.map(
          (s) =>
            `${AGENT_LABELS[s.agent].padEnd(6)} ${new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${s.id}  ${s.title}`,
        );
        return { exitCode: 0, stdout: lines.length === 0 ? "No sessions." : lines.join("\n") };
      }
      if (command === "show" && args.length >= 3) {
        const parsed = agentSchema.safeParse(args[1]);
        if (!parsed.success) return { exitCode: 1, stderr: usage };
        const session = await findAllSession(parsed.data, args[2]!, option("--host"));
        if (session === null) return { exitCode: 1, stderr: `No ${args[1]} session ${args[2]}.` };
        const transcript = await readSessionTranscript(session);
        const entries = json
          ? transcript.entries
          : transcript.entries.filter((entry) => entry.role !== "tool");
        const render = (entry: (typeof entries)[number]) =>
          json
            ? JSON.stringify(entry)
            : `## ${entry.role === "user" ? "User" : "Assistant"}\n\n${entry.text}`;
        // BB caps CLI output; keep the newest entries that fit.
        let budget = PLUGIN_CLI_OUTPUT_MAX_BYTES - 64 * 1024;
        let start = entries.length;
        while (start > 0) {
          const size = Buffer.byteLength(render(entries[start - 1]!)) + 2;
          if (size > budget) break;
          budget -= size;
          start -= 1;
        }
        const kept = entries.slice(start);
        const truncated = transcript.truncated || start > 0;
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ session: toRow(session), entries: kept, truncated }),
          };
        }
        const header = `# ${session.title}\n${session.cwd}\n${resumeCommand(session)}`;
        const note = start > 0 ? `\n\n… ${start} earlier entries omitted` : "";
        return { exitCode: 0, stdout: `${header}${note}\n\n${kept.map(render).join("\n\n")}` };
      }
      return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: usage };
    },
  });
}
