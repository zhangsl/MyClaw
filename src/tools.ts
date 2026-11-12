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
  definitions.push(
    { name: 'send_media', description: '把当前工作区或本次接收附件目录中的本地文件加入飞书发送队列。path 为绝对路径或相对工作区路径；kind 可选 image/audio/file，默认 file。图片最大 10 MB，其他最大 30 MB。audio 仅支持 .opus/.ogg 且必须提供毫秒时长 durationMs；其他音频用 file 发送。工具成功仅表示已入队，不代表对方已收到。', parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), kind: Type.Optional(Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('file')])), durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })) }) },
  );
  if (agent.healthTools) definitions.push(
    { name: 'health_record', description: '记录用户明确报告的体重(kg)或每日累计运动时长(分钟)。day 为 YYYY-MM-DD，省略则是用户时区今天。同一天同类型记录替换旧值；运动时长须为当天累计总量。不推测缺失数据。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), value: Type.Number(), day: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }) },
    { name: 'health_query', description: '读取最近的体重或运动记录，按日期倒序。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })) }) },
    { name: 'health_delete', description: '删除用户明确要求删除的某日健康记录。', parameters: Type.Object({ kind: Type.Union([Type.Literal('weight'), Type.Literal('exercise')]), day: Type.String() }) },
  );
  if (services.documents) definitions.push(
    { name: 'feishu_doc_read', description: '读取新版飞书 docx 文档纯文本。document 为 docx 链接、指向 docx 的 Wiki 链接或 document_id；不支持旧版 doc、表格或多维表格。', parameters: Type.Object({ document: Type.String({ minLength: 1, maxLength: 2048 }) }) },
    { name: 'feishu_doc_write', description: '向新版飞书 docx 文档写入 Markdown，保留标题、列表、代码块和表格，不支持图片。mode 默认 append 追加；overwrite 会替换全文，只有用户明确要求覆盖时才可使用。document 为 docx 链接、指向 docx 的 Wiki 链接或 document_id。', parameters: Type.Object({ document: Type.String({ minLength: 1, maxLength: 2048 }), content: Type.String({ minLength: 1, maxLength: 100000 }), mode: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('overwrite')])) }) },
  );
  const sheetCell = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
  const sheetRange = Type.String({ minLength: 3, maxLength: 256, pattern: '^[A-Za-z0-9_-]+![A-Z]{1,3}[0-9]+(:[A-Z]{1,3}[0-9]+)?$' });
  if (services.spreadsheets) definitions.push(
    { name: 'feishu_sheet_read', description: '读取飞书电子表格。spreadsheet 为 sheets 链接、指向电子表格的 Wiki 链接或 spreadsheet_token。range 可选，格式为 工作表ID!A1:Z100；省略时读取首个可见工作表的 A1:Z100，并返回所有工作表 ID。', parameters: Type.Object({ spreadsheet: Type.String({ minLength: 1, maxLength: 2048 }), range: Type.Optional(sheetRange) }) },
    { name: 'feishu_sheet_write', description: '写入飞书电子表格，values 是二维数组（每行一个数组，单元格为字符串、数字、布尔值或 null）。mode 默认 append，在首个可见工作表追加行；range 可指定工作表和区域。overwrite 只覆盖明确指定的 range，必须提供 range，只有用户明确要求覆盖时才可使用。', parameters: Type.Object({ spreadsheet: Type.String({ minLength: 1, maxLength: 2048 }), range: Type.Optional(sheetRange), values: Type.Array(Type.Array(sheetCell, { minItems: 1, maxItems: 100 }), { minItems: 1, maxItems: 5000 }), mode: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('overwrite')])) }) },
  );
  return definitions.map(d => ({
    ...d, label: d.name,
    async execute(callId, args) {
      signal.throwIfAborted();
      const result = d.name.startsWith('feishu_doc_')
        ? await services.callDocument(agent, run, d.name, args, callId, signal)
        : d.name.startsWith('feishu_sheet_')
          ? await services.callSpreadsheet(agent, run, d.name, args, callId, signal)
          : services.call(agent, run, d.name, args, callId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} };
    },
  }));
}
