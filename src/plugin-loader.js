import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

export async function loadPlugins(plugins, { configPath, ...context } = {}) {
  if (!Array.isArray(plugins)) throw new TypeError("plugins must be an array");
  const base = configPath ? dirname(configPath) : process.cwd();

  for (const entry of plugins) {
    const descriptor = typeof entry === "string" ? { file: entry } : entry;
    if (!descriptor || typeof descriptor.file !== "string" || !descriptor.file.trim()) {
      throw new TypeError("plugin must be a file path or { file, options }");
    }
    const file = isAbsolute(descriptor.file) ? descriptor.file : resolve(base, descriptor.file);
    const module = await import(pathToFileURL(file).href);
    const register = module.register || module.default;
    if (typeof register !== "function") {
      throw new TypeError(`plugin ${descriptor.file} must export register()`);
    }
    await register({ ...context, configPath, options: descriptor.options || {} });
  }
}
