import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@objy/client";

// This utility is deliberately bound to the local CLI test deployment.
const url = "http://127.0.0.1:8179";
// The test server and its ownership manifest live outside this repository.
const testWorkspace = process.env.OBJY_TEST_WORKSPACE;
if (!testWorkspace) {
  throw new Error(
    "Set OBJY_TEST_WORKSPACE to the existing test workspace; see scripts/seed-ui-load.md.",
  );
}
const planPath = resolve(testWorkspace, "outputs/objy-ui-load.json");
const secretsPath = resolve(
  testWorkspace,
  "work/objy-test-server/odb-98c29b0766b8/secrets.json",
);
const names = [
  "customers",
  "products",
  "orders",
  "inventory",
  "events",
  "devices",
  "readings",
  "projects",
  "tasks",
  "invoices",
  "payments",
  "shipments",
  "suppliers",
  "locations",
  "assets",
  "tickets",
  "sessions",
  "metrics",
  "documents",
  "audit_logs",
];
const through = Number(
  process.argv.find((arg) => arg.startsWith("--through="))?.split("=")[1] ||
    100,
);
const verifyOnly = process.argv.includes("--verify");
const prefix = "ui_load_20261110_";
const target = {
  databases: 100,
  collectionsPerDatabase: names.length,
  objectsPerCollection: 2000,
};
let client, plan;
const started = Date.now();
const out = (value) => console.log(JSON.stringify(value));
async function save() {
  plan.updatedAt = new Date().toISOString();
  await writeFile(planPath + ".tmp", JSON.stringify(plan, null, 2) + "\n");
  await rename(planPath + ".tmp", planPath);
}
async function memory() {
  const config = await client.status();
  const local = config.nodes.find((node) => node.local) || config.nodes[0];
  const guard = local.memoryGuard;
  const result = {
    rssMiB: Math.round(local.memory.rss / 1024 ** 2),
    limitMiB: Math.round(guard.limitBytes / 1024 ** 2),
    percent: guard.rssPercent,
    heapMiB: Math.round(local.memory.heapUsed / 1024 ** 2),
    acceptingWrites: guard.acceptingWrites,
  };
  if (!verifyOnly && (!guard.acceptingWrites || guard.rssPercent >= 78)) {
    throw new Error(
      `Paused before the server's memory guard: ${result.rssMiB} MiB RSS (${result.percent}% of its limit). Resume after reviewing capacity.`,
    );
  }
  return result;
}
const idFor = (n) => `load_${String(n).padStart(6, "0")}`;
function objectFor(database, collection, sequence) {
  const object = {
    _id: idFor(sequence),
    name: `${collection} ${String(sequence).padStart(4, "0")}`,
    sequence,
    status: ["active", "pending", "archived"][sequence % 3],
    active: sequence % 5 !== 0,
    value: ((sequence * 137 + database * 17) % 100000) / 100,
  };
  if (sequence % 10 === 0) {
    object.details = {
      region: ["Europe", "Americas", "Asia"][sequence % 3],
      priority: sequence % 4,
      database,
    };
    object.tags = ["ui-load", collection];
  }
  return object;
}
async function main() {
  if (!Number.isInteger(through) || through < 1 || through > target.databases)
    throw new Error("Invalid --through database count.");
  const { adminPassword } = JSON.parse(await readFile(secretsPath, "utf8"));
  client = createClient({ url, timeoutMs: 120_000 });
  await client.login({
    username: "admin",
    password: adminPassword,
    database: "_global",
    collection: "users",
  });
  const existing = new Set((await client.listDatabases()).databases);
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (plan) {
    if (
      plan.url !== url ||
      plan.prefix !== prefix ||
      JSON.stringify(plan.target) !== JSON.stringify(target)
    )
      throw new Error("Existing load plan does not match this run.");
  } else {
    if (verifyOnly) throw new Error("There is no load plan to verify.");
    if ([...existing].some((name) => name.startsWith(prefix)))
      throw new Error(
        "The load-test prefix already exists without an owned manifest.",
      );
    plan = {
      version: 1,
      runId: crypto.randomUUID(),
      url,
      prefix,
      target,
      collections: names,
      preservedDatabases: [...existing],
      createdAt: new Date().toISOString(),
      completed: [],
    };
    await save();
  }
  out({
    phase: "start",
    target,
    existingDatabases: existing.size,
    memory: await memory(),
  });
  let verifiedObjects = 0,
    verifiedCollections = 0;
  for (let dbIndex = 1; dbIndex <= through; dbIndex++) {
    const dbName = prefix + String(dbIndex).padStart(3, "0");
    if (!verifyOnly && plan.completed.includes(dbName)) continue;
    if (!existing.has(dbName)) {
      if (verifyOnly) throw new Error(`Missing database ${dbName}`);
      await client.createDatabase(dbName, {
        meta: {
          uiLoadTest: plan.runId,
          purpose: "Disposable UI stress-test data",
        },
      });
      existing.add(dbName);
    }
    const db = client.database(dbName),
      collections = new Set((await db.listCollections()).collections);
    for (const name of names) {
      let fresh = false;
      if (!collections.has(name)) {
        if (verifyOnly) throw new Error(`Missing collection ${dbName}/${name}`);
        await db.createCollection(name, { uiLoadTest: plan.runId });
        fresh = true;
      }
      const collection = db.collection(name);
      if (!fresh && (await collection.getMeta()).uiLoadTest !== plan.runId)
        throw new Error(
          `Refusing to change unowned collection ${dbName}/${name}`,
        );
      const count = fresh ? 0 : await collection.count();
      if (!verifyOnly && count < target.objectsPerCollection) {
        // Reconcile a partial/uncertain batch by exact IDs before writing again.
        const present = new Set();
        if (count)
          for await (const object of collection.iterate(
            {},
            { pageSize: 250 },
          )) {
            if (
              !/^load_\d{6}$/.test(object._id) ||
              +object._id.slice(5) < 1 ||
              +object._id.slice(5) > target.objectsPerCollection
            )
              throw new Error(`Unexpected object in ${dbName}/${name}`);
            present.add(object._id);
          }
        const objects = Array.from(
          { length: target.objectsPerCollection },
          (_, i) => objectFor(dbIndex, name, i + 1),
        ).filter((object) => !present.has(object._id));
        for (let offset = 0; offset < objects.length; offset += 1000) {
          await collection.insertMany(objects.slice(offset, offset + 1000), {
            minimal: true,
          });
        }
      }
      const actual =
        !verifyOnly && count !== target.objectsPerCollection
          ? await collection.count()
          : count;
      if (actual !== target.objectsPerCollection)
        throw new Error(`Count mismatch in ${dbName}/${name}: ${actual}`);
      verifiedObjects += actual;
      verifiedCollections++;
    }
    const snapshot = await memory();
    if (!verifyOnly) {
      plan.completed.push(dbName);
      plan.memory = snapshot;
      await save();
    }
    out({
      phase: verifyOnly ? "verify" : "seed",
      database: dbIndex,
      databasesCompleted: plan.completed.length,
      objectsCompleted:
        plan.completed.length *
        target.collectionsPerDatabase *
        target.objectsPerCollection,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      memory: snapshot,
    });
  }
  if (verifyOnly) {
    plan.verification = {
      at: new Date().toISOString(),
      databases: through,
      collections: verifiedCollections,
      objects: verifiedObjects,
    };
    await save();
  }
  out({
    phase: "complete",
    databases: plan.completed.length,
    verification: plan.verification || null,
  });
}
try {
  await main();
} catch (error) {
  out({
    phase: "stopped",
    message: error.message,
    status: error.status,
    writeMayHaveSucceeded: Boolean(error.writeMayHaveSucceeded),
  });
  process.exitCode = 1;
} finally {
  client?.logout();
}
