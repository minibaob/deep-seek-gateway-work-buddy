import { runTask } from './runner.mjs';
import { newId, truncate } from './util.mjs';

export const TOOL_DEF = {
  type: 'function',
  function: {
    name: 'workbuddy_exec',
    description: `在用户本机的受控工作区里执行任务，返回结构化交付物（改了哪些文件、diff 行数统计、关键文件正文、可选的验证命令结果）。

必须遵守：
1. 每次派单都要给出 acceptance_criteria（2~5 条可逐条判定的检查项）。没有验收标准的请求会被网关拒收，因为审核无从下手。
2. 首次派单自己拟定一个稳定的 session_id，同一任务的返工必须原样复用它。返工必须带 review_feedback，写清楚上一轮哪一条标准没达标。
3. 同一任务最多 3 轮。超出会被拒绝并要求转人工，不要靠换 session_id 重开一轮来绕过。
4. 审核只认证据：artifacts[].preview 是实际文件内容，output 只是执行方自述。两者冲突时以 artifacts 为准；artifacts_total 大于 artifacts 长度时说明还有文件没回传。
5. 任务完成、失败或决定放弃时，向用户汇报：改了什么、证据是什么、遗留什么。`,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要做的事，自然语言，尽量具体。返工时写清这次只修哪几条问题。',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: '验收标准，逐条可判定，例如「hello.txt 内容恰好是 Hello」。执行方会逐条自检，你之后按同样的条目核对。',
        },
        session_id: {
          type: 'string',
          description: '任务会话标识。首次派单拟一个短字符串（如 s-01），同一任务的每次返工都原样复用。',
        },
        review_feedback: {
          type: 'string',
          description: '返工时必填：上一轮哪条验收标准没达标、差在哪、期望改成什么样。',
        },
        workspace: {
          type: 'string',
          description: '工作目录，必须落在网关白名单内。省略则用默认目录。',
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
      required: ['task', 'acceptance_criteria'],
    },
  },
};

async function callDeepSeek(cfg, payload) {
  const ds = cfg.deepseek;
  const apiKey = ds.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const err = new Error('未配置 DeepSeek API Key：请在 config.json 的 deepseek.apiKey 填写，或设置环境变量 DEEPSEEK_API_KEY');
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${ds.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`上游模型返回 ${res.status}: ${truncate(text, 800)}`);
    err.status = 502;
    throw err;
  }
  return JSON.parse(text);
}

function toolResultContent(record) {
  const payload = {
    ok: record.status === 'delivered',
    task_id: record.task_id,
    session_id: record.session_id,
    attempt: record.attempt,
    status: record.status,
    diff_stat: record.diff_stat,
    output: truncate(record.output || '', 4000),
    artifacts: (record.artifacts || []).map((a) => ({
      path: a.path,
      change: a.change,
      diff_stat: a.diff_stat,
      bytes: a.bytes,
      preview: a.preview ? truncate(a.preview, 2000) : undefined,
    })),
    artifacts_total: record.artifacts_total,
    verify: record.verify || undefined,
    // 失败且无 output 时，stderr 是唯一线索
    ...(record.stderr_tail ? { stderr_tail: truncate(record.stderr_tail, 1200) } : {}),
    next_action: record.next_action,
    ...(record.error?.code ? { error: { code: record.error.code } } : {}),
  };
  return truncate(JSON.stringify(payload), 24000);
}

export async function chatCompletion({ cfg, ledger, body }) {
  const ds = cfg.deepseek;
  const model = body.model || ds.model;
  const maxRounds = Math.max(1, Math.min(20, ds.maxToolRounds || 8));

  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const clientTools = (Array.isArray(body.tools) ? body.tools : []).filter(
    (t) => t?.function?.name !== TOOL_DEF.function.name,
  );
  const tools = [...clientTools, TOOL_DEF];
  const trace = [];

  for (let round = 0; round <= maxRounds; round++) {
    const upstream = await callDeepSeek(cfg, {
      model,
      messages,
      tools,
      tool_choice: body.tool_choice ?? 'auto',
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    });

    const choice = upstream.choices?.[0];
    if (!choice?.message) {
      const err = new Error('上游模型没有返回 message');
      err.status = 502;
      throw err;
    }

    const msg = choice.message;
    messages.push(msg);

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      return {
        id: newId('chatcmpl'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
        usage: upstream.usage,
        gateway_trace: trace,
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }

      if (name !== TOOL_DEF.function.name) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: `未知工具: ${name}，本网关只提供 workbuddy_exec` }),
        });
        continue;
      }

      try {
        const record = await runTask(cfg, ledger, {
          task: args.task,
          acceptance_criteria: args.acceptance_criteria,
          session_id: args.session_id,
          review_feedback: args.review_feedback,
          workspace: args.workspace,
          verify: args.verify,
        });
        trace.push({ task_id: record.task_id, status: record.status, diff_stat: record.diff_stat });
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultContent(record) });
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: err.message, body: err.body || null }),
        });
      }
    }
  }

  const err = new Error(`工具调用超过 ${maxRounds} 轮仍未收敛，已强制中止。`);
  err.status = 508;
  throw err;
}
