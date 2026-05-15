import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIFunctionTool,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "../types.js";

export function anthropicToOpenAIRequest(
  req: AnthropicMessagesRequest,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  const systemText = flattenSystem(req.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    if (msg.role === "user") {
      messages.push(...convertUserMessage(msg));
    } else {
      messages.push(convertAssistantMessage(msg));
    }
  }

  const out: OpenAIChatRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
  };

  if (req.stream !== undefined) out.stream = req.stream;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) {
    out.stop = req.stop_sequences;
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map(convertTool);
  }
  if (req.tool_choice) {
    const tc = convertToolChoice(req.tool_choice);
    if (tc !== undefined) out.tool_choice = tc;
  }
  if (req.metadata?.user_id) out.user = req.metadata.user_id;

  return out;
}

function flattenSystem(
  system: string | AnthropicTextBlock[] | undefined,
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

function convertUserMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  const userParts: OpenAIContentPart[] = [];
  const toolMessages: OpenAIMessage[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      userParts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    } else if (block.type === "tool_result") {
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: stringifyToolResultContent(block.content),
      });
    }
  }

  const out: OpenAIMessage[] = [];
  out.push(...toolMessages);

  if (userParts.length > 0) {
    if (userParts.length === 1 && userParts[0].type === "text") {
      out.push({ role: "user", content: userParts[0].text });
    } else {
      out.push({ role: "user", content: userParts });
    }
  }

  return out;
}

function convertAssistantMessage(msg: AnthropicMessage): OpenAIMessage {
  const out: OpenAIMessage = { role: "assistant", content: null };

  if (typeof msg.content === "string") {
    out.content = msg.content;
    return out;
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "thinking") {
      thinkingParts.push(block.thinking);
    } else if (block.type === "redacted_thinking") {
      // Drop redacted — opaque, can't be forwarded as reasoning_content
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  out.content = textParts.length > 0 ? textParts.join("") : null;

  if (thinkingParts.length > 0) {
    out.reasoning_content = thinkingParts.join("");
  }

  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls;
  }

  return out;
}

function stringifyToolResultContent(
  content: string | AnthropicContentBlock[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("");
}

function convertTool(tool: AnthropicTool): OpenAIFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function convertToolChoice(
  tc: AnthropicToolChoice,
): OpenAIToolChoice | undefined {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: tc.name } };
    case "none":
      return "none";
  }
}