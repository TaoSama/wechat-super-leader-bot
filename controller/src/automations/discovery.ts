import type { NodeHub } from "../nodes/hub.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";
import { isTerminalSession } from "../sessions/terminal.js";
import type { FrozenTarget } from "./contracts.js";
import { AutomationValidationError } from "./errors.js";

export function discoverAutomationTarget(hub: Pick<NodeHub, "isNodeConnected" | "getNodeSession">,
  nodeId: string, sessionId: string, now = Date.now()): FrozenTarget {
  if (!hub.isNodeConnected(nodeId)) throw new Error("Target node is offline");
  const session = hub.getNodeSession(nodeId, sessionId);
  if (!session) throw new AutomationValidationError("Target session was not discovered");
  if (isTerminalSession(session)) throw new AutomationValidationError("Terminal sessions cannot supply exact command completion evidence");
  const selected = selectSendRoute(session, now);
  if (!selected.ready) {
    if (selected.httpStatus === 400) throw new AutomationValidationError(selected.reason);
    throw new Error(selected.reason);
  }
  if (selected.route === "terminal-pane") throw new AutomationValidationError("Terminal sessions cannot supply exact command completion evidence");
  return { nodeId, sessionId, sendRoute: selected.route };
}
