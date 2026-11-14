import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, experimental_useRpcQuery, experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { availableCredits, contract, type ResetCredit } from "./contract";

type Target = { hostId: string | null; accountId: string };
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});
function TicketIcon({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 1 1-1Z" />
    <path d="M15 5v2m0 4v2m0 4v2" />
  </svg>;
}
function expiry(credit: ResetCredit, now: number) {
  if (credit.expiresAt === null) return "Без срока истечения";
  const minutes = Math.ceil((credit.expiresAt * 1000 - now) / 60_000);
  const relative = minutes <= 0 ? "срок истёк" : minutes >= 1440 ? `через ${Math.ceil(minutes / 1440)} д` : minutes >= 60 ? `через ${Math.ceil(minutes / 60)} ч` : `через ${minutes} мин`;
  return `Истекает ${dateFormat.format(credit.expiresAt * 1000)} · ${relative}`;
}

export function ResetButton({ target, onOpen }: { target: Target; onOpen: () => void }) {
  const query = experimental_useRpcQuery({ contract, method: "resets", input: target });
  const count = query.error ? "—" : query.data?.availableCount ?? "…";
  return <button type="button" className="usage-rings-action usage-resets-ticket" onClick={onOpen}
    aria-label={`Сохранённые сбросы Codex: ${count}`} title={`Сохранённые сбросы: ${count}`}>
    <TicketIcon className="usage-rings-small-icon" /><span>{count}</span>
  </button>;
}

export function ResetsDialog({ target, onClose, onUsed }: { target: Target; onClose: () => void; onUsed: () => void }) {
  const query = experimental_useRpcQuery({ contract, method: "resets", input: target });
  const mutation = experimental_useRpcMutation({ contract, method: "consumeReset" });
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<{ credit: ResetCredit; accountId: string; key: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);
  const refreshOnOpen = useRef(query.refetch);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.clearInterval(timer); if (element.open) element.close(); };
  }, []);
  useEffect(() => { void refreshOnOpen.current().catch(() => {}); }, []);
  const data = query.data;
  const credits = data ? availableCredits(data, now) : [];
  const selectedAvailable = selected && data?.accountId === selected.accountId && credits.some(c => c.id === selected.credit.id);
  async function useReset() {
    if (!selected || !confirmed || !selectedAvailable || busy.current) return;
    busy.current = true; setFailure(null); setMessage("Применяется выбранный сброс…");
    try {
      const outcome = await mutation.mutate({ ...target, creditId: selected.credit.id, expectedAccountId: selected.accountId, idempotencyKey: selected.key, confirmed: true });
      setMessage(outcome === "reset" ? "Сброс применён. Обновляем лимиты…"
        : outcome === "nothingToReset" ? "Сейчас нечего сбрасывать. Сохранённый сброс не потрачен."
        : outcome === "alreadyRedeemed" ? "Этот сброс уже был использован."
        : "Этот сброс больше недоступен.");
      setSelected(null); setConfirmed(false);
      onUsed(); await query.refetch().catch(() => {});
    } catch (error) {
      setMessage(null);
      setFailure(error instanceof Error ? error.message : "Ответ не получен. Обновите список перед новой попыткой.");
      // Keep the selected credit and idempotency key for an uncertain retry.
    } finally { busy.current = false; }
  }
  return createPortal(<dialog ref={dialog} className="usage-resets-dialog" aria-labelledby={titleId}
    data-bb-plugin-root="" data-bb-plugin="usage-rings" data-usage-rings-owned="" lang="ru"
    onClose={onClose} onCancel={event => { if (mutation.isPending) event.preventDefault(); }}>
    <header className="usage-rings-heading">
      <TicketIcon className="usage-rings-heading-logo" />
      <h2 id={titleId}>{selected ? "Использовать сброс?" : "Сохранённые сбросы"}</h2>
      <span className="usage-rings-spacer" />
      <button type="button" autoFocus className="usage-rings-action" aria-label="Закрыть окно сбросов" disabled={mutation.isPending} onClick={() => dialog.current?.close()}><Icon name="X" className="usage-rings-small-icon" /></button>
    </header>
    {data && <p className="usage-resets-summary"><span>Доступно: <strong>{data.availableCount}</strong></span><span aria-hidden="true"> · </span><span className="usage-resets-identity" title={data.email}>{data.email}</span></p>}
    <div className="usage-resets-body" aria-busy={query.isFetching || mutation.isPending}>
      {query.error && <p role="alert">{query.error.message}</p>}
      {!data && !query.error && <p>Загрузка доступных сбросов…</p>}
      {data && !selected && <>
        {data.availableCount === 0 && <p className="usage-rings-muted">Сохранённых сбросов нет.</p>}
        {data.availableCount > 0 && credits.length === 0 && <p className="usage-rings-muted">Список и даты сбросов недоступны. Проверьте их на странице использования Codex.</p>}
        {data.credits && data.availableCount > credits.length && credits.length > 0 && <p className="usage-rings-muted">Codex вернул подробности только для {credits.length} сбросов.</p>}
        <ol className="usage-resets-list" aria-label="Сбросы по сроку истечения">
          {credits.map(credit => <li key={credit.id} data-expiring={credit.expiresAt !== null && credit.expiresAt * 1000 - now <= 86400_000}>
            <div><strong>{credit.resetType === "codexRateLimits" ? "Полный сброс" : credit.title ?? "Сброс"}</strong>
              <p className="usage-resets-expiry">{credit.expiresAt === null ? expiry(credit, now) : <time dateTime={new Date(credit.expiresAt * 1000).toISOString()}>{expiry(credit, now)}</time>}</p>
            </div>
            <button type="button" className="usage-resets-button" disabled={credit.resetType !== "codexRateLimits" || !!query.error}
              onClick={() => { setSelected({ credit, accountId: data.accountId, key: crypto.randomUUID() }); setConfirmed(false); setMessage(null); setFailure(null); }}>Использовать</button>
          </li>)}
        </ol>
      </>}
      {selected && <>
        <p><strong>Полный сброс Codex</strong></p>
        <p className="usage-rings-muted">{expiry(selected.credit, now)}</p>
        <p>Будет потрачен один сохранённый сброс. Применимые основные лимиты восстановятся до 100%; время их следующего обновления может измениться.</p>
        {data && <p className="usage-rings-muted">Сейчас: {data.windows.map(w => `${w.label} — ${Math.round(w.remaining)}% осталось`).join(" · ")}</p>}
        {!selectedAvailable && <p role="alert">Сброс больше недоступен или аккаунт изменился. Обновите список.</p>}
        <label className="usage-resets-confirm"><input type="checkbox" checked={confirmed} disabled={mutation.isPending} onChange={e => setConfirmed(e.target.checked)} />Использовать один сохранённый сброс для этого аккаунта</label>
      </>}
      {message && <p role="status">{message}</p>}
      {failure && <p role="alert">{failure}</p>}
    </div>
    {selected && <footer className="usage-resets-footer">
        <button type="button" className="usage-resets-button" disabled={mutation.isPending} onClick={() => { setSelected(null); setConfirmed(false); setFailure(null); }}>Назад</button>
        <button type="button" className="usage-resets-button usage-resets-primary" disabled={!confirmed || !selectedAvailable || !!query.error || mutation.isPending} onClick={() => { void useReset(); }}>{mutation.isPending ? "Применяется…" : failure ? "Повторить этот сброс" : "Подтвердить сброс"}</button>
    </footer>}
  </dialog>, document.body);
}
