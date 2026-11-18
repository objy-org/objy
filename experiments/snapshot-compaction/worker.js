import { S3ObjectStorage } from "../../src/object-storage.js";
import { compactSnapshot } from "./compact.js";
import { sendCompactionResult } from "./process.js";

let finished = false;
const send = (message) => { if (process.connected) process.send(message); };
process.once("disconnect", () => { if (!finished) process.exit(1); });

process.once("message", async ({ plan, s3, limits }) => {
  const storage = new S3ObjectStorage(s3), started = performance.now(), cpu = process.cpuUsage();
  const sample = () => send({ type: "sample", pid: process.pid, memory: process.memoryUsage() });
  const timer = setInterval(sample, 200);
  try {
    const result = await compactSnapshot(storage, plan, {
      ...limits,
      onProgress: (progress) => send({ type: "progress", ...progress }),
    });
    sample();
    await sendCompactionResult({
      ...result, ms: performance.now() - started, cpu: process.cpuUsage(cpu),
      memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
    });
  } catch (error) {
    if (process.connected) await new Promise((resolve) => process.send({ type: "error", error: error.stack }, resolve));
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    storage.client.destroy();
    finished = true;
    process.disconnect();
  }
});
