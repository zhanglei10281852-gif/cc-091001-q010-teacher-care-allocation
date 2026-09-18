import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRules,
  makeClock,
  makeService,
  manager,
  operator,
  proofFrom,
  submitInput,
  teacher,
} from './helpers.js';

test('提交即核验：容量充足时直接占用，并留下可复算决策', async () => {
  const { service, store } = await makeService();
  const { application } = await service.submitApplication(teacher('T-1'), submitInput(makeClock()));
  assert.equal(application.state, 'allocated');
  assert.equal(store.activeAllocations('counselling').length, 1);
  assert.equal(store.decisions.length, 1);
  assert.equal(store.decisions[0].chosenId, application.applicationId);
  assert.equal(store.decisions[0].policyVersion, '2026.2');
});

test('容量满后进入排队，等待解释只有位置与数量', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  for (const id of ['T-1', 'T-2', 'T-3']) {
    await service.submitApplication(teacher(id), submitInput(clock));
  }
  const { application: fourth } = await service.submitApplication(teacher('T-4'), submitInput(clock));
  assert.equal(fourth.state, 'waiting');
  const info = service.waitingInfo(fourth);
  assert.equal(info.position, 1);
  assert.equal(info.aheadCount, 0);
  assert.equal(info.capacity, 3);
  assert.equal(info.inUse, 3);
});

test('重复申请被拒：同一教师同一资源已有活跃申请', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  await service.submitApplication(teacher('T-1'), submitInput(clock));
  await assert.rejects(
    () => service.submitApplication(teacher('T-1'), submitInput(clock)),
    (err) => err.code === 'duplicate-application' && err.status === 409,
  );
});

test('证明剩余有效期不足时在提交环节拒绝', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  await assert.rejects(
    () => service.submitApplication(teacher('T-1'), submitInput(clock, { proofValidUntil: proofFrom(clock, 3) })),
    (err) => err.code === 'proof-expiring-too-soon' && err.status === 422,
  );
});

test('撤回释放名额并按当时有效优先级递补，撤回者进入冷静期', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  const ids = ['T-1', 'T-2', 'T-3'];
  const allocated = [];
  for (const id of ids) allocated.push((await service.submitApplication(teacher(id), submitInput(clock))).application);
  // 两个等待者：一个 standard 先排，一个 priority 后排
  const waitingStandard = (await service.submitApplication(teacher('T-4'), submitInput(clock))).application;
  clock.advance(1);
  const waitingPriority = (await service.submitApplication(teacher('T-5'), submitInput(clock, { urgency: 'priority' }))).application;
  assert.equal(waitingStandard.state, 'waiting');
  assert.equal(waitingPriority.state, 'waiting');

  await service.withdraw(teacher('T-1'), allocated[0].applicationId);
  // priority 权重 3 > standard 1 + 等待加分，后来提交的紧急申请先获得资源
  assert.equal(service.getApplication(operator(), waitingPriority.applicationId).state, 'allocated');
  assert.equal(service.getApplication(operator(), waitingStandard.applicationId).state, 'waiting');
  const releaseDecision = store.decisions.at(-1);
  assert.equal(releaseDecision.trigger, 'release');
  assert.equal(releaseDecision.chosenId, waitingPriority.applicationId);

  // 冷静期内不可再申请同一资源
  await assert.rejects(
    () => service.submitApplication(teacher('T-1'), submitInput(clock)),
    (err) => err.code === 'cooling-off',
  );
  clock.advance(8); // 撤回冷静期 7 天
  const again = await service.submitApplication(teacher('T-1'), submitInput(clock));
  assert.ok(['waiting', 'allocated'].includes(again.application.state));
});

test('经办人升级紧急等级后，递补顺序随之改变', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const allocated = [];
  for (const id of ['T-1', 'T-2', 'T-3']) allocated.push((await service.submitApplication(teacher(id), submitInput(clock))).application);
  const first = (await service.submitApplication(teacher('T-4'), submitInput(clock))).application;
  clock.advance(5);
  const second = (await service.submitApplication(teacher('T-5'), submitInput(clock))).application;

  // 未升级时：先提交者分数更高（等待加分）
  let q = service.queue(operator(), 'counselling');
  assert.equal(q[0].applicationId, first.applicationId);

  await service.escalate(operator(), second.applicationId, 'immediate');
  q = service.queue(operator(), 'counselling');
  assert.equal(q[0].applicationId, second.applicationId);

  await service.complete(operator(), allocated[0].applicationId);
  assert.equal(service.getApplication(operator(), second.applicationId).state, 'allocated');
  assert.equal(service.getApplication(operator(), first.applicationId).state, 'waiting');
});

