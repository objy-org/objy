export type ObjectData = Record<string, any>;
export type Query = Record<string, unknown>;
export type Patch = { _id?: string; $set?: ObjectData; $unset?: string[] | Record<string, unknown> };
export type WriteOptions = { minimal?: boolean };
export type QueryOptions = {
  refDepth?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sort?: "asc" | "desc";
};

export interface Collection<T extends ObjectData = ObjectData> {
  get(id: string, options?: QueryOptions): Promise<T | undefined>;
  insert(object: Partial<T>, options?: WriteOptions): Promise<T | undefined>;
  insertMany(objects: Partial<T>[], options?: WriteOptions): Promise<ObjectData>;
  replace(id: string, object: Partial<T>, options?: WriteOptions): Promise<T | undefined>;
  replaceMany(objects: Partial<T>[], options?: WriteOptions): Promise<ObjectData>;
  patch(id: string, patch: Patch, options?: WriteOptions): Promise<T | undefined>;
  patchMany(patches: Patch[], options?: WriteOptions): Promise<ObjectData>;
  remove(id: string): Promise<void>;
  removeMany(ids: (string | { _id: string })[], options?: WriteOptions): Promise<ObjectData>;
  find(query?: Query, options?: QueryOptions): Promise<T[]>;
  search<R = T>(query?: Query, options?: QueryOptions): Promise<R[]>;
  count(query?: Query): Promise<number>;
  iterate(query?: Query, options?: QueryOptions & { pageSize?: number }): AsyncIterableIterator<T>;
  getMeta(): Promise<ObjectData | null>;
  setMeta(meta: ObjectData): Promise<ObjectData>;
  drop(): Promise<void>;
  ready(): Promise<void>;
  stats(): ObjectData;
}

export interface DatabaseHandle {
  collection<T extends ObjectData = ObjectData>(name: string): Collection<T>;
  listCollections(): Promise<{ database: string; collections: string[] }>;
  createCollection(name: string, meta?: ObjectData): Promise<ObjectData>;
  getMeta(): Promise<ObjectData | null>;
  drop(): Promise<void>;
}

export interface Database {
  database(name: string): DatabaseHandle;
  listDatabases(): Promise<{ databases: string[] }>;
  createDatabase(name: string, options?: { meta?: ObjectData }): Promise<ObjectData>;
  ready(): Promise<void>;
  stats(): ObjectData;
  close(): void;
}

export function createDatabase(options?: {
  storage?: ObjectData;
  vector?: ObjectData | false;
}): Database;
