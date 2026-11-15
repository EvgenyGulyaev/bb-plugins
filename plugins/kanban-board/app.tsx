import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BoardColumn, rpcContract } from "./server";
import { groupBoardThreads, type BoardCard } from "./lib/board-tree";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const columns: Array<{ id: BoardColumn; title: string; icon: string }> = [
  { id: "backlog", title: "В очереди", icon: "ListTodo" },
  { id: "in_progress", title: "В работе", icon: "LoaderCircle" },
  { id: "review", title: "На проверке", icon: "ScanSearch" },
  { id: "done", title: "Готово", icon: "CircleCheck" },
];

const columnTitle = new Map(columns.map((column) => [column.id, column.title]));

// The SDK exports this component under a lowercase experimental_ name, which
// JSX would read as an intrinsic element, so it needs an alias.
const ProviderIcon = experimental_ProviderIcon;

// One dot per state a reader has to notice: working, waiting on a person, and
// broken. Idle threads stay quiet.
const statusDot: Record<string, string> = {
  active: "bg-emerald-500",
  starting: "bg-emerald-500",
  stopping: "bg-amber-500",
  pending: "bg-amber-500",
  provisioning: "bg-amber-500",
  "waiting-for-host": "bg-amber-500",
  error: "bg-destructive",
};

const statusLabel: Record<string, string> = {
  active: "Работает",
  starting: "Запускается",
  stopping: "Останавливается",
  pending: "Ожидает",
  provisioning: "Готовится окружение",
  "waiting-for-host": "Ожидает машину",
  error: "Ошибка",
  idle: "Простаивает",
};

function pluralSubcards(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "подкарточек";
  if (mod10 === 1) return "подкарточка";
  if (mod10 >= 2 && mod10 <= 4) return "подкарточки";
  return "подкарточек";
}

function threadTitle(thread: PluginSidebarThread): string {
  return thread.displayTitle || thread.titleFallback || "Без названия";
}

function Subcard({
  thread,
  column,
  parentColumn,
  onOpen,
  onOpenSplit,
}: {
  thread: PluginSidebarThread;
  column: BoardColumn;
  parentColumn: BoardColumn;
  onOpen: () => void;
  onOpenSplit: () => void;
}) {
  const tone = statusDot[thread.status];
  return (
    <li
      data-board-subcard={thread.id}
      draggable
      onDragStart={(event) => {
        // The card around this row is draggable too; without stopping here its
        // handler would overwrite the payload with the parent's id.
        event.stopPropagation();
        event.dataTransfer.setData("text/thread-id", thread.id);
      }}
      className="group flex cursor-grab items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-state-hover active:cursor-grabbing"
    >
      <button
        type="button"
        aria-label={threadTitle(thread)}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ProviderIcon
          providerKind="agent"
          provider={{ id: thread.providerId }}
          fallback="Code"
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-xs leading-4">
          {threadTitle(thread)}
        </span>
        <span
          data-board-subcard-status={thread.status}
          role="img"
          aria-label={statusLabel[thread.status] ?? thread.status}
          title={statusLabel[thread.status] ?? thread.status}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone ?? "bg-muted-foreground/40",
          )}
        />
        {column === parentColumn ? null : (
          <span
            data-board-subcard-column={column}
            className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground"
          >
            {columnTitle.get(column)}
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100"
        aria-label="Открыть поток"
        onClick={onOpenSplit}
      >
        <Icon name="ArrowUpRight" className="size-3" />
      </Button>
    </li>
  );
}

