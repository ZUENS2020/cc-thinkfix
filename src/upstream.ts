import type { OpenAIChatRequest, OpenAIChatResponse } from "./types.js";

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

export class UpstreamHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`upstream HTTP ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  return `${b}/${p}`;
}

// Build the OpenAI chat-completions URL. Accepts either form of baseUrl —
// "https://host" or "https://host/v1" — and always emits ".../v1/chat/completions".
// This lets us share ANTHROPIC_BASE_URL with plain Claude Code (which expects no /v1).
function chatCompletionsUrl(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${stripped}/v1/chat/completions`;
}

function authHeaders(cfg: UpstreamConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.extraHeaders,
  };
}

export async function callUpstream(
  cfg: UpstreamConfig,
  body: OpenAIChatRequest,
  signal?: AbortSignal,
): Promise<OpenAIChatResponse> {
  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });

  if (!res.ok) {
    throw new UpstreamHttpError(res.status, await res.text());
  }
  return (await res.json()) as OpenAIChatResponse;
}

export async function callUpstreamStream(
  cfg: UpstreamConfig,
  body: OpenAIChatRequest,
  signal?: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: "POST",
    headers: { ...authHeaders(cfg), Accept: "text/event-stream" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "no response body";
    throw new UpstreamHttpError(res.status, text);
  }

  return webStreamToAsyncIterable(res.body);
}

async function* webStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}