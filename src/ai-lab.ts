/*
 * AI超算 (owner, 2026-11-20): a private AI workbench inside WorkOS with three desks: mechanical / industrial design,
 * electrical design and software development. Only main admins see it (WORKOS_AI_LAB_USER_IDS narrows it to some of them). The page never names the AI provider; the server calls the model with the
 * ANTHROPIC_API_KEY already used for translation (AI_LAB_MODEL picks the model).
 *
 * A reply is generated in the background and written to the chat as it streams, so the page polls
 * GET /ai-lab/chats/:id and keeps working through reloads. Code the AI writes (a web page, an SVG drawing, a 3D model
 * page) opens from /ai-lab/previews/:id: its own response, sandboxed (no access to WorkOS, cookies or the API).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const aiLabSchema = `
CREATE TABLE IF NOT EXISTS ai_lab_chats(id text PRIMARY KEY, org_id text NOT NULL, owner_id text NOT NULL, desk text NOT NULL,
  title text NOT NULL DEFAULT '', messages jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ai_lab_chats_owner ON ai_lab_chats(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS ai_lab_files(id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, mime text NOT NULL, kind text NOT NULL,
  size integer NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ai_lab_files_owner ON ai_lab_files(owner_id, created_at);
CREATE TABLE IF NOT EXISTS ai_lab_previews(id text PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
`;

export const DESKS = ['mech', 'elec', 'soft'] as const;
type Desk = typeof DESKS[number];

const COMMON = `你是 OneLaser WorkOS 里的“AI超算”工程助手，为一家激光雕刻 / 切割设备公司的老板和工程团队工作。
- 用户用中文就用中文回答，用英文就用英文回答。回答要专业、具体、可以直接落地，给出数字、型号、尺寸、公式和理由，不说空话。
- 先用两三句话复述需求和关键假设；信息不够时先给出合理假设并继续完成，不要只提问。
- 结构清晰：用小标题、编号列表和表格（Markdown）。
- 需要可视化时，直接输出可运行的代码块，系统会自动渲染预览：
  - 二维图（工程图、三视图、原理图、接线图、流程图）：输出完整的 \`\`\`svg 代码块（带 viewBox、白色背景、清晰的尺寸标注和图例，文字用中文或英文都可以）。
  - 三维模型、交互演示或网页：输出一个完整的单文件 \`\`\`html 代码块（所有 CSS/JS 写在文件里；如需库，只能从 https://cdnjs.cloudflare.com 或 https://cdn.jsdelivr.net 加载固定版本，例如 three.js 用 https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js，鼠标拖动旋转用 https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js）。页面里不能请求任何接口或外部数据。
- 关于你自己：你是 WorkOS 的 AI超算助手。不要提及、猜测或讨论你背后使用的模型、厂商或公司名称；如果被问到，就说这是 WorkOS 接入的 AI 引擎，具体技术细节不对外说明，然后回到工作本身。不要声称自己是 OneLaser 自研的模型。
- 涉及安全（高压、激光、机械运动、承重）时，写明需要遵守的标准（如 UL、CE、IEC 60825、NFPA 70 / NEC）和需要专业工程师复核的地方。`;

const DESK_PROMPTS: Record<Desk, string> = {
  mech: `${COMMON}
你现在是“机械 / 工业设计”工位。擅长：结构设计、钣金与机加工件、导轨丝杆与传动选型、公差配合、材料与表面处理、强度 / 刚度 / 扭矩计算、DFM（可制造性）与成本估算、工业设计外观方案。
交付时尽量包括：设计方案说明、关键参数表、BOM（零件、材料、数量、工艺、估算单价）、核心计算过程、一张带尺寸的 SVG 三视图或结构示意图；需要立体效果时，用 three.js 做一个可拖动旋转的 HTML 三维模型；如果用户需要导入 CAD，再附上 OpenSCAD 参数化代码。`,
  elec: `${COMMON}
你现在是“电气设计”工位。擅长：电源与配电、电机与驱动（步进 / 伺服）、激光电源与安全联锁、传感器与限位、控制板（MCU / PLC）、线径与保护器件计算、EMC、UL / CE 合规。
交付时尽量包括：系统架构说明、器件选型表（型号、关键参数、数量、估算价格、备选型号）、功率 / 电流 / 线径 / 保险计算、一张清晰的 SVG 原理图或接线图（标注线号、颜色、端子），需要时附固件或 PLC 示例代码，并列出安全联锁和测试步骤。`,
  soft: `${COMMON}
你现在是“软件开发”工位。擅长：网站和落地页、管理后台、数据看板、小工具、自动化脚本、API 设计、数据库设计。
做网站或页面时，直接交付一个完整、美观、响应式的单文件 \`\`\`html（现代设计、真实感的示例文案、移动端可用），可以立即预览；其他程序给出完整可运行的代码、目录结构、运行步骤和测试方法。`,
};

const TITLE_MAX = 60, MSG_MAX = 20000, MAX_TURNS = 40;
/* Files the owner attaches (drawings, photos, PDFs, CAD text exports). Images and PDFs go to the model as they are; text-like
 * files (DXF, STEP, G-code, CSV, code…) go in as text. Sizes stay inside what the model accepts. */
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = /\.(txt|csv|tsv|md|json|xml|svg|dxf|step|stp|iges|igs|scad|gcode|nc|ngc|py|js|ts|html|css|c|cpp|h|ino|yaml|yml|ini|log)$/i;
const LIMIT = { image: 5 * 1024 * 1024, pdf: 25 * 1024 * 1024, text: 2 * 1024 * 1024 };
const kindOf = (name: string, mime: string) => IMAGE_MIME.includes(mime) ? 'image' : mime === 'application/pdf' || /\.pdf$/i.test(name) ? 'pdf' : (mime.startsWith('text/') || TEXT_EXT.test(name)) ? 'text' : '';
type FileRef = { id: string; name: string; mime: string; kind: string; size: number };
const FILES_PER_MSG = 10, FILE_TURNS = 4; // files ride along on the latest few user turns; older ones are named only
type Msg = { role: 'user' | 'assistant'; text: string; at: string; files?: FileRef[]; status?: 'streaming' | 'done' | 'error' | 'stopped'; error?: string };
type Client = Pick<Anthropic, 'messages'>;
export type AiLabOptions = { userIds: string[]; isExecutive: (u: User) => boolean; client?: Client; model?: string; now?: () => number };

/** True when this account may see AI超算. */
export const aiLabAllowed = (u: User | null | undefined, o: Pick<AiLabOptions, 'userIds' | 'isExecutive'>) => !!u && o.userIds.includes(u.id) && o.isExecutive(u);

export async function registerAiLabRoutes(app: FastifyInstance, db: Database, o: AiLabOptions) {
  const now = o.now || Date.now;
  const model = o.model || 'claude-opus-5-5';
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  // Anyone else gets a plain 404, so the feature does not show up for them at all.
  const owner = (req: FastifyRequest) => { const u = actorOf(req); if (!aiLabAllowed(u, o)) deny(404, 'NOT_FOUND', 'Not found', '未找到。'); return u; };
  const running = new Map<string, AbortController>();
  const chatOf = async (u: User, id: string) => {
    const r = (await db.query('SELECT * FROM ai_lab_chats WHERE id=$1 AND owner_id=$2', [id, u.id])).rows[0];
    if (!r) deny(404, 'AI_LAB_CHAT_NOT_FOUND', 'Conversation not found', '找不到这个对话。');
    return r;
  };
  const view = (r: any) => ({ id: r.id, desk: r.desk, title: r.title, messages: r.messages || [], busy: running.has(r.id), createdAt: r.created_at, updatedAt: r.updated_at });

  app.get('/ai-lab/chats', async req => {
    const u = owner(req);
    const rows = (await db.query('SELECT id,desk,title,created_at,updated_at FROM ai_lab_chats WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 200', [u.id])).rows;
    return { ready: !!o.client, chats: rows.map((r: any) => ({ id: r.id, desk: r.desk, title: r.title, busy: running.has(r.id), updatedAt: r.updated_at })) };
  });
  app.get<{ Params: { id: string } }>('/ai-lab/chats/:id', async req => view(await chatOf(owner(req), req.params.id)));
  app.post('/ai-lab/chats', async (req, reply) => {
    const u = owner(req), v = z.object({ desk: z.enum(DESKS) }).strict().parse(req.body);
    const id = randomUUID();
    await db.query('INSERT INTO ai_lab_chats(id,org_id,owner_id,desk) VALUES($1,$2,$3,$4)', [id, u.org_id, u.id, v.desk]);
    reply.code(201); return view(await chatOf(u, id));
  });
  app.delete<{ Params: { id: string } }>('/ai-lab/chats/:id', async req => {
    const u = owner(req); await chatOf(u, req.params.id);
    running.get(req.params.id)?.abort();
    await db.query('DELETE FROM ai_lab_chats WHERE id=$1 AND owner_id=$2', [req.params.id, u.id]); return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/ai-lab/chats/:id/stop', async req => {
    const u = owner(req); await chatOf(u, req.params.id); running.get(req.params.id)?.abort(); return { ok: true };
  });

  // Send a message: the reply is generated in the background and saved as it streams.
  app.post<{ Params: { id: string } }>('/ai-lab/chats/:id/messages', async (req, reply) => {
    const u = owner(req), v = z.object({ text: z.string().trim().max(MSG_MAX).default(''), fileIds: z.array(z.string().max(100)).max(FILES_PER_MSG).default([]) }).strict()
      .refine(x => x.text || x.fileIds.length, { message: 'Write a message or attach a file' }).parse(req.body);
    const files: FileRef[] = v.fileIds.length ? (await db.query('SELECT id,name,mime,kind,size FROM ai_lab_files WHERE owner_id=$1 AND id = ANY($2::text[])', [u.id, v.fileIds])).rows : [];
    if (files.length !== new Set(v.fileIds).size) deny(400, 'AI_LAB_FILE_NOT_FOUND', 'An attached file was not found', '有附件找不到了，请重新上传。');
    if (!o.client) deny(503, 'AI_LAB_NOT_CONFIGURED', 'The AI engine is not connected', 'AI 引擎还没有接入。');
    const chat = await chatOf(u, req.params.id);
    if (running.has(chat.id)) deny(409, 'AI_LAB_BUSY', 'Still working on the previous message', '上一条还在生成，请稍等或先停止。');
    const at = new Date(now()).toISOString();
    const history: Msg[] = (chat.messages || []).filter((m: Msg) => (m.text || m.files?.length) && m.status !== 'error').slice(-MAX_TURNS);
    const messages: Msg[] = [...(chat.messages || []), { role: 'user', text: v.text, at, ...(files.length ? { files } : {}) }, { role: 'assistant', text: '', at, status: 'streaming' }];
    const title = chat.title || (v.text || files.map(f => f.name).join(', ')).replace(/\s+/g, ' ').slice(0, TITLE_MAX);
    await db.query('UPDATE ai_lab_chats SET messages=$3::jsonb, title=$4, updated_at=now() WHERE id=$1 AND owner_id=$2', [chat.id, u.id, JSON.stringify(messages), title]);
    const ctrl = new AbortController(); running.set(chat.id, ctrl);
    void generate(u.id, chat.id, chat.desk as Desk, [...history, { role: 'user', text: v.text, at, ...(files.length ? { files } : {}) }], ctrl);
    reply.code(202); return view(await chatOf(u, chat.id));
  });

  // The model input: files on the latest FILE_TURNS user turns go in whole (image / PDF document / text); older ones by name.
  async function contentOf(ownerId: string, turns: Msg[]) {
    const withFiles = turns.map((m, i) => m.role === 'user' && m.files?.length ? i : -1).filter(i => i >= 0).slice(-FILE_TURNS);
    const ids = withFiles.flatMap(i => turns[i].files!.map(f => f.id));
    const rows = new Map(ids.length ? ((await db.query('SELECT id,name,mime,kind,data FROM ai_lab_files WHERE owner_id=$1 AND id = ANY($2::text[])', [ownerId, ids])).rows as any[]).map(r => [r.id, r]) : []);
    return turns.map((m, i) => {
      if (m.role !== 'user' || !m.files?.length) return { role: m.role, content: m.text || '…' };
      const blocks: any[] = [];
      for (const f of m.files) {
        const r = withFiles.includes(i) ? rows.get(f.id) : null;
        if (!r) { blocks.push({ type: 'text', text: `[附件：${f.name}（较早上传，内容未重新附上）]` }); continue; }
        const b64 = Buffer.from(r.data).toString('base64');
        if (r.kind === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: r.mime, data: b64 } });
        else if (r.kind === 'pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }, title: r.name });
        else blocks.push({ type: 'text', text: `附件 ${r.name}：\n\n${Buffer.from(r.data).toString('utf8')}` });
      }
      blocks.push({ type: 'text', text: m.text || '请先看附件，说明你看到了什么，再给出专业意见。' });
      return { role: m.role, content: blocks };
    });
  }

  async function generate(ownerId: string, chatId: string, desk: Desk, turns: Msg[], ctrl: AbortController) {
    let text = '', lastSave = 0, status: Msg['status'] = 'done', error = '';
    const save = async (final: boolean) => {
      const r = (await db.query('SELECT messages FROM ai_lab_chats WHERE id=$1 AND owner_id=$2', [chatId, ownerId])).rows[0];
      if (!r) return;
      const msgs: Msg[] = r.messages || [], last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return;
      last.text = text; last.status = final ? status : 'streaming'; if (final && error) last.error = error;
      await db.query('UPDATE ai_lab_chats SET messages=$3::jsonb, updated_at=now() WHERE id=$1 AND owner_id=$2', [chatId, ownerId, JSON.stringify(msgs)]);
    };
    try {
      const stream = o.client!.messages.stream({
        model, max_tokens: 32000, system: DESK_PROMPTS[desk], thinking: { type: 'adaptive' } as any,
        messages: await contentOf(ownerId, turns),
      } as any, { signal: ctrl.signal });
      for await (const ev of stream as any) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          if (Date.now() - lastSave > 700) { lastSave = Date.now(); await save(false); }
        }
      }
    } catch (err: any) {
      if (ctrl.signal.aborted) status = 'stopped';
      else { status = 'error'; error = String(err?.status ? `${err.status}` : err?.message || 'failed').slice(0, 200); }
    } finally {
      running.delete(chatId);
      await save(true).catch(() => undefined);
    }
  }

  // Attach a drawing, photo, PDF or CAD text export (sent as base64, like the other modules' uploads).
  app.post('/ai-lab/files', { bodyLimit: Math.ceil(LIMIT.pdf * 4 / 3) + 4096 }, async (req, reply) => {
    const u = owner(req), v = z.object({ name: z.string().trim().min(1).max(200), mime: z.string().max(120).default(''), dataBase64: z.string().min(1) }).strict().parse(req.body);
    const kind = kindOf(v.name, v.mime);
    if (!kind) deny(400, 'AI_LAB_FILE_TYPE', 'Use an image (PNG, JPEG, WebP, GIF), a PDF or a text file such as DXF, STEP or CSV', '请上传图片（PNG、JPEG、WebP、GIF）、PDF，或 DXF、STEP、CSV 等文本文件。');
    const data = Buffer.from(v.dataBase64, 'base64');
    if (!data.length) deny(400, 'AI_LAB_FILE_EMPTY', 'The file is empty', '文件是空的。');
    if (data.length > LIMIT[kind as keyof typeof LIMIT]) deny(400, 'AI_LAB_FILE_TOO_BIG', 'The file is too large (images 5 MB, PDF 25 MB, text 2 MB)', '文件太大（图片 5 MB、PDF 25 MB、文本 2 MB 以内）。');
    const id = randomUUID(), mime = kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain' : v.mime;
    await db.query('INSERT INTO ai_lab_files(id,owner_id,name,mime,kind,size,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, u.id, v.name, mime, kind, data.length, data]);
    await db.query("DELETE FROM ai_lab_files WHERE owner_id=$1 AND created_at < now() - interval '180 days'", [u.id]);
    reply.code(201); return { id, name: v.name, mime, kind, size: data.length };
  });
  app.get<{ Params: { id: string } }>('/ai-lab/files/:id', async (req, reply) => {
    const u = owner(req);
    const r = (await db.query('SELECT name,mime,data FROM ai_lab_files WHERE id=$1 AND owner_id=$2', [req.params.id, u.id])).rows[0];
    if (!r) deny(404, 'NOT_FOUND', 'Not found', '未找到。');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=3600');
    reply.type(r.mime === 'text/plain' ? 'text/plain; charset=utf-8' : r.mime); return Buffer.from(r.data);
  });

  // A web page / drawing / 3D model the AI wrote, stored so it can open in its own sandboxed response.
  app.post('/ai-lab/previews', async (req, reply) => {
    const u = owner(req), v = z.object({ kind: z.enum(['html', 'svg']), body: z.string().min(1).max(2_000_000) }).strict().parse(req.body);
    const id = randomUUID();
    await db.query('INSERT INTO ai_lab_previews(id,owner_id,kind,body) VALUES($1,$2,$3,$4)', [id, u.id, v.kind, v.body]);
    await db.query("DELETE FROM ai_lab_previews WHERE owner_id=$1 AND created_at < now() - interval '30 days'", [u.id]);
    reply.code(201); return { id, url: `/api/ai-lab/previews/${id}` };
  });
  app.get<{ Params: { id: string } }>('/ai-lab/previews/:id', async (req, reply) => {
    const u = owner(req);
    const r = (await db.query('SELECT kind, body FROM ai_lab_previews WHERE id=$1 AND owner_id=$2', [req.params.id, u.id])).rows[0];
    if (!r) deny(404, 'NOT_FOUND', 'Not found', '未找到。');
    const body = r.kind === 'svg' ? `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}body{box-sizing:border-box;min-height:100vh;padding:12px;display:flex;align-items:center;justify-content:center}svg{display:block;width:100%;max-width:1400px;height:auto;max-height:calc(100vh - 24px)}</style>${r.body}` : r.body;
    // sandbox: the page runs as an opaque origin, so it cannot read WorkOS cookies or call the API.
    reply.header('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; img-src data: blob: https:; media-src data: blob: https:; connect-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; frame-ancestors 'self'");
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8'); return body;
  });
}
