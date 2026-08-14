/**
 * Background evaluation jobs: FIFO queue, progress checkpointing and resume.
 *
 * One skill evaluation runs at a time so local models are not thrashed by
 * concurrent benchmarks. Every completed pair is persisted as JSON under the
 * jobs directory, so a server restart only interrupts the in-flight pair and
 * the job can be resumed instead of restarting from zero.
 *
 * The module stays storage-agnostic: all store access goes through the `deps`
 * object injected by the HTTP layer, which keeps it unit-testable with fakes
 * or a mock OpenAI server.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { evaluateSkillPromotion } from "./learning-engine.mjs";
import { runPairedSkillBenchmarks } from "./learning-benchmark.mjs";

const QUEUED = "queued";
const RUNNING = "running";
const INTERRUPTED = "interrupted";
const COMPLETED = "completed";
const FAILED = "failed";
const TERMINAL_STATUSES = new Set([COMPLETED, FAILED]);
const RESUMABLE_STATUSES = new Set([QUEUED, INTERRUPTED, FAILED]);

function persistableTrajectory(trajectory) {
  return {
    id: String(trajectory.id || ""),
    source: String(trajectory.source || ""),
    finalTranslation: String(trajectory.finalTranslation || ""),
    humanDecision: trajectory.humanDecision ? {
      accepted: trajectory.humanDecision.accepted === true,
      finalTranslation: String(trajectory.humanDecision.finalTranslation || "")
    } : null,
    neighborContext: trajectory.contextPack?.neighborContext || ""
  };
}

function publicJob(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    scope: job.scope,
    championId: job.championId,
    challengerId: job.challengerId,
    status: job.status,
    progress: {
      requested: job.requestedCaseIds.length,
      completed: Object.keys(job.caseSamples).length,
      failed: Object.keys(job.caseFailures).length
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || "",
    error: job.error || "",
    result: job.result || null
  };
}

export function createEvaluationJobRunner({ benchmark, jobsDirectory, deps, concurrency = 5, now = () => new Date().toISOString() } = {}) {
  if (typeof benchmark !== "function") throw new TypeError("benchmark 必须是函数");
  for (const name of ["getSkill", "getCurrentChampion", "validatePromotionState", "saveEvaluation", "updateSkillMetrics", "buildUiReport"]) {
    if (typeof deps?.[name] !== "function") throw new TypeError(`evaluation job deps 缺少 ${name}`);
  }

  const jobs = new Map();
  let running = false;

  async function jobPath(jobId) {
    return join(jobsDirectory, `${jobId}.json`);
  }

  async function persist(job) {
    await mkdir(dirname(await jobPath(job.jobId)), { recursive: true });
    const path = await jobPath(job.jobId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}
`, "utf8");
    await rename(temporary, path);
  }

  function chainPersist(job) {
    job._persistChain = (job._persistChain || Promise.resolve()).then(() => persist(job)).catch(() => undefined);
    return job._persistChain;
  }

  async function restoreFromDisk() {
    let files = [];
    try { files = await readdir(jobsDirectory); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(join(jobsDirectory, file), "utf8"));
        if (!job?.jobId || job.kind !== "skill-evaluation") continue;
        if ([QUEUED, RUNNING].includes(job.status)) {
          job.status = INTERRUPTED;
          job.error = "服务重启中断了本次评测，可续跑剩余样本";
          job.updatedAt = now();
          await persist(job);
        }
        jobs.set(job.jobId, job);
      } catch { /* 损坏的检查点文件不阻断启动，直接忽略 */ }
    }
  }

  function pumpQueue() {
    if (running) return;
    running = true;
    (async () => {
      try {
        while (true) {
          const next = [...jobs.values()].find((job) => job.status === QUEUED);
          if (!next) break;
          await execute(next);
        }
      } finally {
        running = false;
      }
    })();
  }

  function markFailed(job, message) {
    job.status = FAILED;
    job.error = message;
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    return chainPersist(job);
  }

  async function execute(job) {
    job.status = RUNNING;
    job.error = "";
    job.updatedAt = now();
    await persist(job);

    // Fail fast when the pairing is already stale, before spending model calls.
    const [champion, candidate] = await Promise.all([deps.getSkill(job.championId), deps.getSkill(job.challengerId)]);
    const currentChampion = await deps.getCurrentChampion(job.scope);
    const initialValidation = deps.validatePromotionState({ candidate, currentChampion });
    if (!initialValidation.valid) {
      await markFailed(job, initialValidation.reasons.join("；"));
      return;
    }

    const trajectories = job.requestedCaseIds
      .filter((caseId) => !job.caseSamples[caseId] && !job.caseFailures[caseId])
      .map((caseId) => job.caseTrajectories[caseId])
      .filter(Boolean);

    if (trajectories.length) {
      await runPairedSkillBenchmarks({
        trajectories,
        champion,
        challenger: candidate,
        benchmark,
        concurrency,
        onProgress: (progress) => {
          if (progress.status === "fulfilled") {
            job.caseSamples[progress.caseId] = { champion: progress.championSample, challenger: progress.challengerSample };
          } else if (progress.caseId) {
            job.caseFailures[progress.caseId] = progress.error || "评测失败";
          }
          job.updatedAt = now();
          chainPersist(job);
        }
      });
      await job._persistChain;
    }

    const championSamples = job.requestedCaseIds.filter((caseId) => job.caseSamples[caseId]).map((caseId) => job.caseSamples[caseId].champion);
    const challengerSamples = job.requestedCaseIds.filter((caseId) => job.caseSamples[caseId]).map((caseId) => job.caseSamples[caseId].challenger);
    const failures = job.requestedCaseIds.filter((caseId) => job.caseFailures[caseId]).map((caseId) => ({
      caseId,
      error: job.caseFailures[caseId]
    }));

    const result = evaluateSkillPromotion({
      scope: job.scope,
      champion: { id: job.championId, scope: job.scope, samples: championSamples },
      challenger: { id: job.challengerId, scope: job.scope, samples: challengerSamples },
      // Every paired case must complete for a real conclusion; a single failed
      // pair makes the whole run insufficient instead of pretending a zero.
      minSamples: job.requestedCaseIds.length,
      minimumCoverage: 0.8,
      guardrails: { requireCost: job.requireCost === true }
    });
    const report = deps.buildUiReport(result);
    report.benchmark = {
      requestedPairs: job.requestedCaseIds.length,
      completedPairs: championSamples.length,
      failedPairs: failures.length,
      failures: failures.slice(0, 10),
      isolation: [...championSamples, ...challengerSamples].reduce((summary, sample) => {
        const isolation = sample?.isolation || {};
        return {
          excludedMemories: summary.excludedMemories + (isolation.excludedMemories || 0),
          excludedQaCases: summary.excludedQaCases + (isolation.excludedQaCases || 0),
          excludedStyleExamples: summary.excludedStyleExamples + (isolation.excludedStyleExamples || 0),
          excludedUserProfileExamples: summary.excludedUserProfileExamples + (isolation.excludedUserProfileExamples || 0),
          totalExcluded: summary.totalExcluded + (isolation.totalExcluded || 0)
        };
      }, { excludedMemories: 0, excludedQaCases: 0, excludedStyleExamples: 0, excludedUserProfileExamples: 0, totalExcluded: 0 })
    };
    if (failures.length) {
      report.promotable = false;
      report.status = "insufficient";
      report.conclusion = `评测未完成：${failures.length} 组 Champion / Challenger 对照在翻译或独立 AIQA 阶段失败。失败样本不会按“零问题”计分，本次结果禁止晋升。`;
    }

    // Revalidate after the potentially long benchmark: the champion may have
    // changed or the candidate may have been rejected while model calls ran.
    const [refreshedCandidate, refreshedChampion] = await Promise.all([deps.getSkill(job.challengerId), deps.getCurrentChampion(job.scope)]);
    const revalidation = deps.validatePromotionState({ candidate: refreshedCandidate, currentChampion: refreshedChampion });
    if (!revalidation.valid) {
      await markFailed(job, revalidation.reasons.join("；"));
      return;
    }

    const evaluation = await deps.saveEvaluation({
      ...job.scope,
      championSkillId: refreshedChampion.id,
      challengerSkillId: refreshedCandidate.id,
      sampleCount: championSamples.length,
      championMetrics: result.championMetrics,
      challengerMetrics: result.challengerMetrics,
      metricDeltas: result.deltas,
      decision: result.status === "promote" ? "promote" : result.status === "reject" ? "reject" : "needs_review",
      report,
      evaluator: "kami-learning-engine-v1"
    });
    await deps.updateSkillMetrics(refreshedCandidate.id, result.challengerMetrics);

    job.result = { evaluationId: String(evaluation?.id || ""), report };
    job.status = COMPLETED;
    job.error = "";
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    await persist(job);
  }

  return {
    async initialize() {
      await restoreFromDisk();
    },
    async create({ scope, champion, challenger, trajectories, requireCost = false }) {
      const job = {
        jobId: randomUUID(),
        kind: "skill-evaluation",
        scope,
        championId: String(champion.id || ""),
        challengerId: String(challenger.id || ""),
        requireCost: requireCost === true,
        requestedCaseIds: trajectories.map((item) => String(item.id || "")).filter(Boolean),
        caseTrajectories: Object.fromEntries(trajectories.map((item) => [String(item.id || ""), persistableTrajectory(item)])),
        caseSamples: {},
        caseFailures: {},
        status: QUEUED,
        result: null,
        error: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: ""
      };
      jobs.set(job.jobId, job);
      await persist(job);
      pumpQueue();
      return publicJob(job);
    },
    get(jobId) {
      const job = jobs.get(String(jobId));
      return job ? publicJob(job) : null;
    },
    list(scope = null) {
      const matchesScope = (job) => !scope || ["locale", "contentType", "domain", "project"].every((field) => job.scope?.[field] === scope[field]);
      return [...jobs.values()].filter(matchesScope).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(publicJob);
    },
    findActiveForChallenger(challengerId) {
      const active = [...jobs.values()].find((job) => job.challengerId === String(challengerId) && !TERMINAL_STATUSES.has(job.status));
      return active ? publicJob(active) : null;
    },
    async resume(jobId) {
      const job = jobs.get(String(jobId));
      if (!job) return null;
      if (!RESUMABLE_STATUSES.has(job.status)) return publicJob(job);
      if (Object.keys(job.caseSamples).length >= job.requestedCaseIds.length) return publicJob(job);
      job.status = QUEUED;
      job.error = "";
      job.updatedAt = now();
      await persist(job);
      pumpQueue();
      return publicJob(job);
    }
  };
}
