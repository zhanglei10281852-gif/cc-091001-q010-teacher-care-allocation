// 端到端性质测试：资格核验、优先级、容量并发、候补递补、
// 证明过期、重复申请、爽约冷静期、申诉不重复占名额、政策版本边界、最小披露视图、复算。

import test from 'node:test';
import assert from 'node:assert/strict';
import { CareService, DomainError } from '../src/service.js';
import { MemoryEventStore } from '../src/store.js';
import { hashTeacherRef } from '../src/crypto.js';

const DAY = 86400000;

function makeService({ now = Date.parse('2026-09-18T09:00:00+08:00') } = {}) {
  let t = now;
  const clock = () => t;
  const service = new CareService({
    store: new MemoryEventStore(),
    sensitiveStore: {
      async put() {},
      async get() {
        return 'plain-note';
      },
    },
    clock,
  });
  return {
    service,
    advance(ms) {
      t += ms;
    },
    setNow(ms) {
      t = ms;
    },
    now: () => t,
  };
}

const teacher = { role: 'teacher', ref: 'T-001' };
const teacher2 = { role: 'teacher', ref: 'T-002' };
const worker = { role: 'worker', ref: 'W-1' };
const director = { role: 'director', ref: 'D-1' };

function proof(service, daysAhead) {
  return new Date(service.now() + daysAhead * DAY).toISOString();
}

