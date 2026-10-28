import type {
  BrowserCollection,
  BrowserDatabase,
  BrowserDatabaseHandle,
  ObjectData,
  Patch,
  Query,
  QueryOptions,
  WriteOptions,
} from "./browser.js";

export type { ObjectData, Patch, Query, QueryOptions, WriteOptions };
export type Collection<T extends ObjectData = ObjectData> = BrowserCollection<T>;
export type DatabaseHandle = BrowserDatabaseHandle;
export type Database = BrowserDatabase;

export function createDatabase(options?: {
  storage?: ObjectData;
  vector?: ObjectData | false;
}): Database;
