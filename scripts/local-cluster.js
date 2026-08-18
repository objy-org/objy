#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const command = process.argv[2] || "status";
const config = arg("--config") || "spread-db.minio.config.json";
const maxOldSpaceSizeMb = positiveInt(
  arg("--max-old-space-size") || arg("--heap") || runtimeConfigValue(config, "maxOldSpaceSizeMb"),
  0,
);
const ports = (arg("--ports") || "8080,8081,8082,8083")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Number.isFinite);
const nodes = ports.map((port) => ({
  id: `node-${port}`,
  port,
  url: `http://localhost:${port}`,
}));
const runDir = resolve(".spread-db/run");
const logDir = resolve(".spread-db/logs");

if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "restart") {
  await stop();
  await start();
} else if (command === "status") await status();
else {
  console.error("usage: node scripts/local-cluster.js start|stop|restart|status [--config file] [--ports 8080,8081] [--heap 15360]");
  process.exit(1);
}

async function start() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  for (const node of nodes) {
    if (isRunning(pidFile(node))) {
      console.log(`${node.id} already running`);
      continue;
    }
    const out = openSync(resolve(logDir, `${node.id}.log`), "a");
    const nodeArgs = [
      ...(maxOldSpaceSizeMb ? [`--max-old-space-size=${maxOldSpaceSizeMb}`] : []),
      "src/index.js",
      "--config", config,
      "--node", node.id,
      "--url", node.url,
      "--port", String(node.port),
    ];
    const child = spawn(process.execPath, nodeArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    writeFileSync(pidFile(node), String(child.pid));
    console.log(`started ${node.id} pid=${child.pid}${maxOldSpaceSizeMb ? ` heap=${maxOldSpaceSizeMb}MB` : ""} log=${resolve(logDir, `${node.id}.log`)}`);
  }
}

async function stop() {
  for (const node of nodes) {
    const file = pidFile(node);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    if (Number.isFinite(pid) && isAlive(pid)) {
      process.kill(pid, "SIGTERM");
      await waitUntil(() => !isAlive(pid), 5000);
    }
    unlinkSync(file);
    console.log(`stopped ${node.id}`);
  }
}

async function status() {
  for (const node of nodes) {
    const pid = readPid(pidFile(node));
    const alive = pid && isAlive(pid);
    const health = alive ? await healthStatus(node.url) : "stopped";
    console.log(`${node.id} pid=${pid || "-"} ${alive ? "running" : "stopped"} health=${health}`);
  }
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const match = process.argv.find((value) => value.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function runtimeConfigValue(path, key) {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.runtime?.[key] ?? parsed.node?.[key];
  } catch {
    return undefined;
  }
}

function pidFile(node) {
  return resolve(runDir, `${node.id}.pid`);
}

function readPid(file) {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8"));
  return Number.isFinite(pid) ? pid : null;
}

function isRunning(file) {
  const pid = readPid(file);
  return pid && isAlive(pid);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthStatus(url) {
  try {
    const res = await fetch(`${url}/health`);
    return res.status;
  } catch {
    return "offline";
  }
}

async function waitUntil(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
