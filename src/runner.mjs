import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { snapshot, diffSnapshots, collectArtifacts } from './artifacts.mjs';
import { buildPrompt, buildArgs, getFreePort, runCli, parseResult, assertNoAuthError, CliError } from './executor.mjs';
import { newId, nowIso } from './util.mjs';
import { resolveWorkspace } from './config.mjs';

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ exit_code: -1, output: err.message });
    }
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < 20000) out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (out.length < 20000) out += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exit_code: -1, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.length > 4000 ? `…${out.slice(-4000)}` : out;
      resolve({ exit_code: code ?? -1, output: tail });
    });
  });
}

/**
 * 会话键不能依赖客户端自觉。优先级：
 * 显式 session_id > 上游会话 id > 自定义 key > 任务文本指纹
 * 最后一种保证「同一段任务反复派」仍然落在同一会话里，轮次上限才有意义。
 */
function sessionKey(body, fingerprint) {
  if (body.session_id) return { id: String(body.session_id), source: 'session_id' };
  if (body.conversation_id) return { id: `conv-${body.conversation_id}`, source: 'conversation_id' };
  if (body.thread_id) return { id: `thr-${body.thread_id}`, source: 'thread_id' };
  if (body.task_key) return { id: `key-${body.task_key}`, source: 'task_key' };
  return { id: `auto-${fingerprint}`, source: 'task_text_hash' };
}

