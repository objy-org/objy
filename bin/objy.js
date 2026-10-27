#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/config.js";

const argv = process.argv.slice(2);
const command = argv.shift() || "help";
const source = fileURLToPath(new URL("../src/index.js", import.meta.url));
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  if (command === "run") await runForeground(argv);
  else if (command === "start") await start(argv);
  else if (command === "stop") await stop(argv);
  else if (command === "restart") await restart(argv);
  else if (command === "status") await status(argv);
  else if (command === "logs") await logs(argv);
  else if (command === "help" || command === "--help" || command === "-h") printHelp();
  else if (command === "version" || command === "--version" || command === "-v") printVersion();
  else fail(`unknown command: ${command}`);
} catch (err) {
  fail(err.message);
}

async function runForeground(args) {
  const context = contextFrom(args);
  const child = spawn(process.execPath, nodeArgs(context.heapMb, serverArgs(args)), {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const relay = (signal) => {
    if (isAlive(child.pid)) process.kill(child.pid, signal);
  };
  const relayInt = () => relay("SIGINT");
  const relayTerm = () => relay("SIGTERM");
  process.on("SIGINT", relayInt);
  process.on("SIGTERM", relayTerm);
  const { code, signal } = await childExit(child);
  process.off("SIGINT", relayInt);
  process.off("SIGTERM", relayTerm);
  process.exitCode = code ?? signalExitCode(signal);
}

async function restart(args) {
  contextFrom(args);
  await stop(args);
  await start(args);
}

async function start(args) {
  const context = contextFrom(args);
  const existing = readManifest(context.manifestPath);
  const explicitTopology = hasOption(args, "--instances") || hasOption(args, "--ports");
  const desired = !explicitTopology && existing?.nodes?.length
    ? existing.nodes.map(({ id, port, url, log }) => ({ id, port, url, log }))
    : desiredNodes(context, args);
  const live = existing?.nodes?.filter((node) => isAlive(node.pid)) || [];

  if (live.length && !sameTopology(existing.nodes, desired)) {
    throw new Error("managed nodes are running with a different topology; stop them before changing ports or instances");
  }

  mkdirSync(context.stateDir, { recursive: true });
  mkdirSync(context.logDir, { recursive: true });

  const runningById = new Map(live.map((node) => [node.id, node]));
  for (const node of desired) {
    if (!runningById.has(node.id) && !(await portAvailable(node.port))) {
      throw new Error(`port ${node.port} is already in use`);
    }
  }

  const manifest = {
    version: 1,
    config: context.configPath,
    heapMb: context.heapMb,
    nodes: [],
  };

  for (const node of desired) {
    const running = runningById.get(node.id);
    if (running) {
      manifest.nodes.push(running);
      console.log(`${node.id} already running (pid ${running.pid})`);
      continue;
    }

    const log = node.log || resolve(context.logDir, `${node.id}.log`);
    const output = openSync(log, "a");
    const child = spawn(process.execPath, nodeArgs(context.heapMb, [
      "--config", context.configPath,
      "--node", node.id,
      "--url", node.url,
      "--port", String(node.port),
    ]), {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", output, output],
    });
    closeSync(output);
    await childSpawned(child);
    child.unref();
    manifest.nodes.push({ ...node, log, pid: child.pid, startedAt: new Date().toISOString() });
    writeManifest(context.manifestPath, manifest);
    console.log(`started ${node.id} on ${node.url} (pid ${child.pid})`);
  }

  writeManifest(context.manifestPath, manifest);
  await sleep(250);
  const failed = manifest.nodes.filter((node) => !isAlive(node.pid));
  if (failed.length) {
    for (const node of failed) console.error(`${node.id} exited during startup; inspect ${node.log}`);
    process.exitCode = 1;
  }
}

async function stop(args) {
  const context = contextFrom(args, { load: false });
  const manifest = readManifest(context.manifestPath);
  if (!manifest?.nodes?.length) {
    console.log("no managed nodes");
    return;
  }

  const live = manifest.nodes.filter((node) => isAlive(node.pid));
  for (const node of live) process.kill(node.pid, "SIGTERM");

  const stopped = await Promise.all(live.map(async (node) => ({
    node,
    clean: await waitUntil(() => !isAlive(node.pid), 60_000),
  })));

  for (const { node, clean } of stopped) {
    if (!clean && hasOption(args, "--force")) {
      process.kill(node.pid, "SIGKILL");
      await waitUntil(() => !isAlive(node.pid), 2_000);
    }
    console.log(`${node.id} ${isAlive(node.pid) ? "is still stopping" : "stopped"}`);
  }

  manifest.nodes = manifest.nodes.map((node) => isAlive(node.pid) ? node : ({ ...node, pid: null }));
  writeManifest(context.manifestPath, manifest);
  if (manifest.nodes.some((node) => isAlive(node.pid))) process.exitCode = 1;
}

async function status(args) {
  const context = contextFrom(args, { load: false });
  const manifest = readManifest(context.manifestPath);
  if (!manifest?.nodes?.length) {
    console.log("no managed nodes");
    return;
  }

  for (const node of manifest.nodes) {
    const running = isAlive(node.pid);
    const health = running ? await healthStatus(node.url) : "stopped";
    console.log(`${node.id.padEnd(20)} ${running ? "running" : "stopped"}  health=${health}  ${node.url}`);
  }
}

async function logs(args) {
  const context = contextFrom(args, { load: false });
  const manifest = readManifest(context.manifestPath);
  if (!manifest?.nodes?.length) throw new Error("no managed nodes");
  const requested = positional(args)[0];
  const nodes = requested ? manifest.nodes.filter((node) => node.id === requested) : manifest.nodes;
  if (!nodes.length) throw new Error(`unknown node: ${requested}`);
  const lines = positiveInt(option(args, "--lines"), 100);

  for (const node of nodes) {
    if (!node.log || !existsSync(node.log)) continue;
    if (nodes.length > 1) console.log(`\n==> ${node.id} <==`);
    process.stdout.write(tail(node.log, lines));
  }

  if (!hasOption(args, "--follow") && !hasOption(args, "-f")) return;
  const cleanups = nodes.map((node) => follow(node.log, nodes.length > 1 ? `${node.id}  ` : ""));
  await new Promise((resolvePromise) => {
    const close = () => {
      for (const cleanup of cleanups) cleanup();
      resolvePromise();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function contextFrom(args, { load = true } = {}) {
  const configPath = resolve(option(args, "--config") || option(args, "-c") || DEFAULT_CONFIG_PATH);
  if (load && !existsSync(configPath)) throw new Error(`config file not found: ${configPath}`);
  const key = createHash("sha256").update(configPath).digest("hex").slice(0, 12);
  const stateDir = resolve(".objydb/processes", key);
  const config = load ? loadConfig(["--config", configPath], process.cwd(), { requireNode: false }) : null;
  return {
    configPath,
    config,
    stateDir,
    logDir: resolve(".objydb/logs", key),
    manifestPath: resolve(stateDir, "nodes.json"),
    heapMb: positiveInt(option(args, "--heap") || option(args, "--max-old-space-size"), config?.runtime?.maxOldSpaceSizeMb)
      || positiveInt(readRuntimeHeap(configPath), 0),
  };
}

function desiredNodes(context, args) {
  const configuredPort = context.config?.server?.port || 8080;
  const explicitTopology = hasOption(args, "--ports") || hasOption(args, "--instances");
  const ports = option(args, "--ports")
    ? option(args, "--ports").split(",").map((value) => positiveInt(value.trim(), null))
    : Array.from({ length: positiveInt(option(args, "--instances"), 1) }, (_, index) => configuredPort + index);
  if (!ports.length || ports.some((port) => !port)) throw new Error("ports must be positive integers");
  if (new Set(ports).size !== ports.length) throw new Error("ports must be unique");

  return ports.map((port, index) => {
    const singleConfiguredNode = !explicitTopology && ports.length === 1 && index === 0;
    return {
      id: singleConfiguredNode && context.config?.node?.id ? context.config.node.id : `node-${port}`,
      port,
      url: singleConfiguredNode && context.config?.node?.url
        ? context.config.node.url
        : localUrl(context.config?.node?.url, port),
    };
  });
}

function nodeArgs(heapMb, args) {
  return [
    ...(heapMb ? [`--max-old-space-size=${heapMb}`] : []),
    source,
    ...args,
  ];
}

function serverArgs(args) {
  const omitted = new Set(["--heap", "--max-old-space-size"]);
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (omitted.has(arg)) {
      index++;
      continue;
    }
    if ([...omitted].some((name) => arg.startsWith(`${name}=`))) continue;
    result.push(arg);
  }
  return result;
}

function readRuntimeHeap(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")).runtime?.maxOldSpaceSizeMb;
  } catch {
    return null;
  }
}

function localUrl(configuredUrl, port) {
  try {
    const url = new URL(configuredUrl || "http://localhost");
    url.port = String(port);
    return url.origin;
  } catch {
    return `http://localhost:${port}`;
  }
}

async function portAvailable(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolvePromise(true)));
  });
}

