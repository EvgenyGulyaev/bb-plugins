// «Api модели» — панель: аккордеоны API-адресов, внутри слева доступные модели
// (GET /models минус подключённые), справа подключённые с формой настроек pi.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { API_TYPES, MODEL_FIELDS, groupProvidersByBaseUrl } from "./lib/schema";
import type { ApiType, ModelPatch, ProviderView } from "./lib/schema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Report = (cause: unknown) => void;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Двухшаговое подтверждение destructive-действия без модальных диалогов. */
function ConfirmButton({ label, confirmLabel, onConfirm, icon }: { label: string; confirmLabel: string; onConfirm: () => void; icon: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button variant="ghost" size="sm" className={armed ? "text-destructive" : "text-muted-foreground"}
      onClick={(event) => { event.stopPropagation(); if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      <Icon name={icon} className="size-3.5" />{armed ? confirmLabel : label}
    </Button>
  );
}

type Draft = Record<string, string | boolean | string[]>;
function toDraft(model: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of MODEL_FIELDS) {
    const value = model[field.key];
    if (field.type === "bool") draft[field.key] = value === true;
    else if (field.type === "multiselect") draft[field.key] = Array.isArray(value) ? value.map(String) : ["text"];
    else draft[field.key] = value === undefined || value === null ? "" : String(value);
  }
  return draft;
}

/** Форма настроек модели: контролы генерятся из MODEL_FIELDS (тип → контрол). */
function ModelForm({ providerId, model, rpc, report }: { providerId: string; model: Record<string, unknown>; rpc: Rpc; report: Report }) {
  const initial = useMemo(() => toDraft(model), [model]);
  const [draft, setDraft] = useState<Draft>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const set = (key: string, value: string | boolean | string[]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const field of MODEL_FIELDS) {
      const value = draft[field.key];
      if (JSON.stringify(value) === JSON.stringify(initial[field.key])) continue;
      if (field.type === "bool") patch[field.key] = value;
      else if (field.type === "int") {
        if (value === "") patch[field.key] = null;
        else {
          const num = Number(value);
          if (!Number.isInteger(num) || num <= 0) { toast.error(`${field.label}: нужно целое > 0`); return; }
          patch[field.key] = num;
        }
      } else if (field.type === "multiselect") patch[field.key] = (value as string[]).length ? value : null;
      else patch[field.key] = value === "" ? null : value;
    }
    if (!Object.keys(patch).length) { toast("Без изменений"); return; }
    rpc.call("model_update", { providerId, modelId: String(model.id), patch: patch as ModelPatch })
      .then(() => toast.success("Сохранено — pi подхватит при открытии /model"), report);
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-3">
      {MODEL_FIELDS.map((field) => (
        <div key={field.key} className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{field.label}</span>
          {field.type === "bool" ? (
            <Checkbox checked={draft[field.key] === true} onCheckedChange={(v) => set(field.key, v === true)} aria-label={field.label} />
          ) : field.type === "multiselect" ? (
            <span className="flex gap-3">
              {field.options!.map((option) => (
                <span key={option} className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={(draft[field.key] as string[]).includes(option)}
                    onCheckedChange={(v) => set(field.key, v === true ? [...(draft[field.key] as string[]), option] : (draft[field.key] as string[]).filter((x) => x !== option))}
                    aria-label={option} />
                  {option}
                </span>
              ))}
            </span>
          ) : (
            <Input className="h-8 w-40" type={field.type === "int" ? "number" : "text"} placeholder={field.placeholder}
              value={String(draft[field.key] ?? "")} onChange={(event) => set(field.key, event.target.value)} aria-label={field.label} />
          )}
        </div>
      ))}
      <div className="mt-1 flex justify-end">
        <Button size="sm" onClick={save}><Icon name="Check" className="size-3.5" />Сохранить</Button>
      </div>
    </div>
  );
}

