import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getRailTarget, mountRail } from "./rail.ts";

test("rings mount above localized Settings, recover after layout replacement, and leave no nodes on dispose", async () => {
  const dom = new JSDOM('<div id="grid"><nav data-sidebar-navigation-placement="rail"></nav><div id="footer"><button aria-label="Настройки"><svg data-icon="Settings"></svg></button></div></div>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const dispose = mountRail(doc, "usage-rings");
  try {
    const first = getRailTarget();
    assert.ok(first);
    assert.equal(first.parentElement?.getAttribute("data-sidebar-navigation-placement"), "rail");
    assert.equal(doc.querySelector("#footer")!.children.length, 1, "Settings footer must keep its original layout");
    doc.querySelector("#footer")!.innerHTML = '<button aria-label="Settings"><svg data-icon="Settings"></svg></button>';
    await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    assert.equal(getRailTarget(), first);
    assert.equal(doc.querySelectorAll("[data-usage-rings-owned]").length, 1);
    const nextRail = doc.createElement("nav");
    nextRail.setAttribute("data-sidebar-navigation-placement", "rail");
    doc.querySelector("nav")!.replaceWith(nextRail);
    await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    assert.notEqual(getRailTarget(), first);
    doc.querySelector("#grid")!.remove();
    await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    assert.equal(getRailTarget(), null);
  } finally {
    dispose();
    dispose();
    assert.equal(getRailTarget(), null);
    assert.equal(doc.querySelectorAll("[data-usage-rings-owned],.usage-rings-host").length, 0);
    dom.window.close();
  }
});
