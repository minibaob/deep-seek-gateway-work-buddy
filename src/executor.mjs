import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { truncate } from './util.mjs';

const MAX_CAPTURE = 4 * 1024 * 1024;

/** 这些变量来自宿主 WorkBuddy 会话，透传给子进程会让它误挂到当前会话上 */
const STRIP_ENV = [
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_MCP_CONFIG',
  'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
  'WORKBUDDY_STARTUP_PID',
  'CODEBUDDY_DOCUMENT_IPC_ADDRESS',
];

export class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'CLI_ERROR';
  }
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function childEnv(cfg) {
  const env = { ...process.env };
  for (const key of STRIP_ENV) delete env[key];
  env.CODEBUDDY_DISABLE_IDE = '1';

  // 这个 WorkBuddy 构建只打包了 dist/codebuddy-lite-wb.mjs，没有 codebuddy 全量包。
  // bin/codebuddy 的产物分派逻辑是：非 headless 时 require('../dist/codebuddy')，
  // 且只有 forceLiteWb / isHeadless 分支才走逐级回退，所以不带这个变量时会直接
  // 抛 MODULE_NOT_FOUND 退出。桌面端拉起 CLI 时也是这么注入的，这里必须自己补上，
  // 否则换个环境（例如被 DSH 拉起）就起不来。
  env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
  delete env.CODEBUDDY_FORCE_HEADLESS_BUNDLE;

  // 自带密钥模式：CLI 支持 CODEBUDDY_API_KEY + CODEBUDDY_BASE_URL，走这条路时
  // 完全不需要账号登录态（实测会直接打到自定义端点）。同时必须清掉账号 token，
  // 否则两者并存时账号态优先，反而又回到「未登录」。
  const ex = (cfg && cfg.executor) || {};
  if (ex.apiKey) {
    env.CODEBUDDY_API_KEY = String(ex.apiKey);
    delete env.CODEBUDDY_AUTH_TOKEN;
    delete env.CODEBUDDY_API_KEY_DISABLED;
  }
  if (ex.baseUrl) env.CODEBUDDY_BASE_URL = String(ex.baseUrl);

  return env;
}

export function buildPrompt({ task, criteria = [], feedback, previousOutput, attempt = 1 }) {
  const parts = [];
  parts.push('你在一台受控机器上执行任务。当前工作目录就是你的工作区，所有读写都必须发生在这个目录内。');
  parts.push('');
  parts.push('# 任务');
  parts.push(String(task).trim());

  if (Array.isArray(criteria) && criteria.length) {
    parts.push('');
    parts.push('# 验收标准');
    parts.push('交付后会逐条核对，必须全部满足：');
    criteria.forEach((c, i) => parts.push(`${i + 1}. ${String(c).trim()}`));
  }

  if (feedback) {
    parts.push('');
    parts.push(`# 上一轮被退回的原因（第 ${attempt - 1} 轮，必须针对性修复）`);
    parts.push(String(feedback).trim());
  }

  if (previousOutput) {
    parts.push('');
    parts.push('# 上一轮你自己报告的交付摘要（避免重复劳动）');
    parts.push(truncate(String(previousOutput).trim(), 1200));
  }

  parts.push('');
  parts.push('# 交付要求');
  parts.push('- 完成后用不超过 200 字说明：改了什么、怎么验证的、有没有做不到的地方');
  parts.push('- 任何一条验收标准如果没有满足，明确写出来，不要假装完成');
  parts.push('- 不要创建与任务无关的文件');

  return parts.join('\n');
}

export function buildArgs(cfg, { prompt, port }) {
  const ex = cfg.executor;
  const args = [
    '-p',
    prompt,
    '--output-format', 'json',
    '--permission-mode', ex.permissionMode,
    '--port', String(port),
    '--max-turns', String(ex.maxTurns),
    '--allowedTools', (ex.allowedTools || []).join(','),
  ];
  if (ex.skipPermissions) args.push('-y');
  if (!ex.persistSession) args.push('--no-session-persistence');
  if (ex.model) args.push('--model', ex.model);
  if (Array.isArray(ex.extraArgs)) args.push(...ex.extraArgs);
  return args;
}

export function runCli({ bin, args, cwd, timeoutMs, cfg }) {
  return new Promise((resolve) => {
    // 坑：Windows 上 spawn 的 ENOENT 有两种来源——可执行文件不存在，或 cwd 不存在。
    // 后者报错信息里只显示命令名，看着像 node 装丢了，实际是工作目录没建。
    // 所以先自己把目录补上，缺什么就报什么，别让调用方去猜。
    let workdir = cwd;
    try {
      fs.mkdirSync(workdir, { recursive: true });
    } catch (err) {
      return resolve({
        code: -1,
        stdout: '',
        stderr: `无法创建工作目录 ${workdir}: ${err.message}`,
        timedOut: false,
        spawnError: true,
      });
    }

    if (!fs.existsSync(bin)) {
      return resolve({
        code: -1,
        stdout: '',
        stderr: `CLI 入口不存在: ${bin}`,
        timedOut: false,
        spawnError: true,
      });
    }

    let child;
    try {
      child = spawn(process.execPath, [bin, ...args], {
        cwd: workdir,
        env: childEnv(cfg),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false, spawnError: true });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }, 5000);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const detail = [
        `spawn 失败: ${err.message}`,
        `  可执行文件 ${process.execPath} (${fs.existsSync(process.execPath) ? '存在' : '不存在'})`,
        `  CLI 入口   ${bin} (${fs.existsSync(bin) ? '存在' : '不存在'})`,
        `  工作目录   ${workdir} (${fs.existsSync(workdir) ? '存在' : '不存在'})`,
      ].join('\n');
      resolve({ code: -1, stdout, stderr: `${stderr}\n${detail}`, timedOut, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

const AUTH_PATTERN = /Authentication required|Please use \/login|not logged in|请先登录|未登录/i;

/**
 * `--output-format json` 在这个构建里输出的**是一个事件数组**，不是单个结果对象：
 *   [ {type:"message",role:"user",...}, {type:"ai-title",...},
 *     {type:"message",role:"assistant",...},
 *     {type:"result", subtype:"success", is_error:false, result:"收到", session_id:"…", usage:{…}} ]
 * 真正的回答在最后那个 type:"result" 里。只按对象取 obj.result 会拿到空字符串，
 * 于是把整段原始 JSON 当成交付内容——审核方看到的就不是答案了。
 */
function extractFromEvents(list) {
  const res = [...list].reverse().find((e) => e && e.type === 'result');
  if (res) {
    return {
      text: typeof res.result === 'string' ? res.result : '',
      sessionId: res.session_id || res.sessionId || null,
      isError: res.is_error === true,
      usage: res.usage || null,
      turns: typeof res.num_turns === 'number' ? res.num_turns : null,
      raw: res,
    };
  }

  // 没有 result 事件时，退一步拼 assistant 消息里的文本
  const texts = [];
  for (const e of list) {
    if (e && e.role === 'assistant' && Array.isArray(e.content)) {
      for (const part of e.content) {
        if (part && typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  return { text: texts.join('\n').trim(), sessionId: null, isError: false, raw: list };
}

export function parseResult(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return { text: '', sessionId: null, raw: null, isError: false };

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const parsed = tryParse(trimmed);
  if (Array.isArray(parsed)) return extractFromEvents(parsed);
  if (parsed && typeof parsed === 'object') {
    if (parsed.type === 'result' || typeof parsed.result === 'string') {
      return extractFromEvents([parsed]);
    }
  }

  // JSONL：一行一个事件
  const events = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) continue;
    const v = tryParse(s);
    if (Array.isArray(v)) events.push(...v);
    else if (v && typeof v === 'object') events.push(v);
  }
  if (events.length) return extractFromEvents(events);

  if (parsed && typeof parsed === 'object') {
    const text = parsed.text ?? parsed.response ?? parsed.message ?? parsed.content ?? null;
    return {
      text: typeof text === 'string' ? text : text ? JSON.stringify(text, null, 2) : trimmed,
      sessionId: parsed.session_id ?? parsed.sessionId ?? null,
      isError: false,
      raw: parsed,
    };
  }

  return { text: trimmed, sessionId: null, raw: null, isError: false };
}

export function assertNoAuthError({ stdout, stderr }) {
  const hay = `${stdout || ''}\n${stderr || ''}`;
  if (AUTH_PATTERN.test(hay)) {
    throw new CliError(
      'codebuddy CLI 处于未登录状态。注意：本机这个 WorkBuddy 构建只有 lite-wb 精简产物，交互界面起不来，也没有 login 子命令，所以无法用账号登录 CLI。请在 gateway/config.json 里填写 executor.apiKey 与 executor.baseUrl，改用「自带密钥」模式（详见 README 的「不登录也能跑」一节）。',
      'CLI_AUTH_REQUIRED',
    );
  }
}
