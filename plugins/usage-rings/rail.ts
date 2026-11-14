let target: HTMLElement | null = null;
const listeners = new Set<() => void>();
export const getRailTarget = () => target;
export function subscribeRail(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(node: HTMLElement | null) {
  target = node;
  for (const listener of listeners) listener();
}
export function mountRail(doc: Document, pluginId: string) {
  const win = doc.defaultView!;
  let host: HTMLElement | null = null;
  let node: HTMLElement | null = null;
  let frame: number | null = null;
  const detach = () => {
    node?.remove();
    host = node = null;
    publish(null);
  };
  const attach = () => {
    frame = null;
    const rail = doc.querySelector('[data-sidebar-navigation-placement="rail"]');
    const settings = rail?.parentElement?.querySelector('[data-icon="Settings"]')?.closest("button");
    const nextHost = settings ? rail as HTMLElement : null;
    if (nextHost === host && node?.isConnected) return;
    if (node) detach();
    if (!nextHost || !settings) return;
    host = nextHost;
    node = doc.createElement("div");
    node.dataset.bbPluginRoot = "";
    node.dataset.bbPlugin = pluginId;
    node.dataset.usageRingsOwned = "";
    node.className = "usage-rings-anchor";
    host.append(node);
    publish(node);
  };
  // ponytail: one coalesced DOM observer; replace the anchor when BB exposes a rail-footer slot.
  const observer = new win.MutationObserver(records => {
    if (records.every(r => r.target instanceof win.Element && r.target.closest("[data-usage-rings-owned]"))) return;
    if (frame === null) frame = win.requestAnimationFrame(attach);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  attach();
  return () => {
    observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    detach();
  };
}
