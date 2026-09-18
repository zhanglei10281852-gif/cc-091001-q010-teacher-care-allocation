// HTTP 适配层：把 CareService 暴露为 JSON API。
// 认证采用 Bearer 令牌 → { role, ref } 的受控令牌表（生产由环境注入）。
// 教师身份（teacherRef）只从令牌声明取得，不信任请求体自报身份。

import { createServer } from 'node:http';
import { constantTimeEqual } from './crypto.js';
import { DomainError } from './service.js';

export function defaultTokens() {
  // 演示用固定令牌；受控环境必须通过环境变量覆盖。
  return new Map([
    ['teacher-T-HASH-09', { role: 'teacher', ref: 'T-HASH-09' }],
    ['teacher-T-HASH-12', { role: 'teacher', ref: 'T-HASH-12' }],
    ['worker-1', { role: 'worker', ref: 'W-01' }],
    ['director-1', { role: 'director', ref: 'D-01' }],
  ]);
}

export function createAuth(tokens = defaultTokens()) {
  const list = [...tokens.entries()];
  return function authenticate(header) {
    if (!header?.startsWith('Bearer ')) return null;
    const presented = header.slice(7);
    for (const [token, claim] of list) {
      if (constantTimeEqual(presented, token)) return claim;
    }
    return null;
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function ok(res, data, status = 200) {
  send(res, status, { ok: true, data });
}

function fail(res, status, code, details) {
  send(res, status, { ok: false, error: { code, ...(details ? { details } : {}) } });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new DomainError('payload-too-large');
  }
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createHttpServer(service, { authenticate = createAuth() } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const actor = authenticate(req.headers.authorization);
      if (!actor) return fail(res, 401, 'unauthenticated');

      // --- 教师本人命令 ---
      const exact = path.match(/^\/applications\/([A-Z0-9-]+)$/);
      const sub = path.match(/^\/applications\/([A-Z0-9-]+)\/([a-z/-]+)$/);
      if (req.method === 'POST' && path === '/applications') {
        if (actor.role !== 'teacher') return fail(res, 403, 'forbidden');
        const body = await readJson(req);
        const data = await service.submitApplication({ ...body, teacherRef: actor.ref }, actor);
        return ok(res, data, 201);
      }
      if (req.method === 'GET' && exact) {
        const data = service.teacherView(exact[1], actor.ref, actor);
        return ok(res, data);
      }
      const action = sub?.[2];
      const appId = sub?.[1];
      if (sub && req.method === 'POST' && action === 'withdraw') {
        const data = await service.withdraw(appId, actor.ref, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'POST' && action === 'renew-proof') {
        const body = await readJson(req);
        const data = await service.renewProof(appId, actor.ref, body.proofValidUntil, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'POST' && action === 'appeals') {
        const body = await readJson(req);
        const data = await service.fileAppeal(appId, actor.ref, body.reasonCode, actor);
        return ok(res, data);
      }

      // --- 经办人/负责人命令 ---
      if (sub && req.method === 'POST' && action === 'escalate') {
        const body = await readJson(req);
        const data = await service.escalateUrgency(appId, body.to, body.reasonCode, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'POST' && action === 'outcomes') {
        const body = await readJson(req);
        const data = await service.recordOutcome(appId, body.attended === true, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'POST' && action === 'review/start') {
        const data = await service.startAppealReview(appId, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'POST' && action === 'review/resolve') {
        const body = await readJson(req);
        const data = await service.resolveAppeal(appId, body.resolution, actor);
        return ok(res, data);
      }
      if (sub && req.method === 'GET' && action === 'note') {
        const data = await service.readSensitiveNote(appId, actor);
        return ok(res, data);
      }

      if (req.method === 'GET' && path === '/worker/applications') {
        const data = service.workerList(url.searchParams.get('resource') ?? undefined, actor);
        return ok(res, data);
      }
      if (req.method === 'POST' && path === '/allocations/run') {
        const data = await service.allocate(url.searchParams.get('resource') ?? undefined, actor);
        return ok(res, data);
      }
      if (req.method === 'GET' && path === '/director/resources') {
        return ok(res, service.resourceOverview(actor));
      }
      if (req.method === 'GET' && path === '/director/recompute') {
        const data = await service.recompute(actor);
        return ok(res, data);
      }
      if (req.method === 'POST' && path === '/policies') {
        const body = await readJson(req);
        const data = await service.activatePolicy(body, actor);
        return ok(res, data, 201);
      }

      return fail(res, 404, 'not-found');
    } catch (err) {
      if (err instanceof DomainError) {
        const status = err.code === 'forbidden' ? 403
          : err.code === 'application-not-found' ? 404
          : ['bad-application-id', 'bad-resource', 'bad-urgency', 'bad-proof-date', 'bad-teacher-ref', 'bad-resolution', 'bad-appeal-reason-code', 'immediate-requires-reason-code', 'immediate-requires-escalation', 'escalation-must-increase'].includes(err.code) ? 400
          : 422;
        return fail(res, status, err.code, err.details);
      }
      if (err instanceof SyntaxError) return fail(res, 400, 'bad-json');
      // 不向调用方泄露内部细节。
      return fail(res, 500, 'internal-error');
    }
  });
}
