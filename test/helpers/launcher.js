import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export async function withNode({ entry, cwd, args = [], stopSignal = "SIGTERM" }, exercise) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let startupTimer;
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error(`node startup timed out:\n${output}`)), 15000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const port = output.match(/listening on http:\/\/localhost:(\d+)/)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    closed.then(({ code, signal }) => reject(new Error(`node exited before readiness (${code}, ${signal}):\n${output}`)));
  });

  try {
    const url = await ready;
    clearTimeout(startupTimer);
    const result = await exercise(url);
    const shutdownTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      child.kill(stopSignal);
      assert.deepEqual(await closed, { code: 0, signal: null }, output);
    } finally {
      clearTimeout(shutdownTimer);
    }
    return result;
  } finally {
    clearTimeout(startupTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}
