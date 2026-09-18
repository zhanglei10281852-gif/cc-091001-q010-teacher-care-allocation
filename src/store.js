// 事件存储：仅追加（append-only）的 JSONL 日志，是排队库的唯一事实来源。
// 所有状态变更都先落事件，再投影到内存读模型；容量决策因此可完整重放复算。
// 单进程内由 service 层的互斥串行化，保证“读取-判断-占用”整体是原子事务，
// 并发请求不可能同时看到同一个空闲名额。

import { appendFile, readFile } from 'node:fs/promises';

let eventSeq = 0;
function nextEventId() {
  eventSeq += 1;
  return `evt_${Date.now().toString(36)}_${eventSeq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class EventStore {
  constructor(file, { fs = { appendFile, readFile } } = {}) {
    this.file = file;
    this.fs = fs;
  }

  async append(type, data, { actor, at }) {
    const event = {
      eventId: nextEventId(),
      type,
      at,
      actor: actor ? { role: actor.role, ref: actor.ref ?? null } : null,
      data,
    };
    // 每条事件单行 JSON，追加写在 POSIX 上对小写入是原子的；
    // 真正的互斥由 service 的事务串行保证。
    await this.fs.appendFile(this.file, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  async readAll() {
    let raw;
    try {
      raw = await this.fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    if (!raw.trim()) return [];
    return raw.split('\n').filter(Boolean).map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`corrupt-event-log-line:${i + 1}`);
      }
    });
  }
}

// 供测试使用的内存版事件存储，行为与文件版一致。
export class MemoryEventStore {
  constructor() {
    this.events = [];
  }

  async append(type, data, meta) {
    const event = {
      eventId: nextEventId(),
      type,
      at: meta.at,
      actor: meta.actor ? { role: meta.actor.role, ref: meta.actor.ref ?? null } : null,
      data,
    };
    this.events.push(event);
    return event;
  }

  async readAll() {
    return this.events.slice();
  }
}
