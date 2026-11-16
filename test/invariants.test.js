import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import test from 'node:test';
import { CRDTNode, localPeer } from '../src/crdt.js';
import { nodeCompression } from '../src/node-runtime.js';
import { matchesQuery, compareSortValues } from '../src/query.js';
import { applyPatchToObject } from '../src/patch.js';
import { MemoryObjectStorage } from '../src/object-storage.js';
import { PersistenceManager } from '../src/persistence.js';
import { LocalWalStore } from '../src/local-wal.js';
import { startServer } from '../src/server.js';

function check(feature, name, run) {
  return test(`${feature}: ${name}`, run);
}
function makeNode(engine = 'object', id = 'audit') {
  return new CRDTNode({ id, storage: { engine, compression: nodeCompression } });
}
function sortedIds(rows) { return rows.map(row => row._id).sort(); }
const tiering = { mode: 'compressedMemory', offload: ['payload'], minBytes: 1 };
const sample = { _id: 'a', score: 42, details: { rank: 7, label: 'keep' }, items: [{ score: 42, name: 'first' }, { score: 8, name: 'second' }], payload: 'cold '.repeat(32) };

for (const engine of ['object', 'shape']) {
  await check('CRUD', `${engine}: defensive reads, replace, unset, delete`, async () => {
    const n = makeNode(engine);
    try {
      n.insertMany('d', 'c', [sample]);
      const got = n.get('d', 'c', 'a'); got.details.rank = 999;
      assert.deepEqual(n.get('d', 'c', 'a'), sample);
      const replacement = { _id: 'a', score: 0, flag: false, nullable: null };
      n.replaceManyCount('d', 'c', [replacement]);
      assert.deepEqual(n.get('d', 'c', 'a'), replacement);
      n.replace('d', 'c', 'a', applyPatchToObject(replacement, { $unset: ['score'], $set: { 'nested.value': 5 } }));
      assert.deepEqual(n.get('d', 'c', 'a'), { _id: 'a', flag: false, nullable: null, nested: { value: 5 } });
      n.remove('d', 'c', 'a'); assert.equal(n.get('d', 'c', 'a'), undefined);
    } finally { n.db.dispose(); }
  });
  for (const transition of ['remove', 'deferred-remove', 'parent-child', 'array-column', 'array-tiering']) {
    await check('Storage transitions', `${engine}: ${transition}`, async () => {
      const n = makeNode(engine);
      try {
        n.createCollection('d', 'c', transition === 'parent-child' ? { columns: ['details'] } : transition.startsWith('array') ? {} : { columns: ['score'] });
        n.insertManyCount('d', 'c', [sample]); await n.awaitIndexes('d', 'c');
        if (transition === 'deferred-remove') n.db.beginBulkLoad();
        const next = transition === 'parent-child' ? { columns: ['details.rank'] } : transition === 'array-column' ? { columns: ['items.0.score'] } : transition === 'array-tiering' ? { tiering: { mode: 'compressedMemory', keep: ['items.0.score'], minBytes: 1 } } : {};
        n.setCollectionMeta('d', 'c', next);
        if (transition === 'deferred-remove') n.db.endBulkLoad();
        await n.awaitIndexes('d', 'c');
        assert.deepEqual(n.get('d', 'c', 'a'), sample);
      } finally { n.db.dispose(); }
    });
  }
  await check('Storage transitions', `${engine}: retiering preserves dirty column fields`, async () => {
    const n = makeNode(engine);
    try {
      n.createCollection('d', 'c', { columns: ['score'] });
      const rows = Array.from({ length: 5001 }, (_, i) => ({ _id: String(i), score: i, payload: 'cold '.repeat(16) }));
      n.insertManyCount('d', 'c', rows); await n.awaitIndexes('d', 'c');
      const updated = rows.map(row => ({ ...row, score: 10000 }));
      n.replaceManyCount('d', 'c', updated);
      assert.equal(n.db.getCollection('d', 'c').indexDirtyRids.size, 5001);
      n.setCollectionMeta('d', 'c', { columns: ['score'], tiering });
      await n.awaitIndexes('d', 'c');
      assert.deepEqual(n.get('d', 'c', '0'), updated[0]);
    } finally { n.db.dispose(); }
  });
  await check('Job lifecycle', `${engine}: replacement build preserves pending unset`, async () => {
    const n = makeNode(engine);
    try {
      n.createCollection('d', 'c', { columns: ['score'] });
      n.insertManyCount('d', 'c', [sample]); await n.awaitIndexes('d', 'c');
      const c = n.db.getCollection('d', 'c'); c.scheduleIndexBuildsFromMeta();
      const { score, ...expected } = sample;
      n.replaceManyCount('d', 'c', [expected]); c.scheduleIndexBuildsFromMeta();
      await n.awaitIndexes('d', 'c'); assert.deepEqual(n.get('d', 'c', 'a'), expected);
    } finally { n.db.dispose(); }
  });
  await check('Job lifecycle', `${engine}: removed and recreated column rejects the superseded build`, async () => {
    const n = makeNode(engine);
    try {
      const rows = Array.from({ length: 5001 }, (_, i) => ({ _id: String(i), score: i, details: { rank: i, label: 'keep' } }));
      n.insertManyCount('d', 'c', rows);
      const c = n.db.getCollection('d', 'c');
      const scheduler = c.derivedStateScheduler;
      const schedule = scheduler.schedule.bind(scheduler);
      let changed = false;
      scheduler.schedule = (name, run, options) => schedule(name, (job) => {
        const checkpoint = job.checkpoint.bind(job);
        job.checkpoint = async (scanned) => {
          if (name.startsWith('column:') && !changed) {
            changed = true;
            rows[0] = { ...rows[0], score: 99999 };
            n.replaceManyCount('d', 'c', [rows[0]]);
            n.setCollectionMeta('d', 'c', {});
            n.setCollectionMeta('d', 'c', { columns: ['score'] });
          }
          await checkpoint(scanned);
        };
        return run(job);
      }, options);
      n.setCollectionMeta('d', 'c', { columns: ['score'] });
      await n.awaitIndexes('d', 'c');
      assert.equal(changed, true);
      assert.deepEqual(n.get('d', 'c', '0'), rows[0]);
      assert.deepEqual(n.aggregate('d', 'c', {}, { fields: { sum: { $sum: 'score' } } }), [{ sum: rows.reduce((sum, row) => sum + row.score, 0) }]);
    } finally { n.db.dispose(); }
  });
  await check('Storage transitions', `${engine}: overlapping columns, dirty writes and retiering retain every value`, async () => {
    const n = makeNode(engine);
    try {
      const rows = Array.from({ length: 5001 }, (_, i) => ({ ...sample, _id: String(i), score: i, details: { rank: i, label: 'keep' } }));
      n.createCollection('d', 'c', { columns: ['details', 'details.rank', 'score', 'items.0.score'], tiering });
      n.insertManyCount('d', 'c', rows);
      await n.awaitIndexes('d', 'c');
      rows[0] = { _id: rows[0]._id, ...applyPatchToObject(rows[0], { $unset: ['details.rank'], $set: { 'items.0.score': null } }) };
      n.replaceManyCount('d', 'c', rows);
      n.setCollectionMeta('d', 'c', { columns: ['details.rank', 'score'], tiering: { mode: 'compressedMemory', offload: ['details', 'items', 'payload'], minBytes: 1 } });
      await n.awaitIndexes('d', 'c');
      n.setCollectionMeta('d', 'c', { columns: ['score'] });
      await n.awaitIndexes('d', 'c');
      for (const row of rows) assert.deepEqual(n.get('d', 'c', row._id), row);
    } finally { n.db.dispose(); }
  });

  const values = [undefined, null, '', 0, 1, 2, 3, '1', '01', false, true, [], [1, 2], ['1'], [null], [[1]], { a: 1 }, ['1', 1], 5, ' ', '0x1', '1e0', '-0', 'false', 'Infinity'];
  const rows = values.map((v, i) => ({ _id: String(i).padStart(3, '0'), ...(v === undefined ? {} : { v }), score: i, group: i % 3, payload: 'cold '.repeat(16) }));
  const constraints = [0, 1, '1', '01', false, true, null, '', ' ', '0x1', '1e0', 'Infinity', { $eq: 1 }, { $equal: '1' }, { $in: [1, 2] }, { $eq: 1, $gt: 4 }, { $in: [1, 2], $ne: 1 }, { $or: [1, 2], $gt: 1 }, { $eq: 1, $type: 'number' }, { $eq: 1, unknown: 1 }, { $contains: 1 }, { $contains: '' }, { $contains: null }, { $exists: true }, { $exists: false }, { $gt: 0 }, { $gte: 1, $lt: 3 }, { $ne: 1 }, { $nin: [1, 2] }, { $deepEquals: [1, 2] }, { $regex: '^0?1$' }, { $eq: 5, $regex: '^0?1$' }];
  for (const [mode, meta] of [['scan', {}], ['indexed', { indexes: ['v', 'group'] }], ['columns', { columns: ['v', 'score', 'group'] }], ['compressed', { indexes: ['v', 'group'], columns: ['score'], tiering }]]) {
    const n = makeNode(engine);
    try {
      n.createCollection('d', 'c', meta); n.insertManyCount('d', 'c', rows); await n.awaitIndexes('d', 'c');
      await check('Query semantics', `${engine}/${mode}: optimized results equal scan evaluator`, () => {
        const mismatches = [];
        for (const constraint of constraints) {
          const criteria = { v: constraint };
          const expected = sortedIds(rows.filter(row => matchesQuery(row, criteria)));
          const actual = sortedIds(n.find('d', 'c', criteria));
          if (!isDeepStrictEqual(actual, expected)) mismatches.push({ criteria, expected, actual });
          assert.equal(n.count('d', 'c', criteria), expected.length, JSON.stringify(criteria));
          const aggregated = n.aggregate('d', 'c', criteria, { fields: { count: { $count: true }, sum: { $sum: 'score' } } });
          assert.deepEqual(aggregated, expected.length ? [{ count: expected.length, sum: rows.filter(row => matchesQuery(row, criteria)).reduce((sum, row) => sum + row.score, 0) }] : [], JSON.stringify(criteria));
        }
        assert.deepEqual(mismatches, []);
        return { comparisons: constraints.length };
      });
      await check('Ordering', `${engine}/${mode}: total order with ID ties`, () => {
        const expected = [...rows].sort((a, b) => compareSortValues(a.v, b.v) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
        assert.deepEqual(n.find('d', 'c', {}, { sortBy: 'v', limit: 7, offset: 3 }).map(o => o._id), expected.slice(3, 10).map(o => o._id));
      });
      await check('Aggregation', `${engine}/${mode}: sum and non-null field count`, () => {
        const spec = { fields: { total: { $sum: 'score' }, nonNull: { $count: 'v' }, count: { $count: true } } };
        assert.deepEqual(n.aggregate('d', 'c', {}, spec), [{ total: rows.reduce((sum, r) => sum + r.score, 0), nonNull: rows.filter(r => r.v !== undefined && r.v !== null).length, count: rows.length }]);
      });
    } finally { n.db.dispose(); }
  }
  await check('Persistence', `${engine}: full snapshot restores logical values`, async () => {
    const n = makeNode(engine, 'snapshot-source'); const fresh = makeNode(engine, 'snapshot-restored');
    const storage = new MemoryObjectStorage();
    const p = new PersistenceManager({ node: n, storage, flushMs: 0, snapshotMs: 0 });
    try {
      p.start(); n.createCollection('d', 'c', { indexes: ['details.rank'], columns: ['score'], tiering });
      n.insertManyCount('d', 'c', [sample]); await n.awaitIndexes('d', 'c'); await p.checkpoint();
      await new PersistenceManager({ node: fresh, storage, flushMs: 0, snapshotMs: 0 }).restore();
      await fresh.awaitIndexes('d', 'c'); assert.deepEqual(fresh.get('d', 'c', 'a'), sample);
    } finally { await p.stop(); n.db.dispose(); fresh.db.dispose(); }
  });
  await check('Query semantics', `${engine}: warming and dirty plans preserve mixed-type predicates`, async () => {
    const n = makeNode(engine);
    try {
      const rows = Array.from({ length: 5001 }, (_, i) => ({ _id: String(i), v: values[i % values.length], score: i }));
      n.insertManyCount('d', 'c', rows);
      n.setCollectionMeta('d', 'c', { indexes: ['v'], columns: ['score'] });
      const verify = () => {
        for (const v of constraints) {
          const query = { v }, expected = rows.filter(row => matchesQuery(row, query));
          assert.deepEqual(sortedIds(n.find('d', 'c', query)), sortedIds(expected));
          assert.equal(n.count('d', 'c', query), expected.length);
          assert.deepEqual(n.aggregate('d', 'c', query, { fields: { count: { $count: true }, sum: { $sum: 'score' } } }),
            expected.length ? [{ count: expected.length, sum: expected.reduce((sum, row) => sum + row.score, 0) }] : []);
        }
      };
      verify();
      await n.awaitIndexes('d', 'c'); verify();
      for (let i = 0; i < rows.length; i++) rows[i] = { ...rows[i], v: values[(i + 7) % values.length], score: i * 3 };
      n.replaceManyCount('d', 'c', rows);
      assert.equal(n.db.getCollection('d', 'c').indexDirtyRids.size, rows.length);
      verify();
      await n.awaitIndexes('d', 'c'); verify();
    } finally { n.db.dispose(); }
  });
  await check('Query semantics', `${engine}: numeric ID predicates do not become exact string lookups`, () => {
    const n = makeNode(engine);
    try {
      const rows = ['1', '01', '001', '2', 'true'].map(_id => ({ _id, score: 1 }));
      n.insertManyCount('d', 'c', rows);
      for (const operand of [1, true, '01', { $in: [1, 'true'] }, { $eq: 1, $ne: '1' }]) {
        const query = { _id: operand }, expected = rows.filter(row => matchesQuery(row, query));
        assert.deepEqual(sortedIds(n.find('d', 'c', query)), sortedIds(expected));
        assert.equal(n.count('d', 'c', query), expected.length);
      }
    } finally { n.db.dispose(); }
  });
  await check('Persistence', `${engine}: column removal survives replicated metadata and a new snapshot`, async () => {
    const n = makeNode(engine, 'column-writer'), replica = makeNode(engine, 'column-reader'), fresh = makeNode(engine, 'column-writer');
    const storage = new MemoryObjectStorage();
    const p = new PersistenceManager({ node: n, storage, flushMs: 0, snapshotMs: 0 });
    try {
      p.start();
      n.createCollection('d', 'c', { columns: ['score', 'items.0.score'], tiering });
      n.insertManyCount('d', 'c', [sample]);
      await n.awaitIndexes('d', 'c');
      replica.addPeer(localPeer(n)); await replica.syncAll(); await replica.awaitIndexes('d', 'c');
      n.setCollectionMeta('d', 'c', { tiering });
      await replica.syncAll();
      assert.deepEqual(replica.get('d', 'c', 'a'), sample);
      await p.checkpoint();
      await new PersistenceManager({ node: fresh, storage, flushMs: 0, snapshotMs: 0 }).restore();
      assert.deepEqual(fresh.get('d', 'c', 'a'), sample);
    } finally { await p.stop(); n.db.dispose(); replica.db.dispose(); fresh.db.dispose(); }
  });
  await check('Replication', `${engine}: replace/delete convergence with indexes and columns`, async () => {
    const a = makeNode(engine, 'writer'); const b = makeNode(engine, 'replica');
    try {
      for (const n of [a, b]) n.createCollection('d', 'c', { columns: ['score'], indexes: ['details.rank'], tiering });
      a.insertManyCount('d', 'c', [sample, { ...sample, _id: 'b' }]);
      const peer = localPeer(a); b.addPeer(peer); await b.syncAll();
      a.replace('d', 'c', 'a', { ...sample, score: 99 }); a.remove('d', 'c', 'b'); await b.syncAll();
      await Promise.all([a.awaitIndexes('d', 'c'), b.awaitIndexes('d', 'c')]);
      assert.deepEqual(b.get('d', 'c', 'a'), a.get('d', 'c', 'a')); assert.equal(b.get('d', 'c', 'b'), undefined);
    } finally { a.db.dispose(); b.db.dispose(); }
  });
  await check('State-machine oracle', `${engine}: 600 mixed writes preserve objects and aggregates`, async () => {
    const n = makeNode(engine); const model = new Map(); let seed = 8473;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    try {
      n.createCollection('d', 'c', { indexes: ['group'], columns: ['score'], tiering });
      for (let i = 0; i < 600; i++) {
        const id = String(random() % 47);
        if (random() % 5 === 0) { n.remove('d', 'c', id); model.delete(id); }
        else {
          const row = { _id: id, group: random() % 5, score: random() % 10000, flag: random() % 2 === 0, payload: 'cold '.repeat(64), details: { a: i }, items: [i, null, false] };
          n.replaceManyCount('d', 'c', [row]); model.set(id, row);
        }
        if (i % 53 === 0) n.db.getCollection('d', 'c').scheduleIndexBuildsFromMeta();
        if (i % 53 === 10) await n.awaitIndexes('d', 'c');
        for (const [key, expected] of model) assert.deepEqual(n.get('d', 'c', key), expected);
      }
      await n.awaitIndexes('d', 'c');
      assert.deepEqual(n.aggregate('d', 'c', {}, { fields: { sum: { $sum: 'score' }, count: { $count: true } } }), [{ sum: [...model.values()].reduce((sum, r) => sum + r.score, 0), count: model.size }]);
      return { operations: 600, survivingObjects: model.size };
    } finally { n.db.dispose(); }
  });
}

await check('Input safety', 'PATCH must reject prototype-mutating paths', () => {
  try {
    assert.throws(() => applyPatchToObject({ safe: true }, { $set: { '__proto__.objyAuditMarker': 'polluted' } }), /unsafe/);
    assert.equal(({}).objyAuditMarker, undefined);
  } finally { delete Object.prototype.objyAuditMarker; }
});
await check('CRUD', 'PATCH must preserve array element containers', () => {
  const actual = applyPatchToObject(sample, { $set: { 'items.0.score': 99 } });
  assert.deepEqual(actual.items, [{ score: 99, name: 'first' }, { score: 8, name: 'second' }]);
});
await check('Durability', 'WAL accepts new records after recovering a torn final record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-audit-wal-'));
  const wal = new LocalWalStore({ dir, nodeId: 'node', fsync: true });
  try {
    await wal.append([{ version: 1, marker: 'first' }]);
    await appendFile(wal.filePath, '{"version":1,"marker":');
    const first = await wal.readRecords(); assert.equal(first.skippedPartialRecords, 1);
    await wal.append([{ version: 1, marker: 'after-recovery' }]);
    const second = await wal.readRecords();
    assert.equal(second.records.at(-1).marker, 'after-recovery');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await check('Durability', 'WAL recovery preserves UTF-8, CRLF and a complete final record without newline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-wal-boundary-'));
  const wal = new LocalWalStore({ dir, nodeId: 'node' });
  try {
    await wal.append([{ marker: 'start' }]);
    const rows = [{ marker: 'utf8-\u00e4\ud83d\ude80'.repeat(200000) }, { marker: 'complete-tail' }];
    await writeFile(wal.filePath, rows.map(row => JSON.stringify(row)).join('\r\n'));
    assert.deepEqual((await wal.readRecords()).records, rows);
    await wal.append([{ marker: 'next' }]);
    assert.deepEqual((await wal.readRecords()).records, [...rows, { marker: 'next' }]);
    await appendFile(wal.filePath, '{"marker":"torn-\u00e4');
    assert.equal((await wal.readRecords()).skippedPartialRecords, 1);
    await wal.append([{ marker: 'after-torn' }]);
    assert.equal((await wal.readRecords()).records.at(-1).marker, 'after-torn');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await check('Durability', 'complete corrupt WAL records fail closed without discarding data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-wal-corrupt-'));
  const wal = new LocalWalStore({ dir, nodeId: 'node' });
  try {
    await wal.append([{ marker: 'first' }]);
    await appendFile(wal.filePath, '{broken}\n{"marker":"last"}\n');
    const bytes = await readFile(wal.filePath);
    await assert.rejects(wal.readRecords(), /line 2/);
    assert.deepEqual(await readFile(wal.filePath), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await check('Durability', 'a failed WAL append rolls back its entire batch and leaves the queue usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-wal-append-'));
  const wal = new LocalWalStore({ dir, nodeId: 'node' });
  try {
    const first = { marker: 'first' }, last = { marker: 'last' };
    await wal.append([first]);
    const circular = {}; circular.self = circular;
    await assert.rejects(wal.append([{ marker: 'unacknowledged' }, circular]), /circular/i);
    await wal.append([last]);
    assert.deepEqual((await wal.readRecords()).records, [first, last]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check('Durability', 'S3 handoff must not truncate a newly acknowledged WAL write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-audit-wal-handoff-'));
  const storage = new MemoryObjectStorage(); const n = makeNode('object', 'wal-node'); const fresh = makeNode('object', 'wal-node');
  const options = { storage, flushMs: 0, snapshotMs: 0, ack: 'localWal', localWal: { mode: 'on', dir, fsync: true } };
  const p = new PersistenceManager({ node: n, ...options });
  try {
    p.start(); n.insertManyCount('d', 'c', [{ _id: 'before', score: 1 }]); await p.afterWrite();
    const truncate = p.localWal.truncate.bind(p.localWal); let injected = false;
    p.localWal.truncate = async (...args) => {
      if (!injected) {
        injected = true;
        n.insertManyCount('d', 'c', [{ _id: 'acknowledged-during-truncate', score: 2 }]);
        await p.afterWrite();
      }
      return truncate(...args);
    };
    await p.flush();
    const recovered = new PersistenceManager({ node: fresh, ...options }); await recovered.restore();
    assert.deepEqual(fresh.get('d', 'c', 'acknowledged-during-truncate'), { _id: 'acknowledged-during-truncate', score: 2 });
  } finally { await p.stop(); n.db.dispose(); fresh.db.dispose(); await rm(dir, { recursive: true, force: true }); }
});
await check('Durability', 'acknowledged writes survive SIGKILL without any S3 upload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'objy-wal-kill-'));
  const moduleUrl = name => new URL(`../src/${name}.js`, import.meta.url).href;
  const code = `
    import { CRDTNode } from ${JSON.stringify(moduleUrl('crdt'))};
    import { PersistenceManager } from ${JSON.stringify(moduleUrl('persistence'))};
    import { MemoryObjectStorage } from ${JSON.stringify(moduleUrl('object-storage'))};
    const n = new CRDTNode({ id: 'crash-node' });
    const storage = new MemoryObjectStorage();
    const p = new PersistenceManager({ node: n, storage, flushMs: 0, snapshotMs: 0, opBatchSize: 1000000,
      ack: 'localWal', localWal: { mode: 'on', dir: process.env.WAL_TEST_DIR, fsync: true } });
    p.start();
    for (let batch = 0; batch < 10; batch++) {
      n.insertManyCount('d', 'c', Array.from({ length: 500 }, (_, i) => ({ _id: String(batch * 500 + i), score: batch * 500 + i })));
      await p.afterWrite();
    }
    process.send({ acknowledged: 5000, uploaded: (await storage.list('objydb/')).length });
    setInterval(() => {}, 1000);
  `;
  try {
    for (let round = 0; round < 3; round++) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, WAL_TEST_DIR: join(dir, String(round)) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('WAL child timed out')), 30000);
          child.once('message', value => { clearTimeout(timeout); resolve(value); });
          child.once('error', error => { clearTimeout(timeout); reject(error); });
          child.once('exit', code => { clearTimeout(timeout); reject(new Error(`WAL child exited ${code}: ${errors}`)); });
        });
        assert.deepEqual(result, { acknowledged: 5000, uploaded: 0 });
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        const fresh = makeNode('object', 'crash-node');
        try {
          await new PersistenceManager({ node: fresh, storage: new MemoryObjectStorage(), flushMs: 0, snapshotMs: 0,
            ack: 'localWal', localWal: { mode: 'on', dir: join(dir, String(round)), fsync: true } }).restore();
          assert.equal(fresh.count('d', 'c'), result.acknowledged);
          assert.deepEqual(fresh.aggregate('d', 'c', {}, { fields: { sum: { $sum: 'score' } } }), [{ sum: 4999 * 5000 / 2 }]);
          for (let i = 0; i < result.acknowledged; i++) assert.deepEqual(fresh.get('d', 'c', String(i)), { _id: String(i), score: i });
        } finally { fresh.db.dispose(); }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const state = await startServer({ auth: { jwtSecret: 'audit-secret-not-production', users: [{ _id: 'audit-admin', username: 'audit-admin', password: 'audit-only', admin: true }] }, bootstrapLogger: null });
