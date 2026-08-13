import { GLOBAL_COLLECTION, GLOBAL_DATABASE, peerKey } from "./shard-map.js";

const DEFAULT_DEBOUNCE_MS = 25;
const DEFAULT_MAX_SCOPES_PER_HINT = 128;

export function createReplicationScheduler(options = {}) {
  return new ReplicationScheduler(options);
}

export class ReplicationScheduler {
  constructor({
    node,
    enabled = true,
    hintsEnabled = true,
    antiEntropyMs = 0,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    maxScopesPerHint = DEFAULT_MAX_SCOPES_PER_HINT,
  } = {}) {
    if (!node) throw new Error("node is required");
    this.node = node;
    this.enabled = enabled !== false;
    this.hintsEnabled = hintsEnabled !== false;
    this.antiEntropyMs = positiveInt(antiEntropyMs, 0);
    this.debounceMs = positiveInt(debounceMs, DEFAULT_DEBOUNCE_MS);
    this.maxScopesPerHint = positiveInt(maxScopesPerHint, DEFAULT_MAX_SCOPES_PER_HINT);
    this.pendingHintScopes = new Map();
    this.pullQueue = new Map();
    this.inflightPulls = new Set();
    this.hintTimer = null;
    this.antiEntropyTimer = null;
    this.syncingAll = false;
    this.stats = {
      hintsSent: 0,
      hintsReceived: 0,
      hintScopesSent: 0,
      hintScopesReceived: 0,
      pullSyncs: 0,
      antiEntropySyncs: 0,
      lastHintSentAt: null,
      lastHintReceivedAt: null,
      lastSyncAt: null,
      lastError: null,
    };
    this.unsubscribe = this.node.onChange((change) => this._recordLocalChange(change));
  }

  start() {
    if (!this.enabled || this.antiEntropyTimer || !this.antiEntropyMs) return;
    this.antiEntropyTimer = setInterval(() => {
      this.syncAll("anti-entropy");
    }, this.antiEntropyMs);
    this.antiEntropyTimer.unref?.();
  }

  async stop() {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    if (this.antiEntropyTimer) clearInterval(this.antiEntropyTimer);
    this.hintTimer = null;
    this.antiEntropyTimer = null;
    this.unsubscribe?.();
  }

  afterLocalWrite() {
    if (!this.enabled || !this.hintsEnabled || !this.pendingHintScopes.size) return;
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.flushHints();
    }, this.debounceMs);
    this.hintTimer.unref?.();
  }

  async flushHints() {
    if (!this.enabled || !this.hintsEnabled || !this.pendingHintScopes.size) return { peers: 0, scopes: 0 };
    const scopes = [...this.pendingHintScopes.values()];
    this.pendingHintScopes.clear();
    const byPeer = this._hintTargets(scopes);
    const sends = [];
    let sentPeers = 0;
    let sentScopes = 0;

    for (const [key, { peer, scopes: peerScopes }] of byPeer) {
      for (const chunk of chunks(peerScopes, this.maxScopesPerHint)) {
        sentPeers++;
        sentScopes += chunk.length;
        sends.push(this._sendHint(peer, chunk, key));
      }
    }
    await Promise.all(sends);
    return { peers: sentPeers, scopes: sentScopes };
  }

  receiveHint(hint = {}) {
    if (!this.enabled || !this.hintsEnabled) return { accepted: 0, matchedPeer: false };
    const scopes = normalizeHintScopes(hint.scopes);
    let accepted = 0;
    let matchedPeer = false;

    for (const scope of scopes) {
      const peer = this._peerForHint(scope.shard, hint);
      if (!peer) continue;
      matchedPeer = true;
      if (!this.node.ownsShard(scope.shard)) continue;
      this.enqueuePull(peer, this.node.syncScopeForShard(scope.shard));
      accepted++;
    }

    this.stats.hintsReceived++;
    this.stats.hintScopesReceived += accepted;
    this.stats.lastHintReceivedAt = new Date().toISOString();
    return { accepted, matchedPeer };
  }

  enqueuePull(peer, scope) {
    const key = pullKey(peer, scope);
    this.pullQueue.set(key, { peer, scope });
    this._drainPullQueue();
  }

  async syncAll(reason = "manual") {
    if (!this.enabled || this.syncingAll) return 0;
    this.syncingAll = true;
    try {
      const applied = await this.node.syncAll();
      this.stats.lastSyncAt = new Date().toISOString();
      if (reason === "anti-entropy") this.stats.antiEntropySyncs++;
      return applied;
    } catch (err) {
      this._rememberError(err);
      return 0;
    } finally {
      this.syncingAll = false;
    }
  }

  status() {
    return {
      mode: "hinted-pull",
      enabled: this.enabled,
      hintsEnabled: this.hintsEnabled,
      antiEntropyMs: this.antiEntropyMs,
      debounceMs: this.debounceMs,
      maxScopesPerHint: this.maxScopesPerHint,
      pendingHintScopes: this.pendingHintScopes.size,
      queuedPulls: this.pullQueue.size,
      inflightPulls: this.inflightPulls.size,
      syncingAll: this.syncingAll,
      ...this.stats,
    };
  }

  _recordLocalChange(change) {
    if (!this.enabled || !this.hintsEnabled || change?.kind !== "ops") return;
    for (const op of change.ops || []) {
      if (op?.from !== this.node.id || !op.shard) continue;
      const scope = explicitShardScope(op.shard, op.seq);
      const key = scopeKey(scope);
      const pending = this.pendingHintScopes.get(key);
      if (!pending || scope.lastSeq > pending.lastSeq) this.pendingHintScopes.set(key, scope);
    }
  }

  _hintTargets(scopes) {
    const byPeer = new Map();
    for (const scope of scopes) {
      for (const peer of this.node.peersForShard(scope.shard)) {
        if (!peer.url || isSelfPeer(this.node, peer)) continue;
        const key = peerKey(peer);
        const entry = byPeer.get(key) || { peer, scopes: [] };
        entry.scopes.push(scope);
        byPeer.set(key, entry);
      }
    }
    return byPeer;
  }

  async _sendHint(peer, scopes, key = peerKey(peer)) {
    if (!peer.hint) return;
    try {
      await peer.hint({
        node: this.node.id,
        url: this.node.url || undefined,
        scopes,
      });
      this.stats.hintsSent++;
      this.stats.hintScopesSent += scopes.length;
      this.stats.lastHintSentAt = new Date().toISOString();
    } catch (err) {
      this._rememberError(err, `hint ${key}`);
    }
  }

  _peerForHint(shard, hint) {
    return this.node.peersForShard(shard).find((peer) => (
      !isSelfPeer(this.node, peer) &&
      (
        (hint.url && normalizeUrl(peer.url) === normalizeUrl(hint.url)) ||
        (hint.node && (peer.nodeId === hint.node || peer.key === hint.node))
      )
    ));
  }

  _drainPullQueue() {
    for (const [key, item] of this.pullQueue) {
      if (this.inflightPulls.has(key)) continue;
      this.pullQueue.delete(key);
      this._runPull(key, item.peer, item.scope);
    }
  }

  async _runPull(key, peer, scope) {
    this.inflightPulls.add(key);
    try {
      await this.node.syncPeer(peer, scope);
      this.stats.pullSyncs++;
      this.stats.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this._rememberError(err, `pull ${key}`);
    } finally {
      this.inflightPulls.delete(key);
      if (this.pullQueue.has(key)) setImmediate(() => this._drainPullQueue());
    }
  }

  _rememberError(err, prefix = "") {
    const message = err?.message || String(err);
    this.stats.lastError = prefix ? `${prefix}: ${message}` : message;
  }
}

function explicitShardScope(shard, lastSeq = 0) {
  return {
    database: GLOBAL_DATABASE,
    collection: GLOBAL_COLLECTION,
    shard,
    lastSeq: Number(lastSeq) || 0,
  };
}

function normalizeHintScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) {
    const err = new Error("body.scopes must be a non-empty array");
    err.status = 400;
    throw err;
  }
  return scopes.map((scope, index) => {
    if (!scope || typeof scope !== "object" || typeof scope.shard !== "string" || !scope.shard) {
      const err = new Error(`scope at index ${index} must include shard`);
      err.status = 400;
      throw err;
    }
    return explicitShardScope(scope.shard, scope.lastSeq);
  });
}

function chunks(values, size) {
  const n = Math.max(1, size);
  const out = [];
  for (let i = 0; i < values.length; i += n) out.push(values.slice(i, i + n));
  return out;
}

function pullKey(peer, scope) {
  return `${peerKey(peer)}|${scopeKey(scope)}`;
}

function scopeKey(scope) {
  return scope ? `${scope.database}/${scope.collection}/${scope.shard}` : "*";
}

function normalizeUrl(url) {
  return url ? String(url).replace(/\/+$/, "") : null;
}

function isSelfPeer(node, peer) {
  return (
    (peer.url && normalizeUrl(peer.url) === node.url) ||
    peer.nodeId === node.id ||
    peer.key === node.id
  );
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
