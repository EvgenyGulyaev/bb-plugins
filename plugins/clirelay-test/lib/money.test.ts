import { describe, expect, it } from "vitest";
import { formatUsd } from "./money";

describe("formatUsd", () => {
  it("formats cents with two digits", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.07)).toBe("$0.07");
    expect(formatUsd(34.1)).toBe("$34.10");
    expect(formatUsd(999.99)).toBe("$999.99");
    expect(formatUsd(999.995)).toBe("$1.0k");
  });

  it("uses thousands with one digit from 1000", () => {
    expect(formatUsd(1000)).toBe("$1.0k");
    expect(formatUsd(1234.56)).toBe("$1.2k");
    expect(formatUsd(1_000_000)).toBe("$1000.0k");
  });

  it("rejects negative and non-finite numbers", () => {
    expect(formatUsd(-0.01)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
  });
});