const base = `http://127.0.0.1:${state.port}`;
const call = async (method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};
try {
  state.node.createCollection('scope-a', 'users'); state.node.createCollection('scope-a', 'docs'); state.node.createCollection('scope-b', 'secrets');
  const [reader] = state.auth.prepareWriteObjects('scope-a', 'users', [{ _id: 'reader', username: 'reader', password: 'audit-only', permissions: [{ query: {}, perm: 'r' }] }]);
  state.node.insertManyCount('scope-a', 'users', [reader]);
  state.node.insertManyCount('scope-b', 'secrets', [{ _id: 'secret', secret: 'scope-b-only' }]);
  state.node.insertManyCount('scope-a', 'docs', [{ _id: 'reference', target: { type: 'reference', database: 'scope-b', collection: 'secrets', value: 'secret' } }]);
  const login = await call('POST', '/api/scope-a/users/auth', { username: 'reader', password: 'audit-only' });
  const token = login.body.accessToken;
  await check('Authorization', 'direct cross-database reads are denied', async () => { assert.equal((await call('GET', '/api/scope-b/secrets/object/secret', undefined, token)).status, 403); });
  await check('Authorization', 'references cannot bypass database isolation', async () => {
    const got = await call('GET', '/api/scope-a/docs/object/reference?$refDepth=1', undefined, token);
    assert.equal(got.status, 403);
    assert.equal((await call('GET', '/api/scope-a/docs/object/reference?$refDepth=0', undefined, token)).status, 200);
    for (const query of [
      { 'target.object.secret': 'scope-b-only', $refDepth: 0 },
      { $sort: { 'target.object.secret': 1 }, $refDepth: 0 },
      { $aggregate: { groupBy: 'target.object.secret', fields: { count: { $count: true } } }, $refDepth: 0 },
    ]) assert.equal((await call('POST', '/api/scope-a/docs/search', query, token)).status, 403);
  });
  await check('Authorization', 'same-database references and global access remain allowed', async () => {
    state.node.insertManyCount('scope-a', 'docs', [{ _id: 'same', target: { type: 'reference', collection: 'users', value: 'reader' } }]);
    const same = await call('GET', '/api/scope-a/docs/object/same?$refDepth=1', undefined, token);
    assert.equal(same.status, 200);
    assert.equal(same.body.target.object._id, 'reader');
    const session = await call('POST', '/api/_global/users/auth', { username: 'audit-admin', password: 'audit-only' });
    const global = await call('GET', '/api/scope-a/docs/object/reference?$refDepth=1', undefined, session.body.accessToken);
    assert.equal(global.status, 200);
    assert.equal(global.body.target.object.secret, 'scope-b-only');
  });
  await check('Authorization', 'aggregation must honor every permission constraint', async () => {
    state.node.createCollection('scope-a', 'metrics', { indexes: ['score'] });
    state.node.insertManyCount('scope-a', 'metrics', [{ _id: 'metric', score: 1 }]);
    const [restricted] = state.auth.prepareWriteObjects('scope-a', 'users', [{ _id: 'restricted', username: 'restricted', password: 'audit-only', permissions: [{ query: { score: { $eq: 1, $gt: 4 } }, perm: 'r' }] }]);
    state.node.insertManyCount('scope-a', 'users', [restricted]);
    const session = await call('POST', '/api/scope-a/users/auth', { username: 'restricted', password: 'audit-only' });
    const got = await call('POST', '/api/scope-a/metrics/search', { $aggregate: { fields: { count: { $count: true } } } }, session.body.accessToken);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, []);
  });
  await check('Authorization', 'cluster routes reject public user tokens', async () => { assert.equal((await call('GET', '/cluster/shards', undefined, token)).status, 401); });
  await check('Authorization', 'global database remains read-only to global administrators', async () => {
    const admin = await call('POST', '/api/_global/users/auth', { username: 'audit-admin', password: 'audit-only' });
    assert.equal((await call('POST', '/api/_global/users/object', { _id: 'blocked' }, admin.body.accessToken)).status, 403);
  });
  await check('Input safety', 'denied HTTP PATCH must not mutate the process prototype', async () => {
    try {
      const denied = await call('PATCH', '/api/scope-a/docs/object/reference', { $set: { '__proto__.objyAuditMarker': 'http-polluted' } }, token);
      assert.ok([400, 403].includes(denied.status));
      assert.equal(({}).objyAuditMarker, undefined);
    } finally { delete Object.prototype.objyAuditMarker; }
  });
  await check('Bulk and streaming', 'NDJSON create/replace/patch/delete preserve shared semantics', async () => {
    const session = await call('POST', '/api/_global/users/auth', { username: 'audit-admin', password: 'audit-only' });
    const t = session.body.accessToken;
    state.node.createCollection('scope-a', 'streamed', { columns: ['score'], indexes: ['status'] });
    const stream = async (method, rows) => {
      const res = await fetch(base + '/api/scope-a/streamed/object', { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/x-ndjson', prefer: 'return=minimal' }, body: rows.map(row => JSON.stringify(row)).join('\n') + '\n' });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await stream('POST', [{ _id: 'one', score: 1 }, { _id: 'two', score: 2 }])).body.inserted, 2);
    assert.equal((await stream('PUT', [{ _id: 'one', score: 9, old: true }])).body.replaced, 1);
    assert.equal((await stream('PATCH', [{ _id: 'one', $set: { score: 10 }, $unset: ['old'] }, { _id: 'missing', $set: { score: 1 } }])).body.updated, 1);
    assert.deepEqual(state.node.get('scope-a', 'streamed', 'one'), { _id: 'one', score: 10 });
    assert.equal((await stream('DELETE', [{ _id: 'one' }, { _id: 'two' }, { _id: 'missing' }])).body.deleted, 2);
    assert.equal(state.node.count('scope-a', 'streamed'), 0);
  });
} finally {
  await state.replication.stop(); state.node.db.dispose();
  await new Promise(resolve => state.server.close(resolve));
}

