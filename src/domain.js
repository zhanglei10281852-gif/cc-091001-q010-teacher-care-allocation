export const resourceKinds = ['counselling', 'temporary-load-relief', 'peer-support'];
export const applicationStates = ['submitted', 'eligible', 'waiting', 'allocated', 'closed', 'withdrawn'];
export const reviewStates = ['none', 'appealed', 'reviewing', 'resolved'];
export const urgencyLevels = ['standard', 'priority', 'immediate'];

// 终态：不再占用容量，也不再参与递补
export const terminalStates = ['closed', 'withdrawn'];
// 活跃态：同一教师同一资源同一时间最多一个活跃申请（防重复占用）
export const activeStates = ['submitted', 'eligible', 'waiting', 'allocated'];
// 关闭原因
export const closeReasons = ['completed', 'no-show', 'proof-invalid', 'rejected'];
// 可申诉的关闭原因
export const appealableReasons = ['no-show', 'proof-invalid', 'rejected'];
// 复核结论
export const reviewOutcomes = ['upheld', 'overturned'];
// 紧急程度序号：升级只能上调，不可下调
export const urgencyRank = { standard: 0, priority: 1, immediate: 2 };
