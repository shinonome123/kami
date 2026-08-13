import test from "node:test";
import assert from "node:assert/strict";
import { runTaskPool } from "../src/task-pool.mjs";

test("task pool limits active work to five concurrent tasks", async () => {
  let active = 0;
  let peak = 0;
  let settled = 0;
  const tasks = Array.from({ length: 13 }, (_, index) => index);
  const results = await runTaskPool(tasks, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return value * 2;
  }, { concurrency: 5, onSettled: () => { settled += 1; } });

  assert.equal(peak, 5);
  assert.equal(settled, tasks.length);
  assert.deepEqual(results.map((result) => result.value), tasks.map((value) => value * 2));
});

test("task pool records failures without blocking remaining tasks", async () => {
  const results = await runTaskPool([0, 1, 2], async (value) => {
    if (value === 1) throw new Error("boom");
    return value;
  }, { concurrency: 5 });

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[2].status, "fulfilled");
});
