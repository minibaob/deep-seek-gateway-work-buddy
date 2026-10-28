import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { loadConfig, resolveWorkspace, CONFIG_PATH, GATEWAY_DIR } from './config.mjs';
import { Ledger } from './ledger.mjs';
import { runTask } from './runner.mjs';
import { chatCompletion } from './openai.mjs';
import { sendJson, readBody, isInside, relPath, Semaphore, log, newId } from './util.mjs';

const cfg = loadConfig();
const ledger = new Ledger(cfg.stateDir);
const sem = new Semaphore(cfg.limits.maxConcurrent);

function tokenOk(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const alt = req.headers['x-gateway-token'] || '';
  const provided = String(bearer || alt);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(cfg.token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function fail(res, err) {
  const status = err.status || 500;
  sendJson(res, status, {
    ok: false,
    error: { code: err.code || 'ERROR', message: err.message },
    ...(err.nextAction ? { next_action: err.nextAction } : {}),
    ...(err.hint ? { hint: err.hint } : {}),
    ...(err.body || {}),
  });
}

/** 允许客户端把会话标识放在 header 里，省得每次塞 body */
function withHeaderSession(req, body) {
  if (body?.session_id) return body;
  const fromHeader = req.headers['x-session-id'] || req.headers['x-conversation-id'];
  if (!fromHeader) return body;
  return { ...body, session_id: String(fromHeader) };
}

async function handleTask(body) {
  if (sem.waiting >= cfg.limits.maxQueue) {
    const err = new Error(`队列已满（等待 ${sem.waiting} 个任务），请稍后重试`);
    err.status = 429;
    throw err;
  }
  await sem.acquire();
  try {
    return await runTask(cfg, ledger, body);
  } finally {
    sem.release();
  }
}

function serveRaw(req, res, record, url) {
  const rel = url.searchParams.get('path');
  if (!rel) return sendJson(res, 400, { ok: false, error: { message: '缺少 path 参数' } });
  const abs = path.resolve(record.workspace, rel);
  if (!isInside(record.workspace, abs)) {
    return sendJson(res, 403, { ok: false, error: { message: 'path 越界' } });
  }
  if (!fs.existsSync(abs)) return sendJson(res, 404, { ok: false, error: { message: '文件不存在' } });
  const st = fs.statSync(abs);
  if (!st.isFile()) return sendJson(res, 400, { ok: false, error: { message: '不是文件' } });
  if (st.size > cfg.limits.maxFileReadBytes) {
    return sendJson(res, 413, {
      ok: false,
      error: { message: `文件 ${st.size} 字节，超过上限 ${cfg.limits.maxFileReadBytes}` },
    });
  }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) {
    return sendJson(res, 415, { ok: false, error: { message: '二进制文件，请直接读磁盘' } });
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(buf),
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
    return sendJson(res, 200, {
      ok: true,
      cli_found: Boolean(cfg.executor.cliBin),
      cli_bin: cfg.executor.cliBin,
      workspaces: cfg.workspaces,
      active: sem.busy,
      queued: sem.waiting,
      max_attempts: cfg.limits.maxAttempts,
    });
  }

  if (!tokenOk(req)) {
    return sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '缺少或错误的 token，用 Authorization: Bearer <token> 传入' },
      hint: `token 见 ${CONFIG_PATH}`,
    });
  }

  try {
    if (req.method === 'GET' && p === '/') {
      return sendJson(res, 200, {
        name: 'dsh-workbuddy-gateway',
        endpoints: {
          'POST /v1/tasks': '派单：执行一个任务，返回结构化交付物',
          'GET /v1/tasks': '查账：?session_id= &limit=',
          'GET /v1/tasks/{id}': '查单条任务',
          'GET /v1/tasks/{id}/raw?path=': '取交付文件全文',
          'POST /v1/chat/completions': 'OpenAI 兼容面，自动注入 workbuddy_exec 工具',
          'GET /healthz': '健康检查（免 token）',
        },
        config: CONFIG_PATH,
      });
    }

    if (req.method === 'POST' && p === '/v1/tasks') {
      const body = await readBody(req);
      const record = await handleTask(withHeaderSession(req, body));
      return sendJson(res, 200, record);
    }

    if (req.method === 'GET' && p === '/v1/tasks') {
      const rows = ledger.list({
        session_id: url.searchParams.get('session_id') || undefined,
        workspace: url.searchParams.get('workspace') || undefined,
        limit: Number(url.searchParams.get('limit') || 20),
      });
      return sendJson(res, 200, {
        ok: true,
        count: rows.length,
        tasks: rows.map((r) => ({
          task_id: r.task_id,
          session_id: r.session_id,
          attempt: r.attempt,
          status: r.status,
          diff_stat: r.diff_stat,
          created_at: r.created_at,
          duration_ms: r.duration_ms,
        })),
      });
    }

    const mTask = /^\/v1\/tasks\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && mTask) {
      const record = ledger.get(decodeURIComponent(mTask[1]));
      if (!record) return sendJson(res, 404, { ok: false, error: { message: '任务不存在' } });
      return sendJson(res, 200, record);
    }

    const mRaw = /^\/v1\/tasks\/([^/]+)\/raw$/.exec(p);
    if (req.method === 'GET' && mRaw) {
      const record = ledger.get(decodeURIComponent(mRaw[1]));
      if (!record) return sendJson(res, 404, { ok: false, error: { message: '任务不存在' } });
      return serveRaw(req, res, record, url);
    }

    if (req.method === 'POST' && p === '/v1/chat/completions') {
      const body = await readBody(req);
      const result = await chatCompletion({ cfg, ledger, body: withHeaderSession(req, body) });

      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const text = result.choices?.[0]?.message?.content || '';
        res.write(`data: ${JSON.stringify({
          id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { ok: false, error: { message: `没有这个路由: ${req.method} ${p}` } });
  } catch (err) {
    if (!err.status) log(`内部错误: ${err.stack || err.message}`);
    return fail(res, err);
  }
});

function doctor() {
  const lines = [];
  lines.push('网关配置自检');
  lines.push(`  配置文件      ${CONFIG_PATH}`);
  lines.push(`  token         ${cfg.token.slice(0, 6)}…（完整值见配置文件）`);
  lines.push(`  监听          http://${cfg.host}:${cfg.port}`);
  lines.push(`  CLI 路径      ${cfg.executor.cliBin || '未找到 — 请手动填写 executor.cliBin'}`);
  lines.push(`  工作区白名单  ${cfg.workspaces.join(', ')}`);
  for (const ws of cfg.workspaces) {
    lines.push(`    - ${ws} ${fs.existsSync(ws) ? '存在' : '不存在（启动时会自动创建）'}`);
  }
  lines.push(`  最大返工轮次  ${cfg.limits.maxAttempts}`);
  lines.push(`  并发上限      ${cfg.limits.maxConcurrent}`);
  const keyReady = Boolean(cfg.executor.apiKey);
  lines.push(`  执行鉴权      ${keyReady ? `自带密钥 ${String(cfg.executor.apiKey).slice(0, 6)}…（${cfg.executor.baseUrl}）` : '未配置密钥 → 会退回账号登录，而本机构建登录不了'}`);
  lines.push(`  权限模式      ${cfg.executor.permissionMode}`);
  lines.push('');
  lines.push('下一步：');
  if (!keyReady) lines.push('  1) node tools/set-key.mjs sk-xxxx   写入 API Key 并验证');
  lines.push(`  ${keyReady ? '1' : '2'}) node src/server.mjs  启动网关（监听 ${cfg.host}:${cfg.port}）`);
  lines.push(`  ${keyReady ? '2' : '3'}) node tools/mcp-test.mjs  跑 MCP 冒烟（含真实派单）`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv.includes('--doctor')) {
  doctor();
  process.exit(0);
}

if (!cfg.executor.cliBin) {
  log('警告：没有找到 codebuddy CLI，任务将直接失败。可用 --doctor 查看自检信息。');
}

server.listen(cfg.port, cfg.host, () => {
  log(`gateway 已启动 http://${cfg.host}:${cfg.port}`);
  log(`配置: ${CONFIG_PATH}`);
  log(`工作区: ${cfg.workspaces.join(', ')}`);
  log(`token: ${cfg.token}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到退出信号，关闭网关');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
