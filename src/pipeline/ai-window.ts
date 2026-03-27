export interface ParsedAiWindow {
  raw: string;
  startMinutes: number;
  endMinutes: number;
  crossesMidnight: boolean;
}

export type AiWindowParseErrorCode =
  | "invalid-window-format"
  | "invalid-window-time"
  | "empty-window-list";

export type AiWindowEvaluationErrorCode =
  | AiWindowParseErrorCode
  | "invalid-timezone"
  | "malformed-timezone-response";

export interface AiWindowError<TCode extends string = string> {
  code: TCode;
  message: string;
  window?: string;
}

export type ParseAiWindowResult =
  | { ok: true; value: ParsedAiWindow }
  | { ok: false; error: AiWindowError<AiWindowParseErrorCode> };

export type ParseAiWindowsResult =
  | { ok: true; value: ParsedAiWindow[] }
  | { ok: false; error: AiWindowError<AiWindowParseErrorCode> };

export interface LocalTimeContext {
  hour: number;
  minute: number;
  localMinutes: number;
}

export type LocalTimeResult =
  | { ok: true; value: LocalTimeContext }
  | { ok: false; error: AiWindowError<"invalid-timezone" | "malformed-timezone-response"> };

export interface EvaluateAiWindowsInput {
  windows: string[];
  timezone: string;
  now: Date;
}

export type EvaluateAiWindowsResult =
  | {
      ok: true;
      active: boolean;
      localMinutes: number;
      localTime: string;
      matchedWindow?: ParsedAiWindow;
      parsedWindows: ParsedAiWindow[];
    }
  | {
      ok: false;
      error: AiWindowError<AiWindowEvaluationErrorCode>;
    };

const WINDOW_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

function parseTimeMinutes(hourText: string, minuteText: string): number | null {
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}

export function parseAiWindow(window: string): ParseAiWindowResult {
  const match = window.match(WINDOW_PATTERN);
  if (!match) {
    return {
      ok: false,
      error: {
        code: "invalid-window-format",
        message: `Invalid AI window format: ${window}. Expected HH:MM-HH:MM`,
        window,
      },
    };
  }

  const [, startHour, startMinute, endHour, endMinute] = match;
  const startMinutes = parseTimeMinutes(startHour, startMinute);
  const endMinutes = parseTimeMinutes(endHour, endMinute);

  if (startMinutes === null || endMinutes === null) {
    return {
      ok: false,
      error: {
        code: "invalid-window-time",
        message: `Invalid AI window time: ${window}. Hours must be 00-23 and minutes 00-59`,
        window,
      },
    };
  }

  return {
    ok: true,
    value: {
      raw: window,
      startMinutes,
      endMinutes,
      crossesMidnight: startMinutes > endMinutes,
    },
  };
}

export function parseAiWindows(windows: string[]): ParseAiWindowsResult {
  if (windows.length === 0) {
    return {
      ok: false,
      error: {
        code: "empty-window-list",
        message: "At least one AI window is required",
      },
    };
  }

  const parsed: ParsedAiWindow[] = [];
  for (const window of windows) {
    const parsedWindow = parseAiWindow(window);
    if (!parsedWindow.ok) {
      return parsedWindow;
    }

    parsed.push(parsedWindow.value);
  }

  return { ok: true, value: parsed };
}

export function getLocalTimeForTimezone(now: Date, timezone: string): LocalTimeResult {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid-timezone",
        message: `Invalid timezone identifier: ${timezone}`,
      },
    };
  }

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  const minutePart = parts.find((part) => part.type === "minute")?.value;

  if (!hourPart || !minutePart) {
    return {
      ok: false,
      error: {
        code: "malformed-timezone-response",
        message: `Intl.DateTimeFormat produced malformed time parts for timezone: ${timezone}`,
      },
    };
  }

  const parsedMinutes = parseTimeMinutes(hourPart, minutePart);
  if (parsedMinutes === null) {
    return {
      ok: false,
      error: {
        code: "malformed-timezone-response",
        message: `Intl.DateTimeFormat produced non-numeric hour/minute parts for timezone: ${timezone}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      hour: Number.parseInt(hourPart, 10),
      minute: Number.parseInt(minutePart, 10),
      localMinutes: parsedMinutes,
    },
  };
}

export function isMinuteInWindow(localMinutes: number, window: ParsedAiWindow): boolean {
  if (window.startMinutes === window.endMinutes) {
    return false;
  }

  if (window.crossesMidnight) {
    return localMinutes >= window.startMinutes || localMinutes < window.endMinutes;
  }

  return localMinutes >= window.startMinutes && localMinutes < window.endMinutes;
}

export function evaluateAiWindows(input: EvaluateAiWindowsInput): EvaluateAiWindowsResult {
  const parsedWindows = parseAiWindows(input.windows);
  if (!parsedWindows.ok) {
    return parsedWindows;
  }

  const localTime = getLocalTimeForTimezone(input.now, input.timezone);
  if (!localTime.ok) {
    return localTime;
  }

  const matchedWindow = parsedWindows.value.find((window) =>
    isMinuteInWindow(localTime.value.localMinutes, window),
  );

  return {
    ok: true,
    active: matchedWindow !== undefined,
    localMinutes: localTime.value.localMinutes,
    localTime: `${String(localTime.value.hour).padStart(2, "0")}:${String(localTime.value.minute).padStart(2, "0")}`,
    matchedWindow,
    parsedWindows: parsedWindows.value,
  };
}
