import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from './config.js';
import type { DocumentReadResult, DocumentService, DocumentWriteResult } from './types.js';

const MAX_CONTENT_LENGTH = 100_000;
const MAX_BLOCKS_PER_REQUEST = 1000;

type ConvertResponse = Awaited<ReturnType<lark.Client['docx']['v1']['document']['convert']>>;
type DocBlock = NonNullable<NonNullable<ConvertResponse['data']>['blocks']>[number];
type BlockChunk = { rootIds: string[]; blocks: DocBlock[] };

export function parseDocumentReference(input: string): { kind: 'docx' | 'wiki'; token: string } {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(value)) return { kind: 'docx', token: value };
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('请提供新版飞书文档的完整链接或 document_id'); }
  if (!['http:', 'https:'].includes(url.protocol) || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
    throw new Error('文档链接必须来自飞书或 Lark');
  }
  const match = url.pathname.match(/\/(docx|wiki)\/([A-Za-z0-9_-]{8,128})(?:\/|$)/);
  if (!match) throw new Error('仅支持新版 docx 文档或指向新版 docx 的 Wiki 链接');
  return { kind: match[1] as 'docx' | 'wiki', token: match[2] };
}

function chunkBlocks(blocks: DocBlock[], rootIds: string[]): BlockChunk[] {
  const byId = new Map(blocks.map(block => [block.block_id, block]));
  const visited = new Set<string>();
  const chunks: BlockChunk[] = [];
  let current: BlockChunk = { rootIds: [], blocks: [] };
  const flush = () => {
    if (current.rootIds.length) chunks.push(current);
    current = { rootIds: [], blocks: [] };
  };
  for (const rootId of rootIds) {
    const descendants: DocBlock[] = [];
    const visiting = new Set<string>();
    const visit = (blockId: string) => {
      if (visited.has(blockId)) return;
      if (visiting.has(blockId)) throw new Error('飞书返回了循环文档块，未执行写入');
      const block = byId.get(blockId);
      if (!block) throw new Error('飞书返回的文档块不完整，未执行写入');
      visiting.add(blockId);
      descendants.push(block);
      for (const child of block.children ?? []) visit(child);
      visiting.delete(blockId);
      visited.add(blockId);
    };
    visit(rootId);
    if (descendants.length > MAX_BLOCKS_PER_REQUEST) throw new Error('单个内容块过大，请拆分后分批写入');
    if (current.blocks.length + descendants.length > MAX_BLOCKS_PER_REQUEST) flush();
    current.rootIds.push(rootId);
    current.blocks.push(...descendants);
  }
  flush();
  if (visited.size !== blocks.length) throw new Error('飞书返回了无法关联的文档块，未执行写入');
  return chunks;
}

export class FeishuDocuments implements DocumentService {
  constructor(private config: Config, private clientFor: (agentId: string) => lark.Client) {}

  private client(agentId: string): lark.Client {
    if (!this.config.agents.some(agent => agent.id === agentId)) throw new Error('Agent 未启用');
    return this.clientFor(agentId);
  }

  private async request<T extends { code?: number; msg?: string }>(action: string, send: () => Promise<T>): Promise<T> {
    let response: T;
    try { response = await send(); }
    catch { throw new Error(`飞书文档${action}请求失败，请检查网络、应用权限和文档共享设置`); }
    if (response.code !== 0) {
      const detail = response.msg ? `：${response.msg.slice(0, 300)}` : '';
      throw new Error(`飞书文档${action}失败 code=${response.code ?? 'unknown'}${detail}。请检查应用权限及文档是否已共享给应用`);
    }
    return response;
  }

  private async resolveDocumentId(client: lark.Client, document: string, signal: AbortSignal): Promise<string> {
    const reference = parseDocumentReference(document);
    if (reference.kind === 'docx') return reference.token;
    signal.throwIfAborted();
    const response = await this.request('解析 Wiki 节点', () => client.wiki.v2.space.getNode({
      params: { token: reference.token },
    }));
    signal.throwIfAborted();
    const node = response.data?.node;
    if (node?.obj_type !== 'docx' || !node.obj_token) {
      throw new Error(`Wiki 节点类型为 ${node?.obj_type ?? '未知'}，仅支持指向新版 docx 的 Wiki 文档`);
    }
    return node.obj_token;
  }

