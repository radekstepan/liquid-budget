import { z } from "zod";

/**
 * Canonical action dispatch: body `{action}` wins, `?action=` is a deprecated
 * alias honored for old clients. Every action route resolves through
 * {@link resolveAction} with its allowed set plus any legacy alias map
 * (e.g. `bulk-delete` -> `delete`), so query and body spellings share one
 * code path instead of tripling the test matrix.
 */
const BodyPeekSchema = z.looseObject({
  action: z.string().optional(),
  type: z.string().optional(),
  mode: z.string().optional(),
});

export type BodyPeek = {
  action?: string;
  type?: string;
  mode?: string;
};

export type RouteAction = {
  /** `?action=` verbatim, or null when absent. */
  query: string | null;
  /** Body `action` verbatim, or undefined when absent/not a string. */
  body: string | undefined;
  /** True when the query OR body action is one of `accepted`. */
  matches: (...accepted: string[]) => boolean;
  /** True when the query action is one of `accepted`. */
  queryMatches: (...accepted: string[]) => boolean;
  /** True when the body action is one of `accepted`. */
  bodyMatches: (...accepted: string[]) => boolean;
};

export function peekBody(json: unknown): BodyPeek {
  const parsed = BodyPeekSchema.safeParse(json);
  return parsed.success ? parsed.data : {};
}

export function readRouteAction(req: Request, json?: unknown): RouteAction {
  const query = new URL(req.url).searchParams.get("action");
  const body = json === undefined ? undefined : peekBody(json).action;
  return {
    query,
    body,
    matches: (...accepted) =>
      (query !== null && accepted.includes(query)) ||
      (body !== undefined && accepted.includes(body)),
    queryMatches: (...accepted) => query !== null && accepted.includes(query),
    bodyMatches: (...accepted) => body !== undefined && accepted.includes(body),
  };
}

/** Mirrors the old `"field" in json` guard without widening to `any`. */
export function bodyHasField(json: unknown, field: string): boolean {
  return typeof json === "object" && json !== null && field in json;
}

/**
 * Resolve the canonical action for a request. Body `{action}` is canonical
 * and wins; `?action=` is a deprecated alias kept for old clients.
 * `aliases` maps legacy spellings (e.g. `bulk-delete` -> `delete`) before
 * the allow-list check. Returns the canonical name or null when neither
 * side carries an accepted value.
 */
export function resolveAction(
  req: Request,
  json: unknown,
  allowed: readonly string[],
  aliases?: Readonly<Record<string, string>>
): string | null {
  const normalise = (raw: string | null | undefined): string | null => {
    if (raw == null || raw === "") return null;
    const mapped = aliases?.[raw] ?? raw;
    return (allowed as readonly string[]).includes(mapped) ? mapped : null;
  };
  const body = json === undefined ? undefined : peekBody(json).action;
  return normalise(body) ?? normalise(new URL(req.url).searchParams.get("action"));
}