function readManifest(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read process state ${path}: ${err.message}`);
  }
}

function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sameTopology(current = [], desired = []) {
  return current.length === desired.length && current.every((node, index) => (
    node.id === desired[index].id && node.port === desired[index].port && node.url === desired[index].url
  ));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthStatus(url) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.status;
  } catch {
    return "offline";
  }
}

function tail(path, lineCount) {
  const size = statSync(path).size;
  if (!size) return "";
  const bytes = Math.min(size, Math.max(64 * 1024, lineCount * 512));
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, "r");
  readSync(fd, buffer, 0, bytes, size - bytes);
  closeSync(fd);
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  return `${lines.slice(Math.max(0, lines.length - lineCount - 1)).join("\n")}\n`;
}

function follow(path, prefix) {
  if (!path || !existsSync(path)) return () => {};
  let offset = statSync(path).size;
  const listener = (current) => {
    if (current.size < offset) offset = 0;
    if (current.size === offset) return;
    const stream = createReadStream(path, { start: offset, end: current.size - 1 });
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (pending) process.stdout.write(`${prefix}${pending}`);
    });
    offset = current.size;
  };
  watchFile(path, { interval: 250 }, listener);
  return () => unwatchFile(path, listener);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function hasOption(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function positional(args) {
  const values = [];
  const optionsWithValues = new Set([
    "--config", "-c", "--instances", "--ports", "--heap", "--max-old-space-size", "--lines",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (optionsWithValues.has(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) values.push(arg);
  }
  return values;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function childExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function childSpawned(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("spawn", resolvePromise);
  });
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

async function waitUntil(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printVersion() {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  console.log(pkg.version);
}

function printHelp() {
  console.log(`OBJY DB local runtime

Usage:
  objy run [options]                 Run one node in the foreground
  objy start [options]               Start managed local node processes
  objy stop [--config file]          Gracefully stop managed nodes
  objy restart [options]             Restart managed nodes
  objy status [--config file]        Show process and health status
  objy logs [node] [-f]              Show node logs

Options:
  -c, --config <file>                Config file (default: objydb.config.json)
      --instances <count>            Number of local nodes
      --ports <port,...>             Explicit local node ports
      --heap <MiB>                   V8 heap limit per node
      --force                        Force processes that do not stop cleanly
  -f, --follow                       Follow logs
      --lines <count>                Number of log lines (default: 100)

Examples:
  objy run --config objydb.config.json
  objy start --config objydb.config.json --instances 4
  objy status --config objydb.config.json
  objy logs node-8081 --follow
  objy stop --config objydb.config.json`);
}

function fail(message) {
  console.error(`objy: ${message}`);
  process.exitCode = 1;
}
