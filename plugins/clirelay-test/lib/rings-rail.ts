// Якорь колец в левом рейле bb: тот же паттерн, что в usage-rings/rail.ts,
// но со своим узлом и своими маркерами — плагины не должны мешать друг другу.
let target: HTMLElement | null = null;
const listeners = new Set<() => void>();

export const getRailTarget = () => target;

export function subscribeRail(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(node: HTMLElement | null) {
  target = node;
  for (const listener of listeners) listener();
}

export function mountRingsRail(doc: Document, pluginId: string): () => void {
  const win = doc.defaultView!;
  let host: HTMLElement | null = null;
  let node: HTMLElement | null = null;
  let frame: number | null = null;
  let disposed = false;
  const detach = () => {
    node?.remove();
    host = node = null;
    publish(null);
  };
  const attach = () => {
    frame = null;
    if (disposed) return;
    const rail = doc.querySelector('[data-sidebar-navigation-placement="rail"]');
    // Кнопка Settings — подтверждение, что рейл смонтирован целиком; без неё
    // якорь встал бы в пустой скелет.
    const settings = rail?.parentElement?.querySelector('[data-icon="Settings"]')?.closest("button");
    const nextHost = settings ? (rail as HTMLElement) : null;
    if (nextHost === host && node?.isConnected) return;
    if (node) detach();
    if (!nextHost || !settings) return;
    host = nextHost;
    node = doc.createElement("div");
    node.dataset.bbPluginRoot = "";
    node.dataset.bbPlugin = pluginId;
    node.dataset.relayRingsOwned = "";
    node.className = "relay-rings-anchor";
    host.append(node);
    publish(node);
  };
  // ponytail: один coalesced observer; заменить на слот рейла, когда bb его отдаст.
  const observer = new win.MutationObserver((records) => {
    // Свои же вставки не должны перезапускать поиск якоря.
    if (records.every((record) => record.target instanceof win.Element && record.target.closest("[data-relay-rings-owned]"))) return;
    if (frame === null) frame = win.requestAnimationFrame(attach);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  attach();
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    detach();
  };
}
