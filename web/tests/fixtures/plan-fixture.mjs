// Synthetic display scenarios only; never imported by the application.
const LIMIT = 12;
const PLAN_ID = '07000000-0000-4000-8000-000000000001';
const SECOND_ID = '07000000-0000-4000-8000-000000000002';
const THIRD_ID = '07000000-0000-4000-8000-000000000003';
const HOUR_MS = 60 * 60 * 1000;
export const PLAN_MODES = ['initial', 'completed', 'uncertain', 'cancelled', 'expired', 'empty', 'overflow', 'invalid', 'result-sources'];

export function createPlanFixture(sessions) {
  const createdAt = Date.now() - 120_000;
  let mode = 'initial';
  const step = (number, target, status, dependsOn, prompt) => ({
    step: number, nodeId: target.nodeId, sessionId: target.id, status, dependsOn, resultFrom: [],
    prompt, promptTruncated: false,
    ...(['completed', 'accepted', 'uncertain'].includes(status)
      ? { commandId: 'plan-browser-command-' + number, turnId: 'plan-browser-turn-' + number } : {}),
  });
  const main = () => ({ id: PLAN_ID, status: 'active', createdAt, expiresAt: createdAt + HOUR_MS,
    steps: [
      step(1, sessions[0], 'completed', [], '梳理工作台历史刷新与消息分页的边界，并给出验收结果。'),
      step(2, sessions[2], 'accepted', [1], '复核计划的事务持久化与回执关联，保留审查结论。'),
      step(3, sessions[3], 'waiting', [2], '前两项完成后，核对多机连接与服务生命周期的文档。'),
    ] });
  return {
    setMode(next) {
      if (!PLAN_MODES.includes(next)) throw new Error('Unknown plan fixture mode');
      mode = next;
    },
    snapshot() {
      const primary = main();
      let items = [primary];
      if (mode === 'initial') {
        items.push({ ...main(), id: SECOND_ID, createdAt: createdAt - 20_000, steps: [
          step(1, sessions[1], 'uncertain', [], '检查微信查询预算；投递回执尚未核实，请勿重复发送。'),
          step(2, sessions[0], 'waiting', [1], '收到准确完成回执后，整理本轮验证记录。'),
        ] });
        items.push({ ...main(), id: THIRD_ID, createdAt: createdAt - HOUR_MS, status: 'cancelled', steps: [
          step(1, sessions[2], 'accepted', [], '只读审查仍在原会话运行。取消计划不代表停止此任务。'),
          step(2, { nodeId: 'old-node', id: 'missing-session' }, 'cancelled', [1], '后续部署检查已取消。'),
        ] });
      }
      if (mode === 'completed') {
        primary.status = 'completed';
        primary.steps = primary.steps.map(item => ({ ...item, status: 'completed',
          commandId: 'plan-browser-command-' + item.step, turnId: 'plan-browser-turn-' + item.step }));
      }
      if (mode === 'result-sources') {
        const source = (number, outputLength, excerptLength) => ({ step: number,
          commandId: 'plan-browser-command-' + number, turnId: 'plan-browser-turn-' + number,
          outputSHA256: String(number).repeat(64), outputLength, excerptLength, truncated: excerptLength < outputLength });
        primary.steps[1].status = 'completed';
        primary.steps[1].resultFrom = [1];
        primary.steps[1].resultSources = [source(1, 4827, 1000)];
        primary.steps[2].resultFrom = [2];
        primary.steps.push({ ...step(4, sessions[1], 'claimed', [2, 1], '使用已冻结的来源摘要继续只读核对；冻结并不证明资料已送达。'),
          resultFrom: [2, 1], resultSources: [source(2, 0, 0), source(1, 4827, 1000)] });
      }
      if (mode === 'uncertain') primary.steps[1].status = 'uncertain';
      if (mode === 'cancelled') { primary.status = 'cancelled'; primary.steps[2].status = 'cancelled'; }
      if (mode === 'expired') primary.expiresAt = Date.now() - 1000; // Durable active until reconciliation.
      if (mode === 'empty') items = [];
      if (mode === 'overflow') items = Array.from({ length: LIMIT }, (_, i) => ({ ...main(),
        id: `07000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, createdAt: createdAt - i * 1000 }));
      if (mode === 'invalid') primary.steps[1].status = 'unverified-success';
      return { observedAt: Date.now(), limit: LIMIT, hasMore: mode === 'overflow', items };
    },
  };
}
