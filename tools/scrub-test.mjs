#!/usr/bin/env node
/**
 * 用「DSH 真实清洗后的环境」跑一次 MCP 派单。
 * dsh-mcp-client 的 stdio spawn 会剔除匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量与所有 DSH_*，
 * 这里照着做一遍，确认网关在这种环境下仍能:启动、定位 CLI、派单、拿到结构化结果。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

const scrubbed = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/KEY|PASSWORD|SECRET|TOKEN/i.test(k)) continue;
  if (k.startsWith('DSH_')) continue;
  scrubbed[k] = v;
}

const removed = Object.keys(process.env).filter((k) => !(k in scrubbed));
console.log(`被剔除的变量 ${removed.length} 个:`, removed.slice(0, 8).join(', ') || '(无)');

const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'mcp.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: scrubbed,
});

createInterface({ input: child.stderr }).on('line', (l) => console.log('  [stderr]', l));

let seq = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    p(m);
  }
});

const rpc = (method, params) => {
  seq += 1;
  const msg = { jsonrpc: '2.0', id: seq, method, ...(params ? { params } : {}) };
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolve) => pending.set(msg.id, resolve));
};

const main = async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'scrub-test', version: '1' },
  });
  console.log('initialize:', init.result?.protocolVersion);

  const list = await rpc('tools/list', {});
  console.log('tools:', list.result?.tools?.map((t) => t.name).join(', '));

  const t0 = Date.now();
  const res = await rpc('tools/call', {
    name: 'exec',
    arguments: {
      task: '清洗环境下的链路验证：在当前目录创建 scrub.txt',
      acceptance_criteria: ['scrub.txt 存在'],
      session_id: `scrub-${Date.now()}`,
    },
  });
  const text = res.result?.content?.[0]?.text || '';
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* 原文 */
  }
  console.log(`\nexec  ${Date.now() - t0}ms  isError=${res.result?.isError}`);
  console.log('  status     ', j.status);
  console.log('  error.code ', j.error?.code || '(无)');
  if (j.stderr_tail) console.log('  stderr_tail', JSON.stringify(j.stderr_tail).slice(0, 300));
  if (j.next_action) console.log('  next_action', String(j.next_action).slice(0, 90));

  child.stdin.end();
  setTimeout(() => child.kill(), 3000);
};

main().catch((e) => {
  console.error(e);
  child.kill();
});
