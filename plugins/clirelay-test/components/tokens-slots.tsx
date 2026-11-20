// Слоты токенов в треде: бейдж у ответа и сегмент строки контекста.
// Настройки отображения читаются одним запросом на окно (общий query cache).
import { useEffect, useSyncExternalStore } from "react";
import { experimental_useRpcKeyedQuery, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalMessageMetadataProps,
  ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { tokensRpcContract } from "../lib/tokens/contract";
import type { TokensDisplay } from "../lib/tokens/display";
import { formatThreadText, formatTurnText, formatTurnTitle } from "../lib/tokens/format";
import { createLatestMessageStore } from "../lib/tokens/latest-message";

const latestMessages = createLatestMessageStore();

/** Настройки отображения; `undefined` — ещё грузятся (тогда ничего не рисуем). */
export function useTokensDisplay(): TokensDisplay | undefined {
  return experimental_useRpcQuery({ contract: tokensRpcContract, method: "tokens_display_get", input: null }).data;
}

export function TokensMessageBadge({ message }: ExperimentalMessageMetadataProps) {
  const display = useTokensDisplay();
  // Пока настройки не пришли, бейдж не рисуется и usage не запрашивается.
  const enabled = display?.badge.enabled === true && message.role === "assistant" && message.turnId !== null;
  const key = enabled ? `${message.threadId}:${message.turnId}` : "";
  const query = experimental_useRpcKeyedQuery({
    contract: tokensRpcContract,
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
    // Выключенные бейджи не участвуют в выборах «последнего».
    if (!enabled || message.turnId === null) return;
    return latestMessages.register({
      threadId: message.threadId,
      turnId: message.turnId,
      messageId: message.id,
      createdAt: message.createdAt,
    });
  }, [enabled, message.createdAt, message.id, message.threadId, message.turnId]);

  if (!enabled || !display || !isLatest || !query.data) return null;
  const text = formatTurnText(query.data, display.badge.fields);
  if (!text) return null;
  return <span className="api-tokens-badge" title={formatTurnTitle(query.data)}>{text}</span>;
}

export function TokensContextSummary({ threadId }: ExperimentalThreadContextSegmentProps) {
  const display = useTokensDisplay();
  const on = display?.thread.enabled === true;
  const query = experimental_useRpcQuery({
    contract: tokensRpcContract,
    method: "thread_usage",
    input: { threadId },
    enabled: on,
  });
  if (!on || !display || !query.data) return null;
  const text = formatThreadText(query.data, display.thread.fields);
  return text ? <span className="api-tokens-context">{text}</span> : null;
}

/** `useVisible` сегмента: при выключенной строке он целиком уходит из ряда. */
export function useTokensContextVisible(_input: unknown): boolean {
  return useTokensDisplay()?.thread.enabled === true;
}