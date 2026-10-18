import { ACKNOWLEDGEMENT_PROMPT } from "../../src/leader/acknowledgement.js";
import type { ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";
import { sessionLabels } from "../../src/leader/plans/presentation.js";

/** Isolate the new prose-generation call from scripted planner/tool sequences. */
export function acknowledgementFixture(messages: ModelMessage[]): ModelReply | undefined {
  if (messages[0]?.content !== ACKNOWLEDGEMENT_PROMPT) return;
  const input = JSON.parse(messages[1].content!);
  const targets = input.targets as { nodeId: string; sessionId: string; title?: string; exactReceipt?: { status: string } }[];
  const labels = sessionLabels(targets, (nodeId, sessionId) => targets.find(target => target.nodeId === nodeId && target.sessionId === sessionId)?.title);
  const statuses: Record<string, string> = { accepted: "已接收，等待完成", pending: "等待接收", queued: "已保存，等待接收", waiting: "等待前序完成或会话可用" };
  const content = input.mode === "goal" ? "目标已确认，后台将按授权预算持续推进；尚未声称会话开始执行。"
    : input.mode === "terminal" ? "输入已写入，执行未确认；非原子投递，不自动重发。"
      : input.mode === "steer" ? "补充已由原会话当前轮受理，执行情况尚待核查。"
        : `计划自动推进中。${targets.map((target, index) => `${labels[index]}：${statuses[target.exactReceipt?.status ?? input.durableState.steps[index].status] ?? "情况待核查"}`).join("；")}。已接收不代表工作完成。`;
  return { content, toolCalls: [] };
}
