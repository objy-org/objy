import { DEFAULT_SHARD } from "./shard-map.js";
import { aggregateObjects, aggregatePartialObjects, isObjectDbAggregateSpec, mergeAggregatePartials } from "./aggregate.js";
import { compareSortValues, getPathValue } from "./query.js";

export const FORWARDED_HEADER = "x-spread-db-forwarded";
export const TARGET_SHARD_HEADER = "x-spread-db-target-shard";

export class ShardRequestRouter {
  constructor({ node }) {
    if (!node) throw new Error("node is required");
    this.node = node;
  }

  targetShard(req) {
    const value = req.headers[TARGET_SHARD_HEADER];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  isForwarded(req) {
    return req.headers[FORWARDED_HEADER] === "1";
  }

  shardForObject(database, collection, id) {
    return this.node.shardForObject(database, collection, id);
  }

  ownsShard(shard = DEFAULT_SHARD) {
    return this.node.ownsShard(shard);
  }

  shouldHandleObjectLocally(req, database, collection, id) {
    const shard = this.shardForObject(database, collection, id);
    this.assertTargetShardMatches(req, shard);
    if (this.ownsShard(shard)) return true;
    if (this.isForwarded(req)) {
      throw httpError(409, `forward target does not own shard ${shard}`);
    }
    return false;
  }

  groupByShard(req, database, collection, items, idOf) {
    const groups = new Map();
    const seen = new Set();
    for (const item of items || []) {
      const id = String(idOf(item));
      if (seen.has(id)) throw httpError(400, `duplicate id in bulk request: ${id}`);
      seen.add(id);
      const shard = this.shardForObject(database, collection, id);
      this.assertTargetShardMatches(req, shard);
      let group = groups.get(shard);
      if (!group) {
        group = {
          shard,
          local: this.ownsShard(shard),
          items: [],
        };
        if (!group.local && this.isForwarded(req)) {
          throw httpError(409, `forward target does not own shard ${shard}`);
        }
        groups.set(shard, group);
      }
      group.items.push(item);
    }
    return [...groups.values()];
  }

  async find(req, database, collection, criteria = {}, options = {}) {
    const targetShard = this.targetShard(req);
    if (targetShard) {
      this.assertOwnsTargetShard(targetShard);
      return this.findLocalShard(database, collection, criteria, options, targetShard);
    }

    const targets = this.queryTargets(database, collection);
    if (targets.length === 1 && targets[0].local && targets[0].shard === null) {
      return {
        count: countIfNeeded(options, () => this.node.count(database, collection, criteria)),
        objects: this.node.find(database, collection, criteria, options),
      };
    }
    if (targets.every((target) => target.local)) {
      return {
        count: countIfNeeded(options, () => this.node.count(database, collection, criteria)),
        objects: this.node.find(database, collection, criteria, options),
      };
    }

    const all = [];
    let count = options.includeCount ? 0 : undefined;
    const shardOptions = shardFetchOptions(options);
    const localShards = targets.filter((target) => target.local).map((target) => target.shard).filter(Boolean);
    if (localShards.length) {
      const local = this.findLocalShards(database, collection, criteria, shardOptions, localShards);
      if (options.includeCount) count += local.count;
      all.push(...local.objects);
    }
    for (const target of targets) {
      if (target.local) continue;
      const remote = await this.forwardToShard(req, target.shard, objectPath(database, collection), {
        method: "GET",
        query: queryForFind(criteria, shardOptions),
        retryStatuses: [409, 503],
      });
      if (!ok(remote.status)) throw httpError(remote.status, remote.body?.error || "remote query failed", remote.body);
      const objects = responseObjects(remote.body);
      if (options.includeCount) count += responseCount(remote.body, objects.length);
      all.push(...objects);
    }

    return {
      count,
      objects: paginate(sortObjects(all, options), options),
    };
  }

  async aggregate(req, database, collection, criteria = {}, spec = {}) {
    const targetShard = this.targetShard(req);
    if (targetShard) {
      this.assertOwnsTargetShard(targetShard);
      if (isObjectDbAggregateSpec(spec)) {
        return this.node.aggregateShards(database, collection, criteria, spec, [targetShard]);
      }
      const rows = this.findLocalShard(database, collection, criteria, {}, targetShard).objects;
      return isPartialAggregateSpec(spec) ? aggregatePartialObjects(rows, spec) : aggregateObjects(rows, spec);
    }

    const targets = this.queryTargets(database, collection);
    if (targets.length === 1 && targets[0].local && targets[0].shard === null) {
      return this.node.aggregate(database, collection, criteria, spec);
    }
    if (targets.every((target) => target.local)) {
      return this.node.aggregate(database, collection, criteria, spec);
    }

    if (isObjectDbAggregateSpec(spec)) {
      const partials = [];
      const localShards = targets.filter((target) => target.local).map((target) => target.shard).filter(Boolean);
      if (localShards.length) {
        partials.push(...this.node.aggregateShards(database, collection, criteria, partialAggregateSpec(spec), localShards));
      }
      const partialSpec = partialAggregateSpec(spec);
      for (const target of targets) {
        if (target.local) continue;
        const remote = await this.forwardToShard(req, target.shard, objectPath(database, collection), {
          method: "GET",
          query: queryForAggregate(criteria, partialSpec),
          retryStatuses: [409, 503],
        });
        if (!ok(remote.status)) throw httpError(remote.status, remote.body?.error || "remote aggregate failed", remote.body);
        partials.push(...responseObjects(remote.body));
      }
      return mergeAggregatePartials(partials, spec);
    }

    const rows = [];
    const localShards = targets.filter((target) => target.local).map((target) => target.shard).filter(Boolean);
    if (localShards.length) {
      rows.push(...this.findLocalShards(database, collection, criteria, {}, localShards).objects);
    }
    for (const target of targets) {
      if (target.local) continue;
      const remote = await this.forwardToShard(req, target.shard, objectPath(database, collection), {
        method: "GET",
        query: queryForCriteria(criteria),
        retryStatuses: [409, 503],
      });
      if (!ok(remote.status)) throw httpError(remote.status, remote.body?.error || "remote aggregate scan failed", remote.body);
      rows.push(...responseObjects(remote.body));
    }
    return aggregateObjects(rows, spec);
  }

  async vectorSearch(req, database, collection, criteria = {}, vector = {}, options = {}) {
    const targetShard = this.targetShard(req);
    if (targetShard) {
      this.assertOwnsTargetShard(targetShard);
      return finalizeVectorRows(
        this.vectorSearchLocalShard(database, collection, criteria, vector, targetShard, options),
        vector,
        options,
      );
    }

    const targets = this.queryTargets(database, collection);
    if (targets.length === 1 && targets[0].local && targets[0].shard === null) {
      return finalizeVectorRows(
        this.vectorSearchLocalShard(database, collection, criteria, vector, null, options),
        vector,
        options,
      );
    }
    if (targets.every((target) => target.local)) {
      const shards = targets.map((target) => target.shard).filter(Boolean);
      return finalizeVectorRows(
        this.vectorSearchLocalShards(database, collection, criteria, vector, shards, options),
        vector,
        options,
      );
    }

    const all = [];
    const localShards = targets.filter((target) => target.local).map((target) => target.shard).filter(Boolean);
    if (localShards.length) {
      all.push(...this.vectorSearchLocalShards(database, collection, criteria, vector, localShards, options));
    }

    for (const target of targets) {
      if (target.local) continue;
      const remote = await this.forwardToShard(req, target.shard, searchPath(database, collection), {
        method: "POST",
        body: queryForVectorSearch(criteria, vector, options),
        retryStatuses: [409, 503],
      });
      if (!ok(remote.status)) throw httpError(remote.status, remote.body?.error || "remote vector search failed", remote.body);
      all.push(...responseObjects(remote.body));
    }

    return finalizeVectorRows(all, vector, options);
  }

  findLocalShard(database, collection, criteria = {}, options = {}, shard) {
    if (!shard) {
      return {
        count: countIfNeeded(options, () => this.node.count(database, collection, criteria)),
        objects: this.node.find(database, collection, criteria, options),
      };
    }
    return this.findLocalShards(database, collection, criteria, options, [shard]);
  }

  findLocalShards(database, collection, criteria = {}, options = {}, shards = []) {
    const shardSet = new Set((shards || []).filter(Boolean));
    if (!shardSet.size) {
      return {
        count: countIfNeeded(options, () => this.node.count(database, collection, criteria)),
        objects: this.node.find(database, collection, criteria, options),
      };
    }
    return {
      count: countIfNeeded(options, () => this.node.countShards(database, collection, criteria, [...shardSet])),
      objects: this.node.findShards(database, collection, criteria, options, [...shardSet]),
    };
  }

  vectorSearchLocalShard(database, collection, criteria = {}, vector = {}, shard = null, options = {}) {
    if (!shard) return this.vectorSearchLocalShards(database, collection, criteria, vector, [], options);
    return this.vectorSearchLocalShards(database, collection, criteria, vector, [shard], options);
  }

  vectorSearchLocalShards(database, collection, criteria = {}, vector = {}, shards = [], options = {}) {
    const queryVec = vector.queryVec || vector.vector;
    const limit = vector.limit || 20;
    const shardSet = new Set((shards || []).filter(Boolean));
    const includeId = shardSet.size
      ? (id) => shardSet.has(this.shardForObject(database, collection, id))
      : null;

    if (criteria && Object.keys(criteria).length > 0) {
      const rows = this.node.find(database, collection, criteria, includeId ? { includeId } : {});
      return this.node.rankVectorRows(database, collection, rows, queryVec, limit);
    }

    const hits = includeId
      ? this.node.vectorSearchShards(database, collection, queryVec, limit, [...shardSet], { ef: vector.ef })
      : this.node.vectorSearch(database, collection, queryVec, limit, { ef: vector.ef });
    return hits
      .map((hit) => {
        const row = this.node.get(database, collection, hit.id, { refDepth: 0 });
        return row ? { ...row, _score: hit._score } : null;
      })
      .filter(Boolean);
  }

  queryTargets(database, collection) {
    const shards = this.node.shardMap.shardsForCollection(database, collection);
    if (!shards.length) return [{ shard: null, local: true }];
    return shards.map((shard) => ({
      shard,
      local: this.ownsShard(shard),
    }));
  }

  async forwardToObject(req, database, collection, id, path, options = {}) {
    const shard = this.shardForObject(database, collection, id);
    return this.forwardToShard(req, shard, path, options);
  }

  async forwardToShard(req, shard, path, {
    method = "GET",
    body,
    query,
    retryStatuses = [409, 502, 503, 504],
  } = {}) {
    const peers = this.node.routingPeersForShard(shard);
    if (!peers.length) throw httpError(503, `no remote peer available for shard ${shard}`);

    let last = null;
    for (const peer of peers) {
      try {
        const response = await this.forwardJson(req, peer, shard, path, { method, body, query });
        last = response;
        if (!retryStatuses.includes(response.status)) return response;
      } catch (err) {
        last = {
          status: err.status || 503,
          body: { error: err.message },
        };
      }
    }
    return last;
  }

  async forwardToAllPeers(req, path, {
    method = "GET",
    body,
    retryStatuses = [502, 503, 504],
  } = {}) {
    const peers = this.node.shardMap.allPeers().filter((peer) => peer.url && !this.node._isSelfPeer(peer));
    const unique = new Map(peers.map((peer) => [peer.url, peer]));
    const responses = [];
    for (const peer of unique.values()) {
      const response = await this.forwardJson(req, peer, null, path, {
        method,
        body,
        forwardedOnly: true,
      });
      responses.push(response);
      if (retryStatuses.includes(response.status) || !ok(response.status)) return response;
    }
    return { status: 200, body: { ok: true, peers: responses.length } };
  }

  async forwardJson(req, peer, shard, path, { method = "GET", body, query, forwardedOnly = false } = {}) {
    const suffix = query ? `?${query}` : "";
    const headers = forwardedOnly ? forwardedControlHeaders(req, body !== undefined) : forwardedHeaders(req, shard, body !== undefined);
    const response = await fetch(`${peer.url}${path}${suffix}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  }

  assertTargetShardMatches(req, shard) {
    const targetShard = this.targetShard(req);
    if (targetShard && targetShard !== shard) {
      throw httpError(409, `object belongs to shard ${shard}, not forwarded shard ${targetShard}`);
    }
  }

  assertOwnsTargetShard(shard) {
    if (!this.ownsShard(shard)) throw httpError(409, `forward target does not own shard ${shard}`);
  }
}

export function httpError(status, message, body) {
  const err = new Error(message);
  err.status = status;
  err.body = body;
  return err;
}

export function ok(status) {
  return status >= 200 && status < 300;
}

export function objectPath(database, collection, id = null) {
  const base = `/api/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/object`;
  return id === null ? base : `${base}/${encodeURIComponent(id)}`;
}

export function searchPath(database, collection) {
  return `/api/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/search`;
}

function queryForCriteria(criteria) {
  const query = new URLSearchParams();
  if (criteria && Object.keys(criteria).length > 0) query.set("q", JSON.stringify(criteria));
  return query.toString();
}

function queryForFind(criteria, options = {}) {
  const query = new URLSearchParams(queryForCriteria(criteria));
  if (options.sortBy) query.set("sortBy", options.sortBy);
  if (options.sort) query.set("sort", options.sort);
  if (options.limit !== undefined && Number.isFinite(options.limit)) query.set("limit", String(options.limit));
  if (options.offset !== undefined && Number.isFinite(options.offset)) query.set("offset", String(options.offset));
  if (options.refDepth !== undefined) query.set("$refDepth", String(options.refDepth));
  return query.toString();
}

function queryForAggregate(criteria, spec = {}) {
  const query = new URLSearchParams();
  query.set("q", JSON.stringify({
    ...(criteria || {}),
    $aggregate: spec,
    $refDepth: 0,
  }));
  return query.toString();
}

function queryForVectorSearch(criteria, vector = {}, options = {}) {
  return {
    ...(criteria || {}),
    $vector: {
      vector: vector.queryVec || vector.vector,
      limit: vector.limit,
      ...(vector.ef ? { ef: vector.ef } : {}),
    },
    $refDepth: 0,
    ...(options.sortBy ? { $sort: { [options.sortBy]: options.sort === "desc" ? "desc" : "asc" } } : {}),
  };
}

function partialAggregateSpec(spec = {}) {
  return { ...(spec || {}), $partial: true };
}

function isPartialAggregateSpec(spec = {}) {
  return spec?.$partial === true;
}

function shardFetchOptions(options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : undefined;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  return {
    ...(options.sortBy ? { sortBy: options.sortBy } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
    ...(limit !== undefined ? { limit: offset + limit } : {}),
    offset: 0,
    ...(options.includeCount ? { includeCount: true } : {}),
  };
}

function countIfNeeded(options, count) {
  return options.includeCount ? count() : undefined;
}

function forwardedHeaders(req, shard, hasBody) {
  const headers = {
    [FORWARDED_HEADER]: "1",
    [TARGET_SHARD_HEADER]: shard,
  };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.prefer) headers.prefer = req.headers.prefer;
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

function forwardedControlHeaders(req, hasBody) {
  const headers = {
    [FORWARDED_HEADER]: "1",
  };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers.prefer) headers.prefer = req.headers.prefer;
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

function sortObjects(objects, options = {}) {
  if (!options.sortBy) return [...objects];
  const direction = options.sort === "desc" ? -1 : 1;
  return [...objects].sort((left, right) => {
    return compareSortValues(getPathValue(left, options.sortBy), getPathValue(right, options.sortBy)) * direction;
  });
}

function paginate(objects, options = {}) {
  const offset = options.offset || 0;
  const limit = options.limit ?? Infinity;
  if (limit <= 0) return [];
  return objects.slice(offset, offset + limit);
}

function finalizeVectorRows(rows, vector = {}, options = {}) {
  const limit = Number.isFinite(vector.limit) ? vector.limit : 20;
  const ranked = [...(rows || [])]
    .filter((row) => typeof row?._score === "number")
    .sort((left, right) => right._score - left._score)
    .slice(0, limit);
  return options.sortBy ? sortObjects(ranked, options) : ranked;
}

function responseObjects(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.objects)) return body.objects;
  return [];
}

function responseCount(body, fallback) {
  return Number.isFinite(body?.count) ? body.count : fallback;
}
