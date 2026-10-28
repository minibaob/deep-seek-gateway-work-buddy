import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const GATEWAY_DIR = path.resolve(import.meta.dirname, '..');
export const PROJECT_DIR = path.resolve(GATEWAY_DIR, '..');
export const CONFIG_PATH = path.join(GATEWAY_DIR, 'config.json');

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  token: null,
  workspaces: [path.join(PROJECT_DIR, 'ws')],
  // 作用域白名单：派单的 workspace 必须落在这些根目录内，否则 403。
  // 空数组 = 不限制（退化为 workspaces 白名单）。这是「只在这个工作区生效」的硬闸。
  scope: {
    allowRoots: ['D:\\workbuddy'],
  },
  stateDir: path.join(GATEWAY_DIR, '.gateway'),
  executor: {
    cliBin: null,
    // 必须用 bypassPermissions：无人值守时 dontAsk / acceptEdits 会把所有写操作判为
    // permission denied（没有交互界面可弹授权框），于是每次都「诚实失败」。
    // 安全性靠 allowedTools + workspace 白名单兜，不是靠这个模式。
    permissionMode: 'bypassPermissions',
    skipPermissions: false,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    maxTurns: 40,
    timeoutMs: 15 * 60 * 1000,
    model: null,
    persistSession: false,
    extraArgs: [],
    // 用「自带密钥」模式跑，绕开 WorkBuddy 账号登录（这个构建没有可用的登录界面）。
    // 填了 apiKey 就自动启用，见 README「不登录也能跑」。
    apiKey: '',
    baseUrl: '',
  },
  limits: {
    maxAttempts: 3,
    maxConcurrent: 2,
    maxQueue: 20,
    requireAcceptanceCriteria: true,
    previewBytes: 8192,
    previewChars: 4000,
    maxFileReadBytes: 1024 * 1024,
  },
  artifacts: {
    ignore: [
      '.git', 'node_modules', '.gateway', '.workbuddy', '.codebuddy',
      'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.venv',
      'venv', '.cache', '.pytest_cache', 'target', 'coverage',
    ],
    maxFiles: 5000,
    maxDepth: 12,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    maxToolRounds: 8,
  },
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 依次尝试：配置显式指定 → 环境变量 → 默认安装目录 */
export function detectCli(override) {
  const candidates = [];
  if (override) candidates.push(override);
  const res = process.env.WORKBUDDY_RESOURCES_PATH;
  if (res) candidates.push(path.join(res, 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  for (const drive of [process.env.LOCALAPPDATA, process.env.ProgramFiles].filter(Boolean)) {
    candidates.push(path.join(drive, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return path.resolve(c);
    } catch {
      /* 忽略非法路径 */
    }
  }
  return null;
}

export function loadConfig({ createIfMissing = true } = {}) {
  let disk = {};
  if (fs.existsSync(CONFIG_PATH)) {
    disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const cfg = deepMerge(structuredClone(DEFAULTS), disk);

  if (!cfg.token) cfg.token = randomBytes(24).toString('base64url');
  cfg.workspaces = (cfg.workspaces || []).map((p) => path.resolve(PROJECT_DIR, p));
  cfg.stateDir = path.resolve(PROJECT_DIR, cfg.stateDir);
  cfg.scope = cfg.scope || {};
  cfg.scope.allowRoots = (cfg.scope.allowRoots || []).map((p) => path.resolve(p));
  cfg.executor.cliBin = detectCli(cfg.executor.cliBin);

  if (createIfMissing) {
    const toWrite = {
      ...cfg,
      token: disk.token || cfg.token,
      executor: { ...cfg.executor },
    };
    fs.mkdirSync(GATEWAY_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
  }

  for (const ws of cfg.workspaces) fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(cfg.stateDir, 'ledger'), { recursive: true });

  return cfg;
}

/** 把请求里的 workspace 解析到白名单内的绝对路径，越界抛 403 */
export function resolveWorkspace(cfg, requested) {
  const fallback = cfg.workspaces[0];
  if (!requested) {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  const abs = path.resolve(PROJECT_DIR, requested);
  const hit = cfg.workspaces.find((w) => {
    const rel = path.relative(w, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!hit) {
    const err = new Error(`workspace 不在白名单内: ${abs}`);
    err.status = 403;
    err.code = 'WORKSPACE_DENIED';
    err.nextAction = `workspace 必须落在白名单目录内：${cfg.workspaces.join(' / ')}。改成其中之一，或直接省略 workspace 使用默认目录。`;
    err.hint = `允许的目录: ${cfg.workspaces.join(', ')}`;
    throw err;
  }

  // 作用域硬闸：只允许落在 scope.allowRoots 里的工作区，否则 403。
  // 这是「只在这个工作区生效」的强制保证，不依赖模型的自觉。
  const allowRoots = cfg.scope?.allowRoots || [];
  if (allowRoots.length > 0) {
    const inScope = allowRoots.some((root) => {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inScope) {
      const err = new Error(`workspace 不在允许的工作区范围内: ${abs}`);
      err.status = 403;
      err.code = 'WORKSPACE_SCOPE_DENIED';
      err.nextAction =
        `本工具只在以下工作区生效：${allowRoots.join(' / ')}。` +
        '你当前的工作区不在其中，不要调用 exec/history，直接用自己的能力回答即可。';
      err.hint = `允许的工作区: ${allowRoots.join(', ')}`;
      throw err;
    }
  }

  // 目录必须在快照之前就存在：否则 snapshot 拿到的是空结果，
  // 而 spawn 会因 cwd 不存在报 ENOENT（错误信息里只显示命令名，极易误判成 node 装丢了）。
  fs.mkdirSync(abs, { recursive: true });  return abs;
}
