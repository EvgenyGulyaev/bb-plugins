import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useRpcKeyedQuery,
  useRealtime,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { ModelMark } from "./model-mark";
import { modelBadgesContract } from "@/lib/model-badges-contract";
import type { ThreadBadge } from "@/lib/model-badges";

export type BadgeData = Record<string, ThreadBadge | null>;
export const BADGES_CHANGED = "model-badges-changed";

/** Перезапросить keyed-данные, когда сервер сообщил о смене марки/модели. */
function useRefreshOnChange(refetch: () => Promise<void>) {
  const latest = useRef(refetch);
  useEffect(() => { latest.current = refetch; }, [refetch]);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  useRealtime(BADGES_CHANGED, bump);
  useEffect(() => {
    if (version > 0) void latest.current();
  }, [version]);
}

/** Один батч на все строки списка: keyed RPC по pi-тредам. */
export function useThreadBadges({ threads }: ExperimentalThreadRowMetadataDataInput): BadgeData | undefined {
  const keys = useMemo(
    () => threads.filter((thread) => thread.providerId === "pi").map((thread) => thread.id),
    [threads],
  );
  const query = experimental_useRpcKeyedQuery({
    contract: modelBadgesContract,
    method: "model_badges_for",
    keys,
    enabled: keys.length > 0,
  });
  useRefreshOnChange(query.refetch);
  return query.data;
}

/** Чистый рендер: mark треда pi; не-pi и отсутствие данных → null. */
export function ThreadModelBadge({ thread, data }: ExperimentalThreadRowMetadataProps<BadgeData | undefined>) {
  if (thread.providerId !== "pi") return null;
  const badge = data?.[thread.id];
  if (!badge) return null;
  return <ModelMark mark={badge.mark} label={badge.model} />;
}

function useThreadBadge(threadId: string): ThreadBadge | null | undefined {
  const query = experimental_useRpcKeyedQuery({
    contract: modelBadgesContract,
    method: "model_badges_for",
    keys: [threadId],
    enabled: Boolean(threadId),
  });
  useRefreshOnChange(query.refetch);
  return query.data?.[threadId];
}

/** Контекстная строка открытого треда: марка + полное имя модели. */
export function ThreadModelSummary({ threadId }: ExperimentalThreadContextSegmentProps) {
  const badge = useThreadBadge(threadId);
  if (!badge) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={badge.model}>
      <ModelMark mark={badge.mark} label={badge.model} />
      <span className="max-w-48 truncate">{badge.model}</span>
    </span>
  );
}