  async read(agentId: string, document: string, signal: AbortSignal): Promise<DocumentReadResult> {
    const client = this.client(agentId);
    const documentId = await this.resolveDocumentId(client, document, signal);
    signal.throwIfAborted();
    const [metadata, raw] = await Promise.all([
      this.request('读取', () => client.docx.v1.document.get({ path: { document_id: documentId } })),
      this.request('读取', () => client.docx.v1.document.rawContent({ path: { document_id: documentId } })),
    ]);
    signal.throwIfAborted();
    if (raw.data?.content === undefined) throw new Error('飞书文档读取响应缺少内容');
    const characters = [...raw.data.content];
    return {
      document_id: documentId,
      title: metadata.data?.document?.title ?? '',
      revision_id: metadata.data?.document?.revision_id ?? null,
      content: characters.slice(0, MAX_CONTENT_LENGTH).join(''),
      truncated: characters.length > MAX_CONTENT_LENGTH,
    };
  }

  async write(agentId: string, document: string, content: string, mode: 'append' | 'overwrite', signal: AbortSignal, operationId: string): Promise<DocumentWriteResult> {
    const client = this.client(agentId);
    const documentId = await this.resolveDocumentId(client, document, signal);
    signal.throwIfAborted();
    const converted = await this.request('转换', () => client.docx.v1.document.convert({
      data: { content_type: 'markdown', content },
    }));
    signal.throwIfAborted();
    const rootIds = converted.data?.first_level_block_ids;
    const blocks = converted.data?.blocks;
    if (!rootIds?.length || !blocks?.length || blocks.some(block => !block.block_id)) {
      throw new Error('飞书未能将内容转换为文档块，未执行写入');
    }
    if (blocks.some(block => 'image' in block)) throw new Error('暂不支持写入 Markdown 图片，请改用图片链接');
    for (const block of blocks) {
      if (block.table) delete block.table.property.merge_info;
    }
    const chunks = chunkBlocks(blocks, rootIds);
    const metadata = await this.request('读取版本', () => client.docx.v1.document.get({ path: { document_id: documentId } }));
    let revision = metadata.data?.document?.revision_id;
    signal.throwIfAborted();

    let originalChildren = 0;
    if (mode === 'overwrite') {
      let pageToken: string | undefined;
      do {
        const page = await this.request('读取结构', () => client.docx.documentBlockChildren.get({
          path: { document_id: documentId, block_id: documentId },
          params: { page_size: 500, page_token: pageToken },
        }));
        originalChildren += page.data?.items?.length ?? 0;
        pageToken = page.data?.has_more ? page.data.page_token : undefined;
        signal.throwIfAborted();
      } while (pageToken);
    }

    const token = createHash('sha256').update(operationId).digest('hex').slice(0, 48);
    let insertIndex = mode === 'overwrite' ? originalChildren : undefined;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const created = await this.request('写入', () => client.docx.documentBlockDescendant.create({
        path: { document_id: documentId, block_id: documentId },
        params: { document_revision_id: revision, client_token: `${token}:${index}` },
        data: {
          children_id: chunk.rootIds,
          descendants: chunk.blocks,
          ...(insertIndex === undefined ? {} : { index: insertIndex }),
        },
      }));
      revision = created.data?.document_revision_id ?? revision;
      if (insertIndex !== undefined) insertIndex += chunk.rootIds.length;
      signal.throwIfAborted();
    }

    if (originalChildren > 0) {
      const deleted = await this.request('替换旧内容', () => client.docx.documentBlockChildren.batchDelete({
        path: { document_id: documentId, block_id: documentId },
        params: { document_revision_id: revision, client_token: `${token}:delete` },
        data: { start_index: 0, end_index: originalChildren },
      }));
      revision = deleted.data?.document_revision_id ?? revision;
    }
    signal.throwIfAborted();
    return { saved: true, document_id: documentId, mode, revision_id: revision ?? null, blocks: blocks.length };
  }
}
