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
import { rpcContract } from "./lib/contract.js";
import { formatThreadText, formatTurnText, formatTurnTitle } from "./lib/format.js";
import { createLatestMessageStore } from "./lib/latest-message.js";
import { TokenMeterSettings } from "./settings.js";
import "./app.css";

const latestMessages = createLatestMessageStore();

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

  const model = query.data?.model;
  // Лёгкий метод: только готовые замеры, без списка моделей и настроек.
  const benchQuery = experimental_useRpcQuery({
    contract: rpcContract,
    method: "bench_results",
    input: null,
    enabled: model !== undefined,
  });
  const benchmark = model === undefined
    ? undefined
    : benchQuery.data?.results.find((row) => row.model === model);

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
    <span className="token-meter-badge" title={formatTurnTitle(query.data, benchmark)}>
      {formatTurnText(query.data, benchmark)}
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
  app.slots.settingsSection({
    id: "benchmark",
    title: "Замер скорости модели",
    description: "Прямой non-stream замер чистой генерации по разнице длин ответов.",
    component: TokenMeterSettings,
  });
});
