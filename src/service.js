// 核心领域服务：所有写操作都经过单写者互斥，形成串行事务，
// 因而“检查容量 → 选择队首 → 占用名额”不会被并发请求穿插，容量不可能被突破。

import { defaultPolicy, validatePolicy, isCommitted } from './policy.js';
import { urgencyRank, permissions, resourceKinds, urgencyLevels, appealReasonCodes } from './domain.js';
import { hashTeacherRef } from './crypto.js';
import { applyEvent, emptyState, fold } from './projector.js';

export class DomainError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

const BLOCKING_STATES = new Set(['waiting', 'allocated']);

// 资格核验纯规则：给定申请、政策、当前所有申请投影与时刻，得出结论与结构化原因。
// 在线判定与负责人复算共用同一实现，避免两套规则漂移。
export function evaluateEligibility(app, policy, allApps, now) {
  const reasons = [];
  let eligible = true;

  const proof = Date.parse(app.proofValidUntil);
  if (!Number.isFinite(proof)) {
    eligible = false;
    reasons.push('proof-unparseable');
  } else {
    if (proof < now + policy.proof.minRemainingMs) {
      eligible = false;
      reasons.push(proof < now ? 'proof-expired' : 'proof-insufficient-remaining');
    }
    if (proof > app.submittedAt + policy.proof.maxHorizonMs) {
      eligible = false;
      reasons.push('proof-horizon-too-far');
    }
  }

  // 重复申请：同一教师同一资源存在候补/占用中的申请，或存在申诉未决的已关闭申请
  //（防止爽约申诉成立回到候补后，与冷静期过后另提的新申请双重占用）。
  const duplicate = allApps.find(
    (other) =>
      other.applicationId !== app.applicationId &&
      other.teacherHash === app.teacherHash &&
      other.resource === app.resource &&
      (BLOCKING_STATES.has(other.state) || other.review === 'appealed' || other.review === 'reviewing'),
  );
  if (duplicate) {
    eligible = false;
    reasons.push('duplicate-active-application');
  }

  // 爽约冷静期：最近一次同资源 no-show 关闭记录仍在冷静期内。
  const cooldownMs = policy.cooldownMs[app.resource] ?? 0;
  if (cooldownMs > 0) {
    const lastNoShow = allApps
      .filter((other) => other.teacherHash === app.teacherHash && other.resource === app.resource)
      .map((other) => other.noShowAt)
      .filter(Boolean)
      .reduce((m, t) => Math.max(m, t), 0);
    if (lastNoShow > 0 && now < lastNoShow + cooldownMs) {
      eligible = false;
      reasons.push('cooldown-active');
    }
  }

  if (eligible) reasons.push('all-checks-passed');
  return { eligible, reasons, checkedAt: now, policyVersion: policy.version };
}

export function rankOf(urgency) {
  return urgencyRank[urgency];
}

// 确定性排队顺序：紧急度降序、提交时间升序、申请编号升序。
export function compareQueue(a, b) {
  const r = rankOf(b.urgency) - rankOf(a.urgency);
  if (r !== 0) return r;
  if (a.submittedAt !== b.submittedAt) return a.submittedAt - b.submittedAt;
  return a.applicationId < b.applicationId ? -1 : a.applicationId > b.applicationId ? 1 : 0;
}

export class CareService {
  constructor({ store, sensitiveStore, clock = () => Date.now(), seedPolicy = true } = {}) {
    this.store = store;
    this.sensitive = sensitiveStore;
    this.clock = clock;
    this.state = emptyState();
    this._chain = Promise.resolve();
    this._seedPolicy = seedPolicy;
  }

  async init() {
    const events = await this.store.readAll();
    this.state = fold(events);
    if (this._seedPolicy && this.state.activePolicyVersion === null) {
      await this.activatePolicy(defaultPolicy(this.clock()), { role: 'director', ref: 'system-bootstrap' });
    }
  }

