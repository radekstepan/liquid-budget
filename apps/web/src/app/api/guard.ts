/**
 * Loopback-only guard for mutating /api/* routes.
 *
 * Local-first default: this app binds to localhost and trusts no network
 * peer. Any POST/PATCH/PUT/DELETE (plus sensitive full-budget exports)
 * arriving with a non-loopback client identity gets a 403 with guidance
 * to deploy behind an auth proxy.
 *
 * Client identity resolution (spoof-aware):
 * - `x-forwarded-for` (first entry) or `x-real-ip` wins when present. A
 *   proxy that forwards an external client IP must not be masked by a
 *   loopback Host header.
 * - Otherwise the request URL hostname and the `Host` header are checked.
 * - Requests with no identity at all (direct in-process handler calls in
 *   unit tests, where `POST()` is invoked without a `Request`) are allowed.
 *
 * Escape hatch for LAN deployments already behind an authenticating
 * reverse proxy: set `ALLOW_NON_LOOPBACK_MUTATIONS=true`.
 */

const LOOPBACK_BYPASS_ENV = "ALLOW_NON_LOOPBACK_MUTATIONS";

function stripBrackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") ) {
    const end = trimmed.indexOf("]");
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed;
}

function withoutZone(id: string): string {
  const pct = id.indexOf("%");
  return pct >= 0 ? id.slice(0, pct) : id;
}

/** True for localhost / 127.0.0.0/8 / ::1 (incl. ::ffff:127.x mapped). */
export function isLoopbackIp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let ip = withoutZone(stripBrackets(value).toLowerCase());
  // Strip a trailing :port on bare IPv4/hostname forms (not IPv6 literals).
  if (!ip.includes("::") && ip.split(":").length === 2) {
    ip = ip.split(":")[0] ?? ip;
  }
  if (ip === "localhost") return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    if (mapped === "127.0.0.1" || mapped.startsWith("127.")) return true;
    return mapped === "::1";
  }
  // 127.0.0.0/8 loopback range, with or without a dotted remainder.
  if (ip === "127.0.0.1" || ip.startsWith("127.")) return true;
  return false;
}

/** True for loopback hostnames, tolerating `host:port` forms. */
export function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  if (!raw) return false;
  // Bracketed IPv6 literal, possibly with port: [::1]:3000.
  if (raw.startsWith("[")) return isLoopbackIp(raw);
  // Bare IPv6 literal (more than one colon) — no port to strip.
  if (raw.split(":").length > 2) return isLoopbackIp(withoutZone(raw));
  // Hostname or IPv4, possibly with :port.
  const hostOnly = raw.split(":")[0] ?? raw;
  return isLoopbackIp(hostOnly);
}

function forwardedClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null && xff.trim() !== "") {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp !== null && realIp.trim() !== "") return realIp.trim();
  return null;
}

function requestHostnames(req: Request): string[] {
  const hosts: string[] = [];
  try {
    const urlHost = new URL(req.url).hostname;
    if (urlHost) hosts.push(urlHost);
  } catch {
    // Relative URL in a direct handler call — fall through to Host header.
  }
  const headerHost = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
  if (headerHost) hosts.push(headerHost);
  return hosts;
}

/**
 * True when the request provably originates from this machine. Requests
 * with no network identity (no forwarding headers and no URL/Host) are
 * treated as in-process loopback so direct handler unit tests keep working.
 */
export function isLoopbackRequest(req: Request): boolean {
  const forwarded = forwardedClientIp(req);
  if (forwarded !== null) return isLoopbackIp(forwarded);
  const hosts = requestHostnames(req);
  if (hosts.length === 0) return true;
  return hosts.some((h) => isLoopbackHost(h));
}

/**
 * Returns a 403 `Response` when a mutation (or sensitive export) from a
 * non-loopback client must be refused, or `null` when it may proceed.
 * Pass no request for direct in-process calls — they are always allowed.
 */
export function mutationGuardResponse(req?: Request): Response | null {
  if (process.env[LOOPBACK_BYPASS_ENV] === "true") return null;
  if (!req) return null;
  if (isLoopbackRequest(req)) return null;
  return Response.json(
    {
      error:
        "Mutations are only allowed from localhost. " +
        "Serve this app on 127.0.0.1 and, for LAN access, deploy behind an " +
        `auth proxy (or set ${LOOPBACK_BYPASS_ENV}=true when the proxy already authenticates).`,
    },
    { status: 403 }
  );
}
