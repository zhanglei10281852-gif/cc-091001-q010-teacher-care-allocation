// 投影：把仅追加事件流重放为当前读模型。
// 投影不做任何权限判断，只负责状态机折叠；复算时也用同一套折叠规则。

export function emptyState() {
  return {
    apps: new Map(), // applicationId -> 申请投影
    policies: new Map(), // version -> policy 快照
    activePolicyVersion: null,
    // 占用台账：resource -> Set(slotId)；alloc/release 必须严格配对。
    occupancy: new Map(),
    allocationDecisions: [], // 仅保留分配决策事件，供复算
    seq: 0,
  };
}

function blankApp(e) {
  return {
    applicationId: e.data.applicationId,
    teacherHash: e.data.teacherHash,
    resource: e.data.resource,
    urgency: e.data.urgency,
    submittedAt: e.data.submittedAt,
    proofValidUntil: e.data.proofValidUntil,
    policyVersion: e.data.policyVersion,
    hasNote: !!e.data.hasNote,
    state: 'submitted',
    eligible: false,
    eligibilityReasons: [],
    eligibleCheckedAt: null,
    review: 'none',
    escalations: [],
    allocations: [], // {at, slotId, releasedAt, releaseReason}
    noShowAt: null,
    closedAt: null,
    closedReason: null,
    withdrawnAt: null,
    appeals: [],
    updatedAt: e.at,
  };
}

// 在一个状态上应用单条事件（纯函数式修改传入的 state）。
export function applyEvent(state, event) {
  state.seq += 1;
  const d = event.data;
  switch (event.type) {
    case 'PolicyActivated': {
      state.policies.set(d.policy.version, d.policy);
      state.activePolicyVersion = d.policy.version;
      return state;
    }
    case 'ApplicationSubmitted': {
      if (state.apps.has(d.applicationId)) throw new Error('duplicate-application-id');
      state.apps.set(d.applicationId, blankApp(event));
      return state;
    }
    case 'EligibilityVerified': {
      const app = state.apps.get(d.applicationId);
      app.eligible = !!d.eligible;
      app.eligibilityReasons = d.reasons.slice();
      app.eligibleCheckedAt = d.checkedAt;
      if (d.policyVersion) app.policyVersion = d.policyVersion;
      if (d.eligible && (app.state === 'submitted')) app.state = 'waiting';
      if (!d.eligible && app.state === 'waiting') app.state = 'submitted';
      app.updatedAt = event.at;
      return state;
    }
    case 'UrgencyChanged': {
      const app = state.apps.get(d.applicationId);
      app.urgency = d.to;
      app.escalations.push({ from: d.from, to: d.to, reasonCode: d.reasonCode ?? null, by: d.by, at: d.at });
      app.updatedAt = event.at;
      return state;
    }
    case 'ApplicationWithdrawn': {
      const app = state.apps.get(d.applicationId);
      app.state = 'withdrawn';
      app.withdrawnAt = d.at;
      app.updatedAt = event.at;
      return state;
    }
    case 'ResourceAllocated': {
      const app = state.apps.get(d.applicationId);
      app.state = 'allocated';
      // 新一轮占用开始：历史申诉已归档在 appeals 中，复核状态复位，
      // 使将来再次爽约时可以就新事实提起申诉。
      app.review = 'none';
      app.allocations.push({ at: d.at, slotId: d.slotId, releasedAt: null, releaseReason: null });
      const set = state.occupancy.get(d.resource) ?? new Set();
      if (set.has(d.slotId)) throw new Error(`slot-double-booking:${d.resource}:${d.slotId}`);
      set.add(d.slotId);
      state.occupancy.set(d.resource, set);
      app.updatedAt = event.at;
      state.allocationDecisions.push(event);
      return state;
    }
    case 'AllocationReleased': {
      const app = state.apps.get(d.applicationId);
      const set = state.occupancy.get(d.resource);
      if (!set || !set.has(d.slotId)) throw new Error(`release-without-occupancy:${d.resource}:${d.slotId}`);
      set.delete(d.slotId);
      const alloc = app.allocations.find((a) => a.slotId === d.slotId && a.releasedAt === null);
      if (!alloc) throw new Error(`release-without-active-allocation:${d.applicationId}`);
      alloc.releasedAt = d.at;
      alloc.releaseReason = d.reason;
      app.updatedAt = event.at;
      return state;
    }
    case 'ApplicationClosed': {
      const app = state.apps.get(d.applicationId);
      app.state = 'closed';
      app.closedAt = d.at;
      app.closedReason = d.reason;
      if (d.reason === 'no-show') app.noShowAt = d.at;
      app.updatedAt = event.at;
      return state;
    }
    case 'ProofRenewed': {
      const app = state.apps.get(d.applicationId);
      app.proofValidUntil = d.proofValidUntil;
      app.updatedAt = event.at;
      return state;
    }
    case 'AppealFiled': {
      const app = state.apps.get(d.applicationId);
      app.review = 'appealed';
      app.appeals.push({ reasonCode: d.reasonCode, hasDetail: !!d.hasDetail, filedAt: d.at, resolvedAt: null, resolution: null });
      app.updatedAt = event.at;
      return state;
    }
    case 'AppealReviewStarted': {
      const app = state.apps.get(d.applicationId);
      app.review = 'reviewing';
      app.updatedAt = event.at;
      return state;
    }
    case 'AppealResolved': {
      const app = state.apps.get(d.applicationId);
      app.review = 'resolved';
      const appeal = app.appeals.filter((a) => a.resolvedAt === null).sort((a, b) => a.filedAt - b.filedAt)[0];
      if (appeal) {
        appeal.resolvedAt = d.at;
        appeal.resolution = d.resolution;
      }
      if (d.resolution === 'upheld' && d.effect === 'reinstate-waiting') {
        // 仅当名额已释放（closed/withdrawn 已触发 AllocationReleased）才回到候补，
        // 状态翻转本身不占用任何名额，杜绝重复占用。
        app.noShowAt = null;
        if (app.state === 'closed' || app.state === 'withdrawn') app.state = 'waiting';
      }
      app.updatedAt = event.at;
      return state;
    }
    case 'NoteRead': {
      // 敏感说明读取审计：不改变排队状态，仅保留在日志中。
      return state;
    }
    case 'ResourceSkipped': {
      // “有候补但无人合格”的决策留痕；不改变占用，仅计数保存。
      state.allocationDecisions.push(event);
      return state;
    }
    default:
      // 未知事件类型不静默忽略，避免重放结果与写入时不一致。
      throw new Error(`unknown-event-type:${event.type}`);
  }
}

export function fold(events, state = emptyState()) {
  for (const event of events) applyEvent(state, event);
  return state;
}
