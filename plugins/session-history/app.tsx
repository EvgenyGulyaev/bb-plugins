// bb-plugin-session-history — frontend. A "Past sessions" section on the
// new-thread screen (scoped to the selected project) and a "Sessions" page
// with the full list and a transcript at /sessions/<agent>/<id>, under which a
// composer starts a BB thread that continues the session.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Markdown,
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
  type PluginHomepageSectionProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SessionRow, TranscriptRow, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

type Agent = SessionRow["agent"];
type AgentFilter = Agent | "all";

const PANEL_PATH = "sessions";
const AGENT_LABEL: Record<Agent, string> = { claude: "Claude", codex: "Codex", qwen: "Qwen", pi: "Pi" };
const AGENT_TONE: Record<Agent, string> = {
  claude: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  codex: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  qwen: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  pi: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
function ago(ms: number): string {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return t.justNow;
}

function dateTime(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch (cause) {
    toast.error(errorText(cause));
  }
}

function useSessions(projectId: string | null, hostId?: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    sessions: SessionRow[] | null;
    roots: string[];
    error: string | null;
    refreshing: boolean;
  }>({ sessions: null, roots: [], error: null, refreshing: false });
  const load = useCallback(() => {
    const input = hostId === undefined ? { projectId } : { projectId, hostId };
    rpc.call("sessions_list", input).then(
      (result) => setState({ sessions: result.sessions, roots: result.roots, error: null, refreshing: result.refreshing }),
      (cause) => setState((prev) => ({ ...prev, error: errorText(cause) })),
    );
  }, [rpc, projectId, hostId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!state.refreshing) return;
    const timer = window.setInterval(load, 2_000);
    return () => window.clearInterval(timer);
  }, [load, state.refreshing]);
  return { ...state, reload: load };
}

function useDeleteSession(reload: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  return useCallback(async (session: SessionRow) => {
    await rpc.call("session_delete", { agent: session.agent, id: session.id, hostId: session.hostId });
    toast.success(t.deleted);
    reload();
  }, [rpc, reload]);
}

function useDeleteFolder(reload: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  return useCallback(async (group: SessionFolderGroup) => {
    const result = await rpc.call("session_delete_folder", { hostId: group.hostId, cwd: group.cwd });
    toast.success(t.folderDeleted(result.deleted));
    reload();
  }, [rpc, reload]);
}

