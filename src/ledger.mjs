import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.mjs';

export class Ledger {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'ledger');
    this.indexFile = path.join(stateDir, 'events.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
    this.#load();
  }

  #load() {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (rec && rec.task_id) this.cache.set(rec.task_id, rec);
      } catch {
        /* 损坏的记录跳过，不影响启动 */
      }
    }
  }

  #file(taskId) {
    return path.join(this.dir, `${taskId}.json`);
  }

  save(record) {
    record.updated_at = nowIso();
    this.cache.set(record.task_id, record);
    fs.writeFileSync(this.#file(record.task_id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  get(taskId) {
    return this.cache.get(taskId) || null;
  }

  list({ session_id, workspace, limit = 20 } = {}) {
    let rows = [...this.cache.values()];
    if (session_id) rows = rows.filter((r) => r.session_id === session_id);
    if (workspace) rows = rows.filter((r) => r.workspace === workspace);
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows.slice(0, Math.max(1, Math.min(200, limit)));
  }

  /** 同一 session 下已产生的轮次数量，用于自动推算 attempt */
  attemptsFor(sessionId) {
    if (!sessionId) return 0;
    return [...this.cache.values()].filter((r) => r.session_id === sessionId).length;
  }

  countBy(predicate) {
    let n = 0;
    for (const r of this.cache.values()) if (predicate(r)) n++;
    return n;
  }

  event(type, payload) {
    const line = JSON.stringify({ ts: nowIso(), type, ...payload });
    fs.appendFileSync(this.indexFile, `${line}\n`, 'utf8');
  }
}
