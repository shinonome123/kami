import test from "node:test";
import assert from "node:assert/strict";
import { runPairedSkillBenchmarks } from "../src/learning-benchmark.mjs";

test("配对评测交错运行先后顺序且只有双侧完成的 case 才进入指标", async () => {
  const calls = [];
  const trajectories = Array.from({ length: 4 }, (_, index) => ({ id: `case-${index}` }));
  const result = await runPairedSkillBenchmarks({
    trajectories,
    champion: { id: "champion" },
    challenger: { id: "challenger" },
    concurrency: 1,
    benchmark: async (skill, trajectory, context) => {
      calls.push(`${trajectory.id}:${context.variant}`);
      return { caseId: trajectory.id, skillId: skill.id };
    }
  });

  assert.deepEqual(calls, [
    "case-0:champion", "case-0:challenger",
    "case-1:challenger", "case-1:champion",
    "case-2:champion", "case-2:challenger",
    "case-3:challenger", "case-3:champion"
  ]);
  assert.equal(result.requestedPairs, 4);
  assert.equal(result.completedPairs, 4);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.championSamples.map((item) => item.caseId), trajectories.map((item) => item.id));
  assert.deepEqual(result.challengerSamples.map((item) => item.caseId), trajectories.map((item) => item.id));
});

test("onProgress 逐对汇报完成与失败，失败对保留准确 caseId", async () => {
  const trajectories = [{ id: "ok" }, { id: "bad" }, { id: "ok-2" }];
  const events = [];
  const result = await runPairedSkillBenchmarks({
    trajectories,
    champion: { id: "champion" },
    challenger: { id: "challenger" },
    concurrency: 1,
    benchmark: async (skill, trajectory, { variant }) => {
      if (trajectory.id === "bad" && variant === "challenger") throw new Error("AIQA 失败");
      return { caseId: trajectory.id, variant };
    },
    onProgress: (progress) => events.push({ caseId: progress.caseId, status: progress.status, error: progress.error })
  });
  assert.deepEqual(events.map((item) => item.caseId), ["ok", "bad", "ok-2"]);
  const bad = events.find((item) => item.caseId === "bad");
  assert.equal(bad.status, "rejected");
  assert.equal(bad.error, "AIQA 失败");
  const ok = events.find((item) => item.caseId === "ok");
  assert.equal(ok.status, "fulfilled");
  assert.equal(ok.error, null);
  assert.equal(result.completedPairs, 2);
  assert.equal(result.failures.length, 1);
});

test("任一侧 AIQA 失败时整对样本作废并保留准确 caseId", async () => {
  const trajectories = [{ id: "healthy" }, { id: "qa-failed" }, { id: "healthy-2" }];
  const result = await runPairedSkillBenchmarks({
    trajectories,
    champion: { id: "champion" },
    challenger: { id: "challenger" },
    concurrency: 2,
    benchmark: async (skill, trajectory, { variant }) => {
      if (trajectory.id === "qa-failed" && variant === "challenger") {
        throw new Error("AIQA provider unavailable");
      }
      return { caseId: trajectory.id, skillId: skill.id, qaScore: 99 };
    }
  });

  assert.equal(result.requestedPairs, 3);
  assert.equal(result.completedPairs, 2);
  assert.deepEqual(result.championSamples.map((item) => item.caseId), ["healthy", "healthy-2"]);
  assert.deepEqual(result.challengerSamples.map((item) => item.caseId), ["healthy", "healthy-2"]);
  assert.deepEqual(result.failures, [{ caseId: "qa-failed", error: "AIQA provider unavailable" }]);
});

test("表达型语体按轮次配对采样，同一 case/轮次两侧共用固定 seed", async () => {
  const trajectories = [{ id: "case-0" }, { id: "case-1" }];
  const calls = [];
  const result = await runPairedSkillBenchmarks({
    trajectories,
    champion: { id: "champion" },
    challenger: { id: "challenger" },
    scope: { locale: "ja-JP", contentType: "dialogue", domain: "game", project: "default" },
    evaluationProfile: { repetitions: 2, policyVersion: "test", mode: "expressive-repeated" },
    concurrency: 1,
    benchmark: async (skill, trajectory, context) => {
      calls.push({ caseId: trajectory.id, variant: context.variant, repetition: context.repetition, seed: context.seed });
      return { caseId: `${trajectory.id}#r${context.repetition + 1}`, repetition: context.repetition, skillId: skill.id };
    }
  });
  assert.equal(result.repetitions, 2);
  assert.equal(result.championSamples.length, 4);
  assert.equal(result.challengerSamples.length, 4);
  for (const trajectory of trajectories) {
    for (const repetition of [0, 1]) {
      const pair = calls.filter((item) => item.caseId === trajectory.id && item.repetition === repetition);
      assert.equal(pair.length, 2);
      assert.equal(pair[0].seed, pair[1].seed, "Champion / Challenger 必须共享同一个随机流起点");
    }
  }
});
