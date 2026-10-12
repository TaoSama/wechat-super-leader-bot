const REASONS: Record<string, string> = {
  authorization_revoked: "当前聊天已不在授权名单中，后续派发已暂停。",
  result_unavailable_or_failed: "任务失败或精确结果尚不明确，已暂停；请先核查原会话，不会自动重发。",
  decision_budget_exhausted: "已用完授权的决策轮数，后续派发已暂停。",
  decision_evidence_changed: "决策期间原结果发生变化，需先核查精确证据。",
  model_decision_timeout: "模型决策超时，已暂停；未据此派发新任务。",
  model_decision_transport: "模型连接失败，已暂停；未据此派发新任务。",
  model_decision_http: "模型服务请求失败，已暂停；请检查服务状态或额度。",
  model_decision_invalid_response: "模型返回的决策无效，已暂停；未据此派发新任务。",
  model_decision_processing: "决策未通过处理或授权校验，已暂停；未据此派发新任务。",
};
export function goalReason(reason: string): string { return REASONS[reason] ?? reason; }
