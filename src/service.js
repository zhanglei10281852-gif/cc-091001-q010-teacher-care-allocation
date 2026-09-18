import {
  activeStates,
  appealableReasons,
  reviewOutcomes,
  terminalStates,
  urgencyLevels,
  urgencyRank,
} from './domain.js';
import { KeyedMutex } from './locks.js';
import { compareCandidates, computeScore } from './policy.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from './errors.js';

const DAY_MS = 86400000;
const SYSTEM = { id: 'system', role: 'system' };

// 教师关怀资源分配领域服务：资格核验、优先级、占用、递补、复核全部在此收口。
// 所有写路径在到达第一个 await 之前完成状态校验与落库，配合按资源互斥锁，
// 保证并发请求下容量不被突破、名额不被重复占用。
export class CareService {
  constructor({ store, policies, box, now = () => new Date() }) {
    this.store = store;
    this.policies = policies;
    this.box = box;
    this.now = now;
    this.mutex = new KeyedMutex();
  }

  // ---------- 内部工具 ----------

  #rules() {
    return this.policies.current();
  }

  #can(actor, action) {
    const perms = this.#rules().roles?.[actor.role] ?? [];
    return perms.includes('*') || perms.includes(action);
  }

  #require(actor, action) {
    if (!this.#can(actor, action)) {
      throw forbidden('forbidden', `角色 ${actor.role} 无权执行 ${action}`);
    }
  }

  #audit(actor, action, details = {}) {
    const who = actor ?? SYSTEM;
    this.store.auditLog.push({
      seq: ++this.store.counters.audit,
      at: this.now().toISOString(),
      actorId: who.id,
      actorRole: who.role,
      action,
      ...details,
    });
  }

  #history(app, action, actor, detail) {
    app.history.push({
      at: this.now().toISOString(),
      action,
      actorRole: (actor ?? SYSTEM).role,
      ...(detail ? { detail } : {}),
    });
  }

  #getApp(applicationId) {
    const app = this.store.applications.get(applicationId);
    if (!app) throw notFound('application-not-found', `申请 ${applicationId} 不存在`);
    return app;
  }

  #isOwner(actor, app) {
    return actor.role === 'teacher' && actor.id === app.teacherRef;
  }

  #requireView(actor, app) {
    if (this.#isOwner(actor, app) && this.#can(actor, 'application:view-own')) return;
    if (this.#can(actor, 'application:view-any')) return;
    // 对非本人申请一律按不存在处理，避免泄露他人申请的存在性
    throw notFound('application-not-found', `申请 ${app.applicationId} 不存在`);
  }

  #coolingKey(teacherRef, resource) {
    return `${teacherRef}|${resource}`;
  }

  #activeCooling(teacherRef, resource) {
    const hit = this.store.coolingOff.get(this.#coolingKey(teacherRef, resource));
    return hit && Date.parse(hit.until) > this.now().getTime() ? hit : null;
  }

  #proofValid(app) {
    return Date.parse(app.proofValidUntil) > this.now().getTime();
  }

  // ---------- 分配核心（在资源互斥锁内执行） ----------

  // 每次产生占用都留下完整决策记录（候选、得分、跳过原因、容量快照），
  // 负责人可据此按当时政策版本复算每一次选择。
  async #tryAllocate(resource, trigger, actor) {
    return this.mutex.run(resource, async () => {
      const decisions = [];
      const rules = this.#rules();
      const capacity = rules.resources[resource].capacity;
      for (;;) {
        const inUse = this.store.activeAllocations(resource).length;
        if (inUse >= capacity) break;
        const now = this.now();
        const pool = [...this.store.applications.values()].filter(
          (a) => a.resource === resource && (a.state === 'eligible' || a.state === 'waiting'),
        );
        if (pool.length === 0) break;

        const candidates = pool.map((app) => {
          let skipReason = null;
          if (rules.proof.mustBeValidAtAllocation && !this.#proofValid(app)) {
            // 证明过期：挂起并跳过，绝不允许带着过期证明占用名额
            skipReason = 'proof-expired';
            if (app.holdReason !== 'proof-expired') {
              app.holdReason = 'proof-expired';
              this.#history(app, 'hold:proof-expired', actor);
              this.#audit(actor, 'application.hold', { applicationId: app.applicationId, reason: 'proof-expired' });
            }
          } else if (app.holdReason) {
            skipReason = app.holdReason;
          }
          return {
            applicationId: app.applicationId,
            urgency: app.urgency,
            submittedAt: app.submittedAt,
            score: skipReason ? null : computeScore(app, rules, now),
            skipReason,
          };
        });

        const runnable = candidates.filter((c) => !c.skipReason).sort(compareCandidates);
        const chosen = runnable[0] ?? null;
        const decision = {
          decisionId: this.store.nextId('decision', 'DEC'),
          at: now.toISOString(),
          resource,
          trigger,
          policyVersion: rules.version,
          capacity,
          inUseBefore: inUse,
          candidates,
          chosenId: chosen?.applicationId ?? null,
        };
        this.store.decisions.push(decision);
        decisions.push(decision);
        if (!chosen) break;

        const app = this.store.applications.get(chosen.applicationId);
        app.state = 'allocated';
        app.holdReason = null;
        app.policyVersion = rules.version; // 承诺时刻钉住规则版本，之后版本变化不影响本承诺
        const allocation = {
          allocationId: this.store.nextId('allocation', 'ALLOC'),
          applicationId: app.applicationId,
          teacherRef: app.teacherRef,
          resource,
          allocatedAt: now.toISOString(),
          policyVersion: rules.version,
          terms: { sessionDays: rules.resources[resource].sessionDays },
          decisionId: decision.decisionId,
          endedAt: null,
          endReason: null,
        };
        this.store.allocations.set(allocation.allocationId, allocation);
        this.#history(app, 'allocated', actor, {
          allocationId: allocation.allocationId,
          decisionId: decision.decisionId,
        });
        this.#audit(actor, 'allocation.committed', {
          applicationId: app.applicationId,
          allocationId: allocation.allocationId,
          decisionId: decision.decisionId,
          resource,
        });
      }
      // 未获分配的 eligible 申请转入排队
      for (const app of this.store.applications.values()) {
        if (app.resource === resource && app.state === 'eligible') {
          app.state = 'waiting';
          this.#history(app, 'queued', actor);
        }
      }
      return decisions;
    });
  }

  #releaseAllocation(app, endReason, actor) {
    const alloc = [...this.store.allocations.values()].find(
      (a) => a.applicationId === app.applicationId && !a.endedAt,
    );
    if (alloc) {
      alloc.endedAt = this.now().toISOString();
      alloc.endReason = endReason;
      this.#audit(actor, 'allocation.released', {
        allocationId: alloc.allocationId,
        applicationId: app.applicationId,
        resource: app.resource,
        endReason,
      });
    }
    return alloc;
  }

  // ---------- 申请提交与资格核验 ----------

  async submitApplication(actor, input, idempotencyKey) {
    this.#require(actor, 'application:create');
    const teacherRef = input.teacherRef ?? actor.id;
    if (actor.role === 'teacher' && teacherRef !== actor.id) {
      throw forbidden('not-self', '教师只能为本人提交申请');
    }
    if (idempotencyKey) {
      const seen = this.store.idempotency.get(`${actor.id}:${idempotencyKey}`);
      if (seen) return { application: this.#getApp(seen), idempotentReplay: true };
    }

    const rules = this.#rules();
    const { resource, urgency, proofValidUntil, sensitiveNote } = input;
    if (!rules.resources[resource]) throw badRequest('resource-unknown', `未知资源类型：${resource}`);
    if (!urgencyLevels.includes(urgency)) throw badRequest('urgency-unknown', `未知紧急等级：${urgency}`);
    const proofTs = Date.parse(proofValidUntil);
    if (Number.isNaN(proofTs)) throw badRequest('proof-invalid-format', 'proofValidUntil 无法解析');
    const remainingDays = (proofTs - this.now().getTime()) / DAY_MS;
    if (remainingDays < rules.proof.minRemainingDaysAtSubmit) {
      throw unprocessable(
        'proof-expiring-too-soon',
        `证明剩余有效期不足 ${rules.proof.minRemainingDaysAtSubmit} 天`,
        { remainingDays },
      );
    }

    // 重复申请：同一教师同一资源已有活跃申请即拒绝，从源头防止重复占用
    const duplicate = [...this.store.applications.values()].find(
      (a) => a.teacherRef === teacherRef && a.resource === resource && activeStates.includes(a.state),
    );
    if (duplicate) {
      throw conflict('duplicate-application', '同一资源已存在进行中的申请', {
        existingApplicationId: duplicate.applicationId,
      });
    }

    const cooling = this.#activeCooling(teacherRef, resource);
    if (cooling) {
      throw conflict('cooling-off', '冷静期内不可再次申请同一资源', {
        until: cooling.until,
        reason: cooling.reason,
      });
    }

    const app = {
      applicationId: this.store.nextId('application', 'CARE'),
      teacherRef,
      resource,
      urgency,
      proofValidUntil,
      policyVersion: rules.version,
      state: 'submitted',
      reviewState: 'none',
      holdReason: null,
      closeReason: null,
      submittedAt: this.now().toISOString(),
      hasSensitiveNote: false,
      history: [],
    };
    this.store.applications.set(app.applicationId, app);
    if (idempotencyKey) this.store.idempotency.set(`${actor.id}:${idempotencyKey}`, app.applicationId);

    if (sensitiveNote) {
      // 敏感说明加密后独立存放，申请与排队记录中只保留“是否存在”的标记
      this.store.sensitiveNotes.set(app.applicationId, this.box.seal(sensitiveNote));
      app.hasSensitiveNote = true;
      this.#audit(actor, 'sensitive.sealed', { applicationId: app.applicationId });
    }

    // 自动资格核验通过（证明有效、无重复、无冷静期），进入待分配
    app.state = 'eligible';
    this.#history(app, 'verified', actor);
    this.#audit(actor, 'application.submitted', { applicationId: app.applicationId, resource, urgency });

    await this.#tryAllocate(resource, 'submit', actor);
    return { application: app, idempotentReplay: false };
  }

  // ---------- 撤回（仅本人） ----------

  async withdraw(actor, applicationId) {
    const app = this.#getApp(applicationId);
    if (!this.#isOwner(actor, app) || !this.#can(actor, 'application:withdraw-own')) {
      throw forbidden('forbidden', '仅本人可撤回申请');
    }
    if (!activeStates.includes(app.state)) {
      throw conflict('not-active', `当前状态 ${app.state} 不可撤回`);
    }
    const wasAllocated = app.state === 'allocated';
    if (wasAllocated) this.#releaseAllocation(app, 'withdrawn', actor);
    app.state = 'withdrawn';
    this.#history(app, 'withdrawn', actor);
    const days = this.#rules().coolingOff.afterWithdrawalDays;
    if (days > 0) {
      const until = new Date(this.now().getTime() + days * DAY_MS).toISOString();
      this.store.coolingOff.set(this.#coolingKey(app.teacherRef, app.resource), { until, reason: 'withdrawn' });
    }
    this.#audit(actor, 'application.withdrawn', { applicationId: app.applicationId, wasAllocated });
    if (wasAllocated) await this.#tryAllocate(app.resource, 'release', actor);
    return app;
  }

  // ---------- 紧急等级升级（经办/负责人，只升不降，仅限未承诺申请） ----------

  async escalate(actor, applicationId, toUrgency) {
    this.#require(actor, 'application:escalate');
    const app = this.#getApp(applicationId);
    if (!urgencyLevels.includes(toUrgency)) {
      throw badRequest('urgency-unknown', `未知紧急等级：${toUrgency}`);
    }
    if (app.state === 'allocated' || terminalStates.includes(app.state)) {
      throw conflict('already-committed', '已承诺或已结束的申请不可调整紧急等级');
    }
    if (urgencyRank[toUrgency] <= urgencyRank[app.urgency]) {
      throw unprocessable('escalation-not-upward', '紧急等级只能上调');
    }
    const from = app.urgency;
    app.urgency = toUrgency;
    this.#history(app, 'escalated', actor, { from, to: toUrgency });
    this.#audit(actor, 'application.escalated', { applicationId, from, to: toUrgency });
    return app;
  }

  // ---------- 证明更新 ----------

  async updateProof(actor, applicationId, proofValidUntil) {
    const app = this.#getApp(applicationId);
    const own = this.#isOwner(actor, app) && this.#can(actor, 'proof:update-own');
    if (!own && !this.#can(actor, 'proof:update-any')) {
      throw forbidden('forbidden', '无权更新该申请的证明');
    }
    const ts = Date.parse(proofValidUntil);
    if (Number.isNaN(ts)) throw badRequest('proof-invalid-format', 'proofValidUntil 无法解析');
    if (ts <= this.now().getTime()) throw unprocessable('proof-expired', '新证明已过期');
    app.proofValidUntil = proofValidUntil;
    if (app.holdReason === 'proof-expired') {
      app.holdReason = null;
      this.#history(app, 'hold-cleared', actor);
    }
    this.#history(app, 'proof-updated', actor);
    this.#audit(actor, 'application.proof-updated', { applicationId });
    if (app.state === 'waiting' || app.state === 'eligible') {
      await this.#tryAllocate(app.resource, 'proof-updated', actor);
    }
    return app;
  }

  // ---------- 办结与爽约（释放容量并按当时有效优先级递补） ----------

  async complete(actor, applicationId) {
    this.#require(actor, 'application:complete');
    const app = this.#getApp(applicationId);
    if (app.state !== 'allocated') throw conflict('not-allocated', '仅已占用资源的申请可办结');
    this.#releaseAllocation(app, 'completed', actor);
    app.state = 'closed';
    app.closeReason = 'completed';
    this.#history(app, 'completed', actor);
    this.#audit(actor, 'application.completed', { applicationId });
    await this.#tryAllocate(app.resource, 'release', actor);
    return app;
  }

  async markNoShow(actor, applicationId) {
    this.#require(actor, 'application:no-show');
    const app = this.#getApp(applicationId);
    if (app.state !== 'allocated') throw conflict('not-allocated', '仅已占用资源的申请可标记爽约');
    // 先结束占用再递补，爽约不会造成名额重复占用
    this.#releaseAllocation(app, 'no-show', actor);
    app.state = 'closed';
    app.closeReason = 'no-show';
    const days = this.#rules().coolingOff.afterNoShowDays;
    if (days > 0) {
      const until = new Date(this.now().getTime() + days * DAY_MS).toISOString();
      this.store.coolingOff.set(this.#coolingKey(app.teacherRef, app.resource), { until, reason: 'no-show' });
    }
    this.#history(app, 'no-show', actor);
    this.#audit(actor, 'application.no-show', { applicationId });
    await this.#tryAllocate(app.resource, 'release', actor);
    return app;
  }

  // ---------- 申诉与复核 ----------

  async appeal(actor, applicationId) {
    const app = this.#getApp(applicationId);
    if (!this.#isOwner(actor, app) || !this.#can(actor, 'application:appeal-own')) {
      throw forbidden('forbidden', '仅本人可申诉');
    }
    if (app.state !== 'closed' || !appealableReasons.includes(app.closeReason)) {
      throw conflict('not-appealable', '当前状态不可申诉');
    }
    if (app.reviewState !== 'none') throw conflict('appeal-exists', '已存在复核流程');
    app.reviewState = 'appealed';
    this.#history(app, 'appealed', actor);
    this.#audit(actor, 'application.appealed', { applicationId });
    return app;
  }

  async review(actor, applicationId, { action, outcome, reason } = {}) {
    this.#require(actor, 'application:review');
    const app = this.#getApp(applicationId);
    if (action === 'start') {
      if (app.reviewState !== 'appealed') throw conflict('review-not-pending', '没有待受理的申诉');
      app.reviewState = 'reviewing';
      this.#history(app, 'review-started', actor);
      this.#audit(actor, 'application.review-started', { applicationId });
      return app;
    }
    if (action === 'resolve') {
      if (app.reviewState !== 'reviewing') throw conflict('review-not-started', '复核尚未受理');
      if (!reviewOutcomes.includes(outcome)) {
        throw badRequest('outcome-unknown', `未知复核结论：${outcome}`);
      }
      app.reviewState = 'resolved';
      app.reviewOutcome = outcome;
      app.reviewReason = reason ?? null;
      if (outcome === 'overturned') {
        // 撤销原结论：清除冷静期、回到排队等待正常递补，
        // 而不是直接占用名额——复核不会造成名额重复占用
        this.store.coolingOff.delete(this.#coolingKey(app.teacherRef, app.resource));
        app.state = 'waiting';
        app.closeReason = null;
        app.holdReason = this.#proofValid(app) ? null : 'proof-expired';
        this.#history(app, 'reinstated', actor);
      }
      this.#history(app, 'review-resolved', actor, { outcome });
      this.#audit(actor, 'application.review-resolved', { applicationId, outcome });
      if (outcome === 'overturned') await this.#tryAllocate(app.resource, 'appeal-overturned', actor);
      return app;
    }
    throw badRequest('review-action-unknown', `未知复核动作：${action}`);
  }

  // ---------- 敏感说明（加密、分离、按权限读取且留痕） ----------

  readSensitive(actor, applicationId) {
    this.#require(actor, 'sensitive:read');
    this.#getApp(applicationId);
    const payload = this.store.sensitiveNotes.get(applicationId);
    if (!payload) throw notFound('sensitive-not-found', '该申请没有敏感说明');
    this.#audit(actor, 'sensitive.read', { applicationId }); // 只记录访问事实，不记录内容
    return this.box.open(payload);
  }

  // ---------- 查询 ----------

  getApplication(actor, applicationId) {
    const app = this.#getApp(applicationId);
    this.#requireView(actor, app);
    return app;
  }

  listApplications(actor, filter = {}) {
    let apps = [...this.store.applications.values()];
    if (this.#can(actor, 'application:view-any')) {
      if (filter.teacherRef) apps = apps.filter((a) => a.teacherRef === filter.teacherRef);
    } else if (this.#can(actor, 'application:view-own')) {
      apps = apps.filter((a) => a.teacherRef === actor.id);
    } else {
      throw forbidden('forbidden', '无权查询申请');
    }
    if (filter.resource) apps = apps.filter((a) => a.resource === filter.resource);
    if (filter.state) apps = apps.filter((a) => a.state === filter.state);
    return apps;
  }

  // 教师视角的等待解释：只有位置与数量，不含任何他人信息
  waitingInfo(app) {
    if (app.state !== 'waiting' && app.state !== 'eligible') return null;
    const rules = this.#rules();
    const now = this.now();
    const queue = [...this.store.applications.values()]
      .filter((a) => a.resource === app.resource
        && (a.state === 'waiting' || a.state === 'eligible')
        && !a.holdReason)
      .map((a) => ({
        applicationId: a.applicationId,
        submittedAt: a.submittedAt,
        score: computeScore(a, rules, now),
      }))
      .sort(compareCandidates);
    const index = queue.findIndex((q) => q.applicationId === app.applicationId);
    const cfg = rules.resources[app.resource];
    return {
      position: index < 0 ? null : index + 1,
      aheadCount: index < 0 ? null : index,
      totalWaiting: queue.length,
      capacity: cfg.capacity,
      inUse: this.store.activeAllocations(app.resource).length,
      holdReason: app.holdReason,
      hint: `该资源每个服务周期约 ${cfg.sessionDays} 天`,
    };
  }

  queue(actor, resource) {
    this.#require(actor, 'queue:view');
    const rules = this.#rules();
    if (!rules.resources[resource]) throw badRequest('resource-unknown', `未知资源类型：${resource}`);
    const now = this.now();
    return [...this.store.applications.values()]
      .filter((a) => a.resource === resource && (a.state === 'waiting' || a.state === 'eligible'))
      .map((a) => ({
        applicationId: a.applicationId,
        teacherRef: a.teacherRef,
        urgency: a.urgency,
        submittedAt: a.submittedAt,
        holdReason: a.holdReason,
        score: a.holdReason ? null : computeScore(a, rules, now),
      }))
      .sort((x, y) => compareCandidates(
        { ...x, score: x.score ?? Number.NEGATIVE_INFINITY },
        { ...y, score: y.score ?? Number.NEGATIVE_INFINITY },
      ));
  }

  // 容量报告：负责人确认“占用从未超过容量”的入口
  capacityReport(actor) {
    this.#require(actor, 'capacity:view');
    const rules = this.#rules();
    const resources = {};
    for (const [resource, cfg] of Object.entries(rules.resources)) {
      const active = this.store.activeAllocations(resource);
      const waiting = [...this.store.applications.values()].filter(
        (a) => a.resource === resource && (a.state === 'waiting' || a.state === 'eligible'),
      ).length;
      resources[resource] = {
        capacity: cfg.capacity,
        inUse: active.length,
        waiting,
        activeAllocationIds: active.map((a) => a.allocationId),
        // 唯一允许 inUse > capacity 的情形是政策缩容后的既有承诺（不再新增）
        overCapacity: active.length > cfg.capacity,
      };
    }
    return { policyVersion: rules.version, at: this.now().toISOString(), resources };
  }

  // ---------- 决策复算 ----------

  listDecisions(actor) {
    this.#require(actor, 'decision:recompute');
    return this.store.decisions;
  }

  // 用决策记录中的候选输入与当时的政策版本重新计算，
  // 结果必须与记录的选择一致；同时校验容量约束当时成立。
  recomputeDecision(actor, decisionId) {
    this.#require(actor, 'decision:recompute');
    const rec = this.store.decisions.find((d) => d.decisionId === decisionId);
    if (!rec) throw notFound('decision-not-found', `决策 ${decisionId} 不存在`);
    const rules = this.policies.get(rec.policyVersion);
    const at = new Date(rec.at);
    const scoreMismatches = [];
    const runnable = rec.candidates
      .filter((c) => !c.skipReason)
      .map((c) => {
        const score = computeScore(c, rules, at);
        if (Math.abs(score - c.score) > 1e-9) scoreMismatches.push(c.applicationId);
        return { ...c, score };
      })
      .sort(compareCandidates);
    const expectedChosenId = runnable[0]?.applicationId ?? null;
    const result = {
      decisionId: rec.decisionId,
      policyVersion: rec.policyVersion,
      recordedChosenId: rec.chosenId,
      expectedChosenId,
      match: expectedChosenId === rec.chosenId,
      capacityRespected: rec.chosenId === null ? true : rec.inUseBefore < rec.capacity,
      scoreMismatches,
    };
    this.#audit(actor, 'decision.recomputed', { decisionId: rec.decisionId, match: result.match });
    return result;
  }

  // ---------- 政策版本 ----------

  currentPolicy(actor) {
    this.#require(actor, 'policy:view');
    return this.#rules();
  }

  // 新版本只作用于尚未承诺的申请：等待中的按新规则评估，
  // 已占用名额的承诺保持原版本条款不变。
  async publishPolicy(actor, rules) {
    this.#require(actor, 'policy:publish');
    const frozen = this.policies.publish(rules);
    this.#audit(actor, 'policy.published', { version: frozen.version });
    for (const resource of Object.keys(frozen.resources)) {
      await this.#tryAllocate(resource, 'policy-published', actor);
    }
    return frozen;
  }

  auditLog(actor) {
    this.#require(actor, 'audit:view');
    return this.store.auditLog;
  }
}
