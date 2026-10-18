import type { CommandRecord } from "../types.js";

export const COMMAND_PREVIEW_CODE_POINTS = 512;
export type PublicCommand = Omit<CommandRecord, "authority" | "queueOrder">;
export type CommandSummary = Omit<PublicCommand, "output"> & {
  hasOutput: boolean;
  outputPreview: string;
  outputTruncated: boolean;
};

/** Explicit HTTP boundary: new durable authorization fields must never escape by spreading a record. */
export function publicCommand(command: CommandRecord): PublicCommand {
  return {
    commandId: command.commandId, requestId: command.requestId,
    nodeId: command.nodeId, sessionId: command.sessionId, action: command.action,
    prompt: command.prompt, skills: command.skills, sendRoute: command.sendRoute,
    status: command.status, output: command.output, error: command.error,
    turnId: command.turnId, inputReceipt: command.inputReceipt,
    deliveryMode: command.deliveryMode, expectedTurnId: command.expectedTurnId,
    expiresAt: command.expiresAt, createdAt: command.createdAt, updatedAt: command.updatedAt,
  };
}

export function commandSummary(command: CommandRecord): CommandSummary {
  const { output: _output, ...metadata } = publicCommand(command);
  // Slice before iterating: an 8 MiB body must not become an array of millions of code points.
  const prefix = [...(command.output ?? "").slice(0, COMMAND_PREVIEW_CODE_POINTS * 2)];
  const outputPreview = prefix.slice(0, COMMAND_PREVIEW_CODE_POINTS).join("");
  return { ...metadata, error: metadata.error?.slice(0, COMMAND_PREVIEW_CODE_POINTS),
    hasOutput: typeof command.output === "string", outputPreview,
    outputTruncated: (command.output?.length ?? 0) > outputPreview.length };
}