function AgentBadge({ agent }: { agent: Agent }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-14 shrink-0 items-center justify-center rounded text-[11px] font-medium",
        AGENT_TONE[agent],
      )}
    >
      {AGENT_LABEL[agent]}
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function matches(session: SessionRow, agent: AgentFilter, query: string): boolean {
  if (agent !== "all" && session.agent !== agent) return false;
  if (query === "") return true;
  const haystack = `${session.title}\n${session.firstPrompt}\n${session.cwd}\n${session.hostName}\n${session.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function SessionRowView({
  session,
  showFolder,
  onOpen,
  onDelete,
}: {
  session: SessionRow;
  showFolder: boolean;
  onOpen: () => void;
  onDelete?: (session: SessionRow) => Promise<void>;
}) {
  const subtitle = [
    showFolder ? folderName(session.cwd) : null,
    session.hostName,
    session.gitBranch,
    session.archived ? t.archived : null,
  ].filter(Boolean);
  return (
    <li>
      <div className="flex items-center gap-1 rounded-md pr-1 hover:bg-state-hover">
        <button
          type="button"
          onClick={onOpen}
          title={session.firstPrompt || session.title}
          className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left text-sm"
        >
          <AgentBadge agent={session.agent} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{session.title}</span>
            {subtitle.length > 0 ? (
              <span className="block truncate text-xs text-muted-foreground">{subtitle.join(" · ")}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{ago(session.updatedAt)}</span>
        </button>
        {onDelete ? <DeleteSessionButton session={session} onDelete={onDelete} /> : null}
      </div>
    </li>
  );
}

function DeleteSessionButton({
  session,
  onDelete,
}: {
  session: SessionRow;
  onDelete: (session: SessionRow) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(session);
      setOpen(false);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t.deleteSession}
          disabled={deleting}
        >
          <Icon name="Trash2" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.deleteSessionTitle}</DialogTitle>
          <DialogDescription>{t.deleteSessionDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={deleting}>{t.cancel}</Button>
          </DialogClose>
          <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
            {deleting ? t.deleting : t.deleteSession}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SessionFolderGroup {
  key: string;
  cwd: string;
  hostId: string;
  hostName: string;
  sessions: SessionRow[];
}

function DeleteFolderButton({
  group,
  onDelete,
}: {
  group: SessionFolderGroup;
  onDelete: (group: SessionFolderGroup) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(group);
      setOpen(false);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t.deleteFolder}
          disabled={deleting}
        >
          <Icon name="Trash2" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.deleteFolderTitle}</DialogTitle>
          <DialogDescription>{t.deleteFolderDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={deleting}>{t.cancel}</Button>
          </DialogClose>
          <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
            {deleting ? t.deleting : t.deleteFolder}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function groupSessionsByFolder(sessions: SessionRow[]): SessionFolderGroup[] {
  const groups = new Map<string, SessionFolderGroup>();
  for (const session of sessions) {
    const key = `${session.hostId}\u0000${session.cwd}`;
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
      continue;
    }
    groups.set(key, {
      key,
      cwd: session.cwd,
      hostId: session.hostId,
      hostName: session.hostName,
      sessions: [session],
    });
  }
  return [...groups.values()];
}

function sessionKey(session: SessionRow): string {
  return `${session.hostId}/${session.agent}/${session.id}`;
}

function SessionList({
  sessions,
  error,
  pageSize,
  showFolder,
  showArchivedToggle = false,
  toolbarExtra,
  onDelete,
  onDeleteFolder,
}: {
  sessions: SessionRow[] | null;
  error: string | null;
  pageSize: number;
  showFolder: boolean;
  showArchivedToggle?: boolean;
  toolbarExtra?: ReactNode;
  onDelete?: (session: SessionRow) => Promise<void>;
  onDeleteFolder?: (group: SessionFolderGroup) => Promise<void>;
}) {
  const navigate = useBbNavigate();
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const [layout, setLayout] = useState<"list" | "folders">("list");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  useEffect(() => setLimit(pageSize), [agent, query, pageSize, showArchived]);

  const availableSessions = useMemo(
    () => (sessions ?? []).filter((session) => showArchived || !session.archived),
    [sessions, showArchived],
  );

  const counts = useMemo(() => {
    const result: Record<AgentFilter, number> = { all: 0, claude: 0, codex: 0, qwen: 0, pi: 0 };
    for (const session of availableSessions) {
      result.all += 1;
      result[session.agent] += 1;
    }
    return result;
  }, [availableSessions]);
  const filtered = useMemo(
    () => availableSessions.filter((session) => matches(session, agent, query.trim())),
    [availableSessions, agent, query],
  );
  const visible = filtered.slice(0, limit);
  const visibleKeys = useMemo(() => new Set(visible.map(sessionKey)), [visible]);
  const folderGroups = useMemo(() => groupSessionsByFolder(filtered), [filtered]);
  const filters: AgentFilter[] = ["all", "claude", "codex", "qwen", "pi"];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {filters.map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant="ghost"
              aria-pressed={agent === filter}
              disabled={filter !== "all" && counts[filter] === 0}
              onClick={() => setAgent(filter)}
            >
              {filter === "all" ? t.all : AGENT_LABEL[filter]}
              <span className="text-muted-foreground">{counts[filter]}</span>
            </Button>
          ))}
        </div>
        {showArchivedToggle ? (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? t.hideArchived : t.showArchived}
          </Button>
        ) : null}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.search}
          aria-label={t.searchLabel}
          className="h-8 min-w-48 flex-1"
        />
        <div className="flex items-center gap-1" role="group" aria-label={t.viewMode}>
          <Button size="sm" variant="ghost" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
            {t.listView}
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={layout === "folders"} onClick={() => setLayout("folders")}>
            {t.folderView}
          </Button>
        </div>
        {toolbarExtra}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-2">
        {sessions === null ? (
          <EmptyState>{t.loadingList}</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>{t.emptyList}</EmptyState>
        ) : (
          <>
            {layout === "list" ? (
              <ul className="flex flex-col">
                {visible.map((session) => (
                  <SessionRowView
                    key={sessionKey(session)}
                    session={session}
                    showFolder={showFolder}
                    onDelete={onDelete}
                    onOpen={() =>
                      navigate.toPluginPanel(PANEL_PATH, { subPath: `${session.hostId}/${session.agent}/${session.id}` })
                    }
                  />
                ))}
              </ul>
            ) : (
              <ul className="flex flex-col">
                {folderGroups.filter((group) => group.sessions.some((session) => visibleKeys.has(sessionKey(session)))).map((group) => {
                  const collapsed = collapsedFolders.has(group.key);
                  const latest = group.sessions[0];
                  const visibleGroupSessions = group.sessions.filter((session) => visibleKeys.has(sessionKey(session)));
                  return (
                    <li key={group.key} className="mt-3 first:mt-1">
                      <div className="flex items-center gap-1 rounded-md pr-1 hover:bg-state-hover">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setCollapsedFolders((previous) => {
                              const next = new Set(previous);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                        >
                          <span className="w-4 shrink-0 text-center text-muted-foreground" aria-hidden>
                            {collapsed ? "▸" : "▾"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{group.cwd || t.unknownFolder}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {group.hostName} · {t.folderSessionCount(group.sessions.length)} · {ago(latest.updatedAt)}
                            </span>
                          </span>
                        </button>
                        {onDeleteFolder ? <DeleteFolderButton group={group} onDelete={onDeleteFolder} /> : null}
                      </div>
                      {!collapsed ? (
                        <ul className="ml-3 flex flex-col border-l border-border pl-2">
                          {visibleGroupSessions.map((session) => (
                            <SessionRowView
                              key={sessionKey(session)}
                              session={session}
                              showFolder={false}
                              onDelete={onDelete}
                              onOpen={() =>
                                navigate.toPluginPanel(PANEL_PATH, {
                                  subPath: `${session.hostId}/${session.agent}/${session.id}`,
                                })
                              }
                            />
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {filtered.length > limit ? (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 w-full text-muted-foreground"
                onClick={() => setLimit((value) => value + 50)}
              >
                {t.showMore(filtered.length - limit)}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function HomepageSessions({ projectId }: PluginHomepageSectionProps) {
  const [allFolders, setAllFolders] = useState(false);
  const { sessions, roots, error, reload } = useSessions(allFolders ? null : projectId);
  const onDelete = useDeleteSession(reload);
  const onDeleteFolder = useDeleteFolder(reload);
  const scoped = !allFolders && roots.length > 0;
  return (
    <SessionList
      sessions={sessions}
      error={error}
      pageSize={8}
      showFolder={!scoped}
      onDelete={onDelete}
      onDeleteFolder={onDeleteFolder}
      toolbarExtra={
        projectId !== null ? (
          <Button size="sm" variant="ghost" aria-pressed={allFolders} onClick={() => setAllFolders((v) => !v)}>
            {t.allFolders}
          </Button>
        ) : null
      }
    />
  );
}

function Message({ entry }: { entry: TranscriptRow }) {
  if (entry.role === "tool") {
    return (
      <div className="flex items-start gap-2 px-1 font-mono text-xs text-muted-foreground">
        <Icon name="Toolbox" className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="min-w-0 break-all">{entry.text}</span>
      </div>
    );
  }
  if (entry.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">
        <div className="whitespace-pre-wrap break-words">{entry.text}</div>
        {entry.timestamp !== null ? (
          <div className="mt-1 text-right text-[11px] text-muted-foreground">{dateTime(entry.timestamp)}</div>
        ) : null}
      </div>
    );
  }
  return <Markdown content={entry.text} className="text-sm" />;
}

const TRANSCRIPT_PAGE = 150;

interface TranscriptData {
  session: SessionRow;
  entries: TranscriptRow[];
  truncated: boolean;
  threadId: string | null;
  suggestedProjectId: string | null;
  suggestedProviderId: string | null;
  suggestedCwd: string | null;
  suggestedHostId: string | null;
}

/** Header, controls and the old messages; the newest page is shown first. */
function SessionTranscript({
  data,
  onBack,
  onDelete,
}: {
  data: TranscriptData;
  onBack: () => void;
  onDelete: () => Promise<void>;
}) {
  const navigate = useBbNavigate();
  const [showTools, setShowTools] = useState(false);
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const visible = useMemo(
    () => data.entries.filter((entry) => showTools || entry.role !== "tool"),
    [data.entries, showTools],
  );
  const hidden = Math.max(0, visible.length - limit);
  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
      setDeleteOpen(false);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="mx-auto box-border w-full max-w-3xl px-4 pt-3 md:px-5 md:pt-4">
      <Button size="sm" variant="ghost" onClick={onBack} className="-ml-2">
        <Icon name="ArrowLeft" />
        {t.allSessions}
      </Button>
      <div className="mt-2 flex items-start gap-3">
        <AgentBadge agent={data.session.agent} />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-snug">{data.session.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {[
              data.session.cwd,
              data.session.gitBranch,
              data.session.model,
              `${dateTime(data.session.createdAt)} — ${dateTime(data.session.updatedAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {data.threadId !== null ? (
          <Button size="sm" variant="outline" onClick={() => navigate.toThread(data.threadId!)}>
            <Icon name="MessageSquare" />
            {t.openThread}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => copy(data.session.resumeCommand, t.copiedCommand)}>
          <Icon name="Terminal" />
          {t.copyResume}
        </Button>
        <Button size="sm" variant="outline" onClick={() => copy(data.session.id, t.copiedId)}>
          <Icon name="Copy" />
          ID
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={showTools} onClick={() => setShowTools((v) => !v)}>
          <Icon name="Toolbox" />
          {t.tools}
        </Button>
        <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
          <DialogTrigger asChild>
            <Button size="sm" variant="destructive" disabled={deleting}>
              <Icon name="Trash2" />
              {t.deleteSession}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t.deleteSessionTitle}</DialogTitle>
              <DialogDescription>{t.deleteSessionDescription}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={deleting}>{t.cancel}</Button>
              </DialogClose>
              <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? t.deleting : t.deleteSession}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {data.truncated ? (
        <p className="mt-3 text-xs text-muted-foreground">{t.truncated(data.entries.length)}</p>
      ) : null}
      {hidden > 0 ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-4 w-full"
          onClick={() => setLimit((value) => value + TRANSCRIPT_PAGE)}
        >
          {t.showEarlier(hidden)}
        </Button>
      ) : null}
      <div className="mt-5 flex flex-col gap-4">
        {visible.length === 0 ? <EmptyState>{t.emptySession}</EmptyState> : null}
        {visible.slice(hidden).map((entry, index) => (
          <Message key={hidden + index} entry={entry} />
        ))}
      </div>
      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        {data.threadId !== null ? t.continuedHere : t.continueHint}
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

function TranscriptView({ agent, id, hostId }: { agent: Agent; id: string; hostId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<TranscriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    let active = true;
    const input = hostId === undefined ? { agent, id } : { agent, id, hostId };
    rpc.call("session_transcript", input).then(
      (next) => { if (active) setData(next); },
      (cause) => { if (active) setError(errorText(cause)); },
    );
    return () => { active = false; };
  }, [rpc, agent, id, hostId]);

  // Open at the end of the session, where a continuation starts.
  const loaded = data !== null && data.threadId === null;
  useEffect(() => {
    if (loaded && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [loaded]);

  const back = () => navigate.toPluginPanel(PANEL_PATH);
  const onDelete = async () => {
    const input = hostId === undefined ? { agent, id } : { agent, id, hostId };
    await rpc.call("session_delete", input);
    toast.success(t.deleted);
    navigate.toPluginPanel(PANEL_PATH);
  };
  const onSubmit = async (request: NewThreadRequest) => {
    try {
      const session = hostId === undefined ? { agent, id } : { agent, id, hostId };
      const { threadId } = await rpc.call("session_continue", {
        ...session,
        request: request as unknown as { projectId: string; input: Record<string, unknown>[] },
      });
      setData((prev) => (prev === null ? prev : { ...prev, threadId }));
    } catch (cause) {
      toast.error(errorText(cause));
      throw cause;
    }
  };

  if (data !== null && data.threadId !== null) {
    return (
      <ThreadChat
        threadId={data.threadId}
        variant="full"
        layout="contained"
        className="h-full min-h-0 flex-1"
        leadingContent={<SessionTranscript data={data} onBack={back} onDelete={onDelete} />}
      />
    );
  }

  return (
    <div ref={scroller} className="h-full min-h-0 flex-1 overflow-y-auto">
      {error !== null ? (
        <div className="mx-auto max-w-3xl px-4 pt-4 md:px-5">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        </div>
      ) : data === null ? (
        <div className="mx-auto max-w-3xl px-4 pt-4 md:px-5">
          <EmptyState>{t.loadingSession}</EmptyState>
        </div>
      ) : (
        <>
          <SessionTranscript data={data} onBack={back} onDelete={onDelete} />
          <div className="sticky bottom-0 bg-background pb-4 pt-2">
            <div className="mx-auto box-border w-full max-w-3xl px-4 md:px-5">
              <NewThreadComposer
                layout="document"
                defaultProjectId={data.suggestedProjectId ?? undefined}
                defaultProviderId={data.suggestedProviderId ?? undefined}
                defaultEnvironment={
                  data.suggestedProjectId && data.suggestedCwd
                    ? { type: "host", hostId: data.suggestedHostId ?? undefined, workspace: { type: "unmanaged", path: data.suggestedCwd } }
                    : undefined
                }
                placeholder={t.continuePlaceholder}
                draftKey={`continue:${agent}/${id}`}
                onSubmit={onSubmit}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SessionsPage({ subPath }: PluginNavPanelProps) {
  const parts = subPath.split("/");
  const [hostId, agent, id] = parts.length >= 3 ? parts : [undefined, parts[0], parts[1]];
  const [selectedHost, setSelectedHost] = useState("all");
  const [knownHosts, setKnownHosts] = useState<{ id: string; name: string }[]>([]);
  const { sessions, error, reload } = useSessions(null, selectedHost === "all" ? undefined : selectedHost);
  const onDelete = useDeleteSession(reload);
  const onDeleteFolder = useDeleteFolder(reload);
  useEffect(() => {
    if (!sessions) return;
    setKnownHosts((previous) => {
      const next = new Map(previous.map((host) => [host.id, host]));
      for (const session of sessions) next.set(session.hostId, { id: session.hostId, name: session.hostName });
      return [...next.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, [sessions]);
  if ((agent === "claude" || agent === "codex" || agent === "qwen" || agent === "pi") && id) {
    return <TranscriptView key={`${hostId}/${agent}/${id}`} agent={agent} id={id} hostId={hostId} />;
  }
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <SessionList
          sessions={sessions}
          error={error}
          pageSize={100}
          showFolder
          showArchivedToggle
          onDelete={onDelete}
          onDeleteFolder={onDeleteFolder}
          toolbarExtra={
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t.machine}</span>
              <select
                value={selectedHost}
                onChange={(event) => setSelectedHost(event.target.value)}
                aria-label={t.machine}
                className="h-8 max-w-56 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
              >
                <option value="all">{t.allMachines}</option>
                {knownHosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </select>
            </label>
          }
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "past-sessions",
    title: t.pastSessions,
    component: HomepageSessions,
  });
  app.slots.navPanel({
    id: "sessions",
    title: t.sessions,
    icon: "Clock",
    path: PANEL_PATH,
    component: SessionsPage,
  });
});
