/**
 * Typed fetch helper for the budget shell's API calls. Failures throw an
 * `Error` carrying the HTTP status (and any structured `state` the route
 * returned, e.g. reconcile conflicts) for the mutation wrapper to report.
 */
export type ApiRequestError = Error & { status?: number; state?: unknown };

export async function jsonReq<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let body: { error?: unknown; state?: unknown } | null = null;
    try {
      body = (await res.json()) as { error?: unknown; state?: unknown };
    } catch {
      const text = await res.text().catch(() => "");
      body = { error: text };
    }
    const rawError: unknown = body?.error;
    const message =
      typeof rawError === "string" && rawError
        ? rawError
        : rawError
          ? String(rawError)
          : `Request failed (${res.status})`;
    const err: ApiRequestError = new Error(message);
    err.status = res.status;
    if (body?.state) {
      err.state = body.state;
    }
    throw err;
  }
  return res.json() as Promise<T>;
}
