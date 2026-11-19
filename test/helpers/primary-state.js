import { PrimaryStateStore } from "../../src/primary-state.js";

export async function readPublished(storage, key) {
  return (await new PrimaryStateStore({ storage }).read(key)).body;
}

export async function writePublished(storage, key, body) {
  const current = await new PrimaryStateStore({ storage }).read(key);
  return new PrimaryStateStore({ storage, epoch: () => Number(current.revision.slice(0, 16)) || 0 }).publish(key, body);
}
