import { pino } from "pino";
import type { Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "*.password", "*.token", "*.secret", "*.apiKey"],
      remove: true,
    },
  });
}