import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeClock,
  makeHttpServer,
  manager,
  operator,
  submitInput,
  teacher,
} from './helpers.js';

// 并发提交 + 并发释放 + 并发撤回混合压力下，
// 容量不变量（占用 ≤ 容量）在每一次决策和最终状态都必须成立。
test('高并发下容量从未被突破，名额不重复占用', async () => {
  const clock = makeClock();
  const app = await makeHttpServer({ clock });
  try {
    // 30 名教师同时提交，counselling 容量为 3
    const submitters = Array.from({ length: 30 }, (_, i) => `T-${i + 1}`);
    const results = await Promise.all(
      submitters.map((id) => app.call('POST', '/applications', { actor: teacher(id), body: submitInput(clock) })),
    );
    assert.ok(results.every((r) => r.status === 201));
    const states = results.map((r) => r.body.application.state);
    assert.equal(states.filter((s) => s === 'allocated').length, 3);
    assert.equal(states.filter((s) => s === 'waiting').length, 27);

    let cap = await app.call('GET', '/capacity', { actor: manager() });
    assert.equal(cap.body.resources.counselling.inUse, 3);
    assert.equal(cap.body.resources.counselling.overCapacity, false);

    // 已占用的 3 个申请并发办结，同时再有 10 人并发提交
    const allocatedIds = results
      .filter((r) => r.body.application.state === 'allocated')
      .map((r) => r.body.application.applicationId);
    const extra = Array.from({ length: 10 }, (_, i) => `N-${i + 1}`);
    await Promise.all([
      ...allocatedIds.map((id) => app.call('POST', `/applications/${id}/complete`, { actor: operator() })),
      ...extra.map((id) => app.call('POST', '/applications', { actor: teacher(id), body: submitInput(clock) })),
    ]);

    cap = await app.call('GET', '/capacity', { actor: manager() });
    assert.equal(cap.body.resources.counselling.inUse, 3);
    assert.equal(cap.body.resources.counselling.overCapacity, false);
    assert.equal(cap.body.resources.counselling.waiting, 34); // 27 - 3 递补 + 10 新提交

    // 并发撤回两个已占用申请
    const nowAllocated = (await app.call('GET', '/applications?state=allocated', { actor: operator() }))
      .body.applications;
    const victims = nowAllocated.slice(0, 2);
    await Promise.all(
      victims.map((a) => app.call('POST', `/applications/${a.applicationId}/withdraw`, {
        actor: teacher(a.teacherRef),
      })),
    );
    cap = await app.call('GET', '/capacity', { actor: manager() });
    assert.equal(cap.body.resources.counselling.inUse, 3);

    // 每一次占用决策在当时容量约束下作出，且全部可复算一致
    const decisions = (await app.call('GET', '/decisions', { actor: manager() })).body.decisions;
    assert.ok(decisions.length > 0);
    for (const d of decisions) {
      if (d.chosenId !== null) assert.ok(d.inUseBefore < d.capacity, `决策 ${d.decisionId} 超出容量`);
      const check = await app.call('POST', `/decisions/${d.decisionId}/recompute`, { actor: manager() });
      assert.equal(check.body.match, true, `决策 ${d.decisionId} 复算不一致`);
      assert.equal(check.body.capacityRespected, true);
    }

    // 任何申请至多一条未结束的占用记录
    const list = (await app.call('GET', '/applications', { actor: manager() })).body.applications;
    const activeByApp = new Map();
    for (const a of list.filter((x) => x.state === 'allocated')) {
      activeByApp.set(a.applicationId, (activeByApp.get(a.applicationId) ?? 0) + 1);
    }
    assert.ok([...activeByApp.values()].every((n) => n === 1));
  } finally {
    await app.close();
  }
});
