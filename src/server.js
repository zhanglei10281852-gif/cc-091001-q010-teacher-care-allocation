import http from 'node:http';
import { badRequest, ServiceError, unauthorized } from './errors.js';
import { viewFor } from './views.js';

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('body-invalid-json', '请求体不是合法 JSON');
  }
}

function actorFrom(req) {
  const id = req.headers['x-actor-id'];
  const role = req.headers['x-actor-role'];
  if (!id || !role) throw unauthorized('缺少 x-actor-id / x-actor-role 请求头');
  return { id, role };
}

// 极简路由：method + 段匹配，:name 为路径参数
function matchRoutes(routes, method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pSeg = pattern.split('/').filter(Boolean);
    const uSeg = pathname.split('/').filter(Boolean);
    if (pSeg.length !== uSeg.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pSeg.length; i += 1) {
      if (pSeg[i].startsWith(':')) params[pSeg[i].slice(1)] = decodeURIComponent(uSeg[i]);
      else if (pSeg[i] !== uSeg[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export function createServer({ service }) {
  const appView = (actor, app) => viewFor(actor, app, service.waitingInfo(app));

  const routes = [
    ['GET', '/health', async () => ({
      status: 200,
      body: { ok: true, policyVersion: service.policies.current().version },
    })],

    ['POST', '/applications', async ({ actor, body, req }) => {
      const { application, idempotentReplay } = await service.submitApplication(
        actor,
        body,
        req.headers['idempotency-key'],
      );
      return { status: idempotentReplay ? 200 : 201, body: { application: appView(actor, application) } };
    }],

    ['GET', '/applications', async ({ actor, query }) => {
      const apps = service.listApplications(actor, {
        teacherRef: query.get('teacherRef') ?? undefined,
        resource: query.get('resource') ?? undefined,
        state: query.get('state') ?? undefined,
      });
      return { status: 200, body: { applications: apps.map((a) => appView(actor, a)) } };
    }],

    ['GET', '/applications/:id', async ({ actor, params }) => {
      const app = service.getApplication(actor, params.id);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/withdraw', async ({ actor, params }) => {
      const app = await service.withdraw(actor, params.id);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/escalate', async ({ actor, params, body }) => {
      const app = await service.escalate(actor, params.id, body.to);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/proof', async ({ actor, params, body }) => {
      const app = await service.updateProof(actor, params.id, body.proofValidUntil);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/complete', async ({ actor, params }) => {
      const app = await service.complete(actor, params.id);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/no-show', async ({ actor, params }) => {
      const app = await service.markNoShow(actor, params.id);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/appeal', async ({ actor, params }) => {
      const app = await service.appeal(actor, params.id);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['POST', '/applications/:id/review', async ({ actor, params, body }) => {
      const app = await service.review(actor, params.id, body);
      return { status: 200, body: { application: appView(actor, app) } };
    }],

    ['GET', '/applications/:id/sensitive', async ({ actor, params }) => {
      const note = service.readSensitive(actor, params.id);
      return { status: 200, body: { applicationId: params.id, note } };
    }],

    ['GET', '/queue/:resource', async ({ actor, params }) => ({
      status: 200,
      body: { resource: params.resource, queue: service.queue(actor, params.resource) },
    })],

    ['GET', '/capacity', async ({ actor }) => ({
      status: 200,
      body: service.capacityReport(actor),
    })],

    ['GET', '/audit', async ({ actor }) => ({
      status: 200,
      body: { entries: service.auditLog(actor) },
    })],

    ['GET', '/decisions', async ({ actor }) => ({
      status: 200,
      body: { decisions: service.listDecisions(actor) },
    })],

    ['POST', '/decisions/:id/recompute', async ({ actor, params }) => ({
      status: 200,
      body: service.recomputeDecision(actor, params.id),
    })],

    ['GET', '/policy', async ({ actor }) => ({
      status: 200,
      body: service.currentPolicy(actor),
    })],

    ['POST', '/policy/versions', async ({ actor, body }) => {
      const frozen = await service.publishPolicy(actor, body);
      return { status: 201, body: { policy: frozen } };
    }],
  ];

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const matched = matchRoutes(routes, req.method, url.pathname);
      if (!matched) {
        sendJson(res, 404, { error: { code: 'route-not-found', message: '路由不存在' } });
        return;
      }
      const needsActor = !(req.method === 'GET' && url.pathname === '/health');
      const actor = needsActor ? actorFrom(req) : null;
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await matched.handler({ actor, params: matched.params, query: url.searchParams, body, req });
      sendJson(res, result.status, result.body);
    } catch (err) {
      const status = err instanceof ServiceError ? err.status : 500;
      const code = err instanceof ServiceError ? err.code : 'internal-error';
      if (status === 500) console.error(err);
      sendJson(res, status, {
        error: { code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
  });
}
