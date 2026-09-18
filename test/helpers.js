import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { PolicyRegistry } from '../src/policy.js';
import { SensitiveBox } from '../src/crypto.js';
import { CareService } from '../src/service.js';
import { createServer } from '../src/server.js';

export const T0 = new Date('2026-09-18T09:00:00+08:00');
const DAY_MS = 86400000;

// 可推进的测试时钟：冷静期、证明过期、等待加分都靠它确定性验证
export function makeClock(start = T0) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (days) => { t += days * DAY_MS; },
    set: (d) => { t = new Date(d).getTime(); },
  };
}

export async function loadRules() {
  return JSON.parse(await readFile(new URL('../policy/rules-2026.2.json', import.meta.url), 'utf8'));
}

export async function makeService({ clock = makeClock(), rules } = {}) {
  const store = new Store();
  const policies = new PolicyRegistry();
  policies.publish(rules ?? (await loadRules()));
  const box = new SensitiveBox({ masterKey: randomBytes(32), keyId: 'test-1' });
  const service = new CareService({ store, policies, box, now: clock.now });
  return { store, policies, box, service, clock };
}

export async function makeHttpServer(opts = {}) {
  const kit = await makeService(opts);
  const server = createServer({ service: kit.service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { actor, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'x-actor-id': actor.id, 'x-actor-role': actor.role } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };
  return { ...kit, server, base, call, close: () => new Promise((r) => server.close(r)) };
}

export const teacher = (id) => ({ id, role: 'teacher' });
export const operator = (id = 'OP-1') => ({ id, role: 'operator' });
export const manager = (id = 'MGR-1') => ({ id, role: 'manager' });

export function proofFrom(clock, days) {
  return new Date(clock.now().getTime() + days * DAY_MS).toISOString();
}

// 常用提交参数
export function submitInput(clock, over = {}) {
  return {
    resource: 'counselling',
    urgency: 'standard',
    proofValidUntil: proofFrom(clock, 30),
    ...over,
  };
}
