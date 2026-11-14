// Disposable loopback-only server for UI verification. No persistence.
import { testServer } from "./server.mjs";
import { createServerAdapter } from "../../src/data/adapters.js";
import { createFileService } from "../../../src/files.js";
import { seedPreviews } from "./attachment-fixtures.mjs";
const server = await testServer({
  files: createFileService({ mode: "memory" }),
  auth: { enabled: true },
  environment: { OBJYDB_ADMIN_PASSWORD: "adapter-test-only" },
  cors: { origins: ["http://127.0.0.1:4317"] },
});
const db = createServerAdapter({
  url: server.url,
  username: "admin",
  password: "adapter-test-only",
});
await db.open();
await db.createDatabase("inventory", {});
await seedPreviews(db, "inventory", "previews");
await db.createCollection("inventory", "bikes");
await db.insertMany(
  "inventory",
  "bikes",
  Array.from({ length: 55 }, (_, i) => ({
    _id: `bike-${String(i + 1).padStart(2, "0")}`,
    name: `Server bike ${i + 1}`,
    gears: 7,
    electric: i % 3 === 0,
  })),
);
await db.createCollection("inventory", "documents");
await db.insertFile("inventory", "documents", {
  _id: "welcome", name: "welcome.txt", description: "Disposable attachment for UI verification",
}, new File(["OBJY attachment verification\n"], "welcome.txt", { type: "text/plain" }));
await db.close();
console.log(server.url);
process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
