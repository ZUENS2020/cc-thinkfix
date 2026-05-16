import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ProxyConfig } from "./config.js";
import { anthropicToOpenAIRequest } from "./transform/request.js";
import { openAIToAnthropicResponse } from "./transform/response.js";
import { bridgeOpenAIToAnthropicStream } from "./transform/stream.js";
import {
  callUpstream,
  callUpstreamStream,
  UpstreamHttpError,
  type UpstreamConfig,
} from "./upstream.js";
import type { AnthropicMessagesRequest } from "./types.js";

export interface ProxyHandle {
  port: number;
  close: () => Promise<void>;
  /**
   * Resolves when the proxy server stops listening. Useful for daemon mode
   * to keep the process alive until a /__shutdown request arrives or some
   * other code calls close().
   */
  closed: Promise<void>;
}

export function startProxy(
  config: ProxyConfig & {
    /** Called when POST /__shutdown is hit. Daemon installs this to do its
     * own cleanup (state file, settings.json) before the proxy actually closes. */
    onShutdownRequest?: () => Promise<void> | void;
  },
): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    const log = makeLogger(config.logLevel ?? "info");
    const upstreamCfg: UpstreamConfig = {
      baseUrl: config.upstreamBaseUrl,
      apiKey: config.upstreamApiKey,
    };

    let closing = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return jsonRes(res, 200, { ok: true, name: "cc-thinkfix" });
        }

        if (req.method === "POST" && url.pathname === "/__shutdown") {
          if (closing) return jsonRes(res, 200, { ok: true, already: true });
          closing = true;
          jsonRes(res, 200, { ok: true });
          // Defer the actual shutdown so this response can flush, and give the
          // owning code a hook to run its own teardown first.
          setImmediate(async () => {
            try {
              if (config.onShutdownRequest) await config.onShutdownRequest();
            } catch (err) {
              log.error("onShutdownRequest threw", err);
            }
            server.close(() => resolveClosed());
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/v1/messages") {
          return await handleMessages(req, res, upstreamCfg, log);
        }

        return pipeRequest(req, res, upstreamCfg, log);
      } catch (err) {
        log.error("unhandled", err);
        if (!res.headersSent) {
          jsonRes(res, 500, { error: { type: "internal_error", message: (err as Error).message } });
        } else {
          res.end();
        }
      }
    });

    const port = config.port ?? 0;
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`listening on http://127.0.0.1:${actualPort}`);
      log.info(`  upstream: ${config.upstreamBaseUrl}`);
      resolve({
        port: actualPort,
        closed,
        close: () =>
          new Promise<void>((res2, rej2) => {
            closing = true;
            server.close((err) => {
              resolveClosed();
              if (err) rej2(err);
              else res2();
            });
          }),
      });
    });

    server.on("error", reject);
  });
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamCfg: UpstreamConfig,
  log: Logger,
) {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonRes(res, 400, {
      error: { type: "invalid_request_error", message: "request body must be JSON" },
    });
  }

  const openAiReq = anthropicToOpenAIRequest(body as AnthropicMessagesRequest);
  log.debug("→ upstream", JSON.stringify(openAiReq).slice(0, 400));

  const wantStream = openAiReq.stream === true;
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    if (wantStream) {
      const upstream = await callUpstreamStream(upstreamCfg, openAiReq, ac.signal);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      for await (const event of bridgeOpenAIToAnthropicStream(upstream)) {
        res.write(event);
      }
      res.end();
    } else {
      const upstreamRes = await callUpstream(upstreamCfg, openAiReq, ac.signal);
      const anthropicRes = openAIToAnthropicResponse(upstreamRes);
      jsonRes(res, 200, anthropicRes);
    }
  } catch (err) {
    if (err instanceof UpstreamHttpError) {
      log.error(`upstream ${err.status}: ${err.body.slice(0, 200)}`);
      const type = err.status === 401 ? "authentication_error"
        : err.status === 429 ? "rate_limit_error"
        : err.status >= 500 ? "api_error"
        : "invalid_request_error";
      return jsonRes(res, err.status, {
        type: "error",
        error: { type, message: err.body.slice(0, 1000) },
      });
    }
    if ((err as Error).name === "AbortError") {
      log.debug("client aborted");
      if (!res.headersSent) res.writeHead(499);
      return res.end();
    }
    throw err;
  }
}

async function pipeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamCfg: UpstreamConfig,
  log: Logger,
) {
  const upstreamUrl = `${upstreamCfg.baseUrl}${req.url}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (upstreamCfg.apiKey) {
    headers["Authorization"] = `Bearer ${upstreamCfg.apiKey}`;
    headers["x-api-key"] = upstreamCfg.apiKey;
  }

  const clientAuth = extractAuth(req);
  if (clientAuth && !upstreamCfg.apiKey) {
    if (clientAuth.type === "bearer") {
      headers["Authorization"] = `Bearer ${clientAuth.value}`;
      headers["x-api-key"] = clientAuth.value;
    } else {
      headers["x-api-key"] = clientAuth.value;
    }
  }

  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (["host", "content-length", "transfer-encoding", "connection", "authorization", "x-api-key"].includes(lower)) continue;
    if (typeof v === "string") headers[k] = v;
  }

  log.debug(`pipe ${req.method} ${req.url} → ${upstreamUrl}`);

  const body = ["GET", "HEAD"].includes(req.method ?? "GET")
    ? undefined
    : await readBody(req);

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(300_000),
    });

    const respHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (!["transfer-encoding", "connection"].includes(lower)) {
        respHeaders[k] = v;
      }
    });

    res.writeHead(upstreamRes.status, respHeaders);
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: (err as Error).message } }));
    }
  }
}

interface ClientAuth {
  type: "bearer" | "api-key";
  value: string;
}

function extractAuth(req: IncomingMessage): ClientAuth | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return { type: "bearer", value: auth.slice(7).trim() };
  }
  const xkey = req.headers["x-api-key"];
  if (typeof xkey === "string") return { type: "api-key", value: xkey.trim() };
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function jsonRes(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

interface Logger {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function makeLogger(level: "silent" | "info" | "debug"): Logger {
  const noop = () => {};
  return {
    info: level === "silent" ? noop : (...a) => console.log("[cc-thinkfix]", ...a),
    debug: level === "debug" ? (...a) => console.log("[cc-thinkfix:debug]", ...a) : noop,
    error: level === "silent" ? noop : (...a) => console.error("[cc-thinkfix]", ...a),
  };
}