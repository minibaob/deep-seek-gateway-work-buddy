#!/usr/bin/env node
/**
 * MCP 冒烟客户端：按 DSH 的握手顺序走一遍，验证
 *   1) initialize 是否返回 instructions（系统提示词注入点）
 *   2) tools/list 是否给出 exec / history
 *   3) tools/call history 是否可读账本
 *   4) tools/call exec 在 CLI 未登录时是否返回 isError（而不是虚假成功）
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

const serverPath = path.join(import.meta.dirname, '..', 'mcp.mjs');
const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

const pending = new Map();
let seq = 0;
const stderrLines = [];

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log('  [非 JSON 输出]', line.slice(0, 120));
    return;
  }
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p(msg);
  }
});

createInterface({ input: child.stderr }).on('line', (l) => stderrLines.push(l));

function rpc(method, params, { notify = false } = {}) {
  const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
  if (!notify) {
    seq += 1;
    msg.id = seq;
  }
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  if (notify) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 120000);
    pending.set(msg.id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
}

const ok = (b) => (b ? '✔' : '✘');

async function main() {
  console.log('== 1. initialize ==');
  const init = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
  });
  const r = init.result || {};
  console.log(`  ${ok(!!r.protocolVersion)} protocolVersion = ${r.protocolVersion}`);
  console.log(`  ${ok(!!r.serverInfo)} serverInfo      = ${r.serverInfo?.name}@${r.serverInfo?.version}`);
  const instr = r.instructions || '';
  console.log(`  ${ok(instr.length > 100)} instructions    = ${instr.length} 字（会进系统提示词）`);
  console.log(`  ${ok(r.capabilities?.tools)} tools 能力      = ${JSON.stringify(r.capabilities?.tools)}`);
  await rpc('notifications/initialized', undefined, { notify: true });

  console.log('== 2. tools/list ==');
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  for (const t of tools) {
    const req = (t.inputSchema?.required || []).join(',') || '-';
    console.log(`  ${ok(true)} ${t.name.padEnd(10)} required=[${req}]  ${t.description.slice(0, 40)}…`);
  }
  console.log(`  公开名会是 mcp__workbuddy__${tools.map((t) => t.name).join(' / mcp__workbuddy__')}`);

  console.log('== 3. tools/call history ==');
  const hist = await rpc('tools/call', { name: 'history', arguments: { limit: 3 } });
  const htext = hist.result?.content?.[0]?.text || '';
  console.log(`  ${ok(!hist.result?.isError)} 返回 ${htext.length} 字  ${htext.replace(/\s+/g, ' ').slice(0, 100)}`);

  console.log('== 4. tools/call exec（缺 acceptance_criteria，应被拒）==');
  const bad = await rpc('tools/call', {
    name: 'exec',
    arguments: { task: '随便做点什么' },
  });
  const bres = bad.result || {};
  const btext = bres.content?.[0]?.text || '';
  let bjson = {};
  try {
    bjson = JSON.parse(btext);
  } catch {
    /* 保留原文 */
  }
  console.log(`  ${ok(bres.isError === true)} isError=${bres.isError}`);
  console.log(`  ${ok(bjson.error?.code === 'ACCEPTANCE_CRITERIA_REQUIRED')} code=${bjson.error?.code} status=${bjson.error?.status}`);
  console.log(`  ${ok(!!bjson.next_action)} next_action 存在（会念给模型听）`);

  console.log('== 5. tools/call exec（真实派单，预期 isError=false 且 status=delivered）==');
  const t0 = Date.now();
  const real = await rpc('tools/call', {
    name: 'exec',
    arguments: {
      task: `MCP 通道验证：创建 mcp-ping-${Date.now()}.txt`,
      acceptance_criteria: ['文件存在'],
      session_id: `mcp-smoke-${Date.now()}`,
    },
  });
  const rres = real.result || {};
  const rtext = rres.content?.[0]?.text || '';
  let rjson = {};
  try {
    rjson = JSON.parse(rtext);
  } catch {
    /* 保留原文 */
  }
  console.log(`  isError=${rres.isError}  耗时 ${Date.now() - t0}ms`);
  console.log(`  code=${rjson.error?.code || '(无)'}  status=${rjson.error?.status ?? rjson.status ?? '(无)'}`);
  console.log(`  片段: ${rtext.replace(/\s+/g, ' ').slice(0, 150)}`);

  console.log('== 6. 未知方法 ==');
  const unk = await rpc('nope/nothing', {});
  console.log(`  ${ok(unk.error?.code === -32601)} error.code = ${unk.error?.code}`);

  console.log('== 7. 服务端 stderr（应只有日志，不能污染 stdout）==');
  for (const l of stderrLines.slice(0, 6)) console.log(`  ${l}`);

  child.stdin.end();
  child.kill();
}

main().catch((err) => {
  console.error('冒烟失败:', err.message);
  child.kill();
  process.exit(1);
});
