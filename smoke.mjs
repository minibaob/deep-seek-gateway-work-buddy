import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const base = `http://${cfg.host}:${cfg.port}`;
const token = cfg.token;

function line(s = '') {
  process.stdout.write(`${s}\n`);
}

async function call(method, p, body, useToken = true) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(useToken ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function main() {
  line('== 1. 健康检查（免 token） ==');
  const health = await call('GET', '/healthz', null, false);
  line(`  HTTP ${health.status}  cli_found=${health.json.cli_found}`);
  if (!health.json.cli_found) {
    line('  ✗ 没找到 codebuddy CLI，先把 config.json 的 executor.cliBin 填上');
    process.exitCode = 1;
    return;
  }

  line('== 2. 鉴权校验（故意不带 token） ==');
  const deny = await call('GET', '/', null, false);
  line(`  HTTP ${deny.status}（期望 401）${deny.status === 401 ? ' ✓' : ' ✗'}`);

  line('== 3. 派单：让 WorkBuddy 建两个文件 ==');
  // 每轮用唯一文本与会话，避免反复冒烟撞上 TASK_REPEAT_LIMIT
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const task = await call('POST', '/v1/tasks', {
    task: `在当前工作目录创建 hello.txt，内容写 "Hello from WorkBuddy ${stamp}"，再创建 NOTES.md，写一行说明这个文件是谁创建的。`,
    acceptance_criteria: ['hello.txt 存在且内容包含 Hello from WorkBuddy', 'NOTES.md 存在且至少一行文字'],
    session_id: `smoke-${Date.now()}`,
  });
  line(`  HTTP ${task.status}`);

  if (task.status !== 200) {
    line(`  失败：${JSON.stringify(task.json, null, 2)}`);
    process.exitCode = 1;
    return;
  }

  const r = task.json;
  line(`  task_id     ${r.task_id}`);
  line(`  status      ${r.status}`);
  line(`  duration    ${r.duration_ms} ms`);
  line(`  diff_stat   ${r.diff_stat}`);
  line(`  output      ${(r.output || '').replace(/\n/g, ' ').slice(0, 300)}`);
  line('  artifacts:');
  for (const a of r.artifacts || []) {
    line(`    [${a.change}] ${a.path}  ${a.diff_stat || ''}`);
    if (a.preview) line(`      ${a.preview.split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
  }

  line('== 4. 查账 ==');
  const ledger = await call('GET', `/v1/tasks?session_id=${encodeURIComponent(r.session_id)}`);
  line(`  HTTP ${ledger.status}  记录数 ${ledger.json.count}`);

  line('');
  line(r.status === 'delivered' ? '✓ 冒烟通过，网关与 WorkBuddy 已打通' : '✗ 任务未成功交付，看上面 output / stderr');
  if (r.status !== 'delivered') process.exitCode = 1;
}

main().catch((err) => {
  line(`冒烟异常: ${err.message}`);
  line('网关是否已启动？先在另一个终端运行 node src/server.mjs');
  process.exitCode = 1;
});
