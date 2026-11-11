import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import type { SpreadsheetReadResult, SpreadsheetService, SpreadsheetWriteResult } from './types.js';

const MAX_RESULT_LENGTH = 100_000;

type ApiResponse<T> = { code?: number; msg?: string; data?: T };
type SheetInfo = {
  sheet_id?: string;
  title?: string;
  index?: number;
  hidden?: boolean;
  grid_properties?: { row_count?: number; column_count?: number };
};

export function parseSpreadsheetReference(input: string): { kind: 'sheet' | 'wiki'; token: string } {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(value)) return { kind: 'sheet', token: value };
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('请提供飞书电子表格的完整链接或 spreadsheet_token'); }
  if (!['http:', 'https:'].includes(url.protocol) || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
    throw new Error('电子表格链接必须来自飞书或 Lark');
  }
  const match = url.pathname.match(/\/(sheets|wiki)\/([A-Za-z0-9_-]{8,128})(?:\/|$)/);
  if (!match) throw new Error('仅支持飞书电子表格或指向电子表格的 Wiki 链接');
  return { kind: match[1] === 'sheets' ? 'sheet' : 'wiki', token: match[2] };
}

function encodeRange(range: string): string {
  return encodeURIComponent(range).replace(/%21/gi, '!').replace(/%3A/gi, ':');
}

export class FeishuSheets implements SpreadsheetService {
  constructor(private config: Config, private clientFor: (agentId: string) => lark.Client) {}

  private client(agentId: string): lark.Client {
    if (!this.config.agents.some(agent => agent.id === agentId)) throw new Error('Agent 未启用');
    return this.clientFor(agentId);
  }

  private async request<T>(action: string, send: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
    let response: ApiResponse<T>;
    try { response = await send(); }
    catch { throw new Error(`飞书电子表格${action}请求失败，请检查网络、应用权限和文档共享设置`); }
    if (response.code !== 0) {
      const detail = response.msg ? `：${response.msg.slice(0, 300)}` : '';
      throw new Error(`飞书电子表格${action}失败 code=${response.code ?? 'unknown'}${detail}。请检查应用权限及表格是否已共享给应用`);
    }
    return response;
  }

  private async resolveToken(client: lark.Client, spreadsheet: string, signal: AbortSignal): Promise<string> {
    const reference = parseSpreadsheetReference(spreadsheet);
    if (reference.kind === 'sheet') return reference.token;
    signal.throwIfAborted();
    const response = await this.request('解析 Wiki 节点', () => client.wiki.v2.space.getNode({
      params: { token: reference.token },
    }));
    signal.throwIfAborted();
    const node = response.data?.node;
    if (node?.obj_type !== 'sheet' || !node.obj_token) {
      throw new Error(`Wiki 节点类型为 ${node?.obj_type ?? '未知'}，仅支持指向电子表格的 Wiki 文档`);
    }
    return node.obj_token;
  }

  private async sheets(client: lark.Client, token: string): Promise<SheetInfo[]> {
    const response = await this.request('读取工作表列表', () => client.sheets.v3.spreadsheetSheet.query({
      path: { spreadsheet_token: token },
    }));
    return response.data?.sheets ?? [];
  }

  private firstSheet(sheets: SheetInfo[]): SheetInfo {
    const sheet = sheets.find(item => item.sheet_id && !item.hidden) ?? sheets.find(item => item.sheet_id);
    if (!sheet?.sheet_id) throw new Error('电子表格没有可操作的工作表');
    return sheet;
  }

  async read(agentId: string, spreadsheet: string, range: string | undefined, signal: AbortSignal): Promise<SpreadsheetReadResult> {
    const client = this.client(agentId);
    const token = await this.resolveToken(client, spreadsheet, signal);
    signal.throwIfAborted();
    const [metadata, sheets] = await Promise.all([
      this.request('读取信息', () => client.sheets.v3.spreadsheet.get({ path: { spreadsheet_token: token } })),
      this.sheets(client, token),
    ]);
    const first = this.firstSheet(sheets);
    const targetRange = range ?? `${first.sheet_id}!A1:Z100`;
    const response = await this.request('读取数据', () => client.request<ApiResponse<{
      revision?: number;
      valueRange?: { range?: string; values?: unknown[][]; revision?: number };
    }>>({
      method: 'GET',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeRange(targetRange)}`,
      params: { valueRenderOption: 'ToString', dateTimeRenderOption: 'FormattedString' },
    }));
    signal.throwIfAborted();
    const source = response.data?.valueRange?.values ?? [];
    if (!Array.isArray(source) || source.some(row => !Array.isArray(row))) throw new Error('飞书电子表格读取响应缺少有效数据');
    const values: unknown[][] = [];
    let length = 2;
    let truncated = range === undefined && ((first.grid_properties?.row_count ?? 0) > 100 || (first.grid_properties?.column_count ?? 0) > 26);
    for (const row of source) {
      length += JSON.stringify(row).length + 1;
      if (length > MAX_RESULT_LENGTH) { truncated = true; break; }
      values.push(row);
    }
    return {
      spreadsheet_token: token,
      title: metadata.data?.spreadsheet?.title ?? '',
      revision_id: response.data?.valueRange?.revision ?? response.data?.revision ?? null,
      range: response.data?.valueRange?.range ?? targetRange,
      values,
      truncated,
      sheets: sheets.map(sheet => ({
        sheet_id: sheet.sheet_id ?? '', title: sheet.title ?? '', index: sheet.index ?? null,
        rows: sheet.grid_properties?.row_count ?? null, columns: sheet.grid_properties?.column_count ?? null,
      })),
    };
  }

  async write(agentId: string, spreadsheet: string, range: string | undefined, values: (string | number | boolean | null)[][], mode: 'append' | 'overwrite', signal: AbortSignal): Promise<SpreadsheetWriteResult> {
    if (mode === 'overwrite' && !range) throw new Error('覆盖电子表格时必须明确提供 range');
    const client = this.client(agentId);
    const token = await this.resolveToken(client, spreadsheet, signal);
    signal.throwIfAborted();
    const sheets = await this.sheets(client, token);
    const sheet = this.firstSheet(sheets);
    const targetRange = range ?? `${sheet.sheet_id}!A1:CV5000`;
    const response = await this.request('写入数据', () => client.request<ApiResponse<{
      revision?: number;
      updatedRange?: string;
      updatedCells?: number;
      updates?: { revision?: number; updatedRange?: string; updatedCells?: number };
    }>>({
      method: mode === 'append' ? 'POST' : 'PUT',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/${mode === 'append' ? 'values_append' : 'values'}`,
      ...(mode === 'append' ? { params: { insertDataOption: 'INSERT_ROWS' } } : {}),
      data: { valueRange: { range: targetRange, values } },
    }));
    signal.throwIfAborted();
    return {
      saved: true,
      spreadsheet_token: token,
      sheet_id: targetRange.split('!')[0],
      mode,
      range: response.data?.updatedRange ?? response.data?.updates?.updatedRange ?? targetRange,
      revision_id: response.data?.revision ?? response.data?.updates?.revision ?? null,
      updated_cells: response.data?.updatedCells ?? response.data?.updates?.updatedCells ?? null,
    };
  }
}
