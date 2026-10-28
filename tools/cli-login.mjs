#!/usr/bin/env node
/**
 * 启动 codebuddy CLI 的交互界面，专门用来完成登录。
 *
 * 为什么需要这个脚本：
 *   1. CLI 启动时会绑定一个「稳定端口」，而 WorkBuddy 桌面端长期占用同一个端口，
 *      直接跑必然 EADDRINUSE；这里自动挑一个空闲端口传 --port。
 *   2. PowerShell 里写 "D:\...\codebuddy" 只是打印字符串，必须用 node 启动。
 *   3. 路径含中文，写在 .cmd/.ps1 里容易被编码搞坏；node 脚本没有这个问题。
 *
 * 用法：
 *   node tools/cli-login.mjs            # 进入登录界面
 *   node tools/cli-login.mjs --version  # 其余参数原样透传给 CLI
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig({ createIfMissing: false });
const cliBin = cfg.executor.cliBin;

if (!cliBin || !fs.existsSync(cliBin)) {
  console.error('找不到 codebuddy CLI。请检查 config.json 里的 executor.cliBin。');
  process.exit(2);
}

const passthrough = process.argv.slice(2);

function freePort() {
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

const credDir = process.env.CODEBUDDY_CONFIG_DIR || path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.codebuddy',
);

function credentialSnapshot() {
  const out = { dir: credDir, files: [] };
  try {
    for (const name of fs.readdirSync(credDir)) {
      if (/settings\.json$|credential|auth|token/i.test(name) && !name.endsWith('.tmp')) {
        out.files.push(name);
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

const before = credentialSnapshot();

const args = passthrough.length
  ? passthrough
  : ['--port', String(await freePort())];

console.log(`CLI      ${cliBin}`);
console.log(`参数     ${args.join(' ')}`);
console.log(`凭据目录 ${credDir}（现有 ${before.files.length} 个相关文件）`);
console.log('');
if (!passthrough.length) {
  console.log('接下来在界面里：');
  console.log('  1. 输入 /login 回车（界面顶部可能已提示 "Authentication required"）');
  console.log('  2. 用 ↑↓ 选 "Log in via Chinese Site"，回车');
  console.log('  3. 浏览器会自动打开，完成登录');
  console.log('  4. 回到终端看到已登录后，输入 /exit 退出');
  console.log('');
}

const child = spawn(process.execPath, [cliBin, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEBUDDY_DISABLE_IDE: '1',
    // 关键：这个 WorkBuddy 构建只打包了 dist/codebuddy-lite-wb.mjs。bin/codebuddy 在
    // 非 headless 且没有这个变量时会 require('../dist/codebuddy')（不存在）并直接抛
    // MODULE_NOT_FOUND 退出——这就是之前那次「退出码 1 + 凭据目录无新增」的原因。
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '',
  },
});

child.on('exit', (code) => {
  const after = credentialSnapshot();
  const fresh = after.files.filter((f) => !before.files.includes(f));
  console.log('');
  if (fresh.length) {
    console.log(`✔ 凭据已生成：${fresh.join(', ')}`);
    console.log('  回到会话里跑 `node tools/mcp-test.mjs`，第 5 项应该变成真实交付。');
  } else {
    console.log(`CLI 退出，退出码 ${code}，凭据目录没有新增文件。`);
    console.log('  如果界面里提示 EADDRINUSE，说明端口又被占用了，重跑一次本脚本即可。');
  }
  process.exit(code ?? 0);
});
