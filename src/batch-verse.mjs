/**
 * Batch verse/parallelism detection and style anchoring.
 *
 * Parallel-structured lines inside one batch (排比、口诀、诗行) must share one
 * sentence pattern, rhythm and register across translations. This module
 * detects the dominant verse shape of a batch and normalizes the finished
 * translations of earlier segments so later lines can be anchored to them.
 *
 * Pure module: no store/provider/clock dependencies.
 */

/** Shape of a single verse-like line such as "不杀生，仇恨永无止息" → "3+7". */
export function verseShape(text) {
  const match = String(text ?? "").trim().match(/^[\u4e00-\u9fff]{2,5}[，,][\u4e00-\u9fff]{5,9}$/u);
  if (!match) return null;
  const [first, second] = match[0].split(/[，,]/u);
  return `${[...first].length}+${[...second].length}`;
}

/**
 * Detect a dominant verse shape across a batch. Requires at least 3 matching
 * segments and a majority share of the batch, so ordinary prose documents with
 * a couple of similar short lines never trigger it.
 */
export function detectBatchVerse(segments = []) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length < 3) return null;
  const counts = new Map();
  for (const segment of list) {
    const shape = verseShape(segment?.source);
    if (!shape) continue;
    counts.set(shape, (counts.get(shape) || 0) + 1);
  }
  let best = null;
  for (const [shape, matchingCount] of counts) {
    if (matchingCount < 3) continue;
    if (matchingCount * 2 <= list.length) continue; // 需要严格过半数，恰好一半不算
    if (!best || matchingCount > best.matchingCount) best = { shape, matchingCount };
  }
  return best ? { active: true, shape: best.shape, matchingCount: best.matchingCount, total: list.length } : null;
}

/** Cap and clean anchor pairs (source → finished translation) from earlier segments. */
export function normalizeBatchReferences(references = []) {
  if (!Array.isArray(references)) return [];
  return references.map((item) => ({
    source: String(item?.source || "").trim(),
    target: String(item?.target || "").trim()
  })).filter((item) => item.source && item.target).slice(0, 3);
}
