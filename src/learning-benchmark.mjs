import { pairedBenchmarkOrder } from "./learning-engine.mjs";
import { runTaskPool } from "./task-pool.mjs";

/**
 * Run paired skill benchmarks with alternating first-run order. A case is only
 * admitted when both variants complete; either translation or AIQA failure
 * rejects the complete pair so partial evidence can never influence promotion.
 */
export async function runPairedSkillBenchmarks({ trajectories, champion, challenger, benchmark, concurrency = 5 } = {}) {
  if (!Array.isArray(trajectories)) throw new TypeError("评测轨迹必须是数组");
  if (typeof benchmark !== "function") throw new TypeError("benchmark 必须是函数");
  const paired = await runTaskPool(trajectories, async (trajectory, caseIndex) => {
    const samples = {};
    for (const variant of pairedBenchmarkOrder(caseIndex)) {
      samples[variant] = await benchmark(variant === "champion" ? champion : challenger, trajectory, { variant, caseIndex });
    }
    return samples;
  }, { concurrency });

  const fulfilled = paired.filter((item) => item.status === "fulfilled").map((item) => item.value);
  const failures = paired.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === "rejected")
    .map(({ item, index }) => ({
      caseId: String(trajectories[index]?.id || ""),
      error: item.reason?.message || String(item.reason || "评测失败")
    }));
  return {
    requestedPairs: trajectories.length,
    completedPairs: fulfilled.length,
    championSamples: fulfilled.map((item) => item.champion),
    challengerSamples: fulfilled.map((item) => item.challenger),
    failures
  };
}
