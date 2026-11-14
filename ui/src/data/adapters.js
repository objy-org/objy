import { createClient } from "@objy/client";

// The application depends only on these asynchronous operations, never SDK handles.
export const ADAPTER_METHODS = [
  "open",
  "close",
  "listDatabases",
  "createDatabase",
  "dropDatabase",
  "listCollections",
  "createCollection",
  "dropCollection",
  "search",
  "count",
  "get",
  "insertMany",
  "insertFile",
  "replaceFile",
  "downloadFile",
  "patch",
  "replace",
  "removeMany",
  "getMeta",
  "setMeta",
  "getClusterStatus",
];

function operations(api) {
  const database = (name) => api.database(name);
  const collection = (db, name) => database(db).collection(name);
  return {
    getClusterStatus: (options) => api.status(options),
    listDatabases: async () => (await api.listDatabases()).databases,
    createDatabase: (name, meta) => api.createDatabase(name, { meta }),
    dropDatabase: (name) => database(name).drop(),
    listCollections: async (db) =>
      (await database(db).listCollections()).collections,
    createCollection: (db, name) => database(db).createCollection(name),
    dropCollection: (db, name) => collection(db, name).drop(),
    search: (db, name, query, options) =>
      collection(db, name).search(query, options),
    count: (db, name, query = {}) => collection(db, name).count(query),
    get: async (db, name, id) => {
      try {
        return await collection(db, name).get(id, { refDepth: 0 });
      } catch (error) {
        if (error.status === 404) return undefined;
        throw error;
      }
    },
    insertMany: (db, name, objects) => collection(db, name).insertMany(objects),
    insertFile: (db, name, object, file) =>
      collection(db, name).insertFile(object, file, { filename: file.name }),
    replaceFile: (db, name, id, object, file) =>
      collection(db, name).replaceFile(id, object, file, { filename: file.name }),
    downloadFile: async (db, name, id, options) =>
      (await collection(db, name).download(id, options)).blob(),
    patch: (db, name, id, patch) => collection(db, name).patch(id, patch),
    replace: (db, name, id, object) => collection(db, name).replace(id, object),
    removeMany: (db, name, ids) => collection(db, name).removeMany(ids),
    getMeta: (db, name) => collection(db, name).getMeta(),
    setMeta: (db, name, meta) => collection(db, name).setMeta(meta),
  };
}

export function createServerAdapter({
  url,
  username,
  password,
  database = "_global",
  collection = "users",
  session,
  sessionAccess,
  ...clientOptions
}) {
  // Let the official client validate URLs; never store credentials in a URL.
  const client = createClient({ ...clientOptions, url, session });
  const address = new URL(url);
  let credentials = username
    ? { username, password, database, collection }
    : null;
  let closed = false;
  let access = sessionAccess;
  const sessionControls = {
    get: () => client.getSession(),
    set: (value) => client.setSession(value),
    clear: () => client.logout(),
  };
  const native = operations(client);
  const wrapped = Object.fromEntries(
    Object.entries(native).map(([name, operation]) => [
      name,
      async (...args) => {
        if (closed) throw new Error("This server connection was closed.");
        const execute = async () => {
          if (closed) throw new Error("This server connection was closed.");
          try {
            return await operation(...args);
          } catch (error) {
            // Permission failures (403) and network failures do not invalidate login.
            // The SDK itself clears sessions when refresh credentials are rejected.
            if (error.status === 401 && !error.writeMayHaveSucceeded)
              client.logout();
            throw error;
          }
        };
        try {
          return await (access ? access(sessionControls, execute) : execute());
        } catch (error) {
          throw serverError(error);
        }
      },
    ]),
  );
  return {
    ...wrapped,
    info: Object.freeze({
      kind: "server",
      label: address.host + address.pathname.replace(/\/$/, ""),
      url: address.href,
      package: "@objy/client",
      version: "0.1.0",
    }),
    async open() {
      try {
        if (credentials) await client.login(credentials);
      } catch (error) {
        throw serverError(error);
      } finally {
        credentials = null;
      }
    },
    getSession: () => client.getSession(),
    persistWith(value) {
      access = value;
    },
    close() {
      closed = true;
      credentials = null;
      client.logout();
    },
  };
}

function serverError(error) {
  let message;
  if (error.writeMayHaveSucceeded)
    message =
      "The server may have applied this change, but its result could not be confirmed. Refresh and inspect the data before repeating it.";
  else if (error.status === 401)
    message =
      "Authentication failed or expired. Connect again with valid credentials.";
  else if (error.status === 403)
    message = "This account does not have permission for this operation.";
  else if (
    !error.status &&
    (["NETWORK_ERROR", "ABORTED"].includes(error.code) ||
      /fetch|network|timeout|abort/i.test(error.message))
  )
    message =
      "Could not reach the OBJY server. Check its address, availability and CORS settings.";
  else message = error.message;
  return Object.assign(new Error(message, { cause: error }), {
    status: error.status,
    code: error.code,
    writeMayHaveSucceeded: Boolean(error.writeMayHaveSucceeded),
  });
}