test('升级只能上调且不能作用于已承诺申请', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const allocated = [];
  for (const id of ['T-1', 'T-2', 'T-3']) {
    allocated.push((await service.submitApplication(teacher(id), submitInput(clock))).application);
  }
  const waiting = (await service.submitApplication(teacher('T-4'), submitInput(clock, { urgency: 'priority' }))).application;
  assert.equal(waiting.state, 'waiting');
  // 排队中的申请：下调被拒
  await assert.rejects(
    () => service.escalate(operator(), waiting.applicationId, 'standard'),
    (err) => err.code === 'escalation-not-upward',
  );
  // 已承诺的申请：任何调整都被拒
  await assert.rejects(
    () => service.escalate(operator(), allocated[0].applicationId, 'immediate'),
    (err) => err.code === 'already-committed',
  );
});

test('证明过期者不参与递补，更新证明后恢复资格', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  const only = (await service.submitApplication(teacher('T-1'), submitInput(clock))).application;
  // 用满其余容量，只留一个等待场景
  await service.submitApplication(teacher('T-2'), submitInput(clock));
  await service.submitApplication(teacher('T-3'), submitInput(clock));
  const expiring = (await service.submitApplication(
    teacher('T-4'),
    submitInput(clock, { proofValidUntil: proofFrom(clock, 10) }),
  )).application;
  const healthy = (await service.submitApplication(teacher('T-5'), submitInput(clock))).application;

  clock.advance(15); // T-4 的证明已过期
  await service.complete(operator(), only.applicationId);

  assert.equal(service.getApplication(operator(), healthy.applicationId).state, 'allocated');
  const held = service.getApplication(operator(), expiring.applicationId);
  assert.equal(held.state, 'waiting');
  assert.equal(held.holdReason, 'proof-expired');
  const decision = store.decisions.find((d) => d.chosenId === healthy.applicationId);
  const skipped = decision.candidates.find((c) => c.applicationId === expiring.applicationId);
  assert.equal(skipped.skipReason, 'proof-expired');

  // 更新证明后解除挂起，下一次释放时参与递补
  await service.updateProof(teacher('T-4'), expiring.applicationId, proofFrom(clock, 20));
  assert.equal(service.getApplication(operator(), expiring.applicationId).holdReason, null);
  await service.complete(operator(), healthy.applicationId);
  assert.equal(service.getApplication(operator(), expiring.applicationId).state, 'allocated');
});

test('爽约：释放名额、记录冷静期，申诉推翻后回到排队且不重复占用', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  const noShowApp = (await service.submitApplication(teacher('T-1'), submitInput(clock))).application;
  await service.submitApplication(teacher('T-2'), submitInput(clock));
  await service.submitApplication(teacher('T-3'), submitInput(clock));
  const waiting = (await service.submitApplication(teacher('T-4'), submitInput(clock))).application;

  await service.markNoShow(operator(), noShowApp.applicationId);
  const closed = service.getApplication(operator(), noShowApp.applicationId);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closeReason, 'no-show');
  assert.equal(service.getApplication(operator(), waiting.applicationId).state, 'allocated');
  assert.ok(store.activeAllocations('counselling').length <= 3);

  // 冷静期内不能再申请
  await assert.rejects(
    () => service.submitApplication(teacher('T-1'), submitInput(clock)),
    (err) => err.code === 'cooling-off',
  );

  // 申诉 → 复核 → 推翻：回到排队，冷静期清除
  await service.appeal(teacher('T-1'), noShowApp.applicationId);
  await service.review(operator(), noShowApp.applicationId, { action: 'start' });
  await service.review(operator(), noShowApp.applicationId, { action: 'resolve', outcome: 'overturned', reason: '当日有校车故障证明' });
  const reinstated = service.getApplication(operator(), noShowApp.applicationId);
  assert.equal(reinstated.state, 'waiting');
  assert.equal(reinstated.reviewState, 'resolved');
  assert.ok(store.activeAllocations('counselling').length <= 3);

  // 释放一个名额后按优先级递补到它
  const someAllocated = store.activeAllocations('counselling')[0];
  await service.complete(operator(), someAllocated.applicationId);
  assert.equal(service.getApplication(operator(), noShowApp.applicationId).state, 'allocated');
  // 同一申请只有一条未结束的占用记录
  const actives = [...store.allocations.values()].filter((a) => a.applicationId === noShowApp.applicationId && !a.endedAt);
  assert.equal(actives.length, 1);
});

test('复核维持原结论：状态不变，冷静期继续生效', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const { application } = await service.submitApplication(teacher('T-1'), submitInput(clock));
  await service.markNoShow(operator(), application.applicationId);
  await service.appeal(teacher('T-1'), application.applicationId);
  await service.review(operator(), application.applicationId, { action: 'start' });
  await service.review(operator(), application.applicationId, { action: 'resolve', outcome: 'upheld' });
  const app = service.getApplication(operator(), application.applicationId);
  assert.equal(app.state, 'closed');
  assert.equal(app.reviewState, 'resolved');
  await assert.rejects(
    () => service.submitApplication(teacher('T-1'), submitInput(clock)),
    (err) => err.code === 'cooling-off',
  );
});

