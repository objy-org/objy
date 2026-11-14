import { testServer } from "./server.mjs";
import { ObjyStore, createServerAdapter } from "../../src/data/objy-store.js";

// Every database fixture crosses HTTP through the official client. Servers are
// isolated, loopback-only and ephemeral; never use a developer's real database.
export async function testStore() {
  const server = await testServer();
  try {
    const store = await new ObjyStore(
      createServerAdapter({ url: server.url }),
    ).open();
    const close = store.close.bind(store);
    store.close = async () => {
      try {
        await close();
      } finally {
        await server.close();
      }
    };
    return store;
  } catch (error) {
    await server.close();
    throw error;
  }
}
