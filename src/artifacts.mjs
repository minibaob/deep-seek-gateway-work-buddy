import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { relPath, truncate } from './util.mjs';

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.bash', '.ps1', '.bat',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.sql', '.graphql',
  '.xml', '.svg', '.csv', '.tsv', '.log', '.env', '.gitignore', '.editorconfig',
]);

export function snapshot(root, opts) {
  const ignore = new Set(opts.ignore || []);
  const maxFiles = opts.maxFiles || 5000;
  const maxDepth = opts.maxDepth ?? 12;
  const out = new Map();
  let count = 0;

  const walk = (dir, depth) => {
    if (count >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      if (ignore.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(abs, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(abs);
          out.set(relPath(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
          count++;
        } catch {
          /* 文件在扫描过程中消失，忽略 */
        }
      }
    }
  };

  walk(root, 0);
  return out;
}

export function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [rel, info] of after) {
    const prev = before.get(rel);
    if (!prev) created.push(rel);
    else if (prev.size !== info.size || Math.abs(prev.mtimeMs - info.mtimeMs) >= 1) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel);
  return { created, modified, deleted };
}

function gitAvailable(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

/** 有 git 基线时拿到每文件的 +/- 行数，没有就返回空表 */
function gitNumstat(root) {
  const table = new Map();
  if (!gitAvailable(root)) return table;
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--numstat', '--relative', 'HEAD'], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [added, removed, file] = line.split('\t');
      if (!file) continue;
      table.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
    }
  } catch {
    /* 仓库还没有任何提交时 HEAD 不存在，退回无基线模式 */
  }
  return table;
}

function looksTextual(abs, rel) {
  const ext = path.extname(rel).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (!ext) {
    // 无扩展名的文件（Makefile / Dockerfile 之类）嗅探一下空字节
    try {
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      fs.closeSync(fd);
      return !buf.subarray(0, n).includes(0);
    } catch {
      return false;
    }
  }
  return false;
}

function countLines(abs) {
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return text.split(/\r?\n/).length;
  } catch {
    return undefined;
  }
}

function previewOf(abs, limits) {
  try {
    const st = fs.statSync(abs);
    if (st.size === 0) return '(空文件)';
    if (st.size <= limits.previewBytes) {
      return truncate(fs.readFileSync(abs, 'utf8'), limits.previewChars);
    }
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(limits.previewBytes);
    const n = fs.readSync(fd, buf, 0, limits.previewBytes, 0);
    fs.closeSync(fd);
    return `${buf.subarray(0, n).toString('utf8')}\n…（文件共 ${st.size} 字节，此处仅前 ${n} 字节；需要全文请调用 GET /v1/tasks/{id}/raw?path=）`;
  } catch (err) {
    return `(读取失败: ${err.message})`;
  }
}

export function collectArtifacts(root, diff, cfg) {
  const limits = cfg.limits;
  const numstat = gitNumstat(root);
  const rows = [];

  const push = (rel, change) => {
    const abs = path.join(root, rel);
    const row = { path: rel, change };
    let size = 0;
    if (change !== 'deleted') {
      try {
        size = fs.statSync(abs).size;
      } catch {
        size = 0;
      }
      row.bytes = size;
    }
    const stat = numstat.get(rel);
    if (stat) row.diff_stat = `+${stat.added} -${stat.removed}`;
    else if (change === 'created') {
      const lines = countLines(abs);
      if (lines !== undefined) row.diff_stat = `+${lines} -0`;
    }
    if (change !== 'deleted' && looksTextual(abs, rel)) {
      const pv = previewOf(abs, limits);
      if (pv) row.preview = pv;
    } else if (change !== 'deleted') {
      row.preview = '(二进制或不可预览，请用 raw 接口取)';
    }
    rows.push(row);
  };

  for (const rel of diff.created) push(rel, 'created');
  for (const rel of diff.modified) push(rel, 'modified');
  for (const rel of diff.deleted) push(rel, 'deleted');

  let added = 0;
  let removed = 0;
  let statKnown = 0;
  for (const row of rows) {
    if (!row.diff_stat) continue;
    const m = /^\+(\d+) -(\d+)$/.exec(row.diff_stat);
    if (m) {
      added += Number(m[1]);
      removed += Number(m[2]);
      statKnown++;
    }
  }
  const total = rows.length;
  const summary = total === 0
    ? 'no files changed'
    : `${total} file(s) changed, +${added} -${removed}${statKnown < total ? ` (${total - statKnown} 个文件无 git 基线，行数未计)` : ''}`;

  const cap = 40;
  return {
    artifacts: rows.slice(0, cap),
    artifacts_total: total,
    artifacts_truncated: total > cap,
    diff_stat: summary,
  };
}
