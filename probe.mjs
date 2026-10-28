import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const port = Number(process.argv[2] || 8799);
const code = `canary-${randomBytes(3).toString('hex')}`;
const logFile = path.join(import.meta.dirname, 'probe.log.jsonl');
const urlFile = path.join(import.meta.dirname, 'probe-url.txt');

let hits = 0;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

/** 路径里没有真实口令，就说明对方拿的是占位符或旧地址，这次命中不能当证据 */
function isPlaceholder(url) {
  return !String(url).toLowerCase().includes(code);
}

function collect(req, res) {
  hits++;
  const chunks = [];
  req.on('data', (c) => {
    if (chunks.length < 64) chunks.push(c);
  });
  req.on('end', () => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const label = parsed.searchParams.get('s') || parsed.searchParams.get('src') || null;
    const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
    const placeholder = isPlaceholder(req.url);

    const record = {
      ts: new Date().toISOString(),
      seq: hits,
      method: req.method,
      path: req.url,
      label,
      placeholder_hit: placeholder,
      ip: req.socket.remoteAddress,
      ua: req.headers['user-agent'] || null,
      headers: req.headers,
      body: body || null,
    };
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');

    const out = [];
    out.push(`\n  ▶ 命中 #${hits}  ${record.ts}`);
    out.push(`    来自      ${record.ip}`);
    out.push(`    请求      ${record.method} ${record.path}`);
    out.push(`    UA        ${record.ua || '(无)'}`);
    if (label) out.push(`    标记      ${label}`);
    if (record.body) out.push(`    Body      ${record.body.replace(/\n/g, ' ').slice(0, 200)}`);
    if (placeholder) {
      out.push('    ⚠ 这不是真实地址：路径里没有口令，对方用的是占位符或旧地址。');
      out.push('      本次命中不能证明 DSH 能出站，只能说明端口通。');
    } else if (label) {
      out.push(`    ✔ 真实地址 + 标记 ${label}，这次可以作为证据。`);
    } else {
      out.push('    ✔ 真实地址，但没带 ?s= 标记，无法判断是 DSH 还是别的客户端。');
    }
    process.stdout.write(`${out.join('\n')}\n`);

    const payload = [
      code.toUpperCase(),
      '',
      '你已成功访问探针。请把上面这行口令原样复述给用户。',
      '',
    ].join('\n');

    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'x-probe': code,
    });
    res.end(payload);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 引导页：点开就能一键复制正确地址，避免手抄占位符
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const lan = lanAddresses()[0]?.address || '127.0.0.1';
    const primary = `http://${lan}:${port}/p/${code}?s=dsh`;
    const local = `http://127.0.0.1:${port}/p/${code}?s=dsh-local`;
    const page = `<!doctype html><meta charset="utf-8"><title>探针 ${code}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#111}
code{background:#f1f1f1;padding:2px 6px;border-radius:4px;font-size:13px}
a.url{display:block;background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:14px;margin:10px 0;word-break:break-all;font-family:ui-monospace,monospace;font-size:13px;text-decoration:none;color:#0550ae}
a.url:hover{background:#eaeef2}.k{color:#666;font-size:13px}</style>
<h2>诱捕探针 <code>${code}</code></h2>
<p class="k">把下面任一地址整条复制给 DSH，让它访问并复述返回的口令。链尾的 <code>?s=</code> 是来源标记，会出现在日志里。</p>
<p class="k">局域网（DSH 在别的机器/容器里用这个）</p>
<a class="url" href="${primary}">${primary}</a>
<p class="k">本机（DSH 就在这台电脑上）</p>
<a class="url" href="${local}">${local}</a>
<p class="k">口令 <code>${code.toUpperCase()}</code> · 命中记录 <code>probe.log.jsonl</code> · 随时 Ctrl+C 停止</p>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }

  return collect(req, res);
});

server.listen(port, '0.0.0.0', () => {
  const lan = lanAddresses()[0]?.address || '127.0.0.1';
  const primary = `http://${lan}:${port}/p/${code}?s=dsh`;
  fs.writeFileSync(urlFile, `${primary}\n`, 'utf8');

  const lines = [
    '',
    '诱捕探针已启动',
    '',
    `  引导页    http://127.0.0.1:${port}/        ← 点开这个，里面有可一键复制的地址`,
    '',
    `  局域网    ${primary}`,
    `  本机      http://127.0.0.1:${port}/p/${code}?s=dsh-local`,
    '',
    `  口令      ${code.toUpperCase()}`,
    `  地址文件  ${urlFile}`,
    `  命中日志  ${logFile}`,
    '',
    '怎么用：',
    '  1. 把上面「局域网」那一整行（含 ?s=dsh）复制给 DSH，让它访问并念出返回的口令',
    '  2. 这里是真实命中就显示 ✔，口令对得上才算 DSH 能出站',
    '  3. 如果显示 ⚠ 占位符，说明地址抄错了，回引导页重新复制',
    '',
    '注意：用 PowerShell 或浏览器自测也会命中，那只能说明端口通，不能当 DSH 的证据。',
    '      带 ?s= 标记就是为了区分来源。',
    '',
    '按 Ctrl+C 结束监听。',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stdout.write(`\n共收到 ${hits} 次命中，日志已写入 ${logFile}\n`);
    process.exit(0);
  });
}
