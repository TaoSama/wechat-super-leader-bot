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
});
