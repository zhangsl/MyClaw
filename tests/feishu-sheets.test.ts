import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.js';
import { FeishuSheets, parseSpreadsheetReference } from '../src/feishu-sheets.js';
import { Services } from '../src/services.js';
import { makeTools } from '../src/tools.js';
import { fixture } from './helpers.js';

const spreadsheetToken = 'shtcnAbCdEfGhIjKlMnOp';
const spreadsheetUrl = `https://example.feishu.cn/sheets/${spreadsheetToken}?sheet=sheet1`;

function service(client: object): FeishuSheets {
  const config = { agents: [{ id: 'health' }] } as Config;
  return new FeishuSheets(config, () => client as never);
}

function sheetClient(request: (payload: any) => Promise<unknown>) {
  return {
    sheets: { v3: {
      spreadsheet: { get: async () => ({ code: 0, data: { spreadsheet: { title: '健康记录' } } }) },
      spreadsheetSheet: { query: async () => ({ code: 0, data: { sheets: [
        { sheet_id: 'sheet1', title: '记录', index: 0, grid_properties: { row_count: 200, column_count: 30 } },
        { sheet_id: 'sheet2', title: '其他', index: 1, hidden: true },
      ] } }) },
    } },
    request,
  };
}

test('Feishu spreadsheet references accept sheets and Wiki URLs and reject other types', () => {
  assert.deepEqual(parseSpreadsheetReference(spreadsheetToken), { kind: 'sheet', token: spreadsheetToken });
  assert.deepEqual(parseSpreadsheetReference(spreadsheetUrl), { kind: 'sheet', token: spreadsheetToken });
  assert.deepEqual(parseSpreadsheetReference(`https://example.larksuite.com/wiki/${spreadsheetToken}`), { kind: 'wiki', token: spreadsheetToken });
  assert.throws(() => parseSpreadsheetReference(`https://example.feishu.cn/docx/${spreadsheetToken}`), /仅支持飞书电子表格/);
  assert.throws(() => parseSpreadsheetReference(`https://evil.example/sheets/${spreadsheetToken}`), /必须来自飞书/);
});

test('spreadsheet read returns sheet metadata and a bounded default range', async () => {
  let requestPayload: any;
  const sheets = service(sheetClient(async payload => {
    requestPayload = payload;
    return { code: 0, data: { valueRange: { range: 'sheet1!A1:Z100', revision: 9, values: [['日期', '体重'], ['2026-11-11', 72.3]] } } };
  }));
  const result = await sheets.read('health', spreadsheetUrl, undefined, new AbortController().signal);
  assert.equal(requestPayload.method, 'GET');
  assert.equal(requestPayload.url, `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/sheet1!A1:Z100`);
  assert.equal(requestPayload.params.valueRenderOption, 'ToString');
  assert.equal(result.title, '健康记录');
  assert.equal(result.revision_id, 9);
  assert.deepEqual(result.values, [['日期', '体重'], ['2026-11-11', 72.3]]);
  assert.equal(result.truncated, true);
  assert.equal(result.sheets[0].sheet_id, 'sheet1');
});

test('Wiki spreadsheet links resolve sheet nodes and reject docx nodes', async () => {
  const wikiToken = 'wikiTokenAbCdEfGhIjKlMnOp';
  const sheets = service({
    wiki: { v2: { space: { getNode: async (payload: any) => {
      assert.equal(payload.params.token, wikiToken);
      return { code: 0, data: { node: { obj_type: 'sheet', obj_token: spreadsheetToken } } };
    } } } },
    ...sheetClient(async () => ({ code: 0, data: { valueRange: { values: [['Wiki 表格']] } } })),
  });
  const result = await sheets.read('health', `https://example.feishu.cn/wiki/${wikiToken}`, 'sheet1!A1:A1', new AbortController().signal);
  assert.equal(result.spreadsheet_token, spreadsheetToken);
  assert.deepEqual(result.values, [['Wiki 表格']]);

  const docx = service({ wiki: { v2: { space: { getNode: async () => ({
    code: 0, data: { node: { obj_type: 'docx', obj_token: spreadsheetToken } },
  }) } } } });
  await assert.rejects(docx.read('health', `https://example.feishu.cn/wiki/${wikiToken}`, undefined, new AbortController().signal), /Wiki 节点类型为 docx/);
});

test('spreadsheet write appends safely and overwrites only an explicit range', async () => {
  const requests: any[] = [];
  const sheets = service(sheetClient(async payload => {
    requests.push(payload);
    return { code: 0, data: { revision: 10 + requests.length, updatedRange: 'sheet1!A3:B3', updatedCells: 2 } };
  }));
  const appended = await sheets.write('health', spreadsheetToken, undefined, [['今天', 72.3]], 'append', new AbortController().signal);
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].url, /values_append$/);
  assert.equal(requests[0].params.insertDataOption, 'INSERT_ROWS');
  assert.equal(requests[0].data.valueRange.range, 'sheet1!A1:CV5000');
  assert.deepEqual(requests[0].data.valueRange.values, [['今天', 72.3]]);
  assert.equal(appended.updated_cells, 2);

  const overwritten = await sheets.write('health', spreadsheetToken, 'sheet2!A1:B1', [['新值', true]], 'overwrite', new AbortController().signal);
  assert.equal(requests[1].method, 'PUT');
  assert.match(requests[1].url, /values$/);
  assert.equal(requests[1].data.valueRange.range, 'sheet2!A1:B1');
  assert.equal(overwritten.sheet_id, 'sheet2');
  await assert.rejects(sheets.write('health', spreadsheetToken, undefined, [['不安全']], 'overwrite', new AbortController().signal), /必须明确提供 range/);
});

test('spreadsheet tools execute through Services and replay successful writes without another API call', async () => {
  const f = fixture();
  let writes = 0;
  try {
    const client = sheetClient(async payload => {
      if (payload.method !== 'GET') writes++;
      return { code: 0, data: payload.method === 'GET'
        ? { valueRange: { values: [['已有内容']] } }
        : { updatedRange: 'sheet1!A2:B2', updatedCells: 2, revision: 2 } };
    });
    const spreadsheets = new FeishuSheets(f.config, () => client as never);
    const services = new Services(f.store, f.scheduler, f.config.timezone, undefined, spreadsheets);
    const runId = f.store.enqueue('health', 'chat-health', 'sheet', '读写电子表格');
    const run = f.store.run(runId)!;
    const tools = makeTools(f.config.agents[0], run, services, new AbortController().signal);
    const write = tools.find(tool => tool.name === 'feishu_sheet_write')!;
    const args = { spreadsheet: spreadsheetUrl, values: [['追加', 1]], mode: 'append' } as never;
    const first = await write.execute('same-call', args, undefined, undefined, {} as never);
    const replay = await write.execute('same-call', args, undefined, undefined, {} as never);
    assert.equal(writes, 1);
    assert.equal(first.content[0].text, replay.content[0].text);
    const read = tools.find(tool => tool.name === 'feishu_sheet_read')!;
    const readResult = await read.execute('read-call', { spreadsheet: spreadsheetUrl } as never, undefined, undefined, {} as never);
    assert.match(readResult.content[0].text, /已有内容/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM tool_receipts WHERE run_id=?').get(runId)!.count, 2);
  } finally { await f.cleanup(); }
});
