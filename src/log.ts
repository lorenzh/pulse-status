export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Parses PULSE_LOG_LEVEL: empty or unset means info; an unknown value throws. */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === "") return "info";
  const level = LEVELS.find((l) => l === value);
  if (level === undefined) {
    throw new Error("PULSE_LOG_LEVEL: must be debug, info, warn or error");
  }
  return level;
}

export interface LoggerDeps {
  level: LogLevel;
  now: () => number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** A JSON-lines logger: warn and error go to stderr, the rest to stdout. */
export function createLogger(deps: LoggerDeps): Logger {
  const min = LEVELS.indexOf(deps.level);
  return (level, msg, fields = {}) => {
    if (LEVELS.indexOf(level) < min) return;
    const line = JSON.stringify({
      time: new Date(deps.now()).toISOString(),
      level,
      msg,
      ...fields,
    });
    (level === "warn" || level === "error" ? deps.stderr : deps.stdout)(line);
  };
}
