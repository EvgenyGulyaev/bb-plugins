import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp, experimental_ProviderIcon as ProviderIcon, experimental_Icon as Icon,
  experimental_useRpcQuery, experimental_useRpcMutation,
  useBbContext, experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { contract, type Account, type Provider } from "./contract";
import { remainingPercent, selectWindow, type UsageWindow } from "./limits";
import { getRailTarget, mountRail, subscribeRail } from "./rail";
import "./app.css";

const pluginId = "usage-rings";
function useOverview() {
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads({ experimental_lifecycles: ["active", "archived"] });
  const hostId = threads.find(t => t.id === threadId)?.host?.id ?? null;
  const query = experimental_useRpcQuery({ contract, method: "overview", input: { hostId } });
  useEffect(() => {
    const update = () => { if (document.visibilityState === "visible") void query.refetch(); };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [query.refetch]);
  return { ...query, hostId };
}
function windowLabel(window: UsageWindow) {
  return /^(Five-hour limit|5 hours?|5h)$/i.test(window.label) ? "5 часов"
    : /^(Weekly limit|Weekly|7d)$/i.test(window.label) ? "Неделя" : window.label;
}
function resetLabel(value: string | null) {
  if (!value) return "Время сброса не указано";
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "Время сброса не указано";
  const minutes = Math.ceil((at.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return "Ожидается обновление окна";
  const duration = minutes >= 1440 ? `${Math.floor(minutes / 1440)} д ${Math.floor(minutes % 1440 / 60)} ч`
    : minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`;
  return `Сброс через ${duration}`;
}
function accountMessage(account: Account) {
  switch (account.usage?.status) {
    case "unauthenticated": return "Войдите в аккаунт провайдера и обновите лимиты.";
    case "expired": return "Сессия истекла. Войдите в аккаунт снова.";
    case "not_installed": return "Провайдер не установлен на этом компьютере.";
    case "error": return account.usage.message ?? "Не удалось получить лимиты.";
    case "ok": return "Провайдер не сообщил 5-часовой или недельный лимит.";
    default: return "Лимиты пока не получены.";
  }
}

function ProviderRing({ provider, error, hostId }: { provider: Provider; error: string | null; hostId: string | null }) {
  const account = provider.accounts.find(a => a.usage?.status === "ok") ?? provider.accounts[0];
  const window = account?.usage?.status === "ok" ? selectWindow(account.usage.windows) : null;
  const percent = window && !error ? remainingPercent(window) : null;
  const refresh = experimental_useRpcMutation({ contract, method: "refresh" });
  const refreshError = refresh.error ? "Не удалось обновить лимиты." : null;
  const title = `${provider.displayName}: ${percent === null ? "лимит недоступен" : `${windowLabel(window!)} — осталось ${percent}%`}`;
  const tone = percent === null ? "unknown" : percent <= 5 ? "critical" : percent <= 20 ? "warning" : "normal";
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="usage-ring-button" data-provider-id={provider.id} data-tone={tone} aria-label={title} title={title}>
        <span className="usage-ring-art">
          <svg className="usage-ring-progress" viewBox="0 0 32 32" aria-hidden="true">
            <circle className="usage-ring-track" cx="16" cy="16" r="13" />
            {percent !== null && percent > 0 && <circle className="usage-ring-fill" cx="16" cy="16" r="13" pathLength="100" strokeDasharray={`${percent} 100`} />}
          </svg>
          <ProviderIcon providerKind="agent" provider={provider} className="usage-ring-logo" aria-hidden="true" />
        </span>
        <span className="usage-ring-percent" aria-hidden="true">{percent === null ? "—" : `${percent}%`}</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="usage-rings-popover" side="right" align="end" sideOffset={12} collisionPadding={12}
        data-bb-plugin-root="" data-bb-plugin={pluginId} data-usage-rings-owned="" aria-label={`Лимиты ${provider.displayName}`}>
        <div className="usage-rings-heading"><ProviderIcon providerKind="agent" provider={provider} className="usage-rings-heading-logo" /><strong>{provider.displayName}</strong>
          <span className="usage-rings-spacer" />
          <button type="button" className="usage-rings-action" aria-label="Обновить лимиты" disabled={refresh.isPending} onClick={async () => {
            try { await refresh.mutate({ hostId }); } catch { /* The mutation hook exposes the error above. */ }
          }}><Icon name="RotateCcw" className="usage-rings-small-icon" /></button>
          <Popover.Close className="usage-rings-action" aria-label="Закрыть"><Icon name="X" className="usage-rings-small-icon" /></Popover.Close>
        </div>
        {(error || refreshError) && <p className="usage-rings-notice" role="status">{refreshError ?? error}</p>}
        {provider.accounts.length === 0 && <p className="usage-rings-muted">Лимиты пока не получены.</p>}
        {provider.accounts.map(a => <div key={a.id} className="usage-rings-account">
          <div className="usage-rings-account-label">{a.accountLabel ?? (a.usage?.status === "ok" ? a.usage.accountEmail : null) ?? provider.displayName}
            {a.usage?.status === "ok" && a.usage.planLabel && <span>{a.usage.planLabel}</span>}</div>
          {a.usage?.status === "ok" && a.usage.windows.length > 0 ? a.usage.windows.map((w, index) => <div className="usage-rings-window" key={`${w.label}-${index}`}>
            <div><span>{windowLabel(w)}</span><strong>{remainingPercent(w)}% осталось</strong></div>
            <meter min="0" max="100" value={remainingPercent(w)} aria-label={`${windowLabel(w)}: осталось ${remainingPercent(w)}%`} />
            <p className="usage-rings-muted" title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>{resetLabel(w.resetsAt)}</p>
          </div>) : <p className="usage-rings-muted">{accountMessage(a)}</p>}
        </div>)}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function Rings() {
  const target = useSyncExternalStore(subscribeRail, getRailTarget, () => null);
  const query = useOverview();
  if (!target || !query.data) return null;
  const providers = query.data.providers.filter(p => p.enabled);
  const error = query.error?.message ?? query.data.error;
  if (!providers.length) return null;
  return createPortal(<div className="usage-rings-list" aria-label="Остатки лимитов провайдеров">
    {providers.map(provider => <ProviderRing key={`${query.hostId}-${provider.id}`} provider={provider} error={error} hostId={query.hostId} />)}
  </div>, target);
}

function Settings() {
  const query = useOverview();
  const save = experimental_useRpcMutation({ contract, method: "savePreferences" });
  const [error, setError] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [draft, setDraft] = useState<Provider[] | null>(null);
  useEffect(() => { setDraft(null); }, [query.data]);
  if (!query.data) return <p role="status">{query.error ? "Не удалось загрузить настройки." : "Загрузка провайдеров…"}</p>;
  const rows = draft ?? query.data.providers;
  async function persist(next: Provider[]) {
    setDraft(next);
    setError(null);
    const missing = query.data!.preferences.filter(p => !next.some(row => row.id === p.id));
    try { await save.mutate([...next.map(({ id, enabled }) => ({ id, enabled })), ...missing]); }
    catch { setDraft(null); setError("Не удалось сохранить настройки. Попробуйте ещё раз."); }
  }
  function move(id: string, to: number) {
    const from = rows.findIndex(p => p.id === id);
    if (from < 0 || to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    void persist(next);
  }
  return <div className="usage-rings-settings">
    <p className="usage-rings-muted">Выберите провайдеров и порядок колец над настройками. Перетаскивайте за ручку или используйте стрелки.</p>
    <p className="usage-rings-muted">На кольце — остаток 5-часового лимита. Если его нет — недельного.</p>
    {query.data.machineName && <p className="usage-rings-muted">Компьютер: {query.data.machineName}</p>}
    {(error || query.error) && <p role="alert">{error ?? "Не удалось обновить настройки."}</p>}
    {rows.length === 0 && <p>Нет провайдеров, поддерживающих лимиты.</p>}
    <ol className="usage-rings-provider-settings" aria-label="Порядок провайдеров">
      {rows.map((provider, index) => <li key={provider.id} data-provider-id={provider.id}
        onDragOver={event => { if (dragged && !save.isPending) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={event => { event.preventDefault(); if (dragged && !save.isPending) move(dragged, index); setDragged(null); }}>
        <span className="usage-rings-handle" draggable={!save.isPending} title={`Переместить ${provider.displayName}`} aria-hidden="true"
          onDragStart={event => { setDragged(provider.id); event.dataTransfer.setData("text/plain", provider.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragged(null)}>⠿</span>
        <ProviderIcon providerKind="agent" provider={provider} className="usage-rings-heading-logo" />
        <label><span>{provider.displayName}</span><input type="checkbox" checked={provider.enabled} disabled={save.isPending}
          onChange={event => { void persist(rows.map(p => p.id === provider.id ? { ...p, enabled: event.target.checked } : p)); }} /></label>
        <button type="button" className="usage-rings-action" aria-label={`${provider.displayName}: выше`} disabled={index === 0 || save.isPending} onClick={() => move(provider.id, index - 1)}><Icon name="ArrowUp" className="usage-rings-small-icon" /></button>
        <button type="button" className="usage-rings-action" aria-label={`${provider.displayName}: ниже`} disabled={index === rows.length - 1 || save.isPending} onClick={() => move(provider.id, index + 1)}><Icon name="ArrowDown" className="usage-rings-small-icon" /></button>
      </li>)}
    </ol>
    {query.data.error && <p className="usage-rings-muted" role="status">{query.data.error}</p>}
  </div>;
}

export default definePluginApp(app => {
  app.contentScripts.register({ id: "rail-anchor", mount: ({ pluginId }) => mountRail(document, pluginId) });
  app.slots.experimental_appOverlay({ id: "rings", component: Rings });
  app.slots.settingsSection({ id: "providers", title: "Индикаторы лимита", component: Settings });
});