test('规则版本变化只作用于尚未承诺的申请', async () => {
  const clock = makeClock();
  const { service, store, policies } = await makeService({ clock });
  const committed = (await service.submitApplication(teacher('T-1'), submitInput(clock))).application;
  await service.submitApplication(teacher('T-2'), submitInput(clock));
  await service.submitApplication(teacher('T-3'), submitInput(clock));
  const waiting = (await service.submitApplication(teacher('T-4'), submitInput(clock))).application;

  // 新版本：counselling 扩容 3→4，服务周期缩短
  const rules20262 = await loadRules();
  const next = structuredClone(rules20262);
  next.version = '2026.3';
  next.resources.counselling.capacity = 4;
  next.resources.counselling.sessionDays = 7;
  await service.publishPolicy(manager(), next);

  // 等待中的申请按新版本获得承诺
  const promoted = service.getApplication(operator(), waiting.applicationId);
  assert.equal(promoted.state, 'allocated');
  assert.equal(promoted.policyVersion, '2026.3');
  const newAlloc = [...store.allocations.values()].find((a) => a.applicationId === waiting.applicationId);
  assert.equal(newAlloc.terms.sessionDays, 7);

  // 既有承诺钉住旧版本条款，不受新版本影响
  const oldAlloc = [...store.allocations.values()].find((a) => a.applicationId === committed.applicationId);
  assert.equal(oldAlloc.policyVersion, '2026.2');
  assert.equal(oldAlloc.terms.sessionDays, 14);
  assert.equal(policies.get('2026.2').resources.counselling.capacity, 3);
});

test('政策缩容不撤销既有承诺，但在容量回落前不再新增占用', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  for (const id of ['T-1', 'T-2', 'T-3']) await service.submitApplication(teacher(id), submitInput(clock));
  const waiting = (await service.submitApplication(teacher('T-4'), submitInput(clock))).application;

  const rules = await loadRules();
  const shrunk = structuredClone(rules);
  shrunk.version = '2026.4';
  shrunk.resources.counselling.capacity = 1;
  await service.publishPolicy(manager(), shrunk);

  const report = service.capacityReport(manager());
  assert.equal(report.resources.counselling.inUse, 3);
  assert.equal(report.resources.counselling.overCapacity, true); // 既有承诺保留
  assert.equal(service.getApplication(operator(), waiting.applicationId).state, 'waiting'); // 不再新增

  // 释放一个后 inUse=2 仍高于新容量 1，继续不递补
  const { store } = service;
  const first = store.activeAllocations('counselling')[0];
  await service.complete(operator(), first.applicationId);
  assert.equal(service.getApplication(operator(), waiting.applicationId).state, 'waiting');
});

test('负责人可复算每一次分配选择', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  for (const id of ['T-1', 'T-2', 'T-3']) await service.submitApplication(teacher(id), submitInput(clock));
  await service.submitApplication(teacher('T-4'), submitInput(clock, { urgency: 'priority' }));
  await service.submitApplication(teacher('T-5'), submitInput(clock));
  clock.advance(3);
  const first = store.activeAllocations('counselling')[0];
  await service.complete(operator(), first.applicationId);

  assert.ok(store.decisions.length >= 4);
  for (const decision of store.decisions) {
    const result = service.recomputeDecision(manager(), decision.decisionId);
    assert.equal(result.match, true, `决策 ${decision.decisionId} 复算不一致`);
    assert.equal(result.capacityRespected, true);
    assert.deepEqual(result.scoreMismatches, []);
  }
});

test('敏感说明加密分离保存，读取按权限且留痕', async () => {
  const clock = makeClock();
  const { service, store } = await makeService({ clock });
  const secret = '家庭变故，需要回避某些话题';
  const { application } = await service.submitApplication(
    teacher('T-1'),
    submitInput(clock, { sensitiveNote: secret }),
  );
  // 密文与排队数据分离，且不是明文
  const sealed = store.sensitiveNotes.get(application.applicationId);
  assert.ok(sealed);
  assert.notEqual(JSON.stringify(sealed).includes(secret), true);
  assert.equal(JSON.stringify(store.applications.get(application.applicationId)).includes(secret), false);

  // 经办人无权读取，负责人读取成功且审计留痕（不含内容）
  assert.throws(() => service.readSensitive(operator(), application.applicationId), (err) => err.status === 403);
  assert.equal(service.readSensitive(manager(), application.applicationId), secret);
  const reads = store.auditLog.filter((e) => e.action === 'sensitive.read');
  assert.equal(reads.length, 1);
  assert.equal(JSON.stringify(reads[0]).includes(secret), false);
});

test('教师不能为他人提交或查看他人申请', async () => {
  const clock = makeClock();
  const { service } = await makeService({ clock });
  const { application } = await service.submitApplication(teacher('T-1'), submitInput(clock));
  await assert.rejects(
    () => service.submitApplication(teacher('T-2'), submitInput(clock, { teacherRef: 'T-1' })),
    (err) => err.code === 'not-self',
  );
  // 非本人查询按不存在处理，不泄露存在性
  assert.throws(() => service.getApplication(teacher('T-2'), application.applicationId), (err) => err.status === 404);
});
