import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.js';
import { FeishuDocuments, parseDocumentReference } from '../src/feishu-documents.js';
import { Services } from '../src/services.js';
import { makeTools } from '../src/tools.js';
import { fixture } from './helpers.js';

const documentId = 'doxcnAbCdEfGhIjKlMnOp';
const documentUrl = `https://example.feishu.cn/docx/${documentId}?from=chat`;

function service(client: object): FeishuDocuments {
  const config = { agents: [{ id: 'health' }] } as Config;
  return new FeishuDocuments(config, () => client as never);
}

function textBlock(id: string, content = id) {
  return { block_id: id, block_type: 2, text: { elements: [{ text_run: { content } }] } };
}

test('Feishu document references accept docx and Wiki URLs and reject unsupported document types', () => {
  assert.deepEqual(parseDocumentReference(documentId), { kind: 'docx', token: documentId });
  assert.deepEqual(parseDocumentReference(documentUrl), { kind: 'docx', token: documentId });
  assert.deepEqual(parseDocumentReference(`https://example.larksuite.com/docx/${documentId}/`), { kind: 'docx', token: documentId });
  assert.deepEqual(parseDocumentReference(`https://example.feishu.cn/wiki/${documentId}`), { kind: 'wiki', token: documentId });
  assert.throws(() => parseDocumentReference(`https://example.feishu.cn/docs/${documentId}`), /仅支持新版 docx/);
  assert.throws(() => parseDocumentReference(`https://evil.example/docx/${documentId}`), /必须来自飞书/);
  assert.throws(() => parseDocumentReference('not a document'), /完整链接/);
});

test('Feishu document read returns metadata and bounded plain text', async () => {
  const paths: string[] = [];
  const documents = service({ docx: { v1: { document: {
    get: async (payload: { path: { document_id: string } }) => {
      paths.push(payload.path.document_id);
      return { code: 0, data: { document: { title: '周报', revision_id: 7 } } };
    },
    rawContent: async (payload: { path: { document_id: string } }) => {
      paths.push(payload.path.document_id);
      return { code: 0, data: { content: '正文' } };
    },
  } } } });
  const result = await documents.read('health', documentUrl, new AbortController().signal);
  assert.deepEqual(result, { document_id: documentId, title: '周报', revision_id: 7, content: '正文', truncated: false });
  assert.deepEqual(paths, [documentId, documentId]);
});

test('Wiki links resolve docx nodes and reject other node types', async () => {
  const wikiToken = 'wikiTokenAbCdEfGhIjKlMnOp';
  let resolvedToken = '';
  const documents = service({
    wiki: { v2: { space: { getNode: async (payload: any) => {
      resolvedToken = payload.params.token;
      return { code: 0, data: { node: { obj_type: 'docx', obj_token: documentId } } };
    } } } },
    docx: { v1: { document: {
      get: async () => ({ code: 0, data: { document: { title: 'Wiki 文档', revision_id: 3 } } }),
      rawContent: async (payload: any) => {
        assert.equal(payload.path.document_id, documentId);
        return { code: 0, data: { content: 'Wiki 正文' } };
      },
    } } },
  });
  const result = await documents.read('health', `https://example.feishu.cn/wiki/${wikiToken}`, new AbortController().signal);
  assert.equal(resolvedToken, wikiToken);
  assert.equal(result.document_id, documentId);
  assert.equal(result.content, 'Wiki 正文');

  const sheet = service({ wiki: { v2: { space: { getNode: async () => ({
    code: 0, data: { node: { obj_type: 'sheet', obj_token: documentId } },
  }) } } } });
  await assert.rejects(sheet.read('health', `https://example.feishu.cn/wiki/${wikiToken}`, new AbortController().signal), /Wiki 节点类型为 sheet/);
});

test('Feishu document append converts Markdown and uses a stable idempotency token', async () => {
  let createPayload: any;
  const documents = service({ docx: {
    v1: { document: {
      get: async () => ({ code: 0, data: { document: { revision_id: 4 } } }),
      convert: async (payload: any) => {
        assert.equal(payload.data.content_type, 'markdown');
        return { code: 0, data: { first_level_block_ids: ['b1'], blocks: [textBlock('b1', '新内容')] } };
      },
    } },
    documentBlockDescendant: { create: async (payload: any) => {
      createPayload = payload;
      return { code: 0, data: { document_revision_id: 5 } };
    } },
  } });
  const result = await documents.write('health', documentId, '新内容', 'append', new AbortController().signal, 'call-1');
  assert.equal(createPayload.data.index, undefined);
  assert.deepEqual(createPayload.data.children_id, ['b1']);
  assert.equal(createPayload.params.document_revision_id, 4);
  assert.match(createPayload.params.client_token, /^[a-f0-9]{48}:0$/);
  assert.deepEqual(result, { saved: true, document_id: documentId, mode: 'append', revision_id: 5, blocks: 1 });
});

