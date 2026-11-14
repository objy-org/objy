import { startServer } from "../../../src/server.js";
export async function testServer(options = {}) {
  const runtime = await startServer({
    port: { port: 0, host: "127.0.0.1" },
    environment: {},
    bootstrapLogger: null,
    auth: false,
    ...options,
  });
  return {
    url: `http://127.0.0.1:${runtime.port}`,
    runtime,
    async close() {
      await runtime.replication.stop();
      runtime.server.closeAllConnections();
      await new Promise((resolve) => runtime.server.close(resolve));
      runtime.node.db.dispose();
    },
  };
}
