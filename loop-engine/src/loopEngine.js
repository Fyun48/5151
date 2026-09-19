// Loop Engine state machine (Phase 25/26/27). Drives the autonomous DeepSeek
// development loop and records an audit trail. Owner decisions (final review /
// skip review / return) gate release; budget/limits prevent infinite loops.
//
// States:
//   PLAN -> CODE -> TEST -> (FIX -> TEST)* -> STAGING -> IMPLEMENTATION_COMPLETE
//   -> RELEASE_CANDIDATE -> [FINAL_REVIEW | SKIP_REVIEW_AND_RELEASE] -> RELEASE_READY
//   (or RETURN_TO_DEVELOPMENT -> CODE)
export const TASK_STATE = Object.freeze({
  PLAN: "plan",
  CODE: "code",
  TEST: "test",
  FIX: "fix",
  STAGING: "staging",
  IMPLEMENTATION_COMPLETE: "implementation_complete",
  RELEASE_CANDIDATE: "release_candidate",
  RELEASE_READY: "release_ready",
  RETURNED: "returned",
});

export const OWNER_DECISION = Object.freeze({
  FINAL_REVIEW: "FINAL_REVIEW",
  SKIP_REVIEW_AND_RELEASE: "SKIP_REVIEW_AND_RELEASE",
  RETURN_TO_DEVELOPMENT: "RETURN_TO_DEVELOPMENT",
});

export const DEFAULT_LIMITS = Object.freeze({
  maxSelfFixIterations: 3,
  maxChangedFiles: 20,
  maxDiffLines: 2000,
  maxRuntimeMinutes: 60,
  maxTokens: 200_000,
  maxCostUsd: 25,
});

export function createTask({ id, budget = DEFAULT_LIMITS } = {}) {
  return {
    id: id ?? `task-${Date.now()}`,
    state: TASK_STATE.PLAN,
    selfFixIterations: 0,
    changedFiles: 0,
    diffLines: 0,
    tokens: 0,
    costUsd: 0,
    runtimeMinutes: 0,
    audit: [],
    budget: { ...DEFAULT_LIMITS, ...budget },
  };
}

function record(task, from, to, meta = {}) {
  task.audit.push({ at: new Date().toISOString(), from, to, ...meta });
}

const TRANSITIONS = {
  [TASK_STATE.PLAN]: [TASK_STATE.CODE],
  [TASK_STATE.CODE]: [TASK_STATE.TEST, TASK_STATE.RETURNED],
  [TASK_STATE.TEST]: [TASK_STATE.FIX, TASK_STATE.STAGING],
  [TASK_STATE.FIX]: [TASK_STATE.TEST],
  [TASK_STATE.STAGING]: [TASK_STATE.IMPLEMENTATION_COMPLETE],
  [TASK_STATE.IMPLEMENTATION_COMPLETE]: [TASK_STATE.RELEASE_CANDIDATE],
  [TASK_STATE.RELEASE_CANDIDATE]: [TASK_STATE.RELEASE_READY, TASK_STATE.CODE],
  [TASK_STATE.RETURNED]: [TASK_STATE.CODE],
};

export function transition(task, to, meta = {}) {
  const from = task.state;
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid transition: ${from} -> ${to}`);
  }
  // Enforce limits before entering CODE (the expensive step).
  if (to === TASK_STATE.CODE) {
    assertWithinBudget(task);
  }
  task.state = to;
  if (to === TASK_STATE.FIX) {
    task.selfFixIterations += 1;
    if (task.selfFixIterations > task.budget.maxSelfFixIterations) {
      throw new Error(`max self-fix iterations (${task.budget.maxSelfFixIterations}) exceeded`);
    }
  }
  record(task, from, to, meta);
  return task;
}

export function testPassed(task, stats = {}) {
  return transition(task, TASK_STATE.STAGING, { stats });
}

export function testFailed(task, stats = {}) {
  return transition(task, TASK_STATE.FIX, { stats });
}

export function recordCodeMetrics(task, { changedFiles = 0, diffLines = 0, tokens = 0, costUsd = 0, runtimeMinutes = 0 } = {}) {
  task.changedFiles = changedFiles;
  task.diffLines = diffLines;
  task.tokens += tokens;
  task.costUsd += costUsd;
  task.runtimeMinutes += runtimeMinutes;
  return task;
}

function assertWithinBudget(task) {
  const b = task.budget;
  const checks = [
    [task.changedFiles > b.maxChangedFiles, `max changed files (${b.maxChangedFiles}) exceeded`],
    [task.diffLines > b.maxDiffLines, `max diff lines (${b.maxDiffLines}) exceeded`],
    [task.tokens > b.maxTokens, `max tokens (${b.maxTokens}) exceeded`],
    [task.costUsd > b.maxCostUsd, `max cost (${b.maxCostUsd}) exceeded`],
    [task.runtimeMinutes > b.maxRuntimeMinutes, `max runtime (${b.maxRuntimeMinutes}) exceeded`],
  ];
  for (const [violated, message] of checks) {
    if (violated) throw new Error(message);
  }
}

export function applyOwnerDecision(task, decision, { reviewerResult = null } = {}) {
  if (task.state !== TASK_STATE.RELEASE_CANDIDATE) {
    throw new Error(`owner decision requires state=release_candidate, got ${task.state}`);
  }
  if (decision === OWNER_DECISION.FINAL_REVIEW) {
    record(task, task.state, TASK_STATE.RELEASE_READY, { decision, reviewer: reviewerResult });
    task.reviewerResult = reviewerResult;
    task.state = TASK_STATE.RELEASE_READY;
    return task;
  }
  if (decision === OWNER_DECISION.SKIP_REVIEW_AND_RELEASE) {
    record(task, task.state, TASK_STATE.RELEASE_READY, { decision, code_review: "SKIPPED_BY_OWNER" });
    task.state = TASK_STATE.RELEASE_READY;
    return task;
  }
  if (decision === OWNER_DECISION.RETURN_TO_DEVELOPMENT) {
    record(task, task.state, TASK_STATE.CODE, { decision });
    task.state = TASK_STATE.CODE;
    return task;
  }
  throw new Error(`unknown owner decision: ${decision}`);
}
