import { ScopedSession } from "../../types.js";
import { queueSendRoute } from "../../commands/queue.js";
import { isTerminalSession } from "../../sessions/terminal.js";

export type NLActionType =
  | "list_sessions"
  | "list_nodes"
  | "read_session"
  | "send_session"
  | "clarification"
  | "unknown";

export interface NLIntent {
  action: NLActionType;
  nodeId?: string;
  sessionId?: string;
  prompt?: string;
  clarificationMessage?: string;
  replyText?: string;
}

export interface ResolverContext {
  sessions: ScopedSession[];
  lastContext?: {
    nodeId: string;
    sessionId: string;
  };
}

const terminalInputRequiresConfirmation = (): NLIntent => ({ action: "unknown",
  replyText: "规则模式仅支持读取终端观测；终端非原子输入请使用模型模式生成独立单步并确认，或在控制台明确发送。输入写入不代表执行完成。" });

const READ_VERBS = "(?:查看|读取|看看|查一下|汇报|报告|同步|讲讲|说一下|检查)";
const READ_SUBJECTS = "(?:输出|日志|内容|情况|执行到哪|跑成什么样|结果|tail|log|进度|进展|状态)";
const READ_QUERY_SUFFIX = `\\s*(?:的)?\\s*(?:最新)?${READ_SUBJECTS}[？?。]*$`;
const READ_QUERY_PATTERNS = [
  new RegExp(`^${READ_VERBS}\\s*(.*?)\\s*(?:上)?(?:${READ_VERBS})?${READ_QUERY_SUFFIX}`, "i"),
  new RegExp(`^在\\s*(.*?)\\s*(?:上)?\\s*${READ_VERBS}${READ_QUERY_SUFFIX}`, "i"),
];

export class NaturalLanguageResolver {
  resolve(text: string, ctx: ResolverContext): NLIntent {
    const raw = text.trim();
    if (!raw) {
      return {
        action: "unknown",
        replyText: "未收到有效文本输入。",
      };
    }

    // An explicit dispatch owns its task body; query words inside it are prompt content.
    const sendIntent = this.resolveSendIntent(raw, ctx);
    if (sendIntent) return sendIntent;

    // 1. List / Query nodes/machines
    if (
      /(有哪些|查看|列出|看看|查一下).*(机器|节点|主机|host|node|vps)/i.test(raw) ||
      /^(机器|节点|主机|host|node)列表$/i.test(raw) ||
      /^(查看|查询|列出)?(机器|节点|主机)$/i.test(raw)
    ) {
      return { action: "list_nodes" };
    }

    // Parse the complete read query once so classification and target extraction share a grammar.
    for (const pattern of READ_QUERY_PATTERNS) {
      const match = raw.match(pattern);
      if (match) return this.resolveReadIntent(match[1].trim(), ctx);
    }

    // 3. List / Query sessions/agents (pure listing without output/logs request)
    if (
      /^(会话|agent|task|session)列表$/i.test(raw) ||
      /^(查看|查询|列出)?(会话|agent)$/i.test(raw) ||
      /(有哪些|列出|谁在|活着|在跑).*(会话|agent|任务)/i.test(raw) ||
      /^(查看|看看|查一下)(当前|所有|全部)?(会话|agent|任务)$/i.test(raw)
    ) {
      return { action: "list_sessions" };
    }

    return {
      action: "unknown",
      replyText:
        "未能识别该指令意图。如果要向会话发送指令，请使用明确的执行动词，例如：“让 session-1 执行：pnpm test” 或 “查看会话列表”。",
    };
  }

