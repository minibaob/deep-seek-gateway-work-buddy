#!/usr/bin/env node
/**
 * 把 WorkBuddy 网关注册进 DSH（Cordis profile）。
 *
 * 只做一件事：在 ~/.dsh/profiles/desktop/cordis.patch.yml 追加一条 insert 记录，
 * 让 DSH 启动时以 stdio 拉起 gateway/mcp.mjs，并把 mcp__workbuddy__* 注册进工具表。
 *
 * 幂等：已存在同 id 条目则跳过，重复执行安全。改动前自动备份。
 *   node tools/register-dsh.mjs            注册（缺则加）
 *   node tools/register-dsh.mjs --remove   移除
 *   node tools/register-dsh.mjs --check    只检查
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ENTRY_ID = 'workbuddy-gateway';
const MARK_BEGIN = '# ── WorkBuddy Gateway (MCP) 由 tools/register-dsh.mjs 维护，请勿手改 ──';
const MARK_END = '# ── WorkBuddy Gateway 结束 ──';

const GATEWAY_DIR = path.resolve(import.meta.dirname, '..');
const MCP_ENTRY = path.join(GATEWAY_DIR, 'mcp.mjs');

const patchPath = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'desktop',
  'cordis.patch.yml',
);

const mode = process.argv.includes('--remove')
  ? 'remove'
  : process.argv.includes('--check')
    ? 'check'
    : 'add';

/** 挑一个能跑 import.meta.dirname 的 node（DSH 会清洗环境变量，所以必须写绝对路径） */
function pickNode() {
  // 优先系统 node：不随 WorkBuddy 升级失效；最后才退到当前进程（可能是 WorkBuddy 内置 node）
  const candidates = [
    'D:/Program Files/nodejs/node.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    '/usr/bin/node',
    process.execPath,
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c.replace(/\\/g, '/');
    } catch {
      /* 忽略 */
    }
  }
  return 'node';
}

function block(nodeBin) {
  return `${MARK_BEGIN}
- insert:
    - id: ${ENTRY_ID}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: workbuddy
        transport: stdio
        command: '${nodeBin}'
        args:
          - '${MCP_ENTRY.replace(/\\/g, '/')}'
        cwd: '${GATEWAY_DIR.replace(/\\/g, '/')}'
        # 派单可能要跑十几分钟，DSH 默认 60s 会提前掐断
        toolCallTimeoutMs: 900000
        # 网关起不来时不要拦住 DSH 启动，只会在日志里报错
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 10000
          maxAttempts: 5
${MARK_END}
`;
}

function stripBlock(text) {
  const begin = text.indexOf(MARK_BEGIN);
  if (begin < 0) return text;
  const end = text.indexOf(MARK_END);
  if (end < 0) return text;
  return `${text.slice(0, begin)}${text.slice(end + MARK_END.length)}`.replace(/\n{3,}/g, '\n\n');
}

/** 用 DSH 自带的 js-yaml 校验，确保写进去能被 loader 解析 */
function validate(text) {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
    'js-yaml',
  ];
  for (const c of candidates) {
    try {
      const yaml = require(c);
      const doc = yaml.load(text);
      if (!Array.isArray(doc)) throw new Error('顶层必须是数组');
      return { ok: true, entries: doc.length };
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') continue;
      return { ok: false, error: err.message };
    }
  }
  return { ok: null, error: '没有可用的 YAML 校验器' };
}

function main() {
  if (!fs.existsSync(patchPath)) {
    console.error(`找不到 DSH profile：${patchPath}`);
    console.error('确认 DSH 已安装并至少启动过一次。');
    process.exit(2);
  }

  const original = fs.readFileSync(patchPath, 'utf8');
  const has = original.includes(ENTRY_ID);

  if (mode === 'check') {
    console.log(`profile  ${patchPath}`);
    console.log(`已注册  ${has ? '是' : '否'}`);
    console.log(`mcp 入口 ${MCP_ENTRY} (${fs.existsSync(MCP_ENTRY) ? '存在' : '缺失'})`);
    return;
  }

  if (mode === 'remove') {
    if (!has) {
      console.log('没有找到该条目，无需移除。');
      return;
    }
    const cleaned = stripBlock(original);
    const v = validate(cleaned);
    if (v.ok === false) {
      console.error(`移除后 YAML 校验失败，已放弃写入：${v.error}`);
      process.exit(1);
    }
    const bak = `${patchPath}.bak-${Date.now()}`;
    fs.writeFileSync(bak, original, 'utf8');
    fs.writeFileSync(patchPath, cleaned, 'utf8');
    console.log(`已移除 ${ENTRY_ID}`);
    console.log(`备份  ${bak}`);
    return;
  }

  if (has) {
    console.log(`已存在 ${ENTRY_ID}，跳过。如需改路径，先 --remove 再注册。`);
    return;
  }

  const nodeBin = pickNode();
  const next = `${original.trimEnd()}\n\n${block(nodeBin)}`;
  const v = validate(next);
  if (v.ok === false) {
    console.error(`写入后 YAML 校验失败，已放弃：${v.error}`);
    process.exit(1);
  }

  const bak = `${patchPath}.bak-${Date.now()}`;
  fs.writeFileSync(bak, original, 'utf8');
  fs.writeFileSync(patchPath, next, 'utf8');

  console.log(`已注册 ${ENTRY_ID}`);
  console.log(`  node    ${nodeBin}`);
  console.log(`  入口    ${MCP_ENTRY}`);
  console.log(`  备份    ${bak}`);
  console.log(`  YAML    ${v.ok === true ? `校验通过（${v.entries} 个顶层条目）` : `未校验（${v.error}）`}`);
  console.log('');
  console.log('重启 DSH 后，工具表里会出现 mcp__workbuddy__exec 与 mcp__workbuddy__history。');
}

main();
