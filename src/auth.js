import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JWT = require("./lib/jwt.cjs");
const { hashPassword, randomUUID, verifyPassword } = require("./lib/crypto.cjs");

export const GLOBAL_DATABASE = "_global";
export const USERS_COLLECTION = "users";

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_BOOTSTRAP_USERS = Object.freeze([
  { id: "admin", username: "admin", password: "123", role: "admin" },
]);

export function normalizeAuthConfig(config = {}) {
  if (config === false || config.enabled === false) return { enabled: false };

  const jwtSecret = config.jwtSecret;
  if (typeof jwtSecret !== "string" || jwtSecret.length === 0) {
    throw new Error("auth.jwtSecret is required");
  }

  return {
    enabled: true,
    jwtSecret,
    accessTokenTtlSeconds: positiveInt(config.accessTokenTtlSeconds, DEFAULT_ACCESS_TTL_SECONDS),
    refreshTokenTtlSeconds: positiveInt(config.refreshTokenTtlSeconds, DEFAULT_REFRESH_TTL_SECONDS),
    clockToleranceSeconds: positiveInt(config.clockToleranceSeconds, 0),
    users: [
      ...(Array.isArray(config.users) ? config.users : []),
      ...DEFAULT_BOOTSTRAP_USERS,
    ],
  };
}

export function createAuthService(node, config = {}) {
  const normalized = normalizeAuthConfig(config);
  if (normalized.enabled === false) return new DisabledAuthService();
  const auth = new AuthService(node, normalized);
  auth.ensureGlobalUsers();
  return auth;
}

export class AuthService {
  constructor(node, config) {
    if (!node) throw new Error("node is required");
    this.node = node;
    this.config = config;
    this.enabled = true;
  }

  ensureGlobalUsers() {
    if (this.node.getDatabaseMeta(GLOBAL_DATABASE) === null) {
      this.node.createDatabase(GLOBAL_DATABASE, { system: true });
    }

    const existingMeta = this.node.getCollectionMeta(GLOBAL_DATABASE, USERS_COLLECTION);
    if (existingMeta === null) {
      this.node.createCollection(GLOBAL_DATABASE, USERS_COLLECTION, {
        system: true,
        indexes: ["username"],
      });
    } else if (!Array.isArray(existingMeta.indexes) || !existingMeta.indexes.includes("username")) {
      this.node.setCollectionMeta(GLOBAL_DATABASE, USERS_COLLECTION, {
        ...existingMeta,
        indexes: unique([...(existingMeta.indexes || []), "username"]),
      });
    }

    for (const user of this.config.users) this.ensureBootstrapUser(user);
  }

  ensureBootstrapUser(user) {
    const prepared = this.prepareUserObject({
      id: user.id || user.username,
      role: "user",
      ...user,
    }, { partial: false });
    const existingById = this.node.get(GLOBAL_DATABASE, USERS_COLLECTION, prepared.id);
    const existingByUsername = this.findUserByUsername(GLOBAL_DATABASE, USERS_COLLECTION, prepared.username);
    if (existingById || existingByUsername) return null;
    return this.node.insertMany(GLOBAL_DATABASE, USERS_COLLECTION, [prepared])[0];
  }

  login(database, collection, username, password) {
    assertName(database, "database");
    assertName(collection, "collection");
    if (typeof username !== "string" || username.length === 0) {
      throw httpError(400, "body.username must be a non-empty string");
    }
    if (typeof password !== "string") {
      throw httpError(400, "body.password must be a string");
    }

    if (this.node.getCollectionMeta(database, collection) === null) return null;

    const matches = this.node.find(database, collection, { username });
    const user = matches.find((candidate) => verifyPassword(password, candidate.password));
    if (!user) return null;
    return this.authResponse(database, collection, user);
  }

  renew(database, collection, refreshToken) {
    assertName(database, "database");
    assertName(collection, "collection");
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw httpError(400, "body.refreshToken must be a non-empty string");
    }

    let claims;
    try {
      claims = JWT.verifyRefreshToken(refreshToken, this.config.jwtSecret, {
        clockToleranceSeconds: this.config.clockToleranceSeconds,
      });
    } catch (err) {
      throw httpError(401, `invalid refresh token: ${err.message}`);
    }

    if (claims.database !== database) {
      throw httpError(403, "token database does not match URL database");
    }
    if (claims.collection !== collection) {
      throw httpError(403, "token collection does not match URL collection");
    }

