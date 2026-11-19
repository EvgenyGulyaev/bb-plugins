import { useState } from "react";
import {
  experimental_useRpcMutation,
  experimental_useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type BenchResult } from "./lib/contract.js";
import { formatBenchDate } from "./lib/format.js";

function benchText(result: BenchResult): string {
  return `~${Math.round(result.genTokPerSec)} ток/с · задержка ~${(result.latencyMs / 1_000).toFixed(1)} с · ${formatBenchDate(result.at)}`;
}

export function TokenMeterSettings() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "bench_list", input: null });
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "bench_model" });
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!query.data) {
    return query.error
      ? <p role="alert">Не удалось загрузить замеры: {query.error.message}</p>
      : <p role="status">Загрузка замеров…</p>;
  }
  const { models, results, benchEnabled, hasEndpoint } = query.data;
  const configured = benchEnabled && hasEndpoint;

  async function measure(model: string) {
    setActiveModel(model);
    setLastResult(null);
    setError(null);
    try {
      setLastResult(await mutation.mutate({ model }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActiveModel(null);
    }
  }

  return (
    <div className="token-meter-settings">
      <p className="token-meter-settings-hint">
        Один замер — это 4 платных запроса к вашей модели (до ~3300 выходных токенов) и до ~8 мин в худшем случае
        (таймаут 120 с на запрос). Кнопка отправляет их только по вашему нажатию.
      </p>
      {!benchEnabled && (
        <p className="token-meter-settings-hint">
          Включите benchEnabled и укажите benchEndpoint в настройках плагина. API key задаётся в benchApiKey (secret).
        </p>
      )}
      {benchEnabled && !hasEndpoint && (
        <p className="token-meter-settings-hint">Укажите benchEndpoint в настройках плагина, например http://localhost:8317/v1.</p>
      )}
      {models.length === 0 ? <p>Модели появятся после первого записанного хода.</p> : (
        <ul className="token-meter-settings-models" aria-label="Модели из записанных ходов">
          {models.map((model) => {
            const latest = results.find((row) => row.model === model);
            return (
              <li key={model}>
                <code>{model}</code>
                {latest && <span className="token-meter-settings-result">{benchText(latest)}</span>}
                <button
                  type="button"
                  disabled={!configured || activeModel !== null}
                  onClick={() => void measure(model)}
                >
                  {activeModel === model ? "Замер…" : "Замерить"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {lastResult && (
        <p role="status">
          {lastResult.model}: ~{Math.round(lastResult.genTokPerSec)} ток/с, задержка ~{(lastResult.latencyMs / 1_000).toFixed(1)} с
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
