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

export function getLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = readEnv(env, "LLM_BASE_URL") || DEFAULT_LLM_BASE_URL;
  return {
    apiKey: readEnv(env, "LLM_API_KEY"),
    model: readEnv(env, "LLM_MODEL"),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs: readPositiveInt(env, "LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS),
    maxPayees: readPositiveInt(env, "LLM_MAX_PAYEES", DEFAULT_MAX_SUGGEST_PAYEES),
  };
}

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
  const fetchImpl: LlmFetch = opts?.fetchImpl ?? (fetch as unknown as LlmFetch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? config.timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
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
    } catch (e) {
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
    clearTimeout(timeout);
  }
}
