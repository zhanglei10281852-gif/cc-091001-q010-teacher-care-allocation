// 纯数据容器：领域逻辑全部在 CareService 中，便于替换为持久化实现。
// 注意 sensitiveNotes 独立成集合——敏感说明密文与排队数据物理分离。
export class Store {
  constructor() {
    this.applications = new Map();   // applicationId → 申请（不含敏感说明）
    this.allocations = new Map();    // allocationId → 资源占用记录
    this.sensitiveNotes = new Map(); // applicationId → 密文信封（分离存储）
    this.coolingOff = new Map();     // `${teacherRef}|${resource}` → { until, reason }
    this.auditLog = [];              // 追加式审计（不含敏感内容）
    this.decisions = [];             // 分配决策记录（供负责人复算）
    this.idempotency = new Map();    // `${actorId}:${key}` → applicationId
    this.counters = { application: 0, allocation: 0, decision: 0, audit: 0 };
  }

  nextId(kind, prefix) {
    return `${prefix}-${String(++this.counters[kind]).padStart(4, '0')}`;
  }

  activeAllocations(resource) {
    return [...this.allocations.values()].filter((a) => a.resource === resource && !a.endedAt);
  }
}