test('Feishu document overwrite inserts before deleting old content and strips table merge metadata', async () => {
  const operations: string[] = [];
  let insert: any;
  let deletion: any;
  const table = { block_id: 'table', block_type: 31, children: ['cell'], table: { property: { row_size: 1, column_size: 1, merge_info: [{ row_span: 1 }] } } };
  const cell = { block_id: 'cell', block_type: 32, children: ['b1'] };
  const documents = service({ docx: {
    v1: { document: {
      get: async () => { operations.push('version'); return { code: 0, data: { document: { revision_id: 8 } } }; },
      convert: async () => {
        operations.push('convert');
        return { code: 0, data: { first_level_block_ids: ['table'], blocks: [table, cell, textBlock('b1')] } };
      },
    } },
    documentBlockChildren: {
      get: async () => { operations.push('children'); return { code: 0, data: { items: [{}, {}], has_more: false } }; },
      batchDelete: async (payload: any) => {
        operations.push('delete'); deletion = payload;
        return { code: 0, data: { document_revision_id: 10 } };
      },
    },
    documentBlockDescendant: { create: async (payload: any) => {
      operations.push('insert'); insert = payload;
      assert.equal('merge_info' in payload.data.descendants[0].table.property, false);
      return { code: 0, data: { document_revision_id: 9 } };
    } },
  } });
  const result = await documents.write('health', documentId, '|值|\n|---|\n|一|', 'overwrite', new AbortController().signal, 'call-2');
  assert.deepEqual(operations, ['convert', 'version', 'children', 'insert', 'delete']);
  assert.equal(insert.data.index, 2);
  assert.deepEqual(insert.data.children_id, ['table']);
  assert.equal(deletion.data.start_index, 0);
  assert.equal(deletion.data.end_index, 2);
  assert.equal(deletion.params.document_revision_id, 9);
  assert.equal(result.revision_id, 10);
});

test('Feishu document write rejects images before changing the document and batches large content', async () => {
  let reads = 0;
  const imageDocuments = service({ docx: {
    v1: { document: {
      get: async () => { reads++; return { code: 0, data: {} }; },
      convert: async () => ({ code: 0, data: { first_level_block_ids: ['image'], blocks: [{ block_id: 'image', block_type: 27, image: {} }] } }),
    } },
  } });
  await assert.rejects(imageDocuments.write('health', documentId, '![图](https://example.com/a.png)', 'overwrite', new AbortController().signal, 'image'), /暂不支持写入/);
  assert.equal(reads, 0);

  const blocks = Array.from({ length: 1001 }, (_, index) => textBlock(`b${index}`));
  const batches: any[] = [];
  const documents = service({ docx: {
    v1: { document: {
      get: async () => ({ code: 0, data: { document: { revision_id: 1 } } }),
      convert: async () => ({ code: 0, data: { first_level_block_ids: blocks.map(block => block.block_id), blocks } }),
    } },
    documentBlockDescendant: { create: async (payload: any) => {
      batches.push(payload);
      return { code: 0, data: { document_revision_id: batches.length + 1 } };
    } },
  } });
  await documents.write('health', documentId, 'large', 'append', new AbortController().signal, 'large');
  assert.deepEqual(batches.map(batch => batch.data.descendants.length), [1000, 1]);
  assert.equal(batches[1].params.document_revision_id, 2);
});

test('document tools execute through Services and replay successful writes without another API call', async () => {
  const f = fixture();
  let writes = 0;
  try {
    const client = { docx: {
      v1: { document: {
        get: async () => ({ code: 0, data: { document: { title: '测试', revision_id: 1 } } }),
        rawContent: async () => ({ code: 0, data: { content: '已有内容' } }),
        convert: async () => ({ code: 0, data: { first_level_block_ids: ['b1'], blocks: [textBlock('b1')] } }),
      } },
      documentBlockDescendant: { create: async () => {
        writes++;
        return { code: 0, data: { document_revision_id: 2 } };
      } },
    } };
    const documents = new FeishuDocuments(f.config, () => client as never);
    const services = new Services(f.store, f.scheduler, f.config.timezone, documents);
    const runId = f.store.enqueue('health', 'chat-health', 'doc', '读写文档');
    const run = f.store.run(runId)!;
    const tools = makeTools(f.config.agents[0], run, services, new AbortController().signal);
    const write = tools.find(tool => tool.name === 'feishu_doc_write')!;
    const args = { document: documentUrl, content: '追加内容', mode: 'append' } as never;
    const first = await write.execute('same-call', args, undefined, undefined, {} as never);
    const replay = await write.execute('same-call', args, undefined, undefined, {} as never);
    assert.equal(writes, 1);
    assert.equal(first.content[0].text, replay.content[0].text);
    const read = tools.find(tool => tool.name === 'feishu_doc_read')!;
    const readResult = await read.execute('read-call', { document: documentUrl } as never, undefined, undefined, {} as never);
    assert.match(readResult.content[0].text, /已有内容/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM tool_receipts WHERE run_id=?').get(runId)!.count, 2);
  } finally { await f.cleanup(); }
});
