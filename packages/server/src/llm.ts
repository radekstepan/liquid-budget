import type { LlmChatMessage } from "@ynab/logic";
import { DEFAULT_MAX_SUGGEST_PAYEES } from "@ynab/logic";

/**
 * Minimal OpenAI-compatible chat client for optional AI features.
 *
 * Any provider exposing `POST {baseUrl}/chat/completions` works: OpenAI
 * by default, or a self-hosted/local endpoint (Ollama, LM Studio,
 * OpenRouter, …) via `LLM_BASE_URL`. Configuration comes from
 * environment variables (see `apps/web/.env.example`); the API key is
 * only ever read here on the server and is never sent to the browser.
 */

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

export type LlmConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxPayees: number;
  /**
   * Attach truncated memo evidence to the prompt. Default false (payee
   * names only): memos often contain account numbers and other PII.
   * Opt in with `LLM_INCLUDE_MEMOS=1` when disambiguation needs it.
   */
  includeMemos: boolean;
};

export class LlmError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "LlmError";
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readEnv(env, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = readEnv(env, key).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function getLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = readEnv(env, "LLM_BASE_URL") || DEFAULT_LLM_BASE_URL;
  return {
    apiKey: readEnv(env, "LLM_API_KEY"),
    model: readEnv(env, "LLM_MODEL"),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs: readPositiveInt(env, "LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS),
    maxPayees: readPositiveInt(env, "LLM_MAX_PAYEES", DEFAULT_MAX_SUGGEST_PAYEES),
    includeMemos: readFlag(env, "LLM_INCLUDE_MEMOS"),
  };
}

/**
 * Hostnames where cleartext HTTP is acceptable: the request never leaves
 * the machine, so no payee data is exfiltrated. Anything else must use
 * TLS — otherwise payee names (and the bearer key) cross the network
 * in the clear.
 */
const LOOPBACK_LLM_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Fail closed on plain-HTTP exfiltration targets. Never throws for loopback. */
export function assertSecureLlmBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LlmError(
      `LLM_BASE_URL is not a valid URL (${baseUrl || "(empty)"}). Use https:// for external services or http://localhost:<port> for local ones.`,
      502
    );
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new LlmError(
      `LLM_BASE_URL must be http(s) (got "${parsed.protocol}").`,
      502
    );
  }
  if (protocol === "http:" && !LOOPBACK_LLM_HOSTS.has(bareLlmHostname(parsed))) {
    throw new LlmError(
      `Refusing to send payee names over plain HTTP to "${parsed.hostname}". Use https:// or a loopback URL (http://localhost:<port>).`,
      502
    );
  }
  return bareLlmHostname(parsed);
}

/** Hostname without IPv6 brackets (`[::1]` -> `::1`) for allowlist checks. */
export function bareLlmHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * Audit record for one LLM request. Intentionally PII-free: model ids,
 * counts, and the destination host only — never the key, payees, or
 * memos. Emitted via the caller's `onAudit` sink (server routes log it;
 * tests observe it without touching console output).
 */
export type LlmAuditEntry = {
  /** Destination host (hostname only, no credentials). */
  host: string;
  /** Model id requested in configuration. */
  requestedModel: string;
  /** Model id that served the request (routers may resolve slugs). */
  servedModel?: string;
  /** Distinct payees sent in this request. */
  candidates: number;
  ok: boolean;
  /** Failure reason (upstream detail already scrubbed by LlmError). */
  error?: string;
};

/**
 * AI rename suggestions are available only when a key and a model are
 * configured. The UI hides the feature otherwise.
 */
export function isLlmRenameEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = getLlmConfig(env);
  return config.apiKey.length > 0 && config.model.length > 0;
}

