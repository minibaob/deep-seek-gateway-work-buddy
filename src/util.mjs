import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function newId(prefix = 't') {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function sendJson(res, status, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
  });
  res.end(s);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** child 是否落在 parent 之内（Windows 大小写不敏感） */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function relPath(root, abs) {
  return path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
}

export class Semaphore {
  constructor(n) {
    this.capacity = Math.max(1, n | 0);
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
  get busy() {
    return this.active;
  }
  get waiting() {
    return this.queue.length;
  }
}

export function truncate(text, maxChars) {
  if (typeof text !== 'string') return text;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（已截断，原文 ${text.length} 字符）`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function log(...args) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}\n`);
}