  private resolveReadIntent(target: string, ctx: ResolverContext): NLIntent {
    const targetCheck = this.findTargetSession(target, ctx);
    if (targetCheck.explicitTargetNotFound) {
      return {
        action: "unknown",
        replyText: `未找到指定的节点或会话 '${targetCheck.explicitTargetNotFound}'，无法读取输出。`,
      };
    }

    if (targetCheck.clarificationMessage) {
      return {
        action: "clarification",
        clarificationMessage: targetCheck.clarificationMessage,
      };
    }

    if (targetCheck.session) {
      return {
        action: "read_session",
        nodeId: targetCheck.session.nodeId,
        sessionId: targetCheck.session.id,
      };
    }

    // Implicit target resolution: only allowed when NO explicit target was attempted
    if (ctx.sessions.length === 1) {
      const s = ctx.sessions[0];
      return {
        action: "read_session",
        nodeId: s.nodeId,
        sessionId: s.id,
      };
    }

    if (ctx.sessions.length > 1) {
      const sessionList = ctx.sessions
        .map((s) => `- [${s.nodeId}] ${s.title || s.id} (id: ${s.id})`)
        .join("\n");
      return {
        action: "clarification",
        clarificationMessage: `当前发现多个会话，请指明要在哪个会话中查看输出：\n${sessionList}`,
      };
    }

    return {
      action: "unknown",
      replyText: "当前未发现任何活跃会话，无法读取输出。可用“查看会话列表”检查接入情况。",
    };
  }

  private resolveSendIntent(raw: string, ctx: ResolverContext): NLIntent | null {
    // Fix 2: Require explicit execute/send verbs or affirmative continuation words
    const isContinuation = /^(继续|继续执行|让它继续跑)$/i.test(raw);

    // Matches: "让 <target> 执行: <prompt>", "在 <target> 上执行: <prompt>", "发给 <target>: <prompt>", "执行: <prompt>"
    const sendPattern = /^(?:让|在|告诉|发给|派发|对)\s*([^:：]+?)\s*(?:上)?(?:执行|运行|发送|输入|发|跑|说|做)?\s*[:：]\s*([\s\S]+)$/i;
    const sendPatternNoColon = /^(?:让|在|告诉|发给|派发)\s*([^:：]+?)\s*(?:上)?(?:执行|运行|发送|输入|发|跑)\s+([\s\S]+)$/i;
    const directActionPattern = /^(?:执行|运行|发送|输入|跑一下|跑)\s*[:：]\s*([\s\S]+)$/i;

    let targetClause = "";
    let prompt = "";

    if (isContinuation) {
      prompt = "继续";
    } else {
      const m1 = raw.match(sendPattern);
      if (m1) {
        targetClause = m1[1].trim();
        prompt = m1[2].trim();
      } else {
        const m2 = raw.match(sendPatternNoColon);
        if (m2) {
          targetClause = m2[1].trim();
          prompt = m2[2].trim();
        } else {
          const m3 = raw.match(directActionPattern);
          if (m3) {
            prompt = m3[1].trim();
          }
        }
      }
    }

    if (!prompt) return null;

    // Fix 3 & 4: Only match target in targetClause (avoid prompt text interfering),
    // and if targetClause was specified but unresolvable, reject explicitly without fallback!
    const targetCheck = this.findTargetSession(targetClause, ctx);

    if (targetCheck.explicitTargetNotFound) {
      return {
        action: "unknown",
        replyText: `未找到指定的目标 '${targetCheck.explicitTargetNotFound}'，为防误操作已拒绝执行。`,
      };
    }

    if (targetCheck.clarificationMessage) {
      return {
        action: "clarification",
        clarificationMessage: targetCheck.clarificationMessage,
      };
    }

    if (targetCheck.session) {
      if (isTerminalSession(targetCheck.session)) return terminalInputRequiresConfirmation();
      if (!queueSendRoute(targetCheck.session)) {
        return {
          action: "unknown",
          replyText: `会话 [${targetCheck.session.nodeId}] ${targetCheck.session.id} 当前不支持 send 指令（未取得可用发送路线）。`,
        };
      }

      return {
        action: "send_session",
        nodeId: targetCheck.session.nodeId,
        sessionId: targetCheck.session.id,
        prompt,
      };
    }

    // Implicit sends stay bound to the previous exact target, even when it is absent.
    if (!targetClause) {
      if (ctx.lastContext) {
        const prev = ctx.sessions.find(
          (s) => s.nodeId === ctx.lastContext!.nodeId && s.id === ctx.lastContext!.sessionId
        );
        if (prev) {
          if (isTerminalSession(prev)) return terminalInputRequiresConfirmation();
          if (!queueSendRoute(prev)) {
            return {
              action: "unknown",
              replyText: `上下文会话 [${prev.nodeId}] ${prev.id} 当前不具备 send 资格。`,
            };
          }
          return {
            action: "send_session",
            nodeId: prev.nodeId,
            sessionId: prev.id,
            prompt,
          };
        }
        return {
          action: "unknown",
          replyText: `上下文会话 [${ctx.lastContext.nodeId}] ${ctx.lastContext.sessionId} 当前不可用，为防误操作已拒绝执行。请等待原会话恢复，或明确指定新的目标会话。`,
        };
      }

      if (ctx.sessions.length === 1) {
        const s = ctx.sessions[0];
        if (isTerminalSession(s)) return terminalInputRequiresConfirmation();
        if (!queueSendRoute(s)) {
          return {
            action: "unknown",
            replyText: `会话 [${s.nodeId}] ${s.id} 当前不具备 send 资格。`,
          };
        }
        return {
          action: "send_session",
          nodeId: s.nodeId,
          sessionId: s.id,
          prompt,
        };
      }

      if (ctx.sessions.length > 1) {
        const sessionList = ctx.sessions
          .map((s) => `- [${s.nodeId}] ${s.title || s.id} (id: ${s.id})`)
          .join("\n");
        return {
          action: "clarification",
          clarificationMessage: `检测到多个会话，请明确指定执行的目标会话：\n${sessionList}\n未指定会话前不会盲目派发。`,
        };
      }
    }

    return {
      action: "unknown",
      replyText: "当前未发现任何可用会话，无法派发指令。请确保宿主机 Daemon 已连接并上报会话。",
    };
  }

