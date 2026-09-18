// 教师关怀资源分配的公共领域词汇。
// 排队、视图与复核都只能引用这里的枚举，避免自由文本造成语义分歧。

export const resourceKinds = ['counselling', 'temporary-load-relief', 'peer-support'];

export const applicationStates = ['submitted', 'eligible', 'waiting', 'allocated', 'closed', 'withdrawn'];

export const reviewStates = ['none', 'appealed', 'reviewing', 'resolved'];

export const urgencyLevels = ['standard', 'priority', 'immediate'];

// 紧急等级的全序：数值越大越优先。排队选择与升级校验都使用它。
export const urgencyRank = Object.freeze({
  standard: 0,
  priority: 1,
  immediate: 2,
});

// 经办角色：本人教师、经办人、负责人。权限矩阵见 policy.js / permissions。
export const actorRoles = Object.freeze(['teacher', 'worker', 'director']);

// 角色 → 可执行动作。敏感说明的读取单独审计，且不向负责人批量开放。
export const permissions = Object.freeze({
  'application.submit': ['teacher'],
  'application.withdraw': ['teacher'],
  'application.renewProof': ['teacher'],
  'application.appeal': ['teacher'],
  'application.viewSelf': ['teacher'],
  'worker.list': ['worker', 'director'],
  'worker.view': ['worker', 'director'],
  'urgency.escalate': ['worker', 'director'],
  'outcome.record': ['worker', 'director'],
  'appeal.review': ['worker', 'director'],
  'allocation.trigger': ['worker', 'director'],
  'note.read': ['worker'],
  'policy.activate': ['director'],
  'director.recompute': ['director'],
  'director.viewResources': ['director'],
});

// 申请关闭原因。no-show 会触发冷静期，attended 是正常完成。
export const closedReasons = Object.freeze(['attended', 'no-show', 'withdrawn']);

// 申诉类别（结构化代码而非自由文本，避免排队库接触敏感内容）。
export const appealReasonCodes = Object.freeze(['no-show-disputed', 'eligibility-disputed']);

export const stateLabels = Object.freeze({
  submitted: '已提交',
  eligible: '资格已核验',
  waiting: '候补中',
  allocated: '已获得资源',
  closed: '已结束',
  withdrawn: '已撤回',
});

export const urgencyLabels = Object.freeze({
  standard: '常规',
  priority: '优先',
  immediate: '紧急',
});

export const resourceLabels = Object.freeze({
  counselling: '心理咨询',
  'temporary-load-relief': '临时减课',
  'peer-support': '同伴支持',
});
