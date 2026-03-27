import { describe, expect, test } from "bun:test";
import {
  evaluateAiWindows,
  getLocalTimeForTimezone,
  isMinuteInWindow,
  parseAiWindow,
  parseAiWindows,
  type ParsedAiWindow,
} from "../ai-window";

describe("ai-window", () => {
  test("parseAiWindow parses valid windows", () => {
    const parsed = parseAiWindow("04:00-06:30");
    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      throw new Error("Expected valid AI window parse result");
    }

    expect(parsed.value).toEqual({
      raw: "04:00-06:30",
      startMinutes: 240,
      endMinutes: 390,
      crossesMidnight: false,
    });
  });

  test("parseAiWindow rejects malformed and out-of-range times", () => {
    const malformed = parseAiWindow("4:00-06:00");
    expect(malformed).toEqual({
      ok: false,
      error: {
        code: "invalid-window-format",
        message: "Invalid AI window format: 4:00-06:00. Expected HH:MM-HH:MM",
        window: "4:00-06:00",
      },
    });

    const outOfRange = parseAiWindow("99:99-01:00");
    expect(outOfRange).toEqual({
      ok: false,
      error: {
        code: "invalid-window-time",
        message: "Invalid AI window time: 99:99-01:00. Hours must be 00-23 and minutes 00-59",
        window: "99:99-01:00",
      },
    });
  });

  test("parseAiWindows rejects empty window arrays", () => {
    expect(parseAiWindows([])).toEqual({
      ok: false,
      error: {
        code: "empty-window-list",
        message: "At least one AI window is required",
      },
    });
  });

  test("isMinuteInWindow handles cross-midnight and boundary rules", () => {
    const crossMidnight: ParsedAiWindow = {
      raw: "23:00-01:00",
      startMinutes: 23 * 60,
      endMinutes: 60,
      crossesMidnight: true,
    };

    expect(isMinuteInWindow(22 * 60 + 59, crossMidnight)).toBe(false);
    expect(isMinuteInWindow(23 * 60, crossMidnight)).toBe(true);
    expect(isMinuteInWindow(0, crossMidnight)).toBe(true);
    expect(isMinuteInWindow(59, crossMidnight)).toBe(true);
    expect(isMinuteInWindow(60, crossMidnight)).toBe(false);
  });

  test("evaluateAiWindows evaluates timezone-local window activity", () => {
    const result = evaluateAiWindows({
      windows: ["23:00-01:00"],
      timezone: "Europe/Oslo",
      now: new Date("2026-01-01T23:30:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected timezone evaluation to succeed");
    }

    expect(result.localTime).toBe("00:30");
    expect(result.localMinutes).toBe(30);
    expect(result.active).toBe(true);
    expect(result.matchedWindow?.raw).toBe("23:00-01:00");
  });

  test("evaluateAiWindows returns explicit timezone errors", () => {
    const invalidTimezone = evaluateAiWindows({
      windows: ["04:00-06:00"],
      timezone: "Europe/Definitely-Not-Real",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(invalidTimezone).toEqual({
      ok: false,
      error: {
        code: "invalid-timezone",
        message: "Invalid timezone identifier: Europe/Definitely-Not-Real",
      },
    });
  });

  test("getLocalTimeForTimezone rejects malformed formatToParts output", () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;

    Intl.DateTimeFormat.prototype.formatToParts = function formatToPartsMock() {
      return [{ type: "literal", value: ":" }] as Intl.DateTimeFormatPart[];
    };

    try {
      const result = getLocalTimeForTimezone(
        new Date("2026-01-01T00:00:00.000Z"),
        "Europe/Oslo",
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "malformed-timezone-response",
          message: "Intl.DateTimeFormat produced malformed time parts for timezone: Europe/Oslo",
        },
      });
    } finally {
      Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
    }
  });
});
