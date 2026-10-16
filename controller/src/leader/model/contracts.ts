export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  responseOutput?: Record<string, unknown>[];
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelReply {
  content: string | null;
  toolCalls: ModelToolCall[];
  responseOutput?: Record<string, unknown>[];
}

export interface LeaderModel {
  complete(messages: ModelMessage[], tools: ModelTool[], signal?: AbortSignal): Promise<ModelReply>;
}
