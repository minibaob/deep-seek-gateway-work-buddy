#!/usr/bin/env node
/**
 * 假模型端点：把 CLI 真正发出去的请求路径、头、报文记下来，并返回一个最小可用的
 * Anthropic 风格响应，好让 CLI 继续往下走、暴露更多请求。
 *
 * 用途：CLI 会给 CODEBUDDY_BASE_URL 强行拼 `/v2`，我们需要看清完整路径，
 * 才能写一个准确的转发适配器。
 *
 * 用法：node tools/api-probe.mjs [port]
 */
import http from 'node:http';

const port = Number(process.argv[2] || 46200);

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => {
    if (raw.length < 20000) raw += d.toString('utf8');
  });
  req.on('end', () => {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* 非 JSON 就原样记 */
    }
    const line = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      ua: req.headers['user-agent'],
      auth: req.headers.authorization ? 'Authorization' : req.headers['x-api-key'] ? 'x-api-key' : '(无)',
      model: parsed?.model,
      keys: parsed ? Object.keys(parsed).slice(0, 12) : null,
    };
    console.log(JSON.stringify(line));

    // 回一个 Anthropic 风格的 message，尽量让 CLI 继续跑
    if (req.url.includes('messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: parsed?.model || 'probe',
          content: [{ type: 'text', text: '收到' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`假模型端点已监听 http://127.0.0.1:${port}`);
});