function fingerprintOf(task) {
  const text = String(task || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function normalizeCriteria(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
}

export async function runTask(cfg, ledger, body) {
  if (!body || typeof body.task !== 'string' || !body.task.trim()) {
    const err = new Error('缺少 task 字段');
    err.status = 400;
    err.code = 'TASK_REQUIRED';
    err.nextAction = '请求体必须包含 task（自然语言任务描述）。补上后重新发起，其他字段保持不变。';
    throw err;
  }
  if (!cfg.executor.cliBin) {
    const err = new Error('未找到 codebuddy CLI');
    err.status = 503;
    err.code = 'CLI_NOT_FOUND';
    err.nextAction = '这是环境问题，不是任务问题。请告知用户：网关配置里 executor.cliBin 没有指向有效路径，需要人工修配置。';
    throw err;
  }

  const criteria = normalizeCriteria(body.acceptance_criteria);
  if (cfg.limits.requireAcceptanceCriteria && criteria.length === 0) {
    const err = new Error('缺少 acceptance_criteria');
    err.status = 422;
    err.code = 'ACCEPTANCE_CRITERIA_REQUIRED';
    err.nextAction =
      'acceptance_criteria 是审核的唯一依据，不能省略。把任务拆成 2~5 条可逐条判定的检查项，' +
      '例如「hello.txt 的内容恰好是 Hello」而不是「完成得不错」。' +
      '补全后重新发起同一请求，session_id 保持不变。';
    throw err;
  }

  const workspace = resolveWorkspace(cfg, body.workspace);
  const fingerprint = fingerprintOf(body.task);
  const session = sessionKey(body, fingerprint);
  const sessionId = session.id;

  // attempt 由服务端唯一裁定，客户端传什么都不算数
  const used = ledger.attemptsFor(sessionId);
  const attempt = used + 1;
  const clientAttempt = Number.isInteger(body.attempt) ? body.attempt : null;

  // 防绕过：同一段任务文本换个 session_id 重开，总量也会被卡住
  const hardCap = cfg.limits.maxAttempts * 2;
  const sameTaskRuns = ledger.countBy((r) => r.task_fingerprint === fingerprint);
  if (sameTaskRuns >= hardCap) {
    const err = new Error(
      `同一段任务描述已经执行过 ${sameTaskRuns} 次（跨会话累计），拒绝再跑。`,
    );
    err.status = 409;
    err.code = 'TASK_REPEAT_LIMIT';
    err.nextAction =
      '这条任务已经反复跑了多轮仍没收敛。停止重派，把问题原样交给用户：说明卡在哪一条标准、试过什么、为什么没成。' +
      '如果确实需要重来，必须改写任务描述（换方案或缩小范围），而不是重发同一段话。';
    err.body = { status: 'escalate', reason: 'task_repeat_limit', task_fingerprint: fingerprint, runs: sameTaskRuns };
    throw err;
  }

  if (attempt > cfg.limits.maxAttempts) {
    const err = new Error(
      `该会话已执行 ${used} 轮，达到上限 ${cfg.limits.maxAttempts} 轮，拒绝继续自动返工。`,
    );
    err.status = 409;
    err.code = 'MAX_ATTEMPTS_EXCEEDED';
    err.nextAction =
      '停止自动返工。把最后一份 artifacts 和历次退回原因整理给用户，让用户决定：换方案、缩小范围，还是人工接手。' +
      '不要再用新的 session_id 重开一轮来绕过限制。';
    err.body = {
      status: 'escalate',
      reason: 'max_attempts_exceeded',
      session_id: sessionId,
      attempts_used: used,
      max_attempts: cfg.limits.maxAttempts,
    };
    throw err;
  }

  const prev = ledger.list({ session_id: sessionId, limit: 1 })[0] || null;
  const previousOutput = prev?.output || null;

  const taskId = newId('t');
  const startedAt = nowIso();
  const before = snapshot(workspace, cfg.artifacts);

  const port = await getFreePort();
  const prompt = buildPrompt({
    task: body.task,
    criteria,
    feedback: body.review_feedback,
    previousOutput,
    attempt,
  });
  const args = buildArgs(cfg, { prompt, port });

  let record = {
    task_id: taskId,
    session_id: sessionId,
    session_source: session.source,
    task_fingerprint: fingerprint,
    attempt,
    client_attempt: clientAttempt,
    status: 'running',
    workspace,
    task: body.task,
    acceptance_criteria: criteria,
    review_feedback: body.review_feedback || null,
    created_at: startedAt,
    updated_at: startedAt,
  };

  let cliResult;
  try {
    cliResult = await runCli({
      bin: cfg.executor.cliBin,
      args,
      cwd: workspace,
      timeoutMs: cfg.executor.timeoutMs,
      cfg,
    });
    assertNoAuthError(cliResult);
    if (cliResult.spawnError) throw new CliError(`无法启动 CLI: ${cliResult.stderr}`, 'CLI_SPAWN_FAILED');
  } catch (err) {
    record.status = 'failed';
    record.error = { code: err.code || 'EXEC_ERROR', message: err.message };
    record.finished_at = nowIso();
    record.duration_ms = Date.now() - new Date(startedAt).getTime();
    ledger.save(record);
    ledger.event('task_failed', { task_id: taskId, session_id: sessionId, code: record.error.code });

    const e = new Error(err.message);
    e.code = err.code || 'EXEC_ERROR';
    e.status = err.code === 'CLI_AUTH_REQUIRED' ? 503 : 500;
    if (err.code === 'CLI_AUTH_REQUIRED') {
      e.nextAction =
        '这是环境问题，不是任务问题，重试无效。请告知用户：本机 WorkBuddy 构建无法登录 CLI（只有 lite-wb 精简产物，交互界面起不来），需要在 gateway/config.json 里填写 executor.apiKey 与 executor.baseUrl 改用自带密钥模式，或者改回用桌面端。';
    }
    e.body = {
      task_id: taskId,
      session_id: sessionId,
      session_source: session.source,
      attempt,
      status: 'failed',
      error: record.error,
    };
    throw e;
  }

  const parsed = parseResult(cliResult.stdout);
  const after = snapshot(workspace, cfg.artifacts);
  const diff = diffSnapshots(before, after);
  const collected = collectArtifacts(workspace, diff, cfg);

  let verify = null;
  if (body.verify && typeof body.verify.command === 'string' && body.verify.command.trim()) {
    const res = await runShell(body.verify.command, workspace, body.verify.timeout_ms || 120000);
    verify = {
      command: body.verify.command,
      exit_code: res.exit_code,
      ok: res.exit_code === 0,
      output_tail: res.output,
    };
  }

  const finished = nowIso();
  // 空交付 = 失败。CLI 在「模型请求失败」时仍可能退出码 0、stdout 为空，
  // 按 exit_code 判定会记成 delivered，DSH 就会去审一份空交付——比报错更糟。
  const emptyDelivery = !parsed.text.trim() && collected.artifacts.length === 0;
  const delivered = cliResult.code === 0 && !cliResult.timedOut && !emptyDelivery && !parsed.isError;
  const emptyCode = emptyDelivery && cliResult.code === 0 ? 'EMPTY_RESULT' : null;
  const cliErrorCode = parsed.isError && cliResult.code === 0 ? 'CLI_REPORTED_ERROR' : null;

  record = {
    ...record,
    status: cliResult.timedOut ? 'timeout' : delivered ? 'delivered' : 'failed',
    exit_code: cliResult.code,
    timed_out: cliResult.timedOut,
    output: parsed.text,
    artifacts: collected.artifacts,
    artifacts_total: collected.artifacts_total,
    artifacts_truncated: collected.artifacts_truncated,
    diff_stat: collected.diff_stat,
    verify,
    finished_at: finished,
    duration_ms: Date.now() - new Date(startedAt).getTime(),
    stderr_tail: cliResult.stderr ? cliResult.stderr.slice(-2000) : undefined,
    cli_session_id: parsed.sessionId,
    ...(emptyCode ? { error: { code: emptyCode } } : {}),
    ...(cliErrorCode ? { error: { code: cliErrorCode, message: parsed.text.slice(0, 400) } } : {}),
    next_action: delivered
      ? `第 ${attempt}/${cfg.limits.maxAttempts} 轮。逐条比对 acceptance_criteria 与 artifacts[].preview：不合格就带 review_feedback 再派一次（同 session_id），合格就呈报用户。还要注意 artifacts_total 与 artifacts 长度是否一致。`
      : emptyDelivery
        ? '执行方既没返回文本、也没产生任何文件，等于没交付。先看 stderr_tail：若是模型/密钥/网络报错（如 401、timeout），属环境问题，重试无效，必须告知用户；stderr 为空才考虑带 review_feedback 重派一次。'
        : `执行失败（status=${record.status}）。先看 stderr_tail 判断是环境问题还是任务问题；任务问题可以带 review_feedback 重派，环境问题要告知用户。`,
  };

  if (session.source !== 'session_id') {
    record.session_warning = `本次 session_id 由 ${session.source} 推导得出（${sessionId}）。后续返工请显式传这个 session_id，否则换了任务措辞会被当成新会话，轮次上限就失效了。`;
  }

  ledger.save(record);
  ledger.event('task_done', { task_id: taskId, session_id: sessionId, status: record.status, attempt });

  return record;
}