    const user = this.node.get(database, collection, claims.sub);
    if (!user) throw httpError(401, "invalid refresh token: user not found");
    if ((user.tokenVersion || 0) !== (claims.tokenVersion || 0)) {
      throw httpError(401, "invalid refresh token: token version changed");
    }
    return this.authResponse(database, collection, user, { sessionId: claims.sessionId });
  }

  authResponse(database, collection, user, { sessionId = null } = {}) {
    const pair = this.issueTokenPair(database, collection, user, { sessionId });
    return {
      user: this.redactUser(user),
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  issueTokenPair(database, collection, user, { sessionId = null } = {}) {
    const id = sessionId || randomUUID();
    return {
      accessToken: this.issueToken(database, collection, user, "access", this.config.accessTokenTtlSeconds, id),
      refreshToken: this.issueToken(database, collection, user, "refresh", this.config.refreshTokenTtlSeconds, id),
    };
  }

  issueToken(database, collection, user, type, ttlSeconds, sessionId) {
    const now = Math.floor(Date.now() / 1000);
    return JWT.sign({
      typ: type,
      sub: user.id,
      username: user.username,
      role: user.role || "user",
      database,
      collection,
      globalUser: this.isGlobalUsersCollection(database, collection),
      sessionId,
      tokenVersion: user.tokenVersion || 0,
      iat: now,
      exp: now + ttlSeconds,
    }, this.config.jwtSecret);
  }

  authenticateRequest(req) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return { ok: false, status: 401, error: "missing or malformed Authorization header" };
    }

    const token = header.slice("Bearer ".length).trim();
    try {
      const claims = JWT.verifyAccessToken(token, this.config.jwtSecret, {
        clockToleranceSeconds: this.config.clockToleranceSeconds,
      });
      if (typeof claims.sub !== "string" || typeof claims.database !== "string" || typeof claims.collection !== "string") {
        return { ok: false, status: 401, error: "invalid token: user identity claims required" };
      }
      if (req.params?.database && !this.canAccessDatabase(claims, req.params.database)) {
        return { ok: false, status: 403, error: "token database does not match URL database" };
      }
      req.jwt = claims;
      req.auth = {
        mode: claims.globalUser === true ? "global-user" : "database-user",
        claims,
        user: {
          id: claims.sub,
          username: claims.username,
          role: claims.role || "user",
          database: claims.database,
          collection: claims.collection,
        },
      };
      return { ok: true, claims };
    } catch (err) {
      return { ok: false, status: 401, error: `invalid token: ${err.message}` };
    }
  }

  prepareWriteObjects(database, collection, objects, { partial = false } = {}) {
    const prepared = objects.map((object) => this.prepareUserObject(object, { partial }));
    this.assertUniqueUsernames(database, collection, prepared);
    return prepared;
  }

  prepareUserObject(object, { partial = false } = {}) {
    if (!isPlainObject(object)) throw httpError(400, "user object must be a plain object");

    const next = { ...object };
    if (!partial && next.password !== undefined) {
      if (typeof next.username !== "string" || next.username.length === 0) {
        throw httpError(400, "user.username must be a non-empty string");
      }
      if (typeof next.password !== "string" || next.password.length === 0) {
        throw httpError(400, "user.password must be a non-empty string");
      }
    }

    if (next.username !== undefined && (typeof next.username !== "string" || next.username.length === 0)) {
      throw httpError(400, "user.username must be a non-empty string");
    }
    if (next.password !== undefined) {
      if (typeof next.password !== "string" || next.password.length === 0) {
        throw httpError(400, "user.password must be a non-empty string");
      }
      if (!isPasswordHash(next.password)) next.password = hashPassword(next.password);
    }
    if (next.tokenVersion !== undefined) next.tokenVersion = positiveInt(next.tokenVersion, 0);
    return next;
  }

  assertUniqueUsernames(database, collection, objects) {
    const seen = new Map();
    for (const object of objects) {
      if (object.password === undefined || !object.username) continue;
      const id = object.id === undefined || object.id === null ? null : String(object.id);
      if (seen.has(object.username)) throw httpError(409, `username already exists: ${object.username}`);
      seen.set(object.username, id);

      const matches = this.node.find(database, collection, { username: object.username });
      for (const existing of matches) {
        if (!id || existing.id !== id) throw httpError(409, `username already exists: ${object.username}`);
      }
    }
  }

  findUserByUsername(database, collection, username) {
    return this.node.find(database, collection, { username }, { limit: 1 })[0] || null;
  }

  redactObject(database, collection, object) {
    if (!object || !this.isAuthObject(object)) return object;
    return this.redactUser(object);
  }

  redactObjects(database, collection, objects) {
    return (objects || []).map((object) => this.redactObject(database, collection, object));
  }

  redactResult(database, collection, result) {
    if (!result) return result;
    if (Array.isArray(result)) return this.redactObjects(database, collection, result);
    if (Array.isArray(result.items)) return { ...result, items: this.redactObjects(database, collection, result.items) };
    return this.redactObject(database, collection, result);
  }

  redactUser(user) {
    if (!user) return user;
    const { password, ...safe } = user;
    return safe;
  }

  isGlobalUsersCollection(database, collection) {
    return database === GLOBAL_DATABASE && collection === USERS_COLLECTION;
  }

  isAuthObject(object) {
    return isAuthObject(object);
  }

  canAccessDatabase(claims, database) {
    return claims.globalUser === true || claims.database === database;
  }
}

class DisabledAuthService {
  constructor() {
    this.enabled = false;
  }

  authenticateRequest() {
    return { ok: true, claims: null };
  }

  login() {
    throw httpError(404, "auth is disabled");
  }

  renew() {
    throw httpError(404, "auth is disabled");
  }

  prepareWriteObjects(_database, _collection, objects) {
    return objects;
  }

  redactObject(_database, _collection, object) {
    return object;
  }

  redactObjects(_database, _collection, objects) {
    return objects;
  }

  redactResult(_database, _collection, result) {
    return result;
  }
}

export function isPasswordHash(value) {
  return typeof value === "string" && value.startsWith("pbkdf2$sha256$");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAuthObject(object) {
  return object && object.password !== undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function assertName(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw httpError(400, `${field} must be a non-empty string`);
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
