import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromePidFromLockTarget, pidAlive, withExclusiveLock } from "./browser.mjs";

test("chromePidFromLockTarget reads the pid off a Chromium SingletonLock target", () => {
  assert.equal(chromePidFromLockTarget("railway-12345"), 12345);
  assert.equal(chromePidFromLockTarget("WIN-HOST-88"), 88);
  assert.equal(chromePidFromLockTarget(""), null);
  assert.equal(chromePidFromLockTarget("no-pid"), null);
});

test("pidAlive sees this process and not a bogus pid", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999999), false);
});

test("withExclusiveLock serializes two jobs and steals a dead-pid lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-lock-"));
  const lockPath = path.join(dir, "site.lock");
  const order = [];
  await Promise.all([
    withExclusiveLock(lockPath, async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("a-end");
    }),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await withExclusiveLock(lockPath, async () => {
        order.push("b");
      });
    })(),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);

  await writeFile(lockPath, "999999999\n1\n");
  const result = await withExclusiveLock(lockPath, async () => "stole");
  assert.equal(result, "stole");
  await assert.rejects(() => readFile(lockPath));
});
