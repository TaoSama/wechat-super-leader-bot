import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTOMATION_TOOLS, executeAutomationTool, AutomationService, MemoryAutomationRepository, DEFAULT_BUSINESS_TTL_MS } from "../src/automations/index.js";

const now = Date.parse("2026-10-18T00:00:00Z");
const authority = { chatId: "user", currentMessageId: "msg", explicitCurrentTurnAuthorization: true };
const reminder = { kind: "reminder", title: "test", timing: { type: "at", at: "2026-10-19T00:00:00Z" }, timezone: "UTC", text: "hello" };
const session = { kind: "session", title: "test", timing: { type: "cron", expression: "* * * * *" }, timezone: "UTC", prompt: "inspect", nodeId: "n", sessionId: "s" };
function declared(name: string) {
  const tool = AUTOMATION_TOOLS.find(tool => tool.function.name === name);
  if (!tool) throw new Error("Missing declaration");
  return z.fromJSONSchema(tool.function.parameters);
}
function service() {
  return new AutomationService({ repository: new MemoryAutomationRepository(), now: () => now,
    resolveTarget: async (nodeId, sessionId) => ({ nodeId, sessionId, sendRoute: "control-socket" }),
    runner: { start: async () => ({ status: "unknown", error: "unused" }), inspect: async () => ({ status: "unknown", error: "unused" }) },
  });
}
describe("automation tool declarations", () => {
  it.each([reminder, session])("accepts each documented input variant without output-only defaults", async input => {
    expect(declared("create_automation").safeParse(input).success).toBe(true);
    const result = await executeAutomationTool(service(), "create_automation", input, authority, now) as { businessTtlMs: number; retention: string };
    expect(result.businessTtlMs).toBe(DEFAULT_BUSINESS_TTL_MS); expect(result.retention).toBe("latest");
  });
  it.each([
    { ...reminder, text: undefined }, { ...session, prompt: undefined }, { ...session, nodeId: undefined },
    { ...session, sessionId: undefined }, { ...reminder, unexpected: true }, { ...reminder, text: "x".repeat(128_001) },
    { ...reminder, businessTtlMs: 366 * DEFAULT_BUSINESS_TTL_MS }, { ...reminder, timezone: "x".repeat(129) },
    { ...reminder, timing: { type: "at", at: "tomorrow" } }, { ...session, text: "extra reminder field" },
  ])("rejects invalid inputs in both declaration and executor", async input => {
    expect(declared("create_automation").safeParse(input).success).toBe(false);
    await expect(executeAutomationTool(service(), "create_automation", input, authority, now)).rejects.toThrow();
  });
  it("uses the same strict management schemas for declaration and execution", async () => {
    const cases = [
      ["list_automations", { unexpected: true }], ["automation_runs", { id: "not-uuid" }],
      ["update_automation", { id: "4d768e46-f3a5-44f5-b98f-584767f11b7e", status: "deleted" }],
    ] as const;
    for (const [name, input] of cases) {
      expect(declared(name).safeParse(input).success).toBe(false);
      await expect(executeAutomationTool(service(), name, input, authority, now)).rejects.toThrow();
    }
  });
});