function BoardCardView({
  card,
  column,
  pinned,
  placements,
  onDragStart,
  onOpen,
  onOpenSplit,
}: {
  card: BoardCard<PluginSidebarThread>;
  column: BoardColumn;
  pinned: boolean;
  placements: Record<string, { column: BoardColumn; pinned: boolean }>;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onOpen: (threadId: string) => void;
  onOpenSplit: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const thread = card.thread;
  const children = card.children;

  return (
    <Card
      data-board-card={thread.id}
      draggable
      onDragStart={onDragStart}
      className="cursor-grab shadow-sm transition hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing"
    >
      <CardHeader className="pb-2">
        <CardTitle className="line-clamp-2 text-sm leading-5">
          {threadTitle(thread)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2 pt-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {thread.id}
          </span>
          {pinned ? (
            <span title="Закреплено вручную: автопереходы не двигают эту карточку">
              <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" />
            </span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Открыть поток"
          onClick={() => onOpenSplit(thread.id)}
        >
          <Icon name="ArrowUpRight" className="size-3.5" />
        </Button>
      </CardContent>
      {children.length === 0 ? null : (
        <div className="px-3 pb-2">
          <button
            type="button"
            aria-expanded={expanded}
            data-board-children-toggle={thread.id}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              className="size-3 shrink-0"
            />
            {children.length} {pluralSubcards(children.length)}
          </button>
          {expanded ? (
            <ul
              data-board-children={thread.id}
              aria-label={`Подкарточки: ${threadTitle(thread)}`}
              className="mt-0.5 flex flex-col"
            >
              {children.map((child) => (
                <Subcard
                  key={child.id}
                  thread={child}
                  column={placements[child.id]?.column ?? "backlog"}
                  parentColumn={column}
                  onOpen={() => onOpen(child.id)}
                  onOpenSplit={() => onOpenSplit(child.id)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function BoardPage() {
  const { threads, status } = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [placements, setPlacements] = useState<Record<string, { column: BoardColumn; pinned: boolean }>>({});
  const [autoMove, setAutoMove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleThreads = useMemo(() => threads.filter((thread) => !thread.isArchived && !thread.isHidden), [threads]);
  const threadIds = useMemo(() => visibleThreads.map((thread) => thread.id), [visibleThreads]);
  const cards = useMemo(() => groupBoardThreads(visibleThreads), [visibleThreads]);
  const loadBoard = useCallback(() => {
    rpc.call("board_get", { threadIds }).then(
      ({ placements: next, autoMove: auto }) => {
        setPlacements(Object.fromEntries(next.map(({ threadId, column, pinned }) => [threadId, { column, pinned }])));
        setAutoMove(auto);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadIds]);
  useEffect(() => loadBoard(), [loadBoard]);
  useRealtime("board-changed", loadBoard);
  const move = async (threadId: string, column: BoardColumn) => {
    const previous = placements[threadId] ?? { column: "backlog" as BoardColumn, pinned: false };
    setPlacements((current) => ({ ...current, [threadId]: { column, pinned: column !== "backlog" } }));
    try { await rpc.call("board_move", { threadId, column }); }
    catch (cause) { setPlacements((current) => ({ ...current, [threadId]: previous })); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const toggleAuto = async (enabled: boolean) => {
    setAutoMove(enabled);
    try { await rpc.call("board_auto_set", { enabled }); }
    catch (cause) { setAutoMove(!enabled); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const onDrop = (event: DragEvent<HTMLElement>, column: BoardColumn) => {
    event.preventDefault();
    const threadId = event.dataTransfer.getData("text/thread-id");
    if (threadId) void move(threadId, column);
  };
  return (
    <div className="h-full min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1500px] px-4 pb-6 pt-4 md:px-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Доска задач</h1>
            <p className="mt-1 text-sm text-muted-foreground">Каждая карточка — отдельная рабочая ветка. Перетаскивайте карточки между колонками или включите автопереходы.</p>
          </div>
          <div className="flex items-center gap-3">
            <label
              className="flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground"
              title="Агент начал работу → «В работе», ход завершён → «На проверке». Ручной перенос закрепляет карточку; перенос в «В очереди» возвращает её автоматике. В «Готово» карточки двигает только человек."
            >
              <Checkbox checked={autoMove} onCheckedChange={(value) => void toggleAuto(value === true)} aria-label="Автопереходы" />
              Автопереходы
            </label>
            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{visibleThreads.length} потоков</span>
          </div>
        </div>
        {error ? <p className="mb-4 text-sm text-destructive" role="alert">{error}</p> : null}
        {status === "loading" ? <p className="text-sm text-muted-foreground">Загрузка потоков…</p> : visibleThreads.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Нет активных потоков для отображения.</div>
        ) : (
          <div className="grid min-h-[420px] gap-4 xl:grid-cols-4 md:grid-cols-2">
            {columns.map((column) => {
              const columnCards = cards.filter((card) => (placements[card.thread.id]?.column ?? "backlog") === column.id);
              return (
                <section key={column.id} className="flex min-h-[360px] flex-col rounded-xl bg-muted/30 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, column.id)} aria-label={column.title}>
                  <div className="mb-3 flex items-center justify-between px-1">
                    <div className="flex items-center gap-2 text-sm font-medium"><Icon name={column.icon} className="size-4 text-muted-foreground" />{column.title}</div>
                    <span className="text-xs text-muted-foreground">{columnCards.length}</span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    {columnCards.map((card) => (
                      <BoardCardView
                        key={card.thread.id}
                        card={card}
                        column={column.id}
                        pinned={placements[card.thread.id]?.pinned ?? false}
                        placements={placements}
                        onDragStart={(event) => event.dataTransfer.setData("text/thread-id", card.thread.id)}
                        onOpen={(threadId) => navigate.toThread(threadId)}
                        onOpenSplit={(threadId) => navigate.toThread(threadId, { split: true })}
                      />
                    ))}
                    {columnCards.length === 0 ? <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border/70 text-xs text-muted-foreground">Перетащите сюда</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "board", title: "Доска", icon: "Columns3", path: "board", component: BoardPage });
});
