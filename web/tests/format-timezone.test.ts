import { describe, expect, it } from "vitest";
import { DISPLAY_TIME_ZONE, formatClock, formatTimestamp, formatTimeShort } from "../src/format";

describe("Beijing display time", () => {
  it("uses UTC+8 regardless of the browser's system zone", () => {
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(formatTimestamp("2026-10-18T15:14:05Z")).toBe("2026-10-18 23:14:05");
    expect(formatClock("2026-10-18T15:14:05Z")).toBe("23:14");
    expect(formatTimeShort(new Date("2026-10-18T15:14:05Z"))).toBe("23:14:05");
  });
  it("rolls the date over at local midnight and preserves the instant in offset input", () => {
    expect(formatTimestamp("2026-10-18T16:00:00Z")).toBe("2026-10-19 00:00:00");
    expect(formatTimestamp("2026-10-19T00:00:00+08:00")).toBe("2026-10-19 00:00:00");
    expect(formatClock("2026-10-18T16:00:00Z")).toBe("00:00");
  });
  it("handles missing and invalid dates without throwing", () => {
    expect(formatTimestamp("")).toBe("--");
    expect(formatTimestamp("invalid")).toBe("invalid");
    expect(formatClock("invalid")).toBe("--:--");
    expect(formatTimeShort(null)).toBe("--:--:--");
  });
});
