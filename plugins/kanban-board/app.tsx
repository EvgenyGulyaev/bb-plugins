import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { BoardColumn, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";

const columns: Array<{ id: BoardColumn; title: string; icon: string }> = [
  { id: "backlog", title: "В очереди", icon: "ListTodo" },
  { id: "in_progress", title: "В работе", icon: "LoaderCircle" },
  { id: "review", title: "На проверке", icon: "ScanSearch" },
  { id: "done", title: "Готово", icon: "CircleCheck" },
];

function BoardPage() {
  const { threads, status } = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [placements, setPlacements] = useState<Record<string, BoardColumn>>({});
  const [error, setError] = useState<string | null>(null);
  const visibleThreads = useMemo(() => threads.filter((thread) => !thread.isArchived && !thread.isHidden), [threads]);
  const threadIds = useMemo(() => visibleThreads.map((thread) => thread.id), [visibleThreads]);
  const loadBoard = useCallback(() => {
    if (threadIds.length === 0) { setPlacements({}); return; }
    rpc.call("board_get", { threadIds }).then(
      ({ placements: next }) => { setPlacements(Object.fromEntries(next.map(({ threadId, column }) => [threadId, column]))); setError(null); },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadIds]);
  useEffect(() => loadBoard(), [loadBoard]);
  useRealtime("board-changed", loadBoard);
  const move = async (threadId: string, column: BoardColumn) => {
    const previous = placements[threadId] ?? "backlog";
    setPlacements((current) => ({ ...current, [threadId]: column }));
    try { await rpc.call("board_move", { threadId, column }); }
    catch (cause) { setPlacements((current) => ({ ...current, [threadId]: previous })); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>, column: BoardColumn) => {
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
            <p className="mt-1 text-sm text-muted-foreground">Каждая карточка — отдельная рабочая ветка. Перетаскивайте карточки между колонками.</p>
          </div>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{visibleThreads.length} потоков</span>
        </div>
        {error ? <p className="mb-4 text-sm text-destructive" role="alert">{error}</p> : null}
        {status === "loading" ? <p className="text-sm text-muted-foreground">Загрузка потоков…</p> : visibleThreads.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Нет активных потоков для отображения.</div>
        ) : (
          <div className="grid min-h-[420px] gap-4 xl:grid-cols-4 md:grid-cols-2">
            {columns.map((column) => {
              const columnThreads = visibleThreads.filter((thread) => (placements[thread.id] ?? "backlog") === column.id);
              return (
                <section key={column.id} className="flex min-h-[360px] flex-col rounded-xl bg-muted/30 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, column.id)} aria-label={column.title}>
                  <div className="mb-3 flex items-center justify-between px-1">
                    <div className="flex items-center gap-2 text-sm font-medium"><Icon name={column.icon} className="size-4 text-muted-foreground" />{column.title}</div>
                    <span className="text-xs text-muted-foreground">{columnThreads.length}</span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    {columnThreads.map((thread) => (
                      <Card key={thread.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/thread-id", thread.id)} className="cursor-grab shadow-sm transition hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing">
                        <CardHeader className="pb-2"><CardTitle className="line-clamp-2 text-sm leading-5">{thread.displayTitle || thread.titleFallback || "Без названия"}</CardTitle></CardHeader>
                        <CardContent className="flex items-center justify-between gap-2 pt-0">
                          <span className="truncate font-mono text-[10px] text-muted-foreground">{thread.id}</span>
                          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Открыть поток" onClick={() => navigate.toThread(thread.id, { split: true })}><Icon name="ArrowUpRight" className="size-3.5" /></Button>
                        </CardContent>
                      </Card>
                    ))}
                    {columnThreads.length === 0 ? <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border/70 text-xs text-muted-foreground">Перетащите сюда</div> : null}
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

