import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './config.js';
import type { Run } from './types.js';
import { Services } from './services.js';

const scheduleSchema = Type.Object({
  name: Type.String(), cron: Type.Optional(Type.String()), at: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()), action: Type.Union([Type.Literal('reminder'), Type.Literal('agent')]),
  prompt: Type.String(), misfire: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('latest')])),
  graceSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86400 })),
});

export function makeTools(agent: AgentConfig, run: Run, services: Services, signal: AbortSignal): ToolDefinition[] {
  const definitions = [
    { name: 'memory_read', description: '读取当前助理的长期记忆。', parameters: Type.Object({}) },
    { name: 'memory_write', description: '完整替换当前助理的长期记忆，先读后合并。只记用户明确提供的稳定事实与偏好；勿把日报或测量值当记忆。', parameters: Type.Object({ content: Type.String({ maxLength: 16000 }) }) },
    { name: 'recent_runs', description: '查询当前聊天最近的执行和定时任务结果，回答关于之前报告的追问。', parameters: Type.Object({}) },
    { name: 'schedule_list', description: '列出当前助理在当前聊天中的定时任务。', parameters: Type.Object({}) },
    { name: 'schedule_create', description: '创建计划。cron 为五段表达式；at 为带时区的未来 ISO 时间，两者只能选一。reminder 直接发送 prompt，agent 则在新会话运行 prompt。默认 skip 错过的提醒；日报可选 latest。成功后告知用户 ID、时区及下次时间。', parameters: scheduleSchema },
    { name: 'schedule_update', description: '完整替换一个已有计划的设置。先 list 获取当前值，合并用户修改；不改变暂停状态。', parameters: Type.Object({ id: Type.String(), schedule: scheduleSchema }) },
    { name: 'schedule_change', description: '暂停、恢复或删除当前聊天的指定计划。', parameters: Type.Object({ id: Type.String(), operation: Type.Union(['pause', 'resume', 'delete'].map(x => Type.Literal(x))) }) },
  ];
  if (agent.healthTools) definitions.push(
    { name: 'health_record', description: '记录用户明确报告的体重(kg)或每日累计运动时长(分钟)。day 为 YYYY-MM-DD，省略则是用户时区今天。同一天同类型记录替换旧值；运动时长须为当天累计总量。不推测缺失数据。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), value: Type.Number(), day: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }) },
    { name: 'health_query', description: '读取最近的体重或运动记录，按日期倒序。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })) }) },
    { name: 'health_delete', description: '删除用户明确要求删除的某日健康记录。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), day: Type.String() }) },
  );
  return definitions.map(d => ({
    ...d, label: d.name,
    async execute(callId, args) {
      signal.throwIfAborted();
      const result = services.call(agent, run, d.name, args, callId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} };
    },
  }));
}
