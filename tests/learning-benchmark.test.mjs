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
