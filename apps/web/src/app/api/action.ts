import { z } from "zod";

/**
 * Lenient peek used only to pick a dispatch branch. Branch-specific schemas
 * still validate the full payload afterwards, so this one must tolerate the
 * extra fields each branch carries (`ids`, `patch`, `mode`, ...).
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
