/**
 * Debounce gate for style-profile distillation.
 *
 * Distillation used to fire on "总量过线" alone: once a scope's evidence pool
 * passed the threshold, EVERY subsequent accepted piece of evidence produced
 * another full model rewrite and another draft, burying the review queue in
 * near-identical drafts and burning a model call each time.
 *
 * The gate mirrors the challenger auto-proposal contract in `auto-proposal.mjs`:
 * an unreviewed draft blocks new ones, and after a successful distillation the
 * pool must grow by a full window before the next one. A failed distillation
 * persists nothing, so `lastDistilledEvidenceCount` stays put and the next
 * accepted evidence naturally retries — no error bookkeeping required.
 *
 * Pure module: no store, provider or clock dependency.
 */

export const STYLE_DISTILL_THRESHOLD = 8;
export const STYLE_DISTILL_GROWTH_WINDOW = 8;

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function count(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Decide whether a scope is due for a fresh style-profile distillation.
 *
 * `lastDistilledEvidenceCount` is the `evidenceCount` recorded on the newest
 * profile of this scope regardless of status — a rejected draft still consumed
 * a model call at that pool size, so it counts as "already distilled here".
 */
export function evaluateStyleDistillDecision({
  evidenceCount = 0,
  pendingDraftCount = 0,
  lastDistilledEvidenceCount = null,
  threshold = STYLE_DISTILL_THRESHOLD,
  growthWindow = STYLE_DISTILL_GROWTH_WINDOW
} = {}) {
  const evidence = count(evidenceCount);
  const pending = count(pendingDraftCount);
  const minimum = positiveInteger(threshold, STYLE_DISTILL_THRESHOLD);
  const window = positiveInteger(growthWindow, STYLE_DISTILL_GROWTH_WINDOW);
  // Number(null) and Number("") are both 0, so an absent baseline must be
  // rejected before the numeric check or a first-ever distillation would look
  // like "already distilled at 0" and get held back by the growth window.
  const blank = lastDistilledEvidenceCount === null || lastDistilledEvidenceCount === undefined || lastDistilledEvidenceCount === "";
  const last = blank ? Number.NaN : Number(lastDistilledEvidenceCount);
  const hasRecord = Number.isFinite(last);
  const sinceLastDistill = hasRecord ? evidence - last : null;
  const base = { evidenceCount: evidence, threshold: minimum, growthWindow: window, sinceLastDistill };

  if (pending > 0) {
    return { ...base, distill: false, skipped: "pending_draft", reason: `该范围已有 ${pending} 个待审核风格草稿，审核完成前不再重复蒸馏` };
  }
  if (evidence < minimum) {
    return { ...base, distill: false, skipped: "threshold", reason: `风格证据累计 ${evidence} 条，未达 ${minimum} 条蒸馏阈值，继续累积` };
  }
  if (hasRecord && sinceLastDistill < window) {
    return { ...base, distill: false, skipped: "growth_window", reason: `自上次蒸馏后仅新增 ${sinceLastDistill} 条证据，未达增长窗口 ${window} 条` };
  }
  return {
    ...base,
    distill: true,
    skipped: "",
    reason: hasRecord
      ? `自上次蒸馏后新增 ${sinceLastDistill} 条证据，达到增长窗口 ${window} 条`
      : `风格证据累计 ${evidence} 条，首次达到 ${minimum} 条蒸馏阈值`
  };
}

/**
 * Reduce a scope's profile list to the two facts the gate needs. Accepts the
 * full per-locale list and filters by scope itself so callers can reuse one
 * store round-trip.
 */
export function readStyleDistillState(styleProfiles = [], { contentType, domain = "general" } = {}) {
  const scoped = (Array.isArray(styleProfiles) ? styleProfiles : []).filter((item) => item
    && item.contentType === contentType
    && (item.domain || "general") === (domain || "general"));
  const latest = scoped.reduce((best, item) => (
    !best || (Number(item.version) || 0) > (Number(best.version) || 0) ? item : best
  ), null);
  return {
    pendingDraftCount: scoped.filter((item) => item.status === "draft").length,
    lastDistilledEvidenceCount: latest ? count(latest.evidenceCount) : null
  };
}
