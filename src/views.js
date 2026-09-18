// 按角色裁剪字段：教师只看自己的阶段与等待解释，经办人看必要字段。
// 任何视图都不包含敏感说明明文——它只存在于独立的密文集合中。
export function teacherView(app, waitingInfo = null) {
  return {
    applicationId: app.applicationId,
    resource: app.resource,
    state: app.state,
    urgency: app.urgency,
    reviewState: app.reviewState,
    submittedAt: app.submittedAt,
    policyVersion: app.policyVersion,
    holdReason: app.holdReason,
    closeReason: app.closeReason,
    waiting: waitingInfo,
  };
}

export function operatorView(app) {
  return {
    ...teacherView(app),
    teacherRef: app.teacherRef,
    proofValidUntil: app.proofValidUntil,
    hasSensitiveNote: app.hasSensitiveNote, // 只暴露“是否存在”，不暴露内容
    reviewOutcome: app.reviewOutcome ?? null,
    history: app.history,
  };
}

export function managerView(app) {
  return { ...operatorView(app) };
}

export function viewFor(actor, app, waitingInfo = null) {
  if (actor.role === 'teacher') return teacherView(app, waitingInfo);
  if (actor.role === 'manager') return managerView(app);
  return operatorView(app);
}
