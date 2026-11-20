// Вкладка «Настройки»: что показывать в строке треда и в бейдже у ответа.
// Пишем по одной галочке за вызов, оптимистично — превью и бейджи меняются сразу.
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { tokensRpcContract } from "../lib/tokens/contract";
import {
  BADGE_FIELDS,
  THREAD_FIELDS,
  applyTokensDisplayPatch,
  type BadgeField,
  type ThreadField,
  type TokensDisplay,
  type TokensDisplayPatch,
} from "../lib/tokens/display";
import { formatThreadText, formatTurnText } from "../lib/tokens/format";
import { useTokensDisplay } from "./tokens-slots";

const THREAD_LABELS: Record<ThreadField, string> = {
  total: "Σ токенов",
  speed: "ток/с (эфф.)",
  model: "модель",
  turns: "число ходов",
  contextWindow: "окно контекста",
};

const BADGE_LABELS: Record<BadgeField, string> = {
  input: "вход ↑",
  output: "выход ↓",
  cache: "кэш",
  reasoning: "reasoning",
  speed: "ток/с (эфф.)",
  model: "модель",
};

/** Примеры рисуются теми же форматтерами, поэтому не разъедутся с реальным выводом. */
const SAMPLE_THREAD = {
  total: 5_100_000, turns: 12, averageTokPerSec: 51.3, modelContextWindow: 1_000_000, model: "example-model",
};
const SAMPLE_TURN = {
  input: 1_200, cached: 265_000, output: 740, reasoning: 120, tokPerSec: 59.2, model: "example-model",
};
const EMPTY = "Нечего показывать — отметьте хотя бы одно поле";
const OFF = "Выключено";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function sample(text: string, muted: boolean) {
  return <p className={`mt-3 rounded-md bg-background/60 px-2 py-1 font-mono text-xs ${muted ? "text-muted-foreground" : ""}`}>{text}</p>;
}

function threadSample(display: TokensDisplay): { text: string; muted: boolean } {
  if (!display.thread.enabled) return { text: OFF, muted: true };
  const text = formatThreadText(SAMPLE_THREAD, display.thread.fields);
  return text ? { text, muted: false } : { text: EMPTY, muted: true };
}

function badgeSample(display: TokensDisplay): { text: string; muted: boolean } {
  if (!display.badge.enabled) return { text: OFF, muted: true };
  const text = formatTurnText(SAMPLE_TURN, display.badge.fields);
  return text ? { text, muted: false } : { text: EMPTY, muted: true };
}

function FieldCheckbox({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <Checkbox checked={checked} disabled={disabled} aria-label={label}
        onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

export function TokensSettingsTab() {
  const display = useTokensDisplay();
  const set = experimental_useRpcMutation({
    contract: tokensRpcContract,
    method: "tokens_display_set",
    optimistic: (patch, cache) =>
      cache.update("tokens_display_get", null, (current) => applyTokensDisplayPatch(current, patch)),
  });
  const send = (patch: TokensDisplayPatch) => {
    set.mutate(patch).catch((cause: unknown) => toast.error(message(cause)));
  };

  // Пока настройки грузятся — скелетон, как у «Аккаунтов».
  if (!display) return <div className="h-40 animate-pulse rounded-xl bg-muted/40" />;

  const thread = threadSample(display);
  const badge = badgeSample(display);

  return (
    <div className="flex flex-col gap-3">
      {set.error ? <p className="text-sm text-destructive" role="alert">{set.error.message}</p> : null}

      <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Строка треда</h3>
            <p className="mt-1 text-xs text-muted-foreground">Сводка над полем ввода: сумма по записанным ходам треда.</p>
          </div>
          <Switch checked={display.thread.enabled} label="Показывать строку треда"
            onChange={(enabled) => send({ target: "thread", enabled })} />
        </div>
        <div className={`mt-3 flex flex-wrap gap-x-4 gap-y-2 ${display.thread.enabled ? "" : "opacity-60"}`}>
          {THREAD_FIELDS.map((field) => (
            <FieldCheckbox key={field} label={`Строка треда: ${THREAD_LABELS[field]}`}
              checked={display.thread.fields[field]} disabled={!display.thread.enabled}
              onChange={(on) => send({ target: "threadField", field, on })} />
          ))}
        </div>
        {sample(thread.text, thread.muted)}
      </section>

      <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Бейдж у ответа</h3>
            <p className="mt-1 text-xs text-muted-foreground">Токены последнего вызова модели у последнего ответа хода.</p>
          </div>
          <Switch checked={display.badge.enabled} label="Показывать бейдж у ответа"
            onChange={(enabled) => send({ target: "badge", enabled })} />
        </div>
        <div className={`mt-3 flex flex-wrap gap-x-4 gap-y-2 ${display.badge.enabled ? "" : "opacity-60"}`}>
          {BADGE_FIELDS.map((field) => (
            <FieldCheckbox key={field} label={`Бейдж у ответа: ${BADGE_LABELS[field]}`}
              checked={display.badge.fields[field]} disabled={!display.badge.enabled}
              onChange={(on) => send({ target: "badgeField", field, on })} />
          ))}
        </div>
        {sample(badge.text, badge.muted)}
      </section>

      <p className="text-xs text-muted-foreground">
        Сбор токенов идёт всегда, даже когда показ выключен. Изменения применяются сразу во всех окнах.
        Скорость «эфф.» — выход ÷ время последнего вызова модели, включая ожидание первого токена.
      </p>
    </div>
  );
}