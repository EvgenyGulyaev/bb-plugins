import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import * as Popover from "@radix-ui/react-popover";
import { countdown } from "@/lib/countdown";
import { quotaLabel } from "@/lib/quota-labels";
import type { RelayAccount } from "@/lib/relay-accounts";
import { providerLogo } from "@/lib/provider-logos";
import { ringDashArray, effectiveRingSize, ringItems, ringPercentText, ringTitle, type RingItem, type RingsState } from "@/lib/rings";
import { loadRingsSources, type RingsRpc } from "@/lib/rings-source";

// Логотипы вендорены в lib/provider-logos.ts (lobe-icons, MIT) и содержат
// только path/currentColor. HTML вставляем лишь из этих констант — RPC-данные
// через dangerouslySetInnerHTML не проходят никогда.
function RingLogo({ logo }: { logo: string | null }) {
  const svg = providerLogo(logo);
  if (svg === null) return null;
  return <span className="relay-ring-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function quotaPercent(quota: RelayAccount["quotas"][number]): number | null {
  return typeof quota.percent === "number" && Number.isFinite(quota.percent)
    ? Math.min(100, Math.max(0, Math.round(quota.percent)))
    : null;
}

/** Одно кольцо: больший активный остаток типа + попавер со всеми его аккаунтами. */
export function RelayRing({ item }: { item: RingItem }) {
  const title = ringTitle(item.label, item.percent, item.activeCount);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="relay-ring-button" data-ring-key={item.key} data-tone={item.tone}
          aria-label={title} title={title}>
          <span className="relay-ring-art">
            <svg className="relay-ring-progress" viewBox="0 0 32 32" aria-hidden="true">
              <circle className="relay-ring-track" cx="16" cy="16" r="13" />
              {item.percent !== null && item.percent > 0 && (
                <circle className="relay-ring-fill" cx="16" cy="16" r="13" pathLength="100"
                  strokeDasharray={ringDashArray(item.percent)} />
              )}
            </svg>
            {item.logo === null
              ? <span className="relay-ring-initial" aria-hidden="true">{item.label.charAt(0).toUpperCase()}</span>
              : <RingLogo logo={item.logo} />}
          </span>
          <span className="relay-ring-percent" aria-hidden="true">{ringPercentText(item.percent)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="relay-rings-popover" side="right" align="end" sideOffset={12} collisionPadding={12}
          data-bb-plugin-root="" data-bb-plugin="clirelay-test" data-relay-rings-owned=""
          aria-label={`Квоты ${item.label}`}>
          <div className="relay-rings-heading">
            <RingLogo logo={item.logo} />
            <strong>{item.label}</strong>
          </div>
          {item.accounts.map((account) => (
            <div className="relay-rings-account" key={account.key} data-disabled={account.disabled ? "" : undefined}>
              <div className="relay-rings-account-label">
                <span>{account.label}</span>
                <span className="relay-rings-account-meta">
                  {account.disabled && <span className="relay-rings-off">выключен</span>}
                  <strong>{ringPercentText(account.percent)}</strong>
                </span>
              </div>
              {account.quotas.length === 0
                ? <p className="relay-rings-muted">relay не сообщил квоту для этого аккаунта.</p>
                : account.quotas.map((quota) => {
                  const percent = quotaPercent(quota);
                  const reset = countdown(quota.reset_at);
                  return (
                    <div className="relay-rings-window" key={quota.quota_key}>
                      <div><span>{quotaLabel(quota)}</span><strong>{ringPercentText(percent)}</strong></div>
                      {percent !== null && (
                        <meter min="0" max="100" value={percent} aria-label={`${account.label} · ${quotaLabel(quota)}: осталось ${percent}%`} />
                      )}
                      {reset && <p className="relay-rings-muted">Сброс через {reset}</p>}
                    </div>
                  );
                })}
            </div>
          ))}
          <Popover.Close className="relay-rings-close" aria-label="Закрыть">Закрыть</Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Кольца выбранных аккаунтов: данные — существующий `relay_accounts`,
 * обновление раз в минуту и по `reloadSignal` (реалтайм плагина).
 */
export function RelayRings({ rpc, state, target, reloadSignal = 0 }: {
  rpc: RingsRpc;
  state: RingsState;
  target: HTMLElement | null;
  reloadSignal?: number;
}) {
  const [items, setItems] = useState<RingItem[]>([]);
  const [railWidth, setRailWidth] = useState(0);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const selectedKey = state.selected.join("\n");

  useEffect(() => {
    // Ничего не выбрано — нечего показывать: ни первичной загрузки, ни опроса.
    if (state.selected.length === 0) {
      setItems([]);
      return;
    }
    let alive = true;
    const load = async () => {
      // Гейт и внутри: тик мог прийти после снятия последней галочки.
      if (state.selected.length === 0) return;
      const { sources } = await loadRingsSources(rpcRef.current);
      if (!alive) return;
      setItems(ringItems(state.selected, sources));
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // selectedKey покрывает порядок выбора: сам массив приходит новым объектом.
  }, [selectedKey, reloadSignal]);

  // Рейл ~40px: без замера сетка в две колонки шире рейла и кольца режутся.
  // Один coalesced замер на изменение размера якоря (плюс окна).
  useEffect(() => {
    if (target === null) {
      setRailWidth(0);
      return;
    }
    const measure = () => setRailWidth(target.getBoundingClientRect().width);
    measure();
    const win = target.ownerDocument.defaultView ?? window;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(target);
    win.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      win.removeEventListener("resize", measure);
    };
  }, [target]);

  if (items.length === 0 || target === null) return null;
  // До замера (ширина 0) размер берётся из настройки — кольца не исчезают.
  const size = effectiveRingSize(railWidth, state.perRow, state.size);
  const layout = {
    "--relay-ring-size": `${size}px`,
    // Flex-база кнопки считается в CSS из числа колонок; неполная последняя
    // строка центрируется justify-content:center.
    "--relay-ring-cols": String(state.perRow),
    width: "100%",
  } as CSSProperties;
  return createPortal(
    <div className="relay-rings-list" aria-label="Кольца квот relay" style={layout}>
      {items.map((item) => <RelayRing key={item.key} item={item} />)}
    </div>,
    target,
  );
}
