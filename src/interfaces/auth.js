import { json, readJson } from "../http-router.js";

export function createAuthInterface() {
  return {
    name: "auth",
    register(router, { auth, node, routing }) {
      router.post("/api/:database/:collection/auth", async (req, res) => {
        try {
          const body = await readJson(req);
          const result = await loginWithRouting(req, {
            auth,
            node,
            routing,
            database: req.params.database,
            collection: req.params.collection,
            username: body?.username,
            password: body?.password,
          });
          if (!result) return json(res, 401, { error: "invalid username or password" });
          json(res, 200, result);
        } catch (err) {
          json(res, err.status || 500, err.body || { error: err.message });
        }
      });

      router.post("/api/:database/:collection/renew", async (req, res) => {
        try {
          const body = await readJson(req);
          json(res, 200, await renewWithRouting(req, {
            auth,
            node,
            routing,
            database: req.params.database,
            collection: req.params.collection,
            refreshToken: body?.refreshToken,
          }));
        } catch (err) {
          json(res, err.status || 500, err.body || { error: err.message });
        }
      });
    },
  };
}

async function loginWithRouting(req, { auth, node, routing, database, collection, username, password }) {
  if (!auth.enabled) return auth.login(database, collection, username, password);
  auth.assertLoginInput(database, collection, username, password);

  const targetShard = routing.targetShard(req);
  if (targetShard) {
    routing.assertOwnsTargetShard(targetShard);
    return auth.loginFromUsers(
      database,
      collection,
      username,
      password,
      localAuthUsers({ node, routing, database, collection, username, shard: targetShard }),
    );
  }

  for (const target of routing.queryTargets(database, collection).filter((candidate) => candidate.local)) {
    const result = auth.loginFromUsers(
      database,
      collection,
      username,
      password,
      localAuthUsers({ node, routing, database, collection, username, shard: target.shard }),
    );
    if (result) return result;
  }

  for (const target of routing.queryTargets(database, collection).filter((candidate) => !candidate.local)) {
    const remote = await routing.forwardToShard(req, target.shard, authPath(database, collection), {
      method: "POST",
      body: { username, password },
      retryStatuses: [409, 503],
    });
    if (remote.status === 200) return remote.body;
    if (remote.status === 401 || remote.status === 404) continue;
    throw remoteError(remote, `auth failed on shard ${target.shard}`);
  }

  return null;
}

async function renewWithRouting(req, { auth, node, routing, database, collection, refreshToken }) {
  if (!auth.enabled) return auth.renew(database, collection, refreshToken);

  const claims = auth.verifyRefreshClaims(database, collection, refreshToken);
  const shard = routing.shardForObject(database, collection, claims.sub);
  routing.assertTargetShardMatches(req, shard);

  if (routing.ownsShard(shard)) {
    const user = node.get(database, collection, claims.sub);
    return auth.renewForUser(database, collection, refreshToken, user, claims);
  }

  if (routing.isForwarded(req)) {
    throw Object.assign(new Error(`forward target does not own shard ${shard}`), { status: 409 });
  }

  const remote = await routing.forwardToShard(req, shard, renewPath(database, collection), {
    method: "POST",
    body: { refreshToken },
    retryStatuses: [409, 503],
  });
  if (remote.status === 200) return remote.body;
  throw remoteError(remote, `renew failed on shard ${shard}`);
}

function localAuthUsers({ node, routing, database, collection, username, shard }) {
  if (node.getCollectionMeta(database, collection) === null) return [];
  if (!shard) return node.find(database, collection, { username });
  return node.findShards(database, collection, { username }, {}, [shard]);
}

function authPath(database, collection) {
  return `/api/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/auth`;
}

function renewPath(database, collection) {
  return `/api/${encodeURIComponent(database)}/${encodeURIComponent(collection)}/renew`;
}

function remoteError(remote, fallback) {
  const err = new Error(remote.body?.error || fallback);
  err.status = remote.status;
  err.body = remote.body;
  return err;
}
