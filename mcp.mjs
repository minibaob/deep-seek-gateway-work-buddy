#!/usr/bin/env node
/**
 * WorkBuddy Gateway —— MCP stdio 服务端
 *
 * 由 DSH 以子进程方式拉起（见 dsh-cordis.patch.yml）。stdout 是协议通道，
 * 任何调试输出必须走 stderr，否则会直接破坏 JSON-RPC 帧。
 *
 * 对外暴露两个工具：
 *   exec     派单给本机 WorkBuddy，回传结构化交付物
 *   history  查账本：某个 session 跑过几轮、每轮什么结论
 */
import { createInterface } from 'node:readline';
import { loadConfig } from './src/config.mjs';
import { Ledger } from './src/ledger.mjs';
import { runTask } from './src/runner.mjs';

const SERVER_NAME = 'workbuddy';
const SERVER_VERSION = '1.0.0';

/** 会被 DSH 作为字面文本放进系统提示词 —— 这是在没有系统提示词编辑器时的纪律入口 */
const INSTRUCTIONS = `你通过 workbuddy 这组工具使用用户本机的 WorkBuddy 执行器。它是执行方，你是审核方。

【作用域】本工具只允许在 D:\\workbuddy 工作区使用。当且仅当用户当前位于 D:\\workbuddy 工作区（而不是 my_agent、obsidian-ai 等其它工作区）时，才调用 exec/history。用户在其它工作区提出任务时，不要调用本工具，直接用你自己的能力回答即可。

派单纪律：
1. 每次调用 exec 必须给出 acceptance_criteria，2~5 条、逐条可判定。写「count.txt 内容恰好是 1」，不要写「完成得不错」。
2. 首次派单自己拟一个短的 session_id（如 s-01），之后这个任务的所有返工原样复用它。换了 session_id 就等于开新任务，轮次上限会失效——网关会拒绝这种绕过。
3. 返工必须带 review_feedback，写清上一轮哪一条标准没达标、差在哪、期望改成什么样。不带这段，执行方只会把同样的活再干一遍。
4. 审核只认证据。artifacts[].preview 是工作区里的真实文件内容，output 只是执行方自述。两者冲突时以 artifacts 为准。artifacts_total 大于 artifacts 长度，说明还有文件没回传，逐条核对前先注意这一点。
5. 同一任务最多 3 轮。到上限会被拒绝并返回 escalate，此时停止重派，把「卡在哪条标准、试过什么、为什么没成」整理给用户决定。
6. 不确定执行结果时，先调用 history 查这个 session 的历次记录，不要凭记忆编造上一轮的结论。
7. 任务交付、失败或升级时，向用户汇报：改了什么、证据是什么、遗留什么。`;

const TOOLS = [
  {
    name: 'exec',
    description:
      '在用户本机的受控工作区里派一个任务给 WorkBuddy 执行，返回结构化交付物：文件清单、diff 行数统计、关键文件正文、可选的验证命令结果。' +
      '仅在 D:\\workbuddy 工作区可用。任务失败或被退回时，带上 review_feedback 和同一个 session_id 再调一次即为返工。',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要做的事，自然语言，尽量具体。返工时写清这次只修哪几条问题。',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: '验收标准，逐条可判定。省略会被网关拒收（422），因为审核无从下手。',
        },
        session_id: {
          type: 'string',
          description: '任务会话标识。首次派单拟一个短字符串，同一任务的每次返工都原样复用。',
        },
        review_feedback: {
          type: 'string',
          description: '返工时必填：上一轮哪条验收标准没达标、差在哪、期望改成什么样。',
        },
        workspace: {
          type: 'string',
          description: '工作目录，必填。只允许 D:\\workbuddy 工作区；本工具只在 D:\\workbuddy 工作区生效。',
        },
        verify: {
          type: 'object',
          description: '可选：执行完自动跑一条校验命令，把退出码一并返回，作为客观证据。',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'number' },
          },
          required: ['command'],
        },
      },
      required: ['task', 'acceptance_criteria', 'workspace'],
    },
  },
  {
    name: 'history',
    description:
      '查账本：某个 session 或 task 的历次执行记录（轮次、状态、diff 统计、退回原因、交付摘要）。上下文丢失或不确定上一轮结论时用它，不要凭记忆猜。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '按会话查全部轮次' },
        task_id: { type: 'string', description: '按单次任务查详情' },
        limit: { type: 'number', description: '最多返回几条，默认 10' },
      },
    },
  },
];

function log(...args) {
  // stdout 是协议通道，只能写 stderr
  process.stderr.write(`[workbuddy-gateway] ${args.join(' ')}\n`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError: Boolean(isError) };
}

