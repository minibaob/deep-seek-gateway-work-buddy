#!/usr/bin/env node
/**
 * 配置「自带密钥」模式，并立刻验证能不能真的跑通。
 *
 * 为什么需要它：
 *   本机这个 WorkBuddy 构建只打包了 lite-wb 精简产物，交互界面起不来（启动即退出），
 *   CLI 也没有 login 子命令，桌面端的登录态又不共享给 CLI。所以账号登录这条路是死的。
 *   但 CLI 认 CODEBUDDY_API_KEY + CODEBUDDY_BASE_URL，走这条路完全不需要账号登录。
 *
 * 用法：
 *   node tools/set-key.mjs                          # 只查看当前配置
 *   node tools/set-key.mjs sk-xxxx                  # 写入密钥（默认 DeepSeek 的 Anthropic 兼容端点）
 *   node tools/set-key.mjs sk-xxxx <baseUrl> [model]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildPrompt, buildArgs, getFreePort, runCli, parseResult } from '../src/executor.mjs';

const CONFIG_PATH = path.join(import.meta.dirname, '..', 'config.json');
// CLI 会在这个 base 后面直接拼 `/chat/completions`（OpenAI 兼容格式，实测通过假端点抓到的）。
// 所以 base 必须是 OpenAI 兼容的版本根，不能是 Anthropic 兼容的 /anthropic ——
// 后者会拼成 /anthropic/chat/completions，直接 404。
const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

const [apiKey, baseUrl, model] = process.argv.slice(2);

const cfg = loadConfig({ createIfMissing: true });
const ex = cfg.executor;

if (!apiKey) {
  console.log(`配置文件   ${CONFIG_PATH}`);
  console.log(`apiKey     ${ex.apiKey ? `${String(ex.apiKey).slice(0, 6)}…（已设置，${String(ex.apiKey).length} 位）` : '（未设置 → 会走账号登录，而本机登录不了）'}`);
  console.log(`baseUrl    ${ex.baseUrl || '（未设置）'}`);
  console.log(`model      ${ex.model || '（未设置，用 CLI 默认）'}`);
  console.log('');
  console.log('写入密钥：node tools/set-key.mjs sk-xxxx');
  process.exit(0);
}

const next = {
  ...ex,
  apiKey: String(apiKey).trim(),
  baseUrl: (baseUrl || DEFAULT_BASE).trim(),
  model: (model || DEFAULT_MODEL).trim(),
};

// 只在 executor 段替换，其余配置（token、白名单、limits）原样保留
const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
raw.executor = next;
fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

console.log(`已写入   apiKey=${next.apiKey.slice(0, 6)}…  baseUrl=${next.baseUrl}  model=${next.model}`);
console.log('正在用这个密钥真跑一次（约 10~30 秒）…');

const port = await getFreePort();
const args = buildArgs({ ...cfg, executor: next }, {
  prompt: buildPrompt({ task: '只回复两个字：收到', criteria: ['回复内容包含“收到”'] }),
  port,
});

const r = await runCli({
  bin: cfg.executor.cliBin,
  args,
  cwd: path.join(import.meta.dirname, '..', 'ws'),
  timeoutMs: 180000,
  cfg: { ...cfg, executor: next },
});

const parsed = parseResult(r.stdout);
if (r.code === 0 && parsed.text.trim()) {
  console.log(`\n✔ 通了，模型返回：${parsed.text.trim().slice(0, 80)}`);
  console.log('  现在可以派真实任务了：node tools/mcp-test.mjs');
  if (parsed.sessionId) console.log(`  会话 ID：${parsed.sessionId}`);
} else {
  console.log(`\n✘ 失败（退出码 ${r.code}）`);
  const err = (r.stderr || '').trim();
  if (/401|invalid|unauthor/i.test(err)) {
    console.log('  密钥被端点拒绝（401）。检查密钥是否正确、是否属于这个 baseUrl。');
  } else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timeout|ETIMEDOUT/i.test(err)) {
    console.log('  网络不通。本机有 http_proxy，必要时给 CLI 配代理，或换 baseUrl。');
  }
  console.log(`  stderr 尾部：\n${err.slice(-600) || '(空)'}`);
  process.exitCode = 1;
}
