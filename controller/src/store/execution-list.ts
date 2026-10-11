import { executionPageLimit } from "../leader/execution.js";
import { validateChatId } from "../leader/state.js";

export function executionListQuery(chatIds: readonly string[], limit: number) {
  const count = executionPageLimit(limit);
  if (!Array.isArray(chatIds)) throw new Error("Execution chat IDs must be an array");
  return { chatIds: [...new Set(chatIds.map(validateChatId))], count };
}
