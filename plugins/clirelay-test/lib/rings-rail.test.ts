// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getRailTarget, mountRingsRail, subscribeRail } from "./rings-rail";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function dom(markup = '<div id="grid"><nav data-sidebar-navigation-placement="rail"></nav><div id="footer"><button aria-label="Настройки"><svg data-icon="Settings"></svg></button></div></div>') {
  document.body.innerHTML = markup;
  return document;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  document.body.innerHTML = "";
});

function mount(doc = document, pluginId = "clirelay-test") {
  const dispose = mountRingsRail(doc, pluginId);
  disposers.push(dispose);
  return dispose;
}

describe("rail anchor", () => {
  it("mounts its own node inside the rail next to Settings", () => {
    const doc = dom();
    mount(doc);
    const target = getRailTarget();
    expect(target).not.toBeNull();
    expect(target!.parentElement?.getAttribute("data-sidebar-navigation-placement")).toBe("rail");
    expect(target!.dataset.relayRingsOwned).toBe("");
    expect(target!.dataset.bbPlugin).toBe("clirelay-test");
    expect(target!.classList.contains("relay-rings-anchor")).toBe(true);
    expect(target!.nextSibling).toBeNull();
    // чужой футер не трогаем
    expect(doc.querySelector("#footer")!.children).toHaveLength(1);
  });

  it("publishes a null target until the rail appears", async () => {
    const doc = dom('<div id="grid"></div>');
    mount(doc);
    expect(getRailTarget()).toBeNull();

    doc.querySelector("#grid")!.innerHTML = '<nav data-sidebar-navigation-placement="rail"></nav><div id="footer"><button><svg data-icon="Settings"></svg></button></div>';
    await frame();
    expect(getRailTarget()).not.toBeNull();
  });

  it("waits for the Settings button before anchoring", async () => {
    const doc = dom('<div id="grid"><nav data-sidebar-navigation-placement="rail"></nav></div>');
    mount(doc);
    expect(getRailTarget()).toBeNull();

    doc.querySelector("#grid")!.insertAdjacentHTML("beforeend", '<div id="footer"><button><svg data-icon="Settings"></svg></button></div>');
    await frame();
    expect(getRailTarget()).not.toBeNull();
  });

  it("notifies subscribers on attach and keeps one node", async () => {
    const doc = dom();
    let calls = 0;
    const unsubscribe = subscribeRail(() => { calls += 1; });
    mount(doc);
    expect(calls).toBe(1);

    doc.querySelector("#footer")!.innerHTML = '<button aria-label="Settings"><svg data-icon="Settings"></svg></button>';
    await frame();
    expect(calls).toBe(1);
    expect(doc.querySelectorAll("[data-relay-rings-owned]")).toHaveLength(1);
    unsubscribe();
  });

  it("mounts after an existing usage-rings anchor", () => {
    const doc = dom();
    const usage = doc.createElement("div");
    usage.dataset.usageRingsOwned = "";
    doc.querySelector("nav")!.append(usage);

    mount(doc);

    expect(usage.nextElementSibling).toBe(getRailTarget());
  });

  it("moves after usage-rings when its anchor is appended later", async () => {
    const doc = dom();
    mount(doc);
    const target = getRailTarget();
    const usage = doc.createElement("div");
    usage.dataset.usageRingsOwned = "";

    doc.querySelector("nav")!.append(usage);
    await frame();

    expect(getRailTarget()).toBe(target);
    expect(usage.nextElementSibling).toBe(target);
  });

  it("re-attaches when bb replaces the rail", async () => {
    const doc = dom();
    mount(doc);
    const first = getRailTarget();

    const nextRail = doc.createElement("nav");
    nextRail.setAttribute("data-sidebar-navigation-placement", "rail");
    doc.querySelector("nav")!.replaceWith(nextRail);
    await frame();

    expect(getRailTarget()).not.toBe(first);
    expect(getRailTarget()!.parentElement).toBe(nextRail);
    expect(doc.querySelectorAll("[data-relay-rings-owned]")).toHaveLength(1);
  });

  it("drops the anchor when the rail goes away", async () => {
    const doc = dom();
    mount(doc);
    expect(getRailTarget()).not.toBeNull();

    doc.querySelector("#grid")!.remove();
    await frame();
    expect(getRailTarget()).toBeNull();
  });

  it("ignores its own mutations", async () => {
    const doc = dom();
    mount(doc);
    const target = getRailTarget()!;

    let calls = 0;
    const unsubscribe = subscribeRail(() => { calls += 1; });
    target.append(doc.createElement("span"));
    await frame();
    expect(calls).toBe(0);
    expect(getRailTarget()).toBe(target);
    unsubscribe();
  });

  it("disposes idempotently and leaves no nodes or listeners", async () => {
    const doc = dom();
    const dispose = mountRingsRail(doc, "clirelay-test");
    expect(getRailTarget()).not.toBeNull();

    dispose();
    dispose();
    expect(getRailTarget()).toBeNull();
    expect(doc.querySelectorAll("[data-relay-rings-owned],.relay-rings-anchor")).toHaveLength(0);

    doc.querySelector("#grid")!.innerHTML = '<nav data-sidebar-navigation-placement="rail"></nav><div id="footer"><button><svg data-icon="Settings"></svg></button></div>';
    await frame();
    expect(getRailTarget()).toBeNull();
  });
});