/** 交付物裁剪：给审核方看的是证据，不是全文倾倒 */
function shapeRecord(record, limits) {
  const preview = Math.min(2000, limits?.previewChars || 2000);
  const payload = {
    ok: record.status === 'delivered',
    task_id: record.task_id,
    session_id: record.session_id,
    attempt: record.attempt,
    status: record.status,
    diff_stat: record.diff_stat,
    output: String(record.output || '').slice(0, 4000),
    artifacts: (record.artifacts || []).map((a) => ({
      path: a.path,
      change: a.change,
      diff_stat: a.diff_stat,
      bytes: a.bytes,
      preview: a.preview ? String(a.preview).slice(0, preview) : undefined,
    })),
    artifacts_total: record.artifacts_total,
    artifacts_truncated: record.artifacts_truncated || undefined,
    verify: record.verify || undefined,
    duration_ms: record.duration_ms,
    next_action: record.next_action,
    // 空交付（EMPTY_RESULT）这类「退出码正常但没干活」的情况，靠这个码让 DSH 分支
    ...(record.error?.code ? { error: { code: record.error.code } } : {}),
    // 执行失败却没有 output 时，stderr 是唯一线索，不能吞掉
    ...(record.stderr_tail ? { stderr_tail: String(record.stderr_tail).slice(-1200) } : {}),
    ...(record.session_warning ? { session_warning: record.session_warning } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

function shapeError(err) {
  return JSON.stringify(
    {
      ok: false,
      error: {
        code: err.code || 'ERROR',
        message: err.message,
        ...(err.status ? { status: err.status } : {}),
      },
      ...(err.nextAction ? { next_action: err.nextAction } : {}),
      ...(err.body || {}),
    },
    null,
    2,
  );
}

async function main() {
  const cfg = loadConfig();
  const ledger = new Ledger(cfg.stateDir);

  // 串行化：WorkBuddy CLI 每次要抢端口和 CPU，并发派单只会互相拖死
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const handlers = {
    async exec(args) {
      return serial(async () => {
        const started = Date.now();
        try {
          const record = await runTask(cfg, ledger, {
            task: args?.task,
            acceptance_criteria: args?.acceptance_criteria,
            session_id: args?.session_id,
            review_feedback: args?.review_feedback,
            workspace: args?.workspace,
            verify: args?.verify,
          });
          log(`exec ok task=${record.task_id} attempt=${record.attempt} ${record.status} ${Date.now() - started}ms`);
          return textResult(shapeRecord(record, cfg.limits));
        } catch (err) {
          log(`exec fail code=${err.code || 'ERROR'} ${err.message}`);
          // 明确失败：模型不能看到虚假的成功
          return textResult(shapeError(err), true);
        }
      });
    },

    async history(args) {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
      if (args?.task_id) {
        const rec = ledger.get(String(args.task_id));
        if (!rec) return textResult(JSON.stringify({ ok: false, error: '没有这条记录' }, null, 2), true);
        return textResult(shapeRecord(rec, cfg.limits));
      }
      const rows = ledger.list({ session_id: args?.session_id, limit });
      const brief = rows.map((r) => ({
        task_id: r.task_id,
        attempt: r.attempt,
        status: r.status,
        diff_stat: r.diff_stat,
        review_feedback: r.review_feedback || null,
        output_head: String(r.output || '').slice(0, 300),
        created_at: r.created_at,
      }));
      return textResult(JSON.stringify({ ok: true, count: brief.length, records: brief }, null, 2));
    },
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log('无法解析的输入帧，已忽略');
      return;
    }

    // 通知类消息没有 id，不需要回包
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      switch (msg.method) {
        case 'initialize': {
          // 回显客户端请求的协议版本，SDK 会自行降级到它支持的版本
          const requested = msg.params?.protocolVersion || '2025-06-18';
          reply(msg.id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          });
          log(`initialize 完成，协议 ${requested}`);
          return;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'initialized':
          return;
        case 'ping':
          if (!isNotification) reply(msg.id, {});
          return;
        case 'tools/list':
          reply(msg.id, { tools: TOOLS });
          return;
        case 'tools/call': {
          const name = msg.params?.name;
          const args = msg.params?.arguments || {};
          const fn = handlers[name];
          if (!fn) {
            replyError(msg.id, -32602, `未知工具: ${name}。可用: exec, history`);
            return;
          }
          const result = await fn(args);
          reply(msg.id, result);
          return;
        }
        case 'resources/list':
          reply(msg.id, { resources: [] });
          return;
        case 'prompts/list':
          reply(msg.id, { prompts: [] });
          return;
        case 'logging/setLevel':
          if (!isNotification) reply(msg.id, {});
          return;
        default:
          if (!isNotification) replyError(msg.id, -32601, `不支持的方法: ${msg.method}`);
      }
    } catch (err) {
      log(`处理 ${msg.method} 出错: ${err.message}`);
      if (!isNotification) replyError(msg.id, -32603, err.message);
    }
  });

  rl.on('close', async () => {
    log('stdin 关闭，等待在途任务收尾');
    try {
      // 上游断开时不能立刻退出，否则正在跑的派单会被掐断、账本也写不进去
      await Promise.race([chain, new Promise((r) => setTimeout(r, 30000))]);
    } catch {
      /* 在途任务自身报错不影响退出 */
    }
    log('退出');
    process.exit(0);
  });

  log(`已就绪：serverName=${SERVER_NAME}，工作区 ${cfg.workspaces.join(', ')}`);
  if (!cfg.executor.cliBin) log('警告：未找到 codebuddy CLI，派单会直接失败');
}

main().catch((err) => {
  log(`启动失败: ${err.stack || err.message}`);
  process.exit(1);
});
