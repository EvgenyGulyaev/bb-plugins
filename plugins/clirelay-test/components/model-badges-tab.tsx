import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { ModelMark } from "./model-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { ProviderView } from "@/lib/schema";
import { FAMILY_IDS, FAMILY_LABELS, familyOf, type FamilyId } from "@/lib/model-families";
import { DEFAULT_MARKS, type FamilyMark } from "@/lib/model-marks";
import type { BadgesState } from "@/lib/model-badges";
import { BADGES_CHANGED } from "./thread-model-badge";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Report = (cause: unknown) => void;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** BB-иконки, которые предлагаются для марки семейства. */
const ICON_CHOICES = [
  "Sparkles", "MessageSquare", "Brain", "Zap", "Gem", "Cloud", "Moon", "Bot",
  "Cpu", "Wind", "Rocket", "Star", "Code", "Terminal", "Globe", "Wrench",
] as const;

function MarkPreview({ mark, label }: { mark: FamilyMark; label: string }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-md border border-border/70 bg-background">
      <ModelMark mark={mark} label={label} className="size-3.5" />
    </span>
  );
}

function IconPicker({ value, onChange, label }: { value: string; onChange: (name: string) => void; label: string }) {
  const choices: readonly string[] = (ICON_CHOICES as readonly string[]).includes(value) ? ICON_CHOICES : [value, ...ICON_CHOICES];
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-8 gap-1">
      {choices.map((name) => {
        const checked = name === value;
        return (
          <button key={name} type="button" role="radio" aria-checked={checked} aria-label={name} onClick={() => onChange(name)}
            className={`flex h-7 items-center justify-center rounded-md border text-muted-foreground outline-none transition focus-visible:ring-1 focus-visible:ring-ring ${checked ? "border-foreground bg-muted text-foreground" : "border-border hover:bg-muted/60"}`}>
            <Icon name={name} fallback="Zap" className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function FamilyMarkEditor({ family, mark, rpc, report }: { family: FamilyId; mark: FamilyMark; rpc: Rpc; report: Report }) {
  const label = FAMILY_LABELS[family];
  const [draft, setDraft] = useState<FamilyMark>(mark);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(mark), [mark]);
  const dirty = draft.kind !== mark.kind || draft.value !== mark.value;
  const save = () => {
    setBusy(true);
    setError(null);
    rpc.call("model_badges_marks_set", { family, mark: draft }).then(
      () => { setBusy(false); toast.success(`Марка «${label}» сохранена`); },
      (cause) => { setBusy(false); const text = message(cause); setError(text); report(cause); },
    );
  };
  const readFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    file.text().then((text) => setDraft({ kind: "svg", value: text }), (cause) => setError(message(cause)));
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-md bg-muted/40 p-0.5" role="group" aria-label={`Тип марки «${label}»`}>
          {([["icon", "Иконка"], ["text", "Текст"], ["svg", "SVG"]] as const).map(([kind, title]) => (
            <button key={kind} type="button" aria-pressed={draft.kind === kind}
              onClick={() => setDraft(kind === "icon" ? { kind, value: ICON_CHOICES[0] } : kind === "text" ? { kind, value: label } : { kind, value: "" })}
              className={`rounded px-2 py-0.5 text-[11px] transition ${draft.kind === kind ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {title}
            </button>
          ))}
        </div>
        <MarkPreview mark={draft} label={`${label}: предпросмотр`} />
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setDraft(DEFAULT_MARKS[family])}>
          <Icon name="RotateCcw" className="size-3.5" />Сброс
        </Button>
        <Button size="sm" className="ml-auto" disabled={busy || !dirty} onClick={save}>
          <Icon name={busy ? "Loading" : "Check"} className={`size-3.5 ${busy ? "animate-spin" : ""}`} />Сохранить
        </Button>
      </div>
      {draft.kind === "icon" ? (
        <IconPicker value={draft.value} onChange={(value) => setDraft({ kind: "icon", value })} label={`Иконка «${label}»`} />
      ) : draft.kind === "text" ? (
        <Input className="h-8 w-32" value={draft.value} maxLength={16} aria-label={`Текст марки «${label}»`}
          onChange={(event) => setDraft({ kind: "text", value: event.target.value })} placeholder="х5" />
      ) : (
        <div className="flex flex-col gap-1.5">
          <textarea className="h-24 w-full rounded-md border border-input bg-transparent p-2 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={draft.value} aria-label={`SVG-марка «${label}»`} spellCheck={false}
            onChange={(event) => setDraft({ kind: "svg", value: event.target.value })}
            placeholder='<svg viewBox="0 0 16 16">…</svg>' />
          <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="Upload" className="size-3.5" />Загрузить .svg
            <input type="file" accept="image/svg+xml,.svg" className="text-xs" aria-label={`Файл SVG для «${label}»`}
              onChange={(event) => { readFile(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          <p className="text-[11px] text-muted-foreground">Только безопасный inline SVG: без script, foreignObject и внешних ссылок.</p>
        </div>
      )}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

function FamilyRow({ family, mark, models, rpc, report }: { family: FamilyId; mark: FamilyMark; models: string[]; rpc: Rpc; report: Report }) {
  const [open, setOpen] = useState(false);
  const label = FAMILY_LABELS[family];
  return (
    <section className="rounded-xl border border-border/60 bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
          <MarkPreview mark={mark} label={label} />
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{models.length} мод.</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{models.slice(0, 3).join(", ")}</span>
        </button>
      </div>
      {open ? <FamilyMarkEditor family={family} mark={mark} rpc={rpc} report={report} /> : null}
    </section>
  );
}

/**
 * Третья вкладка: семейства из подключённых провайдеров models.json и из
 * моделей, увиденных в pi-тредах; марка семейства — иконка, текст или SVG.
 */
export function ModelBadgesTab({ providers, rpc, report }: { providers: ProviderView[]; rpc: Rpc; report: Report }) {
  const [state, setState] = useState<BadgesState | null>(null);
  const load = useCallback(() => {
    rpc.call("model_badges_state").then(setState, report);
  }, [rpc, report]);
  useEffect(() => { load(); }, [load]);
  useRealtime(BADGES_CHANGED, load);
  const modelsByFamily = useMemo(() => {
    const map = new Map<FamilyId, string[]>();
    const add = (model: string) => {
      const family = familyOf(model);
      const list = map.get(family) ?? [];
      if (!list.includes(model)) list.push(model);
      map.set(family, list);
    };
    for (const provider of providers) {
      for (const entry of [...provider.models, ...provider.disabled]) add(String(entry.id));
    }
    for (const entry of Object.values(state?.threads ?? {})) {
      if (entry.providerId === "pi" && entry.model) add(entry.model);
    }
    return map;
  }, [providers, state]);
  const families = FAMILY_IDS.filter((family) => modelsByFamily.has(family));
  if (!state) return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Марка семейства показывается у pi-тредов в списке и в строке контекста открытого треда.
        Семейство определяется по имени модели, поэтому новые модели попадают сюда сами.
      </p>
      {families.map((family) => (
        <FamilyRow key={family} family={family} mark={state.marks[family] ?? DEFAULT_MARKS[family]}
          models={modelsByFamily.get(family) ?? []} rpc={rpc} report={report} />
      ))}
      {families.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Пока нет моделей — подключи их во вкладке «Подключение».
        </div>
      ) : null}
    </div>
  );
}