  private findTargetSession(
    targetText: string,
    ctx: ResolverContext
  ): {
    session?: ScopedSession;
    clarificationMessage?: string;
    explicitTargetNotFound?: string;
  } {
    const searchScope = targetText.trim();
    if (!searchScope) return {};

    // Detect if user used an explicit target pattern in searchScope
    // e.g. "让 X 执行", "在 X 上查看", "X 的输出"
    const candidateName = searchScope;

    // Match exact session IDs or titles in searchScope
    const matchedSessions: ScopedSession[] = [];
    for (const s of ctx.sessions) {
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = (value: string) => new RegExp(
        `^(?:(?:节点|机器|主机)?\\s*${escape(s.nodeId)}(?:\\s+|\\s*的\\s*|\\s*[/]\\s*))?(?:会话\\s*)?${escape(value)}$`, "i"
      ).test(searchScope);
      const matchId = matches(s.id);
      const matchTitle = s.title && matches(s.title);

      if (matchId || matchTitle) {
        matchedSessions.push(s);
      }
    }

    if (matchedSessions.length === 1) {
      return { session: matchedSessions[0] };
    }

    if (matchedSessions.length > 1) {
      const list = matchedSessions
        .map((s) => `- [${s.nodeId}] ${s.title || s.id} (id: ${s.id})`)
        .join("\n");
      return {
        clarificationMessage: `匹配到多个可能的目标会话，请精确指定：\n${list}`,
      };
    }

    // Match node IDs in searchScope
    const mentionedNodes = Array.from(
      new Set(
        ctx.sessions
          .map((s) => s.nodeId)
          .filter((nodeId) => searchScope.replace(/^(?:节点|机器|主机)\s*/, "").toLowerCase() === nodeId.toLowerCase())
      )
    );

    if (mentionedNodes.length === 1) {
      const nodeSessions = ctx.sessions.filter((s) => s.nodeId === mentionedNodes[0]);
      if (nodeSessions.length === 1) {
        return { session: nodeSessions[0] };
      }
      if (nodeSessions.length > 1) {
        const list = nodeSessions
          .map((s) => `- [${s.nodeId}] ${s.title || s.id} (id: ${s.id})`)
          .join("\n");
        return {
          clarificationMessage: `节点 '${mentionedNodes[0]}' 拥有多个会话，请指明是哪一个：\n${list}`,
        };
      }
    } else if (mentionedNodes.length > 1) {
      return {
        clarificationMessage: `语句中提及了多个不同节点（${mentionedNodes.join(", ")}），请明确指定目标。`,
      };
    }

    // If an explicit target clause was provided (e.g. "让 bad-node 的 bad-sess 执行"),
    // but matched NO sessions and NO nodes, report explicitTargetNotFound!
    if (candidateName) {
      return { explicitTargetNotFound: candidateName };
    }

    return {};
  }
}
