// Synthetic browser-only goal observations. No scheduler, agents or credentials.
export const GOAL_MODES = ['empty', 'active', 'completed', 'blocked', 'unverified', 'expired'];
export function createGoalFixture(sessions) {
  let mode = 'empty';
  return {
    setMode(next) { if (!GOAL_MODES.includes(next)) throw new Error('Invalid synthetic goal mode'); mode = next; },
    snapshot() {
      const now = Date.now(), goal = { id: '00000000-0000-4000-8000-000000000021', status: mode === 'unverified' ? 'completed' : mode,
        objective: '核查跨机会话，修复测试并确认交付', objectiveTruncated: false,
        createdAt: now - 60_000, expiresAt: now + 30 * 60_000, maxActions: 4, maxDecisions: 6, decisionAttempts: 3,
        reason: mode === 'blocked' ? '第二轮任务的精确结果尚不明确，已暂停；不会自动重发。' : '根据首轮测试结果安排补充核查，保留原会话与精确回执。',
        targets: [{ nodeId: sessions[0].nodeId, sessionId: sessions[0].id }, { nodeId: sessions[2].nodeId, sessionId: sessions[2].id }],
        criteria: [{ index: 1, text: '测试通过，并提供可核查的结果', supported: mode === 'completed', actions: mode === 'completed' ? [2] : [] }],
        actions: [
          { index: 1, target: 1, prompt: '检查当前测试，给出失败位置与最小修改建议。', promptTruncated: false, sourceActions: [], status: 'completed', commandId: 'synthetic-first-command', turnId: 'synthetic-first-turn' },
          { index: 2, target: 2, prompt: '依据首轮结果复核修改，提供测试命令和输出。', promptTruncated: false, sourceActions: [1],
            status: mode === 'blocked' || mode === 'unverified' ? 'uncertain' : mode === 'completed' ? 'completed' : 'accepted', commandId: 'synthetic-second-command', turnId: 'synthetic-second-turn' },
        ] };
      return { observedAt: now, limit: 12, hasMore: false, items: mode === 'empty' ? [] : [goal] };
    },
  };
}
