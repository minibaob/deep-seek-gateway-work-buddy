#!/usr/bin/env node
/**
 * 在压缩成一行的 bundle 里按关键字取上下文片段。
 * 用途：查 CLI / DSH 内部实现（日志、鉴权、标志位），避免被 9MB 单行文件淹掉。
 *
 *   node tools/snip.mjs <file> <keyword> [前后字数]
 */
import fs from 'node:fs';

const [file, keyword, spanRaw] = process.argv.slice(2);
if (!file || !keyword) {
  console.error('用法: node tools/snip.mjs <file> <keyword> [span]');
  process.exit(2);
}
const span = Number(spanRaw) || 240;
const text = fs.readFileSync(file, 'utf8');

let idx = 0;
let n = 0;
while ((idx = text.indexOf(keyword, idx)) !== -1) {
  n++;
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + keyword.length + span);
  const snippet = text.slice(start, end).replace(/\s+/g, ' ');
  console.log(`\n──── #${n} @${idx} ────\n${snippet}`);
  idx += keyword.length;
  if (n >= 12) break;
}
console.log(`\n共命中 ${n} 处`);