export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractContent(payload: unknown): string | null {
  const root = asRecord(payload);
  const choices = root != null ? root.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = asRecord(choices[0])?.message;
  const content = asRecord(message)?.content;
  if (typeof content === "string") return content;
  // Some providers return OpenAI-style content parts.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const textPart = asRecord(part)?.text;
        return typeof textPart === "string" ? textPart : "";
      })
      .join("");
    return text ? text : null;
  }
  return null;
}

/**
 * Model id that actually served the request. Router slugs (e.g.
 * `openrouter/free`) resolve to a different model per call, so the
 * response id — when present — is what the user needs to see.
 */
function responseModel(payload: unknown, fallback: string): string {
  const model = asRecord(payload)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : fallback;
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  const choices = root != null ? root.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  return asRecord(choices[0]);
}

function firstNonEmpty(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Diagnostic detail for empty responses: which model answered, why it
 * stopped, and whether it produced only reasoning text (some free
 * reasoning models do that instead of answering).
 */
function emptyResponseDetail(payload: unknown, servedModel: string): string {
  const parts = [`model "${servedModel}"`];
  const choice = firstChoice(payload);
  const reason =
    choice != null
      ? firstNonEmpty([choice.finish_reason, choice.native_finish_reason])
      : null;
  if (reason) parts.push(`finish_reason "${reason}"`);
  const message = choice != null ? asRecord(choice.message) : null;
  const reasoning =
    message != null ? firstNonEmpty([message.reasoning, message.reasoning_content]) : null;
  if (reasoning) parts.push("the response contained only reasoning text");
  return ` (${parts.join(", ")})`;
}

/**
 * One JSON-mode chat completion. Resolves to the assistant message text
 * (expected to be JSON; parsing is the caller's job) and the serving
 * model id, which may differ from the configured slug when a router
 * model is used. Throws {@link LlmError} with a 502/504 status on
 * failure — the message never contains the key.
 */
export async function completeChatJson(
  messages: LlmChatMessage[],
  opts?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: LlmFetch;
    timeoutMs?: number;
  }
): Promise<{ content: string; model: string }> {
  const config = getLlmConfig(opts?.env);
  if (!config.apiKey || !config.model) {
    throw new LlmError(
      "AI rename suggestions are not configured. Set LLM_API_KEY and LLM_MODEL (see apps/web/.env.example).",
      501
    );
  }
  // Fail closed before any payee data can leave the machine.
  assertSecureLlmBaseUrl(config.baseUrl);
  const fetchImpl: LlmFetch = opts?.fetchImpl ?? (fetch as unknown as LlmFetch);
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? config.timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new LlmError("The AI request timed out. Try again.", 504);
  try {
    let res;
    try {
      const request = fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      const deadline = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // Abort is best-effort; the deadline rejection below bounds
            // the call even when the transport ignores the signal.
          }
          reject(timeoutError);
        }, timeoutMs);
      });
      res = await Promise.race([request, deadline]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (controller.signal.aborted) {
        throw new LlmError("The AI request timed out. Try again.", 504);
      }
      throw new LlmError(
        `Could not reach the AI service (${e instanceof Error ? e.message : String(e)}).`,
        502
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = body.trim().slice(0, 300);
      const suffix = detail ? `: ${detail}` : "";
      if (res.status === 401) {
        throw new LlmError(
          `Invalid API key — the AI service rejected the request (HTTP 401)${suffix}. Check LLM_API_KEY and try again.`,
          502
        );
      }
      if (res.status === 403) {
        throw new LlmError(
          `Access forbidden — the API key lacks permission or quota (HTTP 403)${suffix}. Check the key's access and quota.`,
          502
        );
      }
      throw new LlmError(
        `The AI service returned an error (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`,
        502
      );
    }
    const payload = await res.json().catch(() => null);
    const content = extractContent(payload);
    const servedModel = responseModel(payload, config.model);
    if (content == null || !content.trim()) {
      throw new LlmError(
        `The AI service returned an empty response${emptyResponseDetail(payload, servedModel)}.`,
        502
      );
    }
    return { content, model: servedModel };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
