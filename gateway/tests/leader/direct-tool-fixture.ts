import type { ControllerTool, DirectToolClient } from "../../src/controller/direct-tools.js";

export const TEST_TOOL_NAME = "test_business";

export function syntheticTool(name = TEST_TOOL_NAME): ControllerTool {
  return { name, description: "Synthetic deterministic business tool", annotations: { readOnlyHint: false },
    inputSchema: { type: "object", properties: { arguments: { type: "object" } },
      required: ["arguments"], additionalProperties: false } };
}

export function directToolController(
  callTool: DirectToolClient["callTool"] = async () => { throw new Error("Unexpected Controller tool execution"); },
  names = [TEST_TOOL_NAME],
): DirectToolClient {
  return { listTools: async () => ({ tools: names.map(syntheticTool), instructions: "Execute business tools directly." }), callTool };
}