  // 把一段工作串行化：同一时刻只有一个事务在读投影/写事件。
  async tx(fn) {
    const run = this._chain.then(() => fn());
    // 链条不因单个事务失败而中断。
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  now() {
    return this.clock();
  }

  activePolicy() {
    const p = this.state.policies.get(this.state.activePolicyVersion);
    if (!p) throw new DomainError('no-active-policy');
    return p;
  }

  _require(actor, action) {
    if (!actor || !permissions[action]?.includes(actor.role)) {
      throw new DomainError('forbidden', { action, role: actor?.role ?? null });
    }
  }

  _getApp(id) {
    const app = this.state.apps.get(id);
    if (!app) throw new DomainError('application-not-found', { applicationId: id });
    return app;
  }

  async _emit(type, data, actor) {
    const event = await this.store.append(type, data, { actor, at: this.now() });
    applyEvent(this.state, event);
    return event;
  }

  // ---------- 资格核验 ----------

  // 纯规则核验：不产生事件，供提交、政策切换、分配前复称复用。
  checkEligibility(app, policy, now = this.now()) {
    return evaluateEligibility(app, policy, [...this.state.apps.values()], now);
  }

  // ---------- 命令 ----------

  async submitApplication(input, actor) {
    return this.tx(async () => {
      this._require(actor, 'application.submit');
      const { applicationId, teacherRef, resource, urgency = 'standard', proofValidUntil, sensitiveNote } = input;
      if (!/^[A-Z0-9-]+$/.test(applicationId ?? '')) throw new DomainError('bad-application-id');
      if (typeof teacherRef !== 'string' || teacherRef.length < 3) throw new DomainError('bad-teacher-ref');
      if (!resourceKinds.includes(resource)) throw new DomainError('bad-resource');
      if (!urgencyLevels.includes(urgency)) throw new DomainError('bad-urgency');
      // 本人提交最多声明 priority；immediate 只能由授权人员升级，防止自我提级插队。
      if (urgency === 'immediate') throw new DomainError('immediate-requires-escalation');
      const proof = Date.parse(proofValidUntil ?? '');
      if (!Number.isFinite(proof)) throw new DomainError('bad-proof-date');
      if (this.state.apps.has(applicationId)) throw new DomainError('duplicate-application-id');

      const now = this.now();
      const policy = this.activePolicy();
      const teacherHash = hashTeacherRef(teacherRef);

      // 先用一个临时投影做资格判断（重复/冷静期需要能查到自己之外的记录）。
      const draft = {
        applicationId, teacherHash, resource, submittedAt: now,
        proofValidUntil: new Date(proof).toISOString(),
      };
      const result = this.checkEligibility(draft, policy, now);

      // 敏感说明先写入独立加密存储：若加密/落盘失败则整个提交中止，
      // 不会留下 hasNote=true 却没有密文的排队事件。
      if (sensitiveNote) {
        await this.sensitive.put(applicationId, sensitiveNote);
      }

      await this._emit('ApplicationSubmitted', {
        applicationId,
        teacherHash, // 排队库只有不可逆指纹，没有教师身份
        resource,
        urgency,
        submittedAt: now,
        proofValidUntil: new Date(proof).toISOString(),
        policyVersion: policy.version,
        hasNote: typeof sensitiveNote === 'string' && sensitiveNote.length > 0,
      }, actor);

      await this._emit('EligibilityVerified', {
        applicationId,
        eligible: result.eligible,
        reasons: result.reasons,
        checkedAt: now,
        policyVersion: policy.version,
      }, { role: 'system', ref: 'eligibility-on-submit' });

      return { applicationId, ...result };
    });
  }

  async renewProof(applicationId, teacherRef, newProofValidUntil, actor) {
    return this.tx(async () => {
      this._require(actor, 'application.renewProof');
      const app = this._getApp(applicationId);
      if (hashTeacherRef(teacherRef) !== app.teacherHash) throw new DomainError('not-owner');
      if (!['submitted', 'waiting'].includes(app.state)) throw new DomainError('illegal-state', { state: app.state });
      const proof = Date.parse(newProofValidUntil ?? '');
      if (!Number.isFinite(proof)) throw new DomainError('bad-proof-date');
      const now = this.now();
      await this._emit('ProofRenewed', {
        applicationId, proofValidUntil: new Date(proof).toISOString(), at: now,
      }, actor);
      const updated = this._getApp(applicationId);
      const result = this.checkEligibility(updated, this.activePolicy(), now);
      await this._emit('EligibilityVerified', {
        applicationId, eligible: result.eligible, reasons: result.reasons,
        checkedAt: now, policyVersion: result.policyVersion,
      }, { role: 'system', ref: 'eligibility-on-renew' });
      return result;
    });
  }

  async withdraw(applicationId, teacherRef, actor) {
    return this.tx(async () => {
      this._require(actor, 'application.withdraw');
      const app = this._getApp(applicationId);
      if (hashTeacherRef(teacherRef) !== app.teacherHash) throw new DomainError('not-owner');
      if (!['submitted', 'waiting', 'allocated'].includes(app.state)) {
        throw new DomainError('illegal-state', { state: app.state });
      }
      const now = this.now();
      if (app.state === 'allocated') await this._releaseLocked(app, 'withdrawn', now, actor);
      await this._emit('ApplicationWithdrawn', { applicationId, at: now }, actor);
      await this._promoteLocked(app.resource, now);
      return { applicationId, state: 'withdrawn' };
    });
  }

  async escalateUrgency(applicationId, to, reasonCode, actor) {
    return this.tx(async () => {
      this._require(actor, 'urgency.escalate');
      const app = this._getApp(applicationId);
      if (!['submitted', 'waiting'].includes(app.state)) throw new DomainError('illegal-state', { state: app.state });
      if (!urgencyLevels.includes(to)) throw new DomainError('bad-urgency');
      if (rankOf(to) <= rankOf(app.urgency)) throw new DomainError('escalation-must-increase');
      const policy = this.activePolicy();
      if (to === 'immediate' && policy.urgency.immediateRequiresReasonCode) {
        if (!reasonCode || !policy.urgency.allowedEscalationReasonCodes.includes(reasonCode)) {
          throw new DomainError('immediate-requires-reason-code');
        }
      }
      const now = this.now();
      await this._emit('UrgencyChanged', {
        applicationId, from: app.urgency, to, reasonCode: reasonCode ?? null, by: actor.ref ?? null, at: now,
      }, actor);
      return { applicationId, urgency: to };
    });
  }

  // 资源释放（内部，调用方已持锁）。alloc/release 严格配对。
  async _releaseLocked(app, reason, now, actor) {
    const active = app.allocations.find((a) => a.releasedAt === null);
    if (!active) throw new DomainError('no-active-allocation');
    await this._emit('AllocationReleased', {
      applicationId: app.applicationId,
      resource: app.resource,
      slotId: active.slotId,
      reason,
      at: now,
    }, actor ?? { role: 'system', ref: `release:${reason}` });
  }

  // 经办人登记结果：attended 正常结束；no-show 关闭并进入冷静期。
  // 两种情况都释放名额，并立刻按“当前有效优先级”递补。
  async recordOutcome(applicationId, attended, actor) {
    return this.tx(async () => {
      this._require(actor, 'outcome.record');
      const app = this._getApp(applicationId);
      if (app.state !== 'allocated') throw new DomainError('illegal-state', { state: app.state });
      const now = this.now();
      const reason = attended ? 'attended' : 'no-show';
      await this._releaseLocked(app, reason, now, actor);
      await this._emit('ApplicationClosed', { applicationId, reason, at: now }, actor);
      const promoted = await this._promoteLocked(app.resource, now);
      return { applicationId, closedReason: reason, promoted };
    });
  }

  // ---------- 申诉复核 ----------

  async fileAppeal(applicationId, teacherRef, reasonCode, actor) {
    return this.tx(async () => {
      this._require(actor, 'application.appeal');
      const app = this._getApp(applicationId);
      if (hashTeacherRef(teacherRef) !== app.teacherHash) throw new DomainError('not-owner');
      if (app.state !== 'closed' || app.closedReason !== 'no-show') {
        // 仅爽约关闭可申诉（资格异议在候补阶段通过原因代码透明展示，无需申诉）。
        throw new DomainError('appeal-only-after-no-show');
      }
      if (app.review !== 'none') {
        throw new DomainError(app.review === 'resolved' ? 'appeal-already-resolved' : 'appeal-already-open');
      }
      if (!appealReasonCodes.includes(reasonCode)) throw new DomainError('bad-appeal-reason-code');
      const now = this.now();
      await this._emit('AppealFiled', { applicationId, reasonCode, hasDetail: false, at: now }, actor);
      return { applicationId, review: 'appealed' };
    });
  }

  async startAppealReview(applicationId, actor) {
    return this.tx(async () => {
      this._require(actor, 'appeal.review');
      const app = this._getApp(applicationId);
      if (app.review !== 'appealed') throw new DomainError('no-open-appeal');
      await this._emit('AppealReviewStarted', { applicationId, at: this.now() }, actor);
      return { applicationId, review: 'reviewing' };
    });
  }

  // 申诉成立（upheld）：撤销 no-show 标记，申请回到候补——它不持有任何名额
  // （名额在关闭时已释放并可能已被递补占用），只能重新排队，杜绝名额重复占用。
  async resolveAppeal(applicationId, resolution, actor) {
    return this.tx(async () => {
      this._require(actor, 'appeal.review');
      const app = this._getApp(applicationId);
      if (app.review !== 'reviewing') throw new DomainError('review-not-started');
      if (!['upheld', 'rejected'].includes(resolution)) throw new DomainError('bad-resolution');
      const now = this.now();
      await this._emit('AppealResolved', {
        applicationId,
        resolution,
        effect: resolution === 'upheld' ? 'reinstate-waiting' : 'none',
        at: now,
      }, actor);
      if (resolution === 'upheld') await this._promoteLocked(app.resource, now);
      return { applicationId, review: 'resolved', resolution };
    });
  }

  // ---------- 政策版本 ----------

  async activatePolicy(policy, actor) {
    return this.tx(async () => {
      this._require(actor, 'policy.activate');
      validatePolicy(policy, { requiredResources: resourceKinds });
      if (this.state.policies.has(policy.version)) throw new DomainError('policy-version-exists');
      await this._emit('PolicyActivated', { policy }, actor);
      // 新版本只立即重验尚未承诺的申请；已 allocated/closed 的申请保持原规则。
      const now = this.now();
      for (const app of [...this.state.apps.values()].filter((a) => !isCommitted(a.state))) {
        if (!['submitted', 'waiting'].includes(app.state)) continue;
        const result = this.checkEligibility(app, policy, now);
        await this._emit('EligibilityVerified', {
          applicationId: app.applicationId,
          eligible: result.eligible,
          reasons: result.reasons,
          checkedAt: now,
          policyVersion: policy.version,
        }, { role: 'system', ref: 'eligibility-on-policy-change' });
      }
      // 容量/规则变化后按新政策递补；缩容不会撤销已作出承诺的占用。
      const now2 = this.now();
      for (const r of resourceKinds) await this._promoteLocked(r, now2);
      return { version: policy.version };
    });
  }

  // ---------- 分配与递补 ----------

  _candidatesFor(resource, now, policy) {
    // 候补队列：仅 waiting 状态参与；分配前按当前有效政策重新核验，
    // 证明过期/变得不合规者本次跳过并记录原因（事件留痕），不占用名额。
    return [...this.state.apps.values()]
      .filter((a) => a.resource === resource && a.state === 'waiting')
      .sort(compareQueue)
      .map((a) => {
        const check = this.checkEligibility(a, policy, now);
        return { app: a, eligible: check.eligible, reasons: check.reasons };
      });
  }

  _freeSlot(resource, policy) {
    const cap = policy.capacities[resource] ?? 0;
    const taken = this.state.occupancy.get(resource) ?? new Set();
    for (let i = 1; i <= cap; i += 1) {
      const slotId = `${resource}#${i}`;
      if (!taken.has(slotId)) return slotId;
    }
    return null;
  }

  async _promoteLocked(resource, now) {
    const promoted = [];

    // 复活步骤：重验停留在 submitted 的申请。此前因重复申请/冷静期被阻断的草稿，
    // 阻断因素可能已经消失（如队首刚因过期退回），恢复资格者转入 waiting 参与本轮。
    // 仍不合格者不重复写事件，保留既有原因与 submitted 状态等待下一次触发。
    const reviveDrafts = async (policy) => {
      let revived = 0;
      const drafts = [...this.state.apps.values()]
        .filter((a) => a.resource === resource && a.state === 'submitted')
        .sort(compareQueue);
      for (const a of drafts) {
        const check = this.checkEligibility(a, policy, now);
        if (check.eligible) {
          await this._emit('EligibilityVerified', {
            applicationId: a.applicationId,
            eligible: true,
            reasons: check.reasons,
            checkedAt: now,
            policyVersion: policy.version,
          }, { role: 'system', ref: 'eligibility-on-promotion-sweep' });
          revived += 1;
        }
      }
      return revived;
    };

    await reviveDrafts(this.activePolicy());

    // 循环直到名额用尽或没有合格队首；每轮都重新评估，确保跳过的申请不阻断后面的人。
    for (;;) {
      const policy = this.activePolicy();
      const slotId = this._freeSlot(resource, policy);
      if (!slotId) break;
      let candidates = this._candidatesFor(resource, now, policy);
      if (candidates.length === 0) break;

      // 把此刻已不合格（如证明过期）的候补人即时刷新：留痕并退回 submitted，
      // 他们不再阻断后续申请人，教师视图也能看到最新原因。
      let demitted = 0;
      for (const c of candidates) {
        if (!c.eligible && c.app.state === 'waiting') {
          await this._emit('EligibilityVerified', {
            applicationId: c.app.applicationId,
            eligible: false,
            reasons: c.reasons,
            checkedAt: now,
            policyVersion: policy.version,
          }, { role: 'system', ref: 'eligibility-on-promotion' });
          demitted += 1;
        }
      }
      // 退回可能改变其他人的判定（如重复阻断解除），先复活受影响草稿，再重算候选列表。
      if (demitted > 0) {
        await reviveDrafts(policy);
        candidates = this._candidatesFor(resource, now, policy);
      }
      if (candidates.length === 0) break;

      const chosen = candidates.find((c) => c.eligible) ?? null;

      // 决策快照：当时的完整排序、每人的核验结果、容量与选中者，供负责人复算。
      const taken = this.state.occupancy.get(resource) ?? new Set();
      const decisionSnapshot = {
        resource,
        at: now,
        policyVersion: policy.version,
        capacity: policy.capacities[resource] ?? 0,
        occupiedBefore: taken.size,
        slotId,
        chosen: chosen ? chosen.app.applicationId : null,
        considered: candidates.map((c, idx) => ({
          order: idx,
          applicationId: c.app.applicationId,
          urgency: c.app.urgency,
          submittedAt: c.app.submittedAt,
          eligible: c.eligible,
          reasons: c.reasons,
        })),
      };

      if (!chosen) {
        // 有候补但全部不合格：记录一次“无分配决策”后结束，避免空转。
        await this._emit('ResourceSkipped', decisionSnapshot, { role: 'system', ref: 'no-eligible-candidate' });
        break;
      }

      await this._emit('ResourceAllocated', { ...decisionSnapshot, applicationId: chosen.app.applicationId },
        { role: 'system', ref: 'allocation' });
      promoted.push(chosen.app.applicationId);
    }
    return promoted;
  }

  // 手动触发某类资源（或全部资源）的分配/递补。
  async allocate(resource, actor) {
    return this.tx(async () => {
      this._require(actor, 'allocation.trigger');
      if (resource !== undefined) {
        if (!resourceKinds.includes(resource)) throw new DomainError('bad-resource');
      }
      const resources = resource ? [resource] : resourceKinds;
      const now = this.now();
      const result = {};
      for (const r of resources) result[r] = await this._promoteLocked(r, now);
      return result;
    });
  }

  // ---------- 查询视图（最小披露） ----------

  // 教师本人视图：阶段 + 只含聚合信息的等待解释，绝不含任何他人身份或申请编号。
  teacherView(applicationId, teacherRef, actor = { role: 'teacher' }) {
    this._require(actor, 'application.viewSelf');
    const app = this._getApp(applicationId);
    if (hashTeacherRef(teacherRef) !== app.teacherHash) throw new DomainError('not-owner');

    const policy = this.activePolicy();
    const view = {
      applicationId,
      resource: app.resource,
      state: app.state,
      urgency: app.urgency,
      hasSensitiveNoteOnFile: app.hasNote,
      proofValidUntil: app.proofValidUntil,
      policyVersion: app.policyVersion,
      eligibility: {
        eligible: app.eligible,
        reasons: app.eligibilityReasons,
        checkedAt: app.eligibleCheckedAt,
      },
      review: app.review,
      waiting: null,
      allocation: null,
    };

    if (app.state === 'waiting') {
      const queue = [...this.state.apps.values()]
        .filter((a) => a.resource === app.resource && a.state === 'waiting')
        .sort(compareQueue);
      const pos = queue.findIndex((a) => a.applicationId === applicationId);
      const ahead = queue.slice(0, Math.max(pos, 0));
      const cap = policy.capacities[app.resource] ?? 0;
      const occupied = (this.state.occupancy.get(app.resource) ?? new Set()).size;
      view.waiting = {
        position: pos + 1,
        totalWaiting: queue.length,
        // 仅聚合数字，不暴露任何他人申请信息。
        aheadByUrgency: {
          immediate: ahead.filter((a) => a.urgency === 'immediate').length,
          priority: ahead.filter((a) => a.urgency === 'priority').length,
          standard: ahead.filter((a) => a.urgency === 'standard').length,
        },
        resourceLoad: { occupied, capacity: cap, free: Math.max(cap - occupied, 0) },
        aheadCount: ahead.length,
      };
    }

    const active = app.allocations.find((a) => a.releasedAt === null);
    if (active || app.state === 'allocated') {
      view.allocation = active ? { at: active.at, slotId: active.slotId } : null;
    }
    return view;
  }

  // 经办人视图：办理所需字段；不含教师真实身份（只有指纹），不含敏感说明。
  workerList(resource, actor) {
    this._require(actor, 'worker.list');
    const apps = [...this.state.apps.values()]
      .filter((a) => !resource || a.resource === resource)
      .sort(compareQueue)
      .map((a) => ({
        applicationId: a.applicationId,
        teacherHash: a.teacherHash,
        resource: a.resource,
        state: a.state,
        urgency: a.urgency,
        submittedAt: a.submittedAt,
        proofValidUntil: a.proofValidUntil,
        eligible: a.eligible,
        eligibilityReasons: a.eligibilityReasons,
        review: a.review,
        policyVersion: a.policyVersion,
        hasSensitiveNoteOnFile: a.hasNote,
      }));
    return { count: apps.length, applications: apps };
  }

  // 读取敏感说明：仅经办人，且每次读取写入审计事件。
  async readSensitiveNote(applicationId, actor) {
    return this.tx(async () => {
      this._require(actor, 'note.read');
      const app = this._getApp(applicationId);
      if (!app.hasNote) throw new DomainError('no-sensitive-note');
      const note = await this.sensitive.get(applicationId);
      await this.store.append('NoteRead', { applicationId, at: this.now() }, { actor, at: this.now() });
      return { applicationId, note };
    });
  }

  // 负责人：资源占用总览。
  resourceOverview(actor) {
    this._require(actor, 'director.viewResources');
    const policy = this.activePolicy();
    const overview = {};
    for (const r of resourceKinds) {
      const occupied = (this.state.occupancy.get(r) ?? new Set()).size;
      const waiting = [...this.state.apps.values()].filter((a) => a.resource === r && a.state === 'waiting').length;
      overview[r] = { capacity: policy.capacities[r] ?? 0, occupied, free: Math.max((policy.capacities[r] ?? 0) - occupied, 0), waiting };
    }
    return { policyVersion: policy.version, resources: overview };
  }

  // ---------- 复算（负责人） ----------

  // 从事件日志独立重放，并校验：
  // 1) 每次分配前，选中者确实是当时队列中合格的队首（独立重建队列比对）；
  // 2) 分配后占用数不超过当时有效政策容量；
  // 3) alloc/release 严格配对、无双重占用（投影本身遇双重占用即抛错）。
  static recompute(events) {
    const report = { decisions: 0, skipped: 0, violations: [], allocationsChecked: [] };

    // 政策激活时间线。
    const timeline = events
      .filter((e) => e.type === 'PolicyActivated')
      .map((e) => ({ at: e.at, policy: e.data.policy }));
    const policyAt = (at) => {
      let current = null;
      for (const t of timeline) if (t.at <= at) current = t.policy;
      return current;
    };

    // 与在线判定共用同一份资格规则；传入的是分配事件发生前的投影事实。
    const recheck = (app, policy, allApps, at) => evaluateEligibility(app, policy, allApps, at).eligible;

    const state = emptyState();
    for (const event of events) {
      if (event.type === 'ResourceAllocated') {
        const d = event.data;
        const policy = policyAt(event.at) ?? state.policies.get(d.policyVersion);
        report.decisions += 1;

        // 在应用本事件之前，独立重建当时该资源的候补队列。
        const queue = [...state.apps.values()]
          .filter((a) => a.resource === d.resource && a.state === 'waiting')
          .sort(compareQueue);
        const eligibleHead = queue.find((a) => recheck(a, policy, [...state.apps.values()], event.at))?.applicationId ?? null;

        // 校验决策快照中的考虑顺序本身符合确定性排序。
        const ids = d.considered.map((c) => c.applicationId);
        const reSorted = d.considered
          .slice()
          .sort((x, y) => {
            const r = rankOf(y.urgency) - rankOf(x.urgency);
            if (r !== 0) return r;
            if (x.submittedAt !== y.submittedAt) return x.submittedAt - y.submittedAt;
            return x.applicationId < y.applicationId ? -1 : x.applicationId > y.applicationId ? 1 : 0;
          })
          .map((c) => c.applicationId);
        if (JSON.stringify(ids) !== JSON.stringify(reSorted)) {
          report.violations.push({ type: 'considered-order-mismatch', eventId: event.eventId });
        }

        if (eligibleHead !== d.chosen) {
          report.violations.push({ type: 'chosen-not-head', eventId: event.eventId, expected: eligibleHead, actual: d.chosen });
        }

        const occupiedBefore = (state.occupancy.get(d.resource) ?? new Set()).size;
        if (occupiedBefore !== d.occupiedBefore) {
          report.violations.push({ type: 'occupancy-snapshot-mismatch', eventId: event.eventId, expected: occupiedBefore, recorded: d.occupiedBefore });
        }
        if (occupiedBefore >= d.capacity) {
          report.violations.push({ type: 'allocation-while-full', eventId: event.eventId });
        }

        report.allocationsChecked.push({ eventId: event.eventId, resource: d.resource, chosen: d.chosen, policyVersion: d.policyVersion });
      }

      if (event.type === 'ResourceSkipped') report.skipped += 1;

      // 应用事件；若发生双重占用/无释放等账本错误，记录为违规并终止重放，
      // 不向上抛出，负责人得到的是结构化结论。
      try {
        applyEvent(state, event);
      } catch (err) {
        report.violations.push({ type: 'ledger-broken', eventId: event.eventId, reason: err.message });
        break;
      }

      if (event.type === 'ResourceAllocated') {
        const d = event.data;
        const policy = policyAt(event.at) ?? state.policies.get(d.policyVersion);
        const occupiedAfter = (state.occupancy.get(d.resource) ?? new Set()).size;
        if (occupiedAfter > (policy?.capacities[d.resource] ?? Infinity)) {
          report.violations.push({ type: 'capacity-exceeded', eventId: event.eventId, resource: d.resource, occupied: occupiedAfter, capacity: policy?.capacities[d.resource] });
        }
      }
    }

    report.ok = report.violations.length === 0;
    return report;
  }

  async recompute(actor) {
    return this.tx(async () => {
      this._require(actor, 'director.recompute');
      const events = await this.store.readAll();
      const report = CareService.recompute(events);
      report.eventCount = events.length;
      return report;
    });
  }
}
