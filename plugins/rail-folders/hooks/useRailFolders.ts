import { useCallback, useEffect, useRef, useState } from "react";
import type { StandardSchemaV1InferInput } from "@get-bb/plugin-sdk/app";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";

import {
  EMPTY_RAIL_STATE,
  RAIL_FOLDERS_CHANGED,
  type RailFoldersState,
} from "../lib/folders";
import type { rpcContract } from "../server";

export type RailMutation = Exclude<
  keyof typeof rpcContract,
  "rail_state" | "project_paths"
>;
export type RailMutationInput<Method extends RailMutation> =
  StandardSchemaV1InferInput<(typeof rpcContract)[Method]["input"]>;

/**
 * The rail arrangement as the server holds it. Reads once on mount, reloads on
 * the plugin's realtime signal, and folds every mutation's returned state back
 * in so the rail updates without waiting for the broadcast.
 */
export function useRailFolders() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<RailFoldersState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refresh = useCallback(() => {
    rpc.call("rail_state", null).then((result) => {
      setState(result.state);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime(RAIL_FOLDERS_CHANGED, refresh);

  // Signals are ephemeral: anything published while the socket was down is
  // gone. Reconcile on every later reconnection, not on the first connect.
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    if (
      connectionState === "connected" &&
      previousConnectionState.current !== "connected"
    ) {
      refresh();
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, refresh]);

  const mutate = useCallback(
    async <Method extends RailMutation>(
      method: Method,
      input: RailMutationInput<Method>,
    ): Promise<boolean> => {
      try {
        const result = await rpc.call(method, input as never);
        setState(result.state);
        setError(null);
        return true;
      } catch (cause) {
        report(cause);
        return false;
      }
    },
    [rpc, report],
  );

  return { state: state ?? EMPTY_RAIL_STATE, isLoaded: state !== null, error, refresh, mutate };
}
