#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`OBJY DB

Usage: objy [options]

Options:
  -c, --config <file>  JSON configuration (default: ./objydb.config.json)
  -n, --node <id>      Override this node's identity
      --url <url>     Override this node's advertised URL
  -p, --port <port>   Override the HTTP port
  -h, --help          Show this help
  -v, --version       Show the installed version

Runs one database node in the foreground. Ctrl+C shuts it down gracefully.`);
} else if (args.includes("--version") || args.includes("-v")) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(version);
} else {
  await import("../src/index.js");
}
