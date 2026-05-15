import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicStopReason,
  OpenAIChatResponse,
  OpenAIFinishReason,
  OpenAIToolCall,
} from "../types.js";

export function openAIToAnthropicResponse(
  res: OpenAIChatResponse,
): AnthropicMessagesResponse {
  const choice = res.choices[0];
  if (!choice) {
    throw new Error("OpenAI response has no choices");
  }
  const msg = choice.message;
  const content: AnthropicContentBlock[] = [];

  if (msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      content.push(toolCallToAnthropic(call));
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: res.id.startsWith("msg_") ? res.id : `msg_${res.id}`,
    type: "message",
    role: "assistant",
    model: res.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function toolCallToAnthropic(call: OpenAIToolCall): AnthropicContentBlock {
  let input: unknown;
  try {
    input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    input = { _raw: call.function.arguments };
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input,
  };
}

export function mapFinishReason(
  reason: OpenAIFinishReason,
): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    case null:
    case undefined:
      return null;
    default:
      return "end_turn";
  }
}