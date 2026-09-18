// 结构化政策：资源容量、资格所需证明有效期、爽约冷静期、紧急等级定义。
// 政策是版本化的不可变快照；每次申请快照所适用的版本，
// 已作出承诺（allocated 及之后）的申请不受新版本影响。

export const POLICY_VERSION_RE = /^\d{4}\.\d+$/;

// 初始政策（与脱敏样例 policyVersion 2026.2 对齐）。
// proofWindowDays：proofValidUntil 的最大可接受前瞻窗口（0 表示不限制前瞻长度，
// 但实际有效期以申请提交时刻起算的最大窗口为准——这里采用“证明必须覆盖未来 N 天”）。
// 更准确地说：核验时要求 proofValidUntil - now >= minProofRemainingMs，
// 同时不允许提交一个把有效期随意填到很远的证明：proofValidUntil <= submittedAt + maxProofHorizonMs。
export function defaultPolicy(now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  return {
    version: '2026.2',
    activatedAt: now,
    // 各类资源名额。释放（完成/爽约/撤回占用）后回到池内。
    capacities: {
      counselling: 2,
      'temporary-load-relief': 1,
      'peer-support': 3,
    },
    // 资格核验：证明在核验/递补时刻必须剩余至少该毫秒数，且不得超过前瞻上限。
    proof: {
      minRemainingMs: 1 * day,
      maxHorizonMs: 180 * day,
    },
    // 爽约后同一教师就同一资源再次申请的冷静期。
    cooldownMs: {
      'counselling': 30 * day,
      'temporary-load-relief': 14 * day,
      'peer-support': 14 * day,
    },
    // 紧急等级的结构化定义：升级到 immediate 需要授权人员记录理由代码。
    urgency: {
      immediateRequiresReasonCode: true,
      allowedEscalationReasonCodes: ['acute-crisis', 'safety-risk', 'management-directed'],
    },
    // 排队规则（确定性）：先按紧急度，再按提交时间，再按申请编号。
    ordering: {
      tieBreaker: 'submittedAt',
    },
    notes: '初始政策：与脱敏样例对齐。',
  };
}

// 政策变更只允许改变容量、窗口、冷静期等数值字段；版本号必须更新。
// 该函数同时做结构校验，防止把不完整政策激活上线。
export function validatePolicy(policy, { requiredResources = [] } = {}) {
  if (!policy || typeof policy !== 'object') throw new Error('policy-must-be-object');
  if (!POLICY_VERSION_RE.test(policy.version)) throw new Error('bad-policy-version');
  if (!Number.isFinite(policy.activatedAt) || policy.activatedAt <= 0) throw new Error('bad-activated-at');
  const caps = policy.capacities;
  if (!caps || typeof caps !== 'object') throw new Error('bad-capacities');
  for (const k of requiredResources) {
    if (!(k in caps)) throw new Error(`missing-capacity:${k}`);
  }
  for (const [k, v] of Object.entries(caps)) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`bad-capacity:${k}`);
  }
  const proof = policy.proof;
  if (!proof || !Number.isFinite(proof.minRemainingMs) || proof.minRemainingMs < 0) {
    throw new Error('bad-proof-min-remaining');
  }
  if (!Number.isFinite(proof.maxHorizonMs) || proof.maxHorizonMs < proof.minRemainingMs) {
    throw new Error('bad-proof-horizon');
  }
  const cd = policy.cooldownMs;
  if (!cd || typeof cd !== 'object') throw new Error('bad-cooldown');
  for (const k of requiredResources) {
    if (!(k in cd)) throw new Error(`missing-cooldown:${k}`);
  }
  for (const [k, v] of Object.entries(cd)) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`bad-cooldown:${k}`);
  }
  if (!policy.urgency || !Array.isArray(policy.urgency.allowedEscalationReasonCodes)) {
    throw new Error('bad-urgency-rules');
  }
  return true;
}

// 判断某个（已快照政策版本的）申请是否已“作出承诺”：
// 规则版本变化只作用于尚未承诺的申请。
export function isCommitted(state) {
  return state === 'allocated' || state === 'closed';
}
