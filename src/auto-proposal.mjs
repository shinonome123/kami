/**
 * Automatic challenger proposal.
 *
 * The evaluation and activation steps keep their human gates — this module only
 * automates the PROPOSAL step: once enough human-approved final translations
 * accumulate in an exact learning scope and no active candidate exists, a
 * challenger is proposed in the background from the same trajectories the
 * manual "生成候选技能" button uses.
 *
 * The decision function is pure; the proposer factory is dependency-injected
 * and serializes all checks through a single promise chain, so bursts of
 * concurrent accepts never produce duplicate model calls or duplicate
 * candidates.
 */

export const AUTO_PROPOSE_THRESHOLD = 10;
export const AUTO_PROPOSE_GROWTH_WINDOW = 10;

/**
 * Decide whether an automatic proposal is due. Pure over JSON-compatible
 * values. Failure metadata lowers the retry bar to "any new accepted
 * translation", while the growth window guards against churn after success.
 */
export function evaluateAutoProposeDecision({
  champion = null,
  activeCandidateCount = 0,
  acceptedCount = 0,
  threshold = AUTO_PROPOSE_THRESHOLD,
  growthWindow = AUTO_PROPOSE_GROWTH_WINDOW
} = {}) {
  const active = Math.max(0, Number(activeCandidateCount) || 0);
  const accepted = Math.max(0, Number(acceptedCount) || 0);
  if (active > 0) return { propose: false, reason: "当前作用域已有待评测候选，不重复提议" };
  if (accepted < threshold) return { propose: false, reason: `人工批准终稿 ${accepted} 条，未达自动提议阈值 ${threshold}` };
  const last = champion?.metadata?.autoPropose || {};
  const lastAcceptedCount = Number(last.lastAcceptedCount);
  const hasRecord = Number.isFinite(lastAcceptedCount);
  if (hasRecord && !last.lastError && accepted - lastAcceptedCount < growthWindow) {
    return { propose: false, reason: `自上次自动提议后仅新增 ${accepted - lastAcceptedCount} 条，未达增长窗口 ${growthWindow}` };
  }
  return { propose: true, reason: hasRecord && last.lastError ? "上次自动提议失败，且新增了人工终稿，重试" : `人工批准终稿 ${accepted} 条，达到自动提议阈值` };
}

const REQUIRED_DEPS = ["getCurrentChampion", "countAcceptedTrajectories", "listActiveCandidates", "listTrajectories", "selectTrajectories", "propose", "recordMetadata"];

export function createAutoProposer({ deps, threshold = AUTO_PROPOSE_THRESHOLD, growthWindow = AUTO_PROPOSE_GROWTH_WINDOW, now = () => new Date().toISOString() } = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps?.[name] !== "function") throw new TypeError(`auto proposer deps 缺少 ${name}`);
  }
  let chain = Promise.resolve();

  async function runCheck(scope) {
    const champion = await deps.getCurrentChampion(scope);
    if (!champion) return { proposed: false, reason: "作用域尚无 Champion，跳过" };
    const [activeCandidates, acceptedCount, trajectories] = await Promise.all([
      deps.listActiveCandidates(scope),
      deps.countAcceptedTrajectories(scope),
      deps.listTrajectories(scope)
    ]);
    const decision = evaluateAutoProposeDecision({
      champion,
      activeCandidateCount: activeCandidates.length,
      acceptedCount,
      threshold,
      growthWindow
    });
    if (!decision.propose) return { proposed: false, reason: decision.reason };
    const selected = deps.selectTrajectories(trajectories);
    if (!selected.length) return { proposed: false, reason: "没有可复盘的完成轨迹" };
    try {
      const candidate = await deps.propose({ scope, champion, trajectories: selected });
      await deps.recordMetadata(champion.id, champion.metadata || {}, {
        lastAcceptedCount: acceptedCount,
        lastProposedAt: now(),
        lastError: "",
        candidateId: String(candidate?.id || "")
      });
      return { proposed: true, candidateId: candidate?.id || "", reason: decision.reason };
    } catch (error) {
      const previous = champion.metadata?.autoPropose || {};
      await deps.recordMetadata(champion.id, champion.metadata || {}, {
        lastAcceptedCount: Number(previous.lastAcceptedCount) || 0,
        lastProposedAt: String(previous.lastProposedAt || ""),
        lastError: String(error.message || error),
        candidateId: String(previous.candidateId || "")
      });
      return { proposed: false, reason: String(error.message || error) };
    }
  }

  return {
    /** Serialized, never-rejecting background check. */
    maybePropose(scope) {
      const task = chain.then(() => runCheck(scope)).catch((error) => ({ proposed: false, reason: String(error.message || error) }));
      chain = task;
      return task;
    }
  };
}
