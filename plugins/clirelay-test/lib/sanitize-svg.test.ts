import { describe, expect, it } from "vitest";
import { MAX_SVG_LENGTH, sanitizeSvg } from "./sanitize-svg";

const SAFE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>';

describe("sanitizeSvg", () => {
  it("пропускает простой inline SVG", () => {
    expect(sanitizeSvg(SAFE)).toBe(SAFE);
    expect(sanitizeSvg(`  ${SAFE}\n`)).toBe(SAFE);
  });

  it("пропускает внутренние ссылки, но не use/image", () => {
    expect(sanitizeSvg('<svg><a href="#p"><path d="M0 0h8"/></a></svg>')).toBe(
      '<svg><a href="#p"><path d="M0 0h8"/></a></svg>',
    );
    expect(sanitizeSvg('<svg><path fill="url(#g)" d="M0 0h8"/></svg>')).toBe(
      '<svg><path fill="url(#g)" d="M0 0h8"/></svg>',
    );
    expect(sanitizeSvg('<svg><defs><path id="p" d="M0 0h8"/></defs><use href="#p"/></svg>')).toBeNull();
  });

  it("отклоняет script и foreignObject", () => {
    expect(sanitizeSvg("<svg><script>alert(1)</script></svg>")).toBeNull();
    expect(sanitizeSvg("<svg><foreignObject><div/></foreignObject></svg>")).toBeNull();
  });

  it("отклоняет внешние ссылки и javascript:", () => {
    expect(sanitizeSvg('<svg><a href="https://example.com/x.svg"><path/></a></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><a xlink:href="//example.com/x"><path/></a></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><a href="javascript:alert(1)"><path/></a></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><image href="https://example.com/a.png"/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect style="fill:url(https://example.com/a.svg#x)"/></svg>')).toBeNull();
  });

  it("отклоняет обработчики и DOCTYPE", () => {
    expect(sanitizeSvg('<svg onload="alert(1)"></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect onclick="x()"/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect width="1"/onload=alert(1)></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><img src="x"/onerror=alert(1)></svg>')).toBeNull();
    expect(sanitizeSvg('<!DOCTYPE svg><svg></svg>')).toBeNull();
    expect(sanitizeSvg('<?xml version="1.0"?><svg></svg>')).toBeNull();
  });

  it("отклоняет unquoted и entity-encoded обходы", () => {
    expect(sanitizeSvg("<svg><a href=https://example.com>x</a></svg>")).toBeNull();
    expect(sanitizeSvg("<svg><a href=//example.com/x>y</a></svg>")).toBeNull();
    expect(sanitizeSvg('<svg><rect fill="url(&#104;ttps://example.com/a)"/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><rect style="fill:expression(alert(1))"/></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><source src="https://example.com/a.png"/></svg>')).toBeNull();
  });

  it("отклоняет не-SVG и слишком длинное", () => {
    expect(sanitizeSvg('<div>no</div>')).toBeNull();
    expect(sanitizeSvg("")).toBeNull();
    expect(sanitizeSvg(`<svg>${"x".repeat(MAX_SVG_LENGTH)}</svg>`)).toBeNull();
  });
});
