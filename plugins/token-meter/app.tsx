import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalMessageMetadataProps,
  ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type TurnUsage } from "./lib/contract.js";
import { formatThreadText, formatTurnText } from "./lib/format.js";
import { createLatestMessageStore } from "./lib/latest-message.js";
import "./app.css";

const latestMessages = createLatestMessageStore();

function turnTitle(usage: TurnUsage): string {
  return [
    `Вход: ${usage.input}`,
    `Кеш: ${usage.cached}`,
    `Кеш чтение: ${usage.cacheRead ?? "не сообщено"}`,
    `Кеш запись: ${usage.cacheWrite ?? "не сообщено"}`,
    `Выход: ${usage.output}`,
    `Reasoning: ${usage.reasoning}`,
    `Всего за вызов: ${usage.total}`,
    `Последний вызов модели: ${usage.durationMs == null ? "недоступна" : `${usage.durationMs / 1_000} с`}`,
    ...(usage.turnDurationMs === undefined ? [] : [`Весь ход: ${usage.turnDurationMs / 1_000} с`]),
    `Скорость: ${usage.tokPerSec === undefined ? "недоступна" : `${usage.tokPerSec} ток/с`}`,
  ].join("\n");
}

function MessageBadge({ message }: ExperimentalMessageMetadataProps) {
  const enabled = message.role === "assistant" && message.turnId !== null;
  const key = enabled ? `${message.threadId}:${message.turnId}` : "";
  const query = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "turn_usage",
    keys: enabled ? [key] : [],
    enabled,
    select: (rows) => enabled ? rows[key] ?? null : null,
  });

  const isLatest = useSyncExternalStore(
    latestMessages.subscribe,
    () => latestMessages.isLatest(key, message.id),
    () => false,
  );
  useEffect(() => {
    if (!enabled || message.turnId === null) return;
    return latestMessages.register({
      threadId: message.threadId,
      turnId: message.turnId,
      messageId: message.id,
      createdAt: message.createdAt,
    });
  }, [enabled, message.createdAt, message.id, message.threadId, message.turnId]);

  if (!enabled || !isLatest || !query.data) return null;
  return (
    <span className="token-meter-badge" title={turnTitle(query.data)}>
      {formatTurnText(query.data)}
    </span>
  );
}

function ContextSummary({ threadId }: ExperimentalThreadContextSegmentProps) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "thread_usage",
    input: { threadId },
  });
  if (!query.data) return null;
  return <span className="token-meter-context">{formatThreadText(query.data)}</span>;
}

export default definePluginApp((app) => {
  app.slots.experimental_messageMetadata({
    id: "token-meter",
    placement: "actionRow",
    component: MessageBadge,
  });
  app.slots.experimental_threadContextSegment({
    id: "token-meter",
    title: "Токены",
    group: "token-meter",
    summary: ContextSummary,
  });
});
