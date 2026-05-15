import { randomUUID } from "node:crypto";
import type {
  AnthropicStopReason,
  OpenAIChatStreamChunk,
} from "../types.js";
import { mapFinishReason } from "./response.js";

interface BridgeState {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  nextIndex: number;
  current:
    | { kind: "thinking"; index: number }
    | { kind: "text"; index: number }
    | {
        kind: "tool_use";
        index: number;
        upstreamIndex: number;
        id: string;
        name: string;
      }
    | null;
  toolBlocks: Map<number, { index: number; id: string; name: string }>;
  stopReason: AnthropicStopReason;
  messageStarted: boolean;
}

export async function* bridgeOpenAIToAnthropicStream(
  upstream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const state: BridgeState = {
    messageId: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    nextIndex: 0,
    current: null,
    toolBlocks: new Map(),
    stopReason: null,
    messageStarted: false,
  };

  for await (const chunk of parseOpenAISSE(upstream)) {
    if (chunk === "[DONE]") break;
    yield* handleChunk(chunk, state);
  }

  if (state.current) {
    yield event("content_block_stop", {
      type: "content_block_stop",
      index: state.current.index,
    });
    state.current = null;
  }

  if (state.messageStarted) {
    yield event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: state.stopReason ?? "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: state.outputTokens },
    });
    yield event("message_stop", { type: "message_stop" });
  }
}

function* handleChunk(
  chunk: OpenAIChatStreamChunk,
  state: BridgeState,
): Generator<string, void, void> {
  if (!state.messageStarted) {
    state.model = chunk.model ?? state.model;
    state.inputTokens = chunk.usage?.prompt_tokens ?? 0;
    yield event("message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: 0,
        },
      },
    });
    state.messageStarted = true;
  }

  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
    state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;
  const delta = choice.delta ?? {};

  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    yield* switchTo(state, "thinking");
    yield event("content_block_delta", {
      type: "content_block_delta",
      index: (state.current as { index: number }).index,
      delta: { type: "thinking_delta", thinking: delta.reasoning_content },
    });
  }

  if (typeof delta.content === "string" && delta.content) {
    yield* switchTo(state, "text");
    yield event("content_block_delta", {
      type: "content_block_delta",
      index: (state.current as { index: number }).index,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      yield* handleToolCallDelta(state, tc);
    }
  }

  if (choice.finish_reason) {
    state.stopReason = mapFinishReason(choice.finish_reason);
  }
}

function* switchTo(
  state: BridgeState,
  kind: "thinking" | "text",
): Generator<string, void, void> {
  if (state.current?.kind === kind) return;

  if (state.current) {
    yield event("content_block_stop", {
      type: "content_block_stop",
      index: state.current.index,
    });
  }

  const index = state.nextIndex++;
  if (kind === "thinking") {
    state.current = { kind: "thinking", index };
    yield event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
  } else {
    state.current = { kind: "text", index };
    yield event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
  }
}

function* handleToolCallDelta(
  state: BridgeState,
  tc: NonNullable<OpenAIChatStreamChunk["choices"][0]["delta"]["tool_calls"]>[number],
): Generator<string, void, void> {
  const upstreamIdx = tc.index ?? 0;
  let mapping = state.toolBlocks.get(upstreamIdx);

  if (!mapping) {
    if (!tc.id || !tc.function?.name) return;

    if (state.current && state.current.kind !== "tool_use") {
      yield event("content_block_stop", {
        type: "content_block_stop",
        index: state.current.index,
      });
      state.current = null;
    }

    const index = state.nextIndex++;
    mapping = { index, id: tc.id, name: tc.function.name };
    state.toolBlocks.set(upstreamIdx, mapping);
    state.current = {
      kind: "tool_use",
      index,
      upstreamIndex: upstreamIdx,
      id: tc.id,
      name: tc.function.name,
    };

    yield event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: {},
      },
    });
  } else if (state.current?.kind !== "tool_use" || state.current.upstreamIndex !== upstreamIdx) {
    state.current = {
      kind: "tool_use",
      index: mapping.index,
      upstreamIndex: upstreamIdx,
      id: mapping.id,
      name: mapping.name,
    };
  }

  if (tc.function?.arguments) {
    yield event("content_block_delta", {
      type: "content_block_delta",
      index: mapping.index,
      delta: {
        type: "input_json_delta",
        partial_json: tc.function.arguments,
      },
    });
  }
}

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function* parseOpenAISSE(
  upstream: AsyncIterable<Uint8Array>,
): AsyncGenerator<OpenAIChatStreamChunk | "[DONE]", void, void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  for await (const bytes of upstream) {
    buffer += decoder.decode(bytes, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) continue;

      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        yield "[DONE]";
        return;
      }

      try {
        yield JSON.parse(data) as OpenAIChatStreamChunk;
      } catch {
        // skip malformed chunks
      }
    }
  }

  buffer += decoder.decode();
}