import { pairedBenchmarkOrder } from "./learning-engine.mjs";
import { runTaskPool } from "./task-pool.mjs";
import { stableEvaluationSeed } from "./evaluation-policy.mjs";

/**
 * Run paired skill benchmarks with alternating first-run order. A case is only
 * admitted when both variants complete; either translation or AIQA failure
 * rejects the complete pair so partial evidence can never influence promotion.
 */
export async function runPairedSkillBenchmarks({
  trajectories,
  champion,
  challenger,
  benchmark,
  concurrency = 5,
  onProgress = null,
  snapshot = null,
  evaluationProfile = null,
  scope = null
} = {}) {
  if (!Array.isArray(trajectories)) throw new TypeError("评测轨迹必须是数组");
  if (typeof benchmark !== "function") throw new TypeError("benchmark 必须是函数");
  const paired = await runTaskPool(trajectories, async (trajectory, caseIndex) => {
    const samples = { champion: [], challenger: [] };
    const repetitions = Math.max(1, Math.trunc(Number(evaluationProfile?.repetitions) || 1));
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const seed = stableEvaluationSeed({ scope: scope || champion?.scope || challenger?.scope || {}, caseId: trajectory.id, repetition });
      for (const variant of pairedBenchmarkOrder(caseIndex + repetition)) {
        samples[variant].push(await benchmark(variant === "champion" ? champion : challenger, trajectory, {
          variant,
          caseIndex,
          repetition,
          seed,
          snapshot,
          evaluationProfile
        }));
      }
    }
    return samples;
  }, {
    concurrency,
    onSettled: (result, index) => {
      if (typeof onProgress !== "function") return;
      onProgress({
        caseId: String(trajectories[index]?.id || ""),
        status: result.status,
        championSample: result.status === "fulfilled" ? result.value.champion[0] : null,
        challengerSample: result.status === "fulfilled" ? result.value.challenger[0] : null,
        championSamples: result.status === "fulfilled" ? result.value.champion : [],
        challengerSamples: result.status === "fulfilled" ? result.value.challenger : [],
        error: result.status === "rejected" ? (result.reason?.message || String(result.reason || "评测失败")) : null
      }, index);
    }
  });

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
    repetitions: Math.max(1, Math.trunc(Number(evaluationProfile?.repetitions) || 1)),
    championSamples: fulfilled.flatMap((item) => item.champion),
    challengerSamples: fulfilled.flatMap((item) => item.challenger),
    failures
  };
}
