import { timingSafeEqual } from "node:crypto";

export const CLUSTER_SECRET_HEADER = "x-spread-db-cluster-secret";

export function normalizeClusterSecret(secret) {
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

export function clusterSecretFromRequest(req, { allowBearer = false } = {}) {
  const header = req?.headers?.[CLUSTER_SECRET_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = req?.headers?.authorization;
  if (allowBearer && typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return null;
}

export function clusterSecretMatches(actual, expected) {
  const normalized = normalizeClusterSecret(expected);
  if (!actual || !normalized) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(normalized);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
