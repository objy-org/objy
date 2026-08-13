import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryGuard } from "../src/memory-guard.js";

test("memory guard uses hysteresis for write admission", () => {
  let rss = 80;
  let now = 0;
  const guard = createMemoryGuard({
    enabled: true,
    limitMb: 100 / 1024 / 1024,
    rejectWritesPercent: 85,
    resumeWritesPercent: 75,
    checkMs: 0,
  }, {
    getUsage: () => ({ rss }),
    now: () => now++,
  });

  assert.equal(guard.status().writeState, "accepting");
  rss = 90;
  assert.equal(guard.status().writeState, "rejecting");
  assert.equal(guard.writeRejection().status, 507);
  rss = 80;
  assert.equal(guard.status().writeState, "rejecting");
  rss = 70;
  assert.equal(guard.status().writeState, "accepting");
});
