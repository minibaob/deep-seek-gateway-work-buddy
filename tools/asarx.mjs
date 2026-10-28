// 极简 asar 读取器：不依赖 @electron/asar，直接解析头部索引
import fs from 'node:fs';

const asarPath = process.argv[2];
const want = process.argv[3] || '';

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

// asar 头部：u32@4 = 头部 pickle 长度，u32@12 = JSON 长度，JSON 从 16 开始
const headerPickleSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const index = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + headerPickleSize;

let count = 0;
function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (val.files) walk(val, p);
    else if (typeof val.offset === 'string') {
      if (!want || p.includes(want)) {
        // 只打印索引信息，不打印内容
        console.log(`${String(val.size).padStart(10)}  ${p}`);
        count++;
        if (process.env.DUMP && p.endsWith(process.env.DUMP)) {
          const buf = Buffer.alloc(Number(val.size));
          fs.readSync(fd, buf, 0, Number(val.size), baseOffset + Number(val.offset));
          const name = p.split('/').pop();
          const dir = new URL('./_dump/', import.meta.url).pathname.replace(/^\//, '');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dir + name, buf);
          console.error(`[dumped] ${dir}${name}`);
        }
      }
    }
  }
}
walk(index, '');
console.error(`total matched: ${count}`);