async function submit(service, actor, overrides = {}) {
  const id = overrides.applicationId ?? `CARE-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  return service.submitApplication({
    applicationId: id,
    teacherRef: actor.ref,
    resource: 'counselling',
    urgency: 'standard',
    proofValidUntil: proof(service, 30),
    ...overrides,
  }, actor);
}

test('初始化引导默认政策；提交后合格申请进入候补', async () => {
  const { service } = makeService();
  await service.init();
  const r = await submit(service, teacher);
  assert.equal(r.eligible, true);
  const view = service.teacherView(r.applicationId, teacher.ref, teacher);
  assert.equal(view.state, 'waiting');
  assert.equal(view.waiting.position, 1);
});

test('证明过期或剩余不足导致不合格，且不占用名额', async () => {
  const { service } = makeService();
  await service.init();
  const r = await submit(service, teacher, { proofValidUntil: new Date(service.now() - DAY).toISOString() });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('proof-expired'));
  const view = service.teacherView(r.applicationId, teacher.ref, teacher);
  assert.equal(view.state, 'submitted');
  assert.equal(view.waiting, null);

  // 续交证明后进入候补
  const renewed = await service.renewProof(r.applicationId, teacher.ref, proof(service, 10), teacher);
  assert.equal(renewed.eligible, true);
  assert.equal(service.teacherView(r.applicationId, teacher.ref, teacher).state, 'waiting');
});

test('同教师同资源的活跃申请被判定重复', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-A' });
  const r2 = await submit(service, teacher, { applicationId: 'CARE-B' });
  assert.equal(r2.eligible, false);
  assert.ok(r2.reasons.includes('duplicate-active-application'));
});

test('本人不可自报 immediate；授权人员升级需要理由代码且紧急者先获得资源', async () => {
  const { service } = makeService();
  await service.init();
  const early = await submit(service, teacher, { applicationId: 'CARE-EARLY' });
  const late = await submit(service, teacher2, { applicationId: 'CARE-LATE', urgency: 'priority' });
  assert.equal(early.applicationId, 'CARE-EARLY');
  await assert.rejects(() => submit(service, teacher2, { applicationId: 'CARE-X', urgency: 'immediate' }), DomainError);

  // counselling 容量为 2，先分配：早的常规与晚的优先都获得
  let alloc = await service.allocate('counselling', worker);
  assert.deepEqual(alloc.counselling.sort(), ['CARE-EARLY', 'CARE-LATE']);

  // 第三个常规申请排队；升级晚到的申请为 immediate 后，一旦有名额应越过常规队首
  await submit(service, { role: 'teacher', ref: 'T-003' }, { applicationId: 'CARE-STD' });
  await submit(service, { role: 'teacher', ref: 'T-004' }, { applicationId: 'CARE-UP' });
  await assert.rejects(
    () => service.escalateUrgency('CARE-UP', 'immediate', 'bogus-code', worker),
    (e) => e.code === 'immediate-requires-reason-code',
  );
  await service.escalateUrgency('CARE-UP', 'immediate', 'acute-crisis', worker);

  // 释放一个名额（CARE-EARLY 完成），应被刚升级的 CARE-UP 取得，而非更早的 CARE-STD
  const out = await service.recordOutcome('CARE-EARLY', true, worker);
  assert.deepEqual(out.promoted, ['CARE-UP']);
  const viewStd = service.teacherView('CARE-STD', 'T-003', { role: 'teacher', ref: 'T-003' });
  assert.equal(viewStd.state, 'waiting');
  assert.equal(viewStd.waiting.aheadByUrgency.immediate, 0);
});

test('并发提交 + 并发释放下容量从不被突破', async () => {
  const { service } = makeService();
  await service.init();
  // peer-support 容量 3，提交 12 份
  const submitted = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      submit(service, { role: 'teacher', ref: `T-${100 + i}` }, {
        applicationId: `CARE-P${i}`,
        resource: 'peer-support',
      })),
  );
  assert.equal(submitted.length, 12);

  // 并发触发多轮分配与释放
  const allocations = await Promise.all([
    service.allocate('peer-support', worker),
    service.allocate('peer-support', worker),
    service.allocate('peer-support', director),
  ]);
  const flat = allocations.flatMap((a) => a['peer-support']);
  assert.equal(new Set(flat).size, 3); // 恰好 3 个不同申请获得名额

  const overview = service.resourceOverview(director);
  assert.equal(overview.resources['peer-support'].occupied, 3);
  assert.equal(overview.resources['peer-support'].free, 0);

  // 并发释放 3 个名额并同时再次分配，占用仍不得超过 3，且每个释放名额只递补一次
  await Promise.all([
    service.recordOutcome('CARE-P0', true, worker),
    service.recordOutcome('CARE-P1', false, worker),
    service.recordOutcome('CARE-P2', true, worker),
    service.allocate('peer-support', worker),
  ]);
  const after = service.resourceOverview(director).resources['peer-support'];
  assert.equal(after.occupied, 3);
  // 复算无违规
  const report = await service.recompute(director);
  assert.equal(report.ok, true);
  assert.equal(report.violations.length, 0);
});

test('候补期间证明过期：递补时跳过且不阻断后续申请人', async () => {
  const { service, advance } = makeService();
  await service.init();
  // temporary-load-relief 容量 1：先让第三人占住唯一名额
  await submit(service, { role: 'teacher', ref: 'T-009' }, { applicationId: 'CARE-HOLDER', resource: 'temporary-load-relief' });
  advance(1);
  const a = await submit(service, teacher, { applicationId: 'CARE-EXPIRE', resource: 'temporary-load-relief', proofValidUntil: proof(service, 5) });
  advance(1);
  const b = await submit(service, teacher2, { applicationId: 'CARE-FRESH', resource: 'temporary-load-relief' });
  assert.equal(a.eligible, true);
  assert.equal(b.eligible, true);
  await service.allocate('temporary-load-relief', worker);
  assert.equal(service.teacherView('CARE-HOLDER', 'T-009', { role: 'teacher', ref: 'T-009' }).state, 'allocated');

  // 时间推进 6 天：CARE-EXPIRE 的证明失效
  advance(6 * DAY);
  const out = await service.recordOutcome('CARE-HOLDER', true, worker);
  assert.deepEqual(out.promoted, ['CARE-FRESH']);
  const staleView = service.teacherView('CARE-EXPIRE', teacher.ref, teacher);
  assert.equal(staleView.state, 'submitted');
  assert.ok(staleView.eligibility.reasons.includes('proof-expired'));
});

test('爽约触发冷静期，冷静期内重新申请不合格；到期后可再申请', async () => {
  const { service, advance } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-NS' });
  await service.allocate('counselling', worker);
  await service.recordOutcome('CARE-NS', false, worker); // 爽约 → counselling 冷静期 30 天

  advance(5 * DAY);
  const again = await submit(service, teacher, { applicationId: 'CARE-AGAIN' });
  assert.equal(again.eligible, false);
  assert.ok(again.reasons.includes('cooldown-active'));

  advance(40 * DAY);
  const later = await submit(service, teacher, { applicationId: 'CARE-LATER' });
  assert.equal(later.eligible, true);
});

test('申诉成立只回到候补，不重复占用名额；申诉未决阻断重复申请', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-NS2' });
  await submit(service, { role: 'teacher', ref: 'T-010' }, { applicationId: 'CARE-HOLDER-X' });
  await service.allocate('counselling', worker);
  // 队列里放一个等待者，名额释放时会被它拿走
  await submit(service, teacher2, { applicationId: 'CARE-WAIT' });
  await service.recordOutcome('CARE-NS2', false, worker); // 释放名额 → CARE-WAIT 应已递补
  assert.equal(service.teacherView('CARE-WAIT', teacher2.ref, teacher2).state, 'allocated');
  // 此时两个槽位分别由 HOLDER-X 与 WAIT 占满

  // 申诉期间不能重复申请
  await service.fileAppeal('CARE-NS2', teacher.ref, 'no-show-disputed', teacher);
  const dup = await submit(service, teacher, { applicationId: 'CARE-DUP' });
  assert.ok(dup.reasons.includes('duplicate-active-application'));

  await service.startAppealReview('CARE-NS2', worker);
  const resolved = await service.resolveAppeal('CARE-NS2', 'upheld', worker);
  assert.equal(resolved.resolution, 'upheld');
  const view = service.teacherView('CARE-NS2', teacher.ref, teacher);
  assert.equal(view.state, 'waiting'); // 回到候补而非直接占用
  const overview = service.resourceOverview(director).resources.counselling;
  assert.equal(overview.occupied, 2); // 容量 2：CARE-WAIT + 另一分配者，未被突破

  const report = await service.recompute(director);
  assert.equal(report.ok, true);
});

test('撤回已占用申请会释放名额并递补；撤回释放与关闭释放不重复', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-HOLD2' });
  await submit(service, teacher2, { applicationId: 'CARE-WAIT2' });
  await service.allocate('counselling', worker);
  assert.equal(service.teacherView('CARE-HOLD2', teacher.ref, teacher).state, 'allocated');
  const w = await service.withdraw('CARE-HOLD2', teacher.ref, teacher);
  assert.equal(w.state, 'withdrawn');
  assert.equal(service.teacherView('CARE-WAIT2', teacher2.ref, teacher2).state, 'allocated');
  const overview = service.resourceOverview(director).resources.counselling;
  assert.equal(overview.occupied, 1); // HOLD2 已释放，仅剩 WAIT2
});

test('政策版本变化只影响未承诺申请；已分配者沿用旧容量承诺', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-OLD' });
  await service.allocate('counselling', worker);
  assert.equal(service.teacherView('CARE-OLD', teacher.ref, teacher).state, 'allocated');

  // 激活 2026.3：counselling 缩容到 1，且证明窗口加长到 60 天
  const newPolicy = {
    version: '2026.3',
    activatedAt: service.now(),
    capacities: { counselling: 1, 'temporary-load-relief': 1, 'peer-support': 3 },
    proof: { minRemainingMs: 60 * DAY, maxHorizonMs: 365 * DAY },
    cooldownMs: { counselling: 30 * DAY, 'temporary-load-relief': 14 * DAY, 'peer-support': 14 * DAY },
    urgency: { immediateRequiresReasonCode: true, allowedEscalationReasonCodes: ['acute-crisis', 'safety-risk', 'management-directed'] },
    ordering: { tieBreaker: 'submittedAt' },
    notes: '缩容+加长证明窗口',
  };
  // 一个证明只剩 30 天的未承诺候补人会因新规则变为不合格
  await submit(service, teacher2, { applicationId: 'CARE-PEND', proofValidUntil: proof(service, 30) });
  assert.equal(service.teacherView('CARE-PEND', teacher2.ref, teacher2).state, 'waiting');
  await service.activatePolicy(newPolicy, director);
  assert.equal(service.teacherView('CARE-PEND', teacher2.ref, teacher2).state, 'submitted');
  assert.ok(service.teacherView('CARE-PEND', teacher2.ref, teacher2).eligibility.reasons.includes('proof-insufficient-remaining'));

  // 已承诺的 CARE-OLD 不被收回；占用数允许暂时等于旧容量 2（此处为 1，因为只有它一人）
  assert.equal(service.teacherView('CARE-OLD', teacher.ref, teacher).state, 'allocated');
  const overview = service.resourceOverview(director);
  assert.equal(overview.resources.counselling.capacity, 1);
  assert.equal(overview.resources.counselling.occupied, 1);
  assert.equal(overview.policyVersion, '2026.3');
});

test('最小披露：教师视图不含他人信息；排队解释只有聚合数字', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-ME' });
  await submit(service, teacher2, { applicationId: 'CARE-OTHER' });
  const view = service.teacherView('CARE-ME', teacher.ref, teacher);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('CARE-OTHER'));
  assert.ok(!json.includes(hashTeacherRef(teacher2.ref)));
  assert.equal(view.waiting.aheadCount, 0); // 同为 standard，按提交时间，ME 排第一

  // 不能查别人的申请
  assert.throws(() => service.teacherView('CARE-OTHER', teacher.ref, teacher), (e) => e.code === 'not-owner');
});

test('最小披露：经办人视图无敏感说明、无真实身份；读取说明留审计事件', async () => {
  const { service, store } = (() => {
    const env = makeService();
    return { service: env.service, store: env.service.store };
  })();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-NOTE', sensitiveNote: '家庭隐私情况……' });
  const list = service.workerList(undefined, worker);
  const row = list.applications.find((a) => a.applicationId === 'CARE-NOTE');
  assert.equal(row.hasSensitiveNoteOnFile, true);
  assert.ok(!('note' in row));
  assert.ok(!JSON.stringify(row).includes('家庭隐私'));
  assert.notEqual(row.teacherHash, teacher.ref);

  // 教师不能读敏感说明
  assert.throws(() => service.workerList(undefined, teacher), (e) => e.code === 'forbidden');

  // 经办人读取后有 NoteRead 审计事件
  const read = await service.readSensitiveNote('CARE-NOTE', worker);
  assert.equal(read.note, 'plain-note'); // mock store 返回值；真实链路由 crypto 测试覆盖
  const events = await store.readAll();
  assert.ok(events.some((e) => e.type === 'NoteRead' && e.actor.role === 'worker'));
});

test('权限矩阵：教师不能升级/登记结果/激活政策/复算', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-PERM' });
  await service.allocate('counselling', worker);
  assert.throws(() => service.workerList(undefined, teacher), (e) => e.code === 'forbidden');
  await assert.rejects(() => service.escalateUrgency('CARE-PERM', 'priority', null, teacher), (e) => e.code === 'forbidden');
  await assert.rejects(() => service.recordOutcome('CARE-PERM', true, teacher), (e) => e.code === 'forbidden');
  await assert.rejects(() => service.activatePolicy({ version: '2099.1' }, teacher), (e) => e.code === 'forbidden');
  await assert.rejects(() => service.recompute(teacher), (e) => e.code === 'forbidden');
  // worker 也不能激活政策
  await assert.rejects(() => service.activatePolicy({ version: '2099.1' }, worker), (e) => e.code === 'forbidden');
});

test('复算检测到被篡改的分配决策', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-V1' });
  await submit(service, teacher2, { applicationId: 'CARE-V2' });
  await service.allocate('counselling', worker);
  const events = await service.store.readAll();
  const tampered = events.map((e) => {
    if (e.type === 'ResourceAllocated') {
      return { ...e, data: { ...e.data, chosen: 'CARE-FAKE' } };
    }
    return e;
  });
  const report = CareService.recompute(tampered);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.type === 'chosen-not-head'));
});

test('队首因过期退回候补时，曾被其重复阻断的后续申请立即解除阻断并递补', async () => {
  const { service, advance } = makeService();
  await service.init();
  // temporary-load-relief 容量 1：持名额者占住
  await submit(service, { role: 'teacher', ref: 'T-020' }, { applicationId: 'CARE-H', resource: 'temporary-load-relief' });
  advance(1);
  // 同一教师 T-001：A 先在候补（证明 5 天后过期），B 随后因重复停留在 submitted
  await submit(service, teacher, { applicationId: 'CARE-A', resource: 'temporary-load-relief', proofValidUntil: proof(service, 5) });
  advance(1);
  const b = await submit(service, teacher, { applicationId: 'CARE-B', resource: 'temporary-load-relief' });
  assert.ok(b.reasons.includes('duplicate-active-application'));
  assert.equal(service.teacherView('CARE-B', teacher.ref, teacher).state, 'submitted');
  await service.allocate('temporary-load-relief', worker);

  // 6 天后持名额者完成：A 过期退回 submitted，B 解除阻断后应获得名额
  advance(6 * DAY);
  const out = await service.recordOutcome('CARE-H', true, worker);
  assert.deepEqual(out.promoted, ['CARE-B']);
  assert.equal(service.teacherView('CARE-B', teacher.ref, teacher).state, 'allocated');
  assert.equal(service.teacherView('CARE-A', teacher.ref, teacher).state, 'submitted');
  const report = await service.recompute(director);
  assert.equal(report.ok, true);
});

test('复算检测到槽位双重占用的损坏账本', async () => {
  const { service } = makeService();
  await service.init();
  await submit(service, teacher, { applicationId: 'CARE-D1' });
  await submit(service, teacher2, { applicationId: 'CARE-D2' });
  await service.allocate('counselling', worker); // D1、D2 各占一个槽位
  // 直接向日志伪造一条占用已占槽位、且没有释放配对的事件
  await service.store.append('ResourceAllocated', {
    applicationId: 'CARE-D2',
    resource: 'counselling',
    at: service.now(),
    slotId: 'counselling#1', // 已被 D1 占用
    considered: [],
    chosen: 'CARE-D2',
    policyVersion: '2026.2',
    capacity: 2,
    occupiedBefore: 2,
  }, { actor: { role: 'worker', ref: 'W-X' }, at: service.now() });

  const events = await service.store.readAll();
  const report = CareService.recompute(events);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.type === 'ledger-broken'));
});
