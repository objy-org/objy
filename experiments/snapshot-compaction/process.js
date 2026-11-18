import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sendCompactionResult(result) {
  const { manifest, ...summary } = result;
  return new Promise((resolve, reject) => {
    process.send({ type: "result", result: summary }, (error) => error ? reject(error) : resolve());
  });
}

export async function runCompaction(plan, { s3, signal, onSample = () => {}, heapMiB = 512, ...limits } = {}) {
  if (!Number.isSafeInteger(heapMiB) || heapMiB < 64) throw new Error("invalid compactor heap limit");
  signal?.throwIfAborted();
  const workDir = await mkdtemp(join(tmpdir(), "objy-compaction-"));
  let child;
  try {
    return await new Promise((resolve, reject) => {
      child = fork(new URL("./worker.js", import.meta.url), [], {
        execArgv: [`--max-old-space-size=${heapMiB}`],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let result, failure, stderr = "";
      const abort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      child.once("error", (error) => { failure = error; });
      child.on("message", (message) => {
        if (message.type === "sample" || message.type === "progress") {
          try { onSample(message); } catch (error) { failure = error; child.kill("SIGKILL"); }
        }
        else if (message.type === "result") result = message.result;
        else if (message.type === "error") failure = new Error(message.error);
      });
      child.once("close", (code, exitSignal) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error(`compactor exited ${code ?? exitSignal}: ${stderr}`));
        else resolve(result);
      });
      child.send({ plan, s3, limits: { ...limits, workDir } });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(workDir, { recursive: true, force: true });
  }
}
