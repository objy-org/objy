export type Query = Record<string, unknown>;
export type ObjectData = Record<string, any>;
export interface Session {
  database: string;
  collection: string;
  accessToken: string;
  refreshToken?: string;
  user?: ObjectData;
  expiresIn?: number;
  [key: string]: unknown;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: HeadersInit;
}
export interface QueryOptions extends RequestOptions {
  refDepth?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sort?: 'asc' | 'desc';
}
export interface WriteOptions extends QueryOptions { minimal?: boolean }
export interface FileOptions extends RequestOptions { filename?: string }
export type Patch = { _id?: string; $set?: ObjectData; $unset?: string[] };
export interface BulkResult<T = ObjectData> {
  inserted?: number;
  replaced?: number;
  updated?: number;
  deleted?: number;
  items?: T[];
  ids?: string[];
  skipped?: number | string[];
}
export type ImportSource = string | Blob | ReadableStream<Uint8Array> | Iterable<ObjectData> | AsyncIterable<ObjectData>;
export interface Collection<T extends ObjectData = ObjectData> {
  get(id: string, options?: QueryOptions): Promise<T>;
  insert(object: Partial<T>, options?: WriteOptions): Promise<T>;
  replace(id: string, object: Partial<T>, options?: WriteOptions): Promise<T>;
  patch(id: string, patch: Patch, options?: WriteOptions): Promise<T>;
  remove(id: string, options?: RequestOptions): Promise<void>;
  find(query?: Query, options?: QueryOptions): Promise<T[]>;
  search<R = T>(query?: Query, options?: QueryOptions): Promise<R[]>;
  count(query?: Query, options?: QueryOptions): Promise<number>;
  iterate(query?: Query, options?: QueryOptions & { pageSize?: number }): AsyncIterableIterator<T>;
  insertMany(objects: Partial<T>[], options?: WriteOptions): Promise<BulkResult<T>>;
  replaceMany(objects: Partial<T>[], options?: WriteOptions): Promise<BulkResult<T>>;
  patchMany(patches: Patch[], options?: WriteOptions): Promise<BulkResult<T>>;
  removeMany(ids: (string | { _id: string })[], options?: WriteOptions): Promise<BulkResult<T>>;
  import(source: ImportSource | (() => ImportSource | Promise<ImportSource>), options?: RequestOptions & { operation?: 'insert' | 'replace' | 'patch' | 'remove' }): Promise<BulkResult<T>>;
  insertFile(object: Partial<T>, file: Blob, options?: FileOptions): Promise<T>;
  replaceFile(id: string, object: Partial<T>, file: Blob, options?: FileOptions): Promise<T>;
  download(id: string, options?: RequestOptions): Promise<Response>;
  getMeta(options?: RequestOptions): Promise<ObjectData>;
  setMeta(meta: ObjectData, options?: RequestOptions): Promise<ObjectData>;
  drop(options?: RequestOptions): Promise<void>;
}
export interface Database {
  collection<T extends ObjectData = ObjectData>(name: string): Collection<T>;
  listCollections(options?: RequestOptions): Promise<{ database: string; collections: string[] }>;
  createCollection(name: string, meta?: ObjectData, options?: RequestOptions): Promise<ObjectData>;
  drop(options?: RequestOptions): Promise<void>;
}
export interface Client {
  login(credentials: { database?: string; collection?: string; username: string; password: string }, options?: RequestOptions): Promise<Session>;
  renew(): Promise<Session>;
  logout(): void;
  setSession(session: Session | null): void;
  getSession(): Session | null;
  database(name: string): Database;
  listDatabases(options?: RequestOptions): Promise<{ databases: string[] }>;
  createDatabase(name: string, options?: RequestOptions & { meta?: ObjectData; adminUser?: ObjectData }): Promise<ObjectData>;
  health(options?: RequestOptions): Promise<ObjectData>;
  status(options?: RequestOptions & { details?: boolean }): Promise<ObjectData>;
}
export class ObjyDBError extends Error {
  constructor(message: string, details?: Record<string, unknown>);
  status: number;
  code: string;
  body?: unknown;
  headers?: Record<string, string>;
  writeMayHaveSucceeded: boolean;
}
export function createClient(options?: {
  url?: string | URL;
  fetch?: typeof fetch;
  autoRenew?: boolean;
  timeoutMs?: number;
  headers?: HeadersInit;
  session?: Session;
}): Client;
