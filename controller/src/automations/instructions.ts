/** Scheduling rules shared by the model leader and the direct tool protocol. */
export const AUTOMATION_INSTRUCTIONS = `定时任务：默认时区 Asia/Shanghai，用户明确指定时区时用该时区。
只在用户本轮明确要求时创建、暂停、恢复或取消定时任务；查询用 list_automations 或 automation_runs。时间、会话或意图含糊时先问，已有提醒不能因为查询而重建。
创建成功只表示已保存、等待调度，未来触发不等于已经启动会话；同一请求不要反复创建。任务开始时默认静默，监控没有变化就不通知。`;
