import { describe, expect, it } from "vitest";
import { isoRangeDays } from "../src/smokeWindow.js";

describe("smoke availability window", () => {
  it("starts five minutes after the current time", () => {
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    const range = isoRangeDays(7, () => now);

    expect(range.start).toBe("2026-09-21T12:05:00.000Z");
    expect(range.end).toBe("2026-09-28T12:05:00.000Z");
  });
});
