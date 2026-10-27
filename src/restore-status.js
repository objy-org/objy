export function createRestoreStatus() {
  const state = {
    status: "idle",
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    currentScope: null,
    scopesTotal: 0,
    scopesDone: 0,
    snapshotObjects: 0,
    journalOps: 0,
    skippedJournals: 0,
    skippedJournalOps: 0,
    localWalOps: 0,
  };

  return {
    start(meta = {}) {
      Object.assign(state, {
        status: "restoring",
        phase: "starting",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        ...meta,
      });
    },
    update(patch = {}) {
      Object.assign(state, patch);
    },
    add(field, count = 1) {
      state[field] = (Number(state[field]) || 0) + (Number(count) || 0);
    },
    scope(scope, index, total) {
      state.phase = "scope";
      state.currentScope = scope ? { ...scope } : null;
      state.scopesDone = Math.max(0, Number(index) || 0);
      state.scopesTotal = Math.max(state.scopesTotal, Number(total) || 0);
    },
    done(stats = {}) {
      Object.assign(state, {
        status: "ready",
        phase: "ready",
        finishedAt: new Date().toISOString(),
        currentScope: null,
        stats: { ...stats },
      });
    },
    fail(error) {
      Object.assign(state, {
        status: "error",
        phase: "error",
        finishedAt: new Date().toISOString(),
        error: error?.message || String(error),
      });
    },
    waiting(patch = {}) {
      Object.assign(state, {
        status: "restoring",
        phase: "waiting-topology",
        finishedAt: null,
        ...patch,
      });
    },
    snapshot() {
      return {
        ...state,
        currentScope: state.currentScope ? { ...state.currentScope } : null,
        stats: state.stats ? { ...state.stats } : undefined,
      };
    },
    get restoring() {
      return state.status === "restoring";
    },
  };
}
