import { describe, expect, it } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

describe("control-plane node normalization", () => {
  it("drops nodes whose connectivity flag is not a boolean", () => {
    const data = normalizeControlPlaneStatus({
      nodes: [
        { nodeId: "offline", connected: "false", sessionCount: 1 },
        { nodeId: "online", connected: true, sessionCount: 1 },
      ],
      sessions: [],
      commands: [],
      executions: emptyExecutions(),
      goals: emptyGoals(),
    });

    expect(data.nodes).toEqual([{ nodeId: "online", connected: true, lastHeartbeat: "", sessionCount: 1 }]);
  });

  it("keeps a read-only synthetic WeChat Codex session", () => {
    const data = normalizeControlPlaneStatus({
      nodes: [{ nodeId: "wechat", connected: true, sessionCount: 1 }],
      sessions: [{ id: "wechat_deadbeef", nodeId: "wechat", provider: "wechat-codex", historySource: "wechat-codex", capabilities: ["read"], observedAt: "2026-10-11T10:00:00Z" }],
      commands: [],
      executions: emptyExecutions(),
      goals: emptyGoals(),
    });
    expect(data.sessions[0]).toMatchObject({ nodeId: "wechat", provider: "wechat-codex", historySource: "wechat-codex", capabilities: ["read"] });
  });
});
