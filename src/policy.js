import { readFile } from 'node:fs/promises';
import { resourceKinds, urgencyLevels } from './domain.js';
import { conflict, unprocessable } from './errors.js';

const VERSION_RE = /^\d{4}\.\d+$/;
const DAY_MS = 86400000;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// 政策规则校验：容量、紧急等级、证明有效期、冷静期、经办角色缺一不可。
export function validateRules(rules) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['rules 必须是对象'];
  if (!VERSION_RE.test(rules.version || '')) errors.push('version 需符合 YYYY.N 格式');
  if (!rules.effectiveFrom || Number.isNaN(Date.parse(rules.effectiveFrom))) {
    errors.push('effectiveFrom 需为可解析时间');
  }
  for (const kind of resourceKinds) {
    const r = rules.resources?.[kind];
    if (!r) { errors.push(`resources.${kind} 缺失`); continue; }
    if (!Number.isInteger(r.capacity) || r.capacity < 0) errors.push(`resources.${kind}.capacity 需为非负整数`);
    if (!Number.isFinite(r.sessionDays) || r.sessionDays <= 0) errors.push(`resources.${kind}.sessionDays 需为正数`);
  }
  for (const level of urgencyLevels) {
    const w = rules.urgency?.[level]?.weight;
    if (!Number.isFinite(w) || w < 0) errors.push(`urgency.${level}.weight 需为非负数`);
  }
  if (rules.urgency
    && Number.isFinite(rules.urgency.standard?.weight)
    && Number.isFinite(rules.urgency.priority?.weight)
    && Number.isFinite(rules.urgency.immediate?.weight)
    && !(rules.urgency.standard.weight <= rules.urgency.priority.weight
      && rules.urgency.priority.weight <= rules.urgency.immediate.weight)) {
    errors.push('urgency 权重需随等级递增（standard ≤ priority ≤ immediate）');
  }
  if (!Number.isFinite(rules.aging?.perDay) || rules.aging.perDay < 0) errors.push('aging.perDay 需为非负数');
  if (!Number.isFinite(rules.aging?.maxBonus) || rules.aging.maxBonus < 0) errors.push('aging.maxBonus 需为非负数');
  if (!Number.isFinite(rules.proof?.minRemainingDaysAtSubmit) || rules.proof.minRemainingDaysAtSubmit < 0) {
    errors.push('proof.minRemainingDaysAtSubmit 需为非负数');
  }
  if (typeof rules.proof?.mustBeValidAtAllocation !== 'boolean') {
    errors.push('proof.mustBeValidAtAllocation 需为布尔值');
  }
  if (!Number.isFinite(rules.coolingOff?.afterWithdrawalDays) || rules.coolingOff.afterWithdrawalDays < 0) {
    errors.push('coolingOff.afterWithdrawalDays 需为非负数');
  }
  if (!Number.isFinite(rules.coolingOff?.afterNoShowDays) || rules.coolingOff.afterNoShowDays < 0) {
    errors.push('coolingOff.afterNoShowDays 需为非负数');
  }
  for (const role of ['teacher', 'operator', 'manager']) {
    if (!Array.isArray(rules.roles?.[role])) errors.push(`roles.${role} 需为权限数组`);
  }
  return errors;
}

// 版本化政策注册表：历史版本全部保留，供决策复算按当时版本重放。
export class PolicyRegistry {
  constructor() {
    this.versions = new Map();
    this.currentVersion = null;
  }

  static async fromFile(path) {
    const rules = JSON.parse(await readFile(path, 'utf8'));
    const registry = new PolicyRegistry();
    registry.publish(rules);
    return registry;
  }

  publish(rules) {
    const errors = validateRules(rules);
    if (errors.length) throw unprocessable('policy-invalid', '政策规则未通过校验', errors);
    if (this.versions.has(rules.version)) {
      throw conflict('policy-version-exists', `政策版本 ${rules.version} 已存在`);
    }
    const frozen = deepFreeze(structuredClone(rules));
    this.versions.set(frozen.version, frozen);
    this.currentVersion = frozen.version;
    return frozen;
  }

  current() {
    return this.versions.get(this.currentVersion);
  }

  get(version) {
    const rules = this.versions.get(version);
    if (!rules) throw unprocessable('policy-unknown-version', `政策版本 ${version} 不存在`);
    return rules;
  }
}

// 有效优先级 = 紧急等级权重 + 等待时长加分（封顶）。
// 该函数同时用于实时分配与事后复算，输入相同则结果必然相同。
export function computeScore({ urgency, submittedAt }, rules, now) {
  const weight = rules.urgency[urgency]?.weight ?? 0;
  const waitedDays = Math.max(0, (now.getTime() - Date.parse(submittedAt)) / DAY_MS);
  const bonus = Math.min(waitedDays * rules.aging.perDay, rules.aging.maxBonus);
  return weight + bonus;
}

// 统一的可复算排序：分数降序 → 提交时间升序 → 申请号升序（完全确定）。
export function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  if (a.applicationId === b.applicationId) return 0;
  return a.applicationId < b.applicationId ? -1 : 1;
}
