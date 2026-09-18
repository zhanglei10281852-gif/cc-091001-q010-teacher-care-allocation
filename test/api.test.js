import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRules,
  makeClock,
  makeHttpServer,
  manager,
  operator,
  submitInput,
  teacher,
} from './helpers.js';

test('健康检查无需身份，其余端点缺少身份头返回 401', async () => {
  const app = await makeHttpServer();
  try {
    const health = await app.call('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.policyVersion, '2026.2');
    const noAuth = await app.call('GET', '/applications');
    assert.equal(noAuth.status, 401);
  } finally {
    await app.close();
  }
});

test('教师端到端：提交、查询阶段与等待解释，且看不到他人信息', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    for (const id of ['T-1', 'T-2', 'T-3']) {
      const r = await app.call('POST', '/applications', { actor: teacher(id), body: submitInput(clock) });
      assert.equal(r.status, 201);
      assert.equal(r.body.application.state, 'allocated');
    }
    const mine = await app.call('POST', '/applications', { actor: teacher('T-4'), body: submitInput(clock) });
    assert.equal(mine.body.application.state, 'waiting');
    const myId = mine.body.application.applicationId;

    const view = await app.call('GET', `/applications/${myId}`, { actor: teacher('T-4') });
    assert.equal(view.status, 200);
    assert.equal(view.body.application.waiting.position, 1);
    assert.equal(view.body.application.waiting.aheadCount, 0);
    // 等待解释不含任何他人标识
    const text = JSON.stringify(view.body);
    for (const other of ['T-1', 'T-2', 'T-3']) assert.equal(text.includes(other), false);

    // 教师列表只返回自己的申请
    const list = await app.call('GET', '/applications', { actor: teacher('T-4') });
    assert.equal(list.body.applications.length, 1);
    // 教师不能查他人申请（按不存在处理）
    const others = await app.call('GET', '/applications', { actor: teacher('T-1') });
    const otherId = others.body.applications[0].applicationId;
    const forbidden = await app.call('GET', `/applications/${otherId}`, { actor: teacher('T-4') });
    assert.equal(forbidden.status, 404);
  } finally {
    await app.close();
  }
});

test('经办人看到必要字段但看不到敏感内容；负责人可读取且留痕', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    const secret = '涉及个人隐私的敏感说明';
    const created = await app.call('POST', '/applications', {
      actor: teacher('T-1'),
      body: submitInput(clock, { sensitiveNote: secret }),
    });
    const id = created.body.application.applicationId;

    const opView = await app.call('GET', `/applications/${id}`, { actor: operator() });
    assert.equal(opView.status, 200);
    assert.equal(opView.body.application.teacherRef, 'T-1');
    assert.equal(opView.body.application.hasSensitiveNote, true);
    assert.equal(JSON.stringify(opView.body).includes(secret), false);

    const opRead = await app.call('GET', `/applications/${id}/sensitive`, { actor: operator() });
    assert.equal(opRead.status, 403);
    const teacherRead = await app.call('GET', `/applications/${id}/sensitive`, { actor: teacher('T-1') });
    assert.equal(teacherRead.status, 403);
    const mgrRead = await app.call('GET', `/applications/${id}/sensitive`, { actor: manager() });
    assert.equal(mgrRead.status, 200);
    assert.equal(mgrRead.body.note, secret);

    const audit = await app.call('GET', '/audit', { actor: manager() });
    const reads = audit.body.entries.filter((e) => e.action === 'sensitive.read');
    assert.equal(reads.length, 1);
    assert.equal(JSON.stringify(audit.body).includes(secret), false);
  } finally {
    await app.close();
  }
});

test('队列与容量端点对经办人开放、对教师关闭', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    await app.call('POST', '/applications', { actor: teacher('T-1'), body: submitInput(clock) });
    const q = await app.call('GET', '/queue/counselling', { actor: operator() });
    assert.equal(q.status, 200);
    const qAsTeacher = await app.call('GET', '/queue/counselling', { actor: teacher('T-1') });
    assert.equal(qAsTeacher.status, 403);
    const cap = await app.call('GET', '/capacity', { actor: operator() });
    assert.equal(cap.body.resources.counselling.inUse, 1);
    assert.equal(cap.body.resources.counselling.overCapacity, false);
  } finally {
    await app.close();
  }
});

test('重复提交与幂等键：重试不会产生第二个申请', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    const first = await app.call('POST', '/applications', {
      actor: teacher('T-1'),
      body: submitInput(clock),
      headers: { 'idempotency-key': 'req-001' },
    });
    assert.equal(first.status, 201);
    const replay = await app.call('POST', '/applications', {
      actor: teacher('T-1'),
      body: submitInput(clock),
      headers: { 'idempotency-key': 'req-001' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.application.applicationId, first.body.application.applicationId);
    const dup = await app.call('POST', '/applications', { actor: teacher('T-1'), body: submitInput(clock) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'duplicate-application');
    const list = await app.call('GET', '/applications', { actor: teacher('T-1') });
    assert.equal(list.body.applications.length, 1);
  } finally {
    await app.close();
  }
});

test('政策发布权限与复算端点', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    await app.call('POST', '/applications', { actor: teacher('T-1'), body: submitInput(clock) });
    const rules = await loadRules();
    const next = structuredClone(rules);
    next.version = '2026.3';

    const asOperator = await app.call('POST', '/policy/versions', { actor: operator(), body: next });
    assert.equal(asOperator.status, 403);
    const asManager = await app.call('POST', '/policy/versions', { actor: manager(), body: next });
    assert.equal(asManager.status, 201);
    const again = await app.call('POST', '/policy/versions', { actor: manager(), body: next });
    assert.equal(again.status, 409); // 版本不可重复发布

    const decisions = await app.call('GET', '/decisions', { actor: manager() });
    assert.ok(decisions.body.decisions.length >= 1);
    const rec = decisions.body.decisions[0];
    const recompute = await app.call('POST', `/decisions/${rec.decisionId}/recompute`, { actor: manager() });
    assert.equal(recompute.status, 200);
    assert.equal(recompute.body.match, true);
    assert.equal(recompute.body.capacityRespected, true);
    // 经办人不可复算
    const denied = await app.call('POST', `/decisions/${rec.decisionId}/recompute`, { actor: operator() });
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});

test('申诉复核全流程通过 HTTP 完成', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    const created = await app.call('POST', '/applications', { actor: teacher('T-1'), body: submitInput(clock) });
    const id = created.body.application.applicationId;
    await app.call('POST', `/applications/${id}/no-show`, { actor: operator() });
    const appeal = await app.call('POST', `/applications/${id}/appeal`, { actor: teacher('T-1') });
    assert.equal(appeal.body.application.reviewState, 'appealed');
    await app.call('POST', `/applications/${id}/review`, { actor: operator(), body: { action: 'start' } });
    const resolved = await app.call('POST', `/applications/${id}/review`, {
      actor: operator(),
      body: { action: 'resolve', outcome: 'overturned', reason: '情况属实' },
    });
    assert.equal(resolved.body.application.reviewState, 'resolved');
    // 容量未满，推翻后直接获得占用
    assert.equal(resolved.body.application.state, 'allocated');
  } finally {
    await app.close();
  }
});