function ModelAccordion({ providerId, model, rpc, report }: { providerId: string; model: Record<string, unknown>; rpc: Rpc; report: Report }) {
  const [open, setOpen] = useState(false);
  const modelId = String(model.id);
  return (
    <div className="rounded-lg border border-border/70">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="ChevronDown" className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="truncate font-mono text-xs">{modelId}</span>
          {typeof model.name === "string" ? <span className="truncate text-xs text-muted-foreground">{model.name}</span> : null}
        </button>
        <ConfirmButton icon="Trash2" label="" confirmLabel="Точно?"
          onConfirm={() => rpc.call("model_disconnect", { providerId, modelId }).then(() => toast.success(`Отключена ${modelId}`), report)} />
      </div>
      {open ? <div className="px-2 pb-2"><ModelForm providerId={providerId} model={model} rpc={rpc} report={report} /></div> : null}
    </div>
  );
}

function ProviderSection({ provider, rpc, report, onEdit, nested = false }: { provider: ProviderView; rpc: Rpc; report: Report; onEdit: () => void; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const connected = useMemo(() => new Set(provider.models.map((model) => String(model.id))), [provider.models]);
  const available = (discovered ?? []).filter((id) => !connected.has(id));
  const discover = useCallback(() => {
    setBusy(true);
    setDiscoverError(null);
    rpc.call("models_discover", { providerId: provider.id }).then(
      ({ models }) => { setDiscovered(models); setBusy(false); },
      (cause) => { setBusy(false); setDiscoverError(message(cause)); },
    );
  }, [rpc, provider.id]);
  useEffect(() => { if (open && discovered === null && !busy) discover(); }, [open, discovered, busy, discover]);
  const connect = (modelId: string) => {
    if (!modelId.trim()) return;
    rpc.call("model_connect", { providerId: provider.id, modelId: modelId.trim() })
      .then(() => { toast.success(`Подключена ${modelId.trim()}`); setManualId(""); }, report);
  };
  return (
    <section className={nested ? "rounded-lg border border-border/60 bg-background/40" : "rounded-xl bg-muted/30"}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="truncate text-sm font-medium">{provider.name || provider.id}</span>
          {!nested ? <span className="truncate font-mono text-xs text-muted-foreground">{provider.baseUrl}</span> : null}
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{provider.models.length} подкл.</span>
          {!provider.apiKeySet ? <span className="shrink-0 text-[10px] text-destructive">ключ не задан</span> : null}
        </button>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Обновить список моделей"
          onClick={() => { setOpen(true); discover(); }}><Icon name={busy ? "Loading" : "Download"} className={`size-3.5 ${busy ? "animate-spin" : ""}`} /></Button>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Настроить адрес" onClick={onEdit}><Icon name="Edit" className="size-3.5" /></Button>
        <ConfirmButton icon="Trash2" label="" confirmLabel="Удалить API?"
          onConfirm={() => rpc.call("provider_delete", { id: provider.id }).then(() => toast.success(`Удалён ${provider.id}`), report)} />
      </div>
      {open ? (
        <div className="grid gap-3 px-3 pb-3 md:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-2">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Доступные (GET /models)</div>
            {busy ? <div className="px-1 py-2 text-xs text-muted-foreground">Загрузка…</div> : null}
            {discoverError ? <div className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">{discoverError}</div> : null}
            <div className="flex flex-col gap-1">
              {available.map((id) => (
                <div key={id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
                  <span className="truncate font-mono text-xs">{id}</span>
                  <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => connect(id)} aria-label={`Подключить ${id}`}>
                    <Icon name="Plus" className="size-3.5" />Подключить
                  </Button>
                </div>
              ))}
              {!busy && !discoverError && available.length === 0 ? <div className="px-2 py-1 text-xs text-muted-foreground">{discovered === null ? "Раскрой адрес — список загрузится сам" : "Все доступные уже подключены"}</div> : null}
            </div>
            <form className="mt-2 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); connect(manualId); }}>
              <Input className="h-8 flex-1 font-mono text-xs" placeholder="добавить по id вручную" value={manualId} onChange={(event) => setManualId(event.target.value)} aria-label="id модели вручную" />
              <Button type="submit" variant="outline" size="sm" className="h-8 shrink-0"><Icon name="Plus" className="size-3.5" /></Button>
            </form>
          </div>
          <div className="rounded-lg border border-border/70 p-2">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Подключённые (в pi)</div>
            <div className="flex flex-col gap-1.5">
              {provider.models.map((model) => <ModelAccordion key={String(model.id)} providerId={provider.id} model={model} rpc={rpc} report={report} />)}
              {provider.models.length === 0 ? <div className="px-2 py-1 text-xs text-muted-foreground">Пока пусто — подключи слева</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Несколько провайдеров на одном адресе → общая группа с вложенными аккордеонами. */
function AddressGroup({ baseUrl, providers, rpc, report, onEdit }: { baseUrl: string; providers: ProviderView[]; rpc: Rpc; report: Report; onEdit: (provider: ProviderView) => void }) {
  const [open, setOpen] = useState(true);
  const total = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  return (
    <section className="rounded-xl bg-muted/30">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="ChevronDown" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{baseUrl}</span>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{providers.length} пров. · {total} подкл.</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {providers.map((provider) => (
            <ProviderSection key={provider.id} provider={provider} rpc={rpc} report={report} nested onEdit={() => onEdit(provider)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProviderDialog({ editing, rpc, report, onClose }: { editing: ProviderView | null; rpc: Rpc; report: Report; onClose: () => void }) {
  const [id, setId] = useState(editing?.id ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [api, setApi] = useState<string>(editing?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rpc.call("provider_save", { id, name: name || undefined, baseUrl, api: api as ApiType, apiKey: apiKey || undefined })
      .then(() => { toast.success("Адрес сохранён"); onClose(); }, report);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{editing ? "Настроить API" : "Добавить API"}</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">id (slug)</span>
            <Input value={id} onChange={(event) => setId(event.target.value)} disabled={!!editing} placeholder="my-router" required aria-label="id провайдера" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Имя (необязательно)</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="имя провайдера" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Адрес (baseUrl)</span>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://host:port/v1" required aria-label="baseUrl" /></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Тип API</span>
            <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={api} onChange={(event) => setApi(event.target.value)} aria-label="тип API">
              {API_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select></label>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">API-ключ {editing ? "(пусто = не менять)" : ""}</span>
            <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" aria-label="API-ключ" /></label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Отмена</Button>
            <Button type="submit"><Icon name="Check" className="size-3.5" />Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApiModelsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: ProviderView | null } | null>(null);
  const report = useCallback((cause: unknown) => { const text = message(cause); setError(text); toast.error(text); }, []);
  const refetch = useCallback(() => {
    rpc.call("providers_list").then(({ providers }) => { setProviders(providers as ProviderView[]); setError(null); }, report);
  }, [rpc, report]);
  useEffect(() => { refetch(); }, [refetch]);
  useRealtime("api-models-changed", refetch);
  return (
    <div className="h-full min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-6 pt-4 md:px-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Api модели</h1>
            <p className="mt-1 text-sm text-muted-foreground">Подключение моделей в pi (~/.pi/agent/models.json). Раскрой адрес → слева доступные, справа подключённые. pi подхватит изменения при открытии /model.</p>
          </div>
          <Button onClick={() => setDialog({ editing: null })}><Icon name="Plus" className="size-4" />Добавить API</Button>
        </div>
        {error ? <p className="mb-4 text-sm text-destructive" role="alert">{error}</p> : null}
        {providers === null ? <p className="text-sm text-muted-foreground">Загрузка…</p> : (
          <div className="flex flex-col gap-3">
            {groupProvidersByBaseUrl(providers).map((group) =>
              group.providers.length === 1 ? (
                <ProviderSection key={group.providers[0]!.id} provider={group.providers[0]!} rpc={rpc} report={report} onEdit={() => setDialog({ editing: group.providers[0]! })} />
              ) : (
                <AddressGroup key={group.baseUrl} baseUrl={group.baseUrl} providers={group.providers} rpc={rpc} report={report} onEdit={(provider) => setDialog({ editing: provider })} />
              ),
            )}
            {providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Нет адресов. Нажми «Добавить API», укажи baseUrl и ключ — модели подтянутся сами.
              </div>
            ) : null}
          </div>
        )}
      </div>
      {dialog ? <ProviderDialog editing={dialog.editing} rpc={rpc} report={report} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "api-models", title: "Api модели", icon: "Workflow", path: "api-models", component: ApiModelsPage });
});
