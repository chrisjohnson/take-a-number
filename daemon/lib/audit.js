// take-a-number daemon: append-only JSONL audit log. One file per UTC day,
// 14-day retention, best-effort after the first write failure of a day.

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const RETENTION_DAYS = 14;

function dayStamp(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

export class Audit {
  /** @param {string} dir @param {(line:string)=>void} [onError] */
  constructor(dir, onError = () => {}) {
    this.dir = dir;
    this.onError = onError;
    this.deadForDay = null;
    mkdirSync(dir, { recursive: true });
    this.#prune();
  }

  #prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    let entries;
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      let st;
      try {
        st = statSync(join(this.dir, name));
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          // best effort
        }
      }
    }
  }

  /** Append one event; `at` is epoch ms (authoritative clock: the daemon's). */
  record(event, at = Date.now()) {
    const day = dayStamp(at);
    if (this.deadForDay === day) return;
    const line = JSON.stringify({ at, ...event });
    try {
      appendFileSync(join(this.dir, `${day}.jsonl`), `${line}\n`);
    } catch (error) {
      this.deadForDay = day;
      this.onError(`audit write failed for ${day}, continuing without audit for the rest of the day: ${String(error?.message ?? error)}`);
    }
  }

  /** Newest-first lines across the retention window, optionally filtered. */
  query({ identity, queue, model, kind, modality, from, to, limit = 200 } = {}) {
    const files = this.#files();
    const out = [];
    for (const name of files) {
      let raw;
      try {
        raw = readFileSync(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (line === '') continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (from !== undefined && entry.at < from) continue;
        if (to !== undefined && entry.at > to) continue;
        if (identity !== undefined && entry.identity !== identity) continue;
        if (queue !== undefined && entry.queue !== queue) continue;
        if (model !== undefined && entry.model !== model) continue;
        if (kind !== undefined && entry.kind !== kind) continue;
        if (modality !== undefined && entry.modality !== modality) continue;
        out.push(entry);
      }
    }
    out.sort((a, b) => b.at - a.at);
    const total = out.length;
    const pages = out.slice(0, Math.max(1, limit));
    return { lines: pages, total, truncated: total > pages.length };
  }

  #files() {
    try {
      return readdirSync(this.dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
