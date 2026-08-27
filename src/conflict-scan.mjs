/**
 * Scheduled and post-distillation conflict scanning.
 *
 * Runs the deterministic shortlist, hands the survivors to the model, and turns
 * confirmed conflicts into reviewable resolutions. Nothing is applied here:
 * every outcome lands in the learning centre for a human, because the two
 * things a conflict can demand — retiring a style rule, or changing a skill's
 * additional rules — both already have their own gates and silently editing
 * either would route around them.
 *
 * Dependency-injected and serialized like `auto-proposal.mjs`: a burst of
 * finished distillations must not fire several overlapping scans of the same
 * scope, and the whole thing must stay testable without a live model.
 */

import { collectPromptRules, findConflictCandidates, planConflictResolution } from "./rule-conflicts.mjs";

const REQUIRED_DEPS = ["loadScopeRules", "adjudicate", "recordReport"];

/** 一次扫描最多送多少对给模型：预筛已经把不相关的挡掉，这里只封顶成本。 */
export const MAX_ADJUDICATED_PAIRS = 12;

export function createConflictScanner({ deps, maxPairs = MAX_ADJUDICATED_PAIRS, now = () => new Date().toISOString() } = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps?.[name] !== "function") throw new TypeError(`conflict scanner deps 缺少 ${name}`);
  }
  let chain = Promise.resolve();

  async function runScan(scope) {
    // 所有出口共用一个形状，前端才不用分别处理"提前退出"和"完整报告"。
    const empty = (scannedRules, candidates, reason) => ({
      scope, scannedRules, candidates, adjudicated: 0, conflicts: [], reason, scannedAt: now()
    });

    const sources = await deps.loadScopeRules(scope);
    const rules = collectPromptRules(sources);
    if (rules.length < 2) {
      // 规则化之前的存量规范只有一整段散文，没有可逐条比对的单位。这在真实
      // 语料上是常态而不是例外，所以要说清楚原因，不能只报「不足两条」。
      const legacy = !Array.isArray(sources?.styleProfile?.rules) || sources.styleProfile.rules.length === 0;
      const reason = legacy && String(sources?.styleProfile?.instruction || "").trim()
        ? "该作用域的风格规范还是规则化之前的整段散文，无法逐条比对；下次蒸馏会把它拆成规则后自动纳入"
        : "该作用域可比较的规则不足两条";
      // "没什么可比"本身就是结论，要留下来，否则刷新页面就变回"尚未扫描"。
      const report = empty(rules.length, 0, reason);
      await deps.recordReport(report);
      return report;
    }
    const candidates = findConflictCandidates(rules, { maxPairs });
    if (!candidates.length) {
      const report = empty(rules.length, 0, "没有谈论同一方面的规则对");
      await deps.recordReport(report);
      return report;
    }

    let verdicts;
    try {
      verdicts = await deps.adjudicate({ ...scope, candidates });
    } catch (error) {
      // 模型不可用时不要把候选当成结论：候选是刻意放宽的，直接上报会全是误报，
      // 也不落报告——没有结论就不该覆盖上一次真正跑出来的那一份。
      return empty(rules.length, candidates.length, `冲突审查模型不可用：${error.message}`);
    }

    const conflicts = verdicts
      .filter((verdict) => verdict.conflict)
      .map((verdict) => {
        const candidate = candidates[verdict.index];
        const plan = planConflictResolution(candidate);
        return {
          aspects: candidate.aspects,
          situation: verdict.situation,
          recommendation: verdict.recommendation,
          left: { origin: candidate.left.origin, originLabel: candidate.left.originLabel, id: candidate.left.id, rule: candidate.left.rule, evidenceCount: candidate.left.evidenceCount },
          right: { origin: candidate.right.origin, originLabel: candidate.right.originLabel, id: candidate.right.id, rule: candidate.right.rule, evidenceCount: candidate.right.evidenceCount },
          action: plan.action,
          reason: plan.reason,
          ruleId: plan.ruleId || "",
          winner: plan.winner ? { originLabel: plan.winner.originLabel, rule: plan.winner.rule } : null
        };
      });

    const report = {
      scope,
      scannedRules: rules.length,
      candidates: candidates.length,
      adjudicated: verdicts.length,
      conflicts,
      scannedAt: now()
    };
    await deps.recordReport(report);
    return report;
  }

  return {
    /** 串行化、永不 reject 的后台扫描：蒸馏完成的突发不会叠加成并发。 */
    scan(scope) {
      const task = chain.then(() => runScan(scope)).catch((error) => ({
        scope, scannedRules: 0, candidates: 0, adjudicated: 0, conflicts: [], reason: String(error?.message || error), scannedAt: now()
      }));
      chain = task;
      return task;
    }
  };
}
