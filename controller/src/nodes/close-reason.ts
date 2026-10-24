const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;
const DUPLICATE_NODE_PREFIX = "Node identity '";
const DUPLICATE_NODE_SUFFIX = "' is already actively connected";
const TRUNCATION_MARKER = "...";

export function duplicateNodeCloseReason(nodeId: string): string {
  const nodeIdBudget = MAX_WEBSOCKET_CLOSE_REASON_BYTES - Buffer.byteLength(DUPLICATE_NODE_PREFIX + DUPLICATE_NODE_SUFFIX, "utf8");
  let displayedNodeId = nodeId;
  if (Buffer.byteLength(nodeId, "utf8") > nodeIdBudget) {
    displayedNodeId = "";
    let bytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
    for (const character of nodeId) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > nodeIdBudget) break;
      displayedNodeId += character;
      bytes += characterBytes;
    }
    displayedNodeId += TRUNCATION_MARKER;
  }
  return DUPLICATE_NODE_PREFIX + displayedNodeId + DUPLICATE_NODE_SUFFIX;
}
