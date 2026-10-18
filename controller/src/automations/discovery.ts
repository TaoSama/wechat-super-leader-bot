import type { NodeHub } from "../nodes/hub.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";
import type { FrozenTarget } from "./contracts.js";

export function discoverAutomationTarget(hub: Pick<NodeHub, "isNodeConnected" | "getNodeSession">,
  nodeId: string, sessionId: string, now = Date.now()): FrozenTarget {
  if (!hub.isNodeConnected(nodeId)) throw new Error("Target node is offline");
  const session = hub.getNodeSession(nodeId, sessionId);
  if (!session) throw new Error("Target session was not discovered");
  const selected = selectSendRoute(session, now);
  if (!selected.ready) throw new Error(selected.reason);
  if (selected.route === "terminal-pane") throw new Error("Terminal sessions cannot supply exact command completion evidence");
  return { nodeId, sessionId, sendRoute: selected.route };
}
