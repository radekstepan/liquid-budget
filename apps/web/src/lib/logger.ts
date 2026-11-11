/**
 * Central logger abstraction for the web host (Next.js API routes + client shell).
 *
 * Every console.* call in app code funnels through `logger` so the transport
 * can be swapped (or silenced) in one place. Server routes log only sanitized
 * summaries via `toLogDetails` — never raw row/payee/memo text that may ride
 * on error objects; unknown errors reach the client as a generic 500 through
 * `apiErrorResponse` (see `src/app/api/errors.ts`).
 *
 * Vitest's onConsoleLog ban still applies to the underlying console transport:
 * tests exercising logging paths mock `console.*` (precedent) or swap the
 * sink with `setLogger`.
 */

export type LogMethod = (...args: unknown[]) => void;

export type Logger = {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
};

function consoleLogger(): Logger {
  return {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

let current: Logger = consoleLogger();

/** Active sink (defaults to the console transport above). */
export function getLogger(): Logger {
  return current;
}

/** Swap the sink (tests, future transports). Pair with `resetLogger`. */
export function setLogger(next: Logger): void {
  current = next;
}

/** Restore the default console transport. */
export function resetLogger(): void {
  current = consoleLogger();
}

/**
 * Live-dispatch facade: import this, not `console`, from app code. Method
 * calls resolve the active sink at call time, so `setLogger` takes effect
 * without re-importing.
 */
export const logger: Logger = {
  debug: (...args) => getLogger().debug(...args),
  info: (...args) => getLogger().info(...args),
  warn: (...args) => getLogger().warn(...args),
  error: (...args) => getLogger().error(...args),
};

/** Prefix every message with `[scope]`; dispatches through `logger`. */
export function createScopedLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    debug: (...args) => logger.debug(prefix, ...args),
    info: (...args) => logger.info(prefix, ...args),
    warn: (...args) => logger.warn(prefix, ...args),
    error: (...args) => logger.error(prefix, ...args),
  };
}

/**
 * PII-safe error summary for server logs. Only name/message/status/code cross
 * the boundary — never payee/memo/row payloads that may ride on error
 * objects (the client envelope is further reduced to a generic 500 by
 * `apiErrorResponse`).
 */
export function toLogDetails(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    const details: Record<string, unknown> = { name: err.name, message: err.message };
    if (typeof record.status === "number") details.status = record.status;
    if (typeof record.code === "string" || typeof record.code === "number") {
      details.code = record.code;
    }
    return details;
  }
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    if (typeof record.message === "string") details.message = record.message;
    if (typeof record.status === "number") details.status = record.status;
    if (typeof record.code === "string" || typeof record.code === "number") {
      details.code = record.code;
    }
    return details;
  }
  return { message: String(err ?? "") };
}
