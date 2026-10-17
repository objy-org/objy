export { createClient, SpreadDBError } from "../client/index.js";
export {
  ObjectHookRegistry,
  ObjectHookRunner,
  createObjectHookRegistry,
  createObjectHookRunner,
  normalizeObjectHooksMeta,
} from "./object-hooks.js";
export {
  createInterfaceContext,
  defaultInterfaces,
  httpPeer,
  shardMapFromHttp,
  startRestoreStatusServer,
  startServer,
} from "./server.js";
