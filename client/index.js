/** The same dependency-free module runs in browsers and Node. */
export class ObjyDBError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'ObjyDBError';
    this.status = 0;
    this.code = 'REQUEST_FAILED';
    this.writeMayHaveSucceeded = false;
    Object.assign(this, details);
  }
}

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const segment = value => {
  if (value == null || String(value) === '' || ['.', '..'].includes(String(value))) {
    throw new TypeError('Database, collection and object identifiers must be non-empty and cannot be dot segments');
  }
  return encodeURIComponent(String(value));
};
const changedSession = () => new ObjyDBError('The session changed during this request', { code: 'SESSION_CHANGED' });

function tokenSession(result, database, collection) {
  if (typeof result?.accessToken !== 'string' || !result.accessToken || typeof result?.refreshToken !== 'string' || !result.refreshToken) {
    throw new ObjyDBError('Authentication response is missing tokens', { code: 'INVALID_RESPONSE' });
  }
  return { ...copy(result), database, collection };
}

function serverUrl(value) {
  const url = new URL(value ?? import.meta.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Provide an HTTP(S) url when importing the client from a package or file');
  if (value === undefined) { url.search = ''; url.hash = ''; }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('Client url must not contain credentials, query parameters or a fragment');
  if (value === undefined) url.pathname = url.pathname.replace(/\/client(?:\/[^/]+)?\.js$/, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function deadline(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative number');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(new ObjyDBError('Request timed out', { code: 'TIMEOUT' })), timeoutMs) : null;
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function downloadResponse(response, cleanup) {
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { cleanup(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { cleanup(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { cleanup(); } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Tokens live only in this client instance. Persist getSession() explicitly if desired. */
export function createClient({ url, fetch: fetcher = globalThis.fetch, autoRenew = true,
  timeoutMs = 30_000, headers: defaultHeaders, session: initialSession } = {}) {
  const base = serverUrl(url);
  if (typeof fetcher !== 'function') throw new TypeError('A fetch implementation is required');
  let session = null;
  let identity = 0;
  let refreshing = null;

  function setSession(value) {
    const next = copy(value);
    if (next) {
      segment(next.database);
      segment(next.collection);
      if (typeof next.accessToken !== 'string' || !next.accessToken) throw new TypeError('Session requires an accessToken');
      if (next.refreshToken !== undefined && typeof next.refreshToken !== 'string') throw new TypeError('refreshToken must be a string');
    }
    identity++;
    session = next;
    refreshing = null;
  }
  if (initialSession) setSession(initialSession);

  async function request(path, { method = 'GET', json, bodyFactory, replayable = true, auth = true,
    write = false, raw = false, query, ...options } = {}) {
    const destination = new URL(path, base);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) destination.searchParams.set(key, String(value));
    }
    const encoded = json === undefined ? undefined : JSON.stringify(json);
    const startedIdentity = identity;
    const life = deadline(options.signal, options.timeoutMs ?? timeoutMs);
    let transferred = false;
    let sent = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        life.signal.throwIfAborted();
        if (auth && identity !== startedIdentity) throw changedSession();
        const accessToken = auth ? session?.accessToken : null;
        const headers = new Headers(defaultHeaders);
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
        headers.delete('authorization');
        if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
        if (encoded !== undefined) headers.set('content-type', 'application/json');
        const body = bodyFactory ? await waitFor(Promise.resolve(bodyFactory()), life.signal) : encoded;
        life.signal.throwIfAborted();
        if (auth && identity !== startedIdentity) throw changedSession();
        if (body instanceof FormData) headers.delete('content-type');
        // A stream must be supplied afresh by its factory when a request is replayed.
        const streaming = body instanceof ReadableStream;
        if (streaming && !supportsRequestStreams()) {
          await body.cancel();
          throw new ObjyDBError('This runtime cannot stream uploads; use an NDJSON Blob or text instead', { code: 'STREAMING_UNSUPPORTED' });
        }
        sent = true;
        const response = await fetcher(destination.href, {
          method, headers, body, signal: life.signal, credentials: 'omit', redirect: 'error',
          ...(streaming ? { duplex: 'half' } : {}),
        });
        if (response.ok && raw) {
          transferred = true;
          return downloadResponse(response, life.close);
        }
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : undefined; }
        catch (cause) {
          if (response.ok) throw new ObjyDBError('Invalid JSON response', { code: 'INVALID_RESPONSE', status: response.status, cause, writeMayHaveSucceeded: write });
          data = { error: text || response.statusText };
        }
        if (response.ok) return data;
        sent = false;
        const error = new ObjyDBError(data?.error || `HTTP ${response.status}`, {
          status: response.status, code: data?.code || 'HTTP_ERROR', body: data,
          headers: Object.fromEntries(response.headers),
          writeMayHaveSucceeded: Boolean(data?.writeMayHaveSucceeded ?? (write && (
            response.status >= 500 && response.status !== 501 ||
            ['inserted', 'replaced', 'updated', 'deleted'].some(key => data?.[key] > 0)
          ))),
        });
        // Only this server-auth marker guarantees rejection before any object operation.
        const expired = response.status === 401 && data?.code === 'ACCESS_TOKEN_EXPIRED' && data?.operationStarted === false;
        if (attempt || !auth || !autoRenew || !expired || error.writeMayHaveSucceeded || !session?.refreshToken) throw error;
        if (identity !== startedIdentity) throw changedSession();
        if (!replayable) {
          throw new ObjyDBError('Expired token: provide a fresh stream factory to allow request replay', {
            ...error, code: 'BODY_NOT_REPLAYABLE', cause: error,
          });
        }
        if (session.accessToken === accessToken) await waitFor(renew(), life.signal);
      }
    } catch (cause) {
      if (life.signal.aborted) cause = life.signal.reason;
      if (cause instanceof ObjyDBError) {
        if (life.signal.aborted && write && sent) cause.writeMayHaveSucceeded = true;
        throw cause;
      }
      throw new ObjyDBError(life.signal.aborted ? 'Request cancelled' : 'Request failed', {
        code: life.signal.aborted ? 'ABORTED' : 'NETWORK_ERROR', cause,
        writeMayHaveSucceeded: write && sent,
      });
    } finally { if (!transferred) life.close(); }
  }

  function renew() {
    if (!session?.refreshToken) return Promise.reject(new ObjyDBError('No refresh token is available', { code: 'NO_REFRESH_TOKEN' }));
    if (refreshing) return refreshing;
    const previous = session;
    const startedIdentity = identity;
    const promise = request(`api/${segment(previous.database)}/${segment(previous.collection)}/renew`, {
      method: 'POST', json: { refreshToken: previous.refreshToken }, auth: false,
    }).then(result => {
      if (identity !== startedIdentity) throw changedSession();
      session = tokenSession(result, previous.database, previous.collection);
      return copy(session);
    }).catch(error => {
      if (identity === startedIdentity && [401, 403].includes(error.status)) setSession(null);
      throw error;
    }).finally(() => { if (refreshing === promise) refreshing = null; });
    refreshing = promise;
    return promise;
  }

  function collection(database, name) {
    const scope = `api/${segment(database)}/${segment(name)}`;
    const objects = `${scope}/object`;
    const read = (path, options = {}, extra = {}) => request(path, {
      ...options, ...extra, query: { ...extra.query, ...queryOptions(options) },
    });
    const write = (method, path, data, options = {}) => request(path, {
      ...options, method, json: data, write: true, query: queryOptions(options),
      headers: { ...Object.fromEntries(new Headers(options.headers)), ...(options.minimal ? { prefer: 'return=minimal' } : {}) },
    });
    const file = (method, path, object, blob, options = {}) => {
      if (!(blob instanceof Blob)) throw new TypeError('File must be a Blob or File');
      const encoded = JSON.stringify(object);
      return request(path, { ...options, method, write: true, bodyFactory: () => {
        const form = new FormData();
        form.append('object', encoded);
        form.append('file', blob, options.filename || blob.name || 'file');
        return form;
      } });
    };
    const handle = {
      get: (id, options) => read(`${objects}/${segment(id)}`, options),
      insert: (object, options) => write('POST', objects, object, options),
      replace: (id, object, options) => write('PUT', `${objects}/${segment(id)}`, object, options),
      patch: (id, patch, options) => write('PATCH', `${objects}/${segment(id)}`, patch, options),
      remove: (id, options) => write('DELETE', `${objects}/${segment(id)}`, undefined, options),
      find: (query = {}, options) => read(objects, { refDepth: query.$refDepth, ...options }, { query: { q: JSON.stringify(query) } }),
      search: (query = {}, options) => read(`${scope}/search`, { refDepth: query.$refDepth, ...options }, { method: 'POST', json: query }),
      async count(query = {}, options) {
        const rows = await handle.search({ ...query, $aggregate: { fields: { count: { $count: true } } } }, options);
        return rows[0]?.count ?? 0;
      },
      async *iterate(query = {}, options = {}) {
        if (query.$aggregate || query.$vector) throw new TypeError('iterate supports ordinary object queries only');
        const snapshot = copy(query);
        const { pageSize = 250, offset = 0, limit = Infinity, ...rest } = options;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250 || !Number.isInteger(offset) || offset < 0 || !(limit === Infinity || Number.isInteger(limit) && limit >= 0)) {
          throw new TypeError('Invalid iteration pageSize, offset or limit');
        }
        let seen = 0;
        while (seen < limit) {
          const size = Math.min(pageSize, limit - seen);
          const rows = await handle.search(snapshot, { ...rest,
            sortBy: rest.sortBy ?? (snapshot.$sort === undefined ? '_id' : undefined),
            sort: rest.sort, offset: offset + seen, limit: size,
          });
          if (!rows.length) break;
          for (const row of rows) { yield row; seen++; }
          if (rows.length < size) break;
        }
      },
      insertMany: (objectsToInsert, options) => write('POST', objects, array(objectsToInsert), options),
      replaceMany: (objectsToReplace, options) => write('PUT', objects, array(objectsToReplace), options),
      patchMany: (patches, options) => write('PATCH', objects, array(patches), options),
      removeMany: (ids, options) => write('DELETE', objects, { ids: array(ids) }, options),
      import(source, { operation = 'insert', ...options } = {}) {
        const method = { insert: 'POST', replace: 'PUT', patch: 'PATCH', remove: 'DELETE' }[operation];
        if (!method) throw new TypeError('Import operation must be insert, replace, patch or remove');
        if (Array.isArray(source)) source = ndjsonBody(source);
        const factory = typeof source === 'function';
        const replayable = factory || typeof source === 'string' || source instanceof Blob || Array.isArray(source);
        return request(objects, { ...options, method, write: true, replayable,
          headers: { ...Object.fromEntries(new Headers(options.headers)), 'content-type': 'application/x-ndjson', prefer: 'return=minimal' },
          bodyFactory: async () => ndjsonBody(factory ? await source() : source),
        });
      },
      insertFile: (object, blob, options) => file('POST', objects, object, blob, options),
      replaceFile: (id, object, blob, options) => file('PUT', `${objects}/${segment(id)}`, object, blob, options),
      download: (id, options) => request(`${objects}/${segment(id)}/blob`, { ...options, raw: true }),
      getMeta: options => request(`${scope}/meta`, options),
      setMeta: (meta, options) => write('PUT', `${scope}/meta`, meta, options),
      drop: options => write('DELETE', `api/${segment(database)}/collections/${segment(name)}`, undefined, options),
    };
    return Object.freeze(handle);
  }

  return Object.freeze({
    async login({ database = '_global', collection = 'users', username, password }, options) {
      const startedIdentity = ++identity;
      session = null;
      refreshing = null;
      const result = await request(`api/${segment(database)}/${segment(collection)}/auth`, {
        ...options, method: 'POST', json: { username, password }, auth: false,
      });
      if (identity !== startedIdentity) throw changedSession();
      session = tokenSession(result, database, collection);
      return copy(session);
    },
    renew,
    logout: () => setSession(null),
    setSession,
    getSession: () => copy(session),
    health: options => request('health', { ...options, auth: false }),
    status: ({ details, ...options } = {}) => request('api/config', { ...options, query: { details: details ? 1 : undefined } }),
    listDatabases: options => request('api/databases', options),
    createDatabase: (name, { meta, adminUser, ...options } = {}) => request('api/databases', { ...options, method: 'POST', write: true, json: { name, meta, adminUser } }),
    database(name) {
      const scope = `api/${segment(name)}/collections`;
      return Object.freeze({
        collection: collectionName => collection(name, collectionName),
        listCollections: options => request(scope, options),
        createCollection: (collectionName, meta = {}, options) => request(scope, { ...options, method: 'POST', write: true, json: { name: collectionName, meta } }),
        drop: options => request(`api/databases/${segment(name)}`, { ...options, method: 'DELETE', write: true }),
      });
    },
  });
}

function supportsRequestStreams() {
  let supported = false;
  try {
    const request = new Request('http://localhost', {
      method: 'POST', body: new ReadableStream({ start(controller) { controller.close(); } }),
      get duplex() { supported = true; return 'half'; },
    });
    return supported && !request.headers.has('content-type');
  } catch { return false; }
}

function array(value) {
  if (!Array.isArray(value)) throw new TypeError('Expected an array');
  return value;
}

function queryOptions({ refDepth, limit, offset, sortBy, sort } = {}) {
  return { refDepth, limit, offset, sortBy, sort };
}

function ndjsonBody(source) {
  if (typeof source === 'string' || source instanceof Blob) return source;
  if (Array.isArray(source)) return new Blob(source.map(value => JSON.stringify(value) + '\n'), { type: 'application/x-ndjson' });
  if (source instanceof ReadableStream) return source;
  const iterator = source?.[Symbol.asyncIterator]?.() ?? source?.[Symbol.iterator]?.();
  if (!iterator) throw new TypeError('Import source must be NDJSON text, a Blob, a ReadableStream, or an iterable of objects');
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  });
}
