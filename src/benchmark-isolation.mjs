/**
 * Clean-room isolation for skill benchmarks.
 *
 * A holdout case must never see assets derived from its own final translation:
 * a memory, QA case, style-profile example or user-profile example whose source
 * text is the same sentence (or a near-identical variant) would inject the
 * "gold" answer into the context pack of both variants, collapse every metric
 * delta to zero and permanently freeze the promotion loop.
 *
 * This module is pure over JSON-compatible values: it never mutates inputs and
 * has no store/provider/clock dependency so it can be unit-tested in isolation.
 */

import { normalizeSource, similarity } from "./text.mjs";

/**
 * Sources this close to the case source count as self-derived. One edit on a
 * 21-character sentence already exceeds 0.95 similarity; short sources require
 * an exact match naturally, so no special-casing is needed.
 */
export const SELF_REFERENCE_SIMILARITY_THRESHOLD = 0.95;

/** True when candidateSource is the same sentence as source (normalized) or a near-identical variant. */
export function isSelfDerived(source, candidateSource) {
  const normalized = normalizeSource(source);
  const candidate = normalizeSource(candidateSource);
  if (!normalized || !candidate) return false;
  if (normalized === candidate) return true;
  return similarity(normalized, candidate) >= SELF_REFERENCE_SIMILARITY_THRESHOLD;
}

function partition(items = [], source) {
  const kept = [];
  const removed = [];
  for (const item of items || []) {
    if (item && typeof item.source === "string" && isSelfDerived(source, item.source)) removed.push(item);
    else kept.push(item);
  }
  return { kept, removed };
}

function filterExamples(examples = [], source) {
  return partition(Array.isArray(examples) ? examples : [], source);
}

/**
 * Remove every asset that could reveal the final translation of the given
 * holdout source from the benchmark retrieval inputs. Returns filtered copies
 * and an isolation report for auditing; inputs are never mutated.
 */
export function isolateBenchmarkAssets({ source, memories = [], qaCases = [], styleProfile = null, userProfile = null } = {}) {
  const memoryPartition = partition(memories, source);
  const qaCasePartition = partition(qaCases, source);
  const styleExamples = filterExamples(styleProfile?.examples, source);
  const userExamples = filterExamples(userProfile?.examples, source);

  const isolatedStyleProfile = styleProfile && styleExamples.removed.length
    ? { ...styleProfile, examples: styleExamples.kept }
    : styleProfile;
  const isolatedUserProfile = userProfile && userExamples.removed.length
    ? { ...userProfile, examples: userExamples.kept }
    : userProfile;

  const excludedMemories = memoryPartition.removed.length;
  const excludedQaCases = qaCasePartition.removed.length;
  const excludedStyleExamples = styleExamples.removed.length;
  const excludedUserProfileExamples = userExamples.removed.length;

  return {
    memories: memoryPartition.kept,
    qaCases: qaCasePartition.kept,
    styleProfile: isolatedStyleProfile,
    userProfile: isolatedUserProfile,
    isolation: {
      excludedMemories,
      excludedQaCases,
      excludedStyleExamples,
      excludedUserProfileExamples,
      totalExcluded: excludedMemories + excludedQaCases + excludedStyleExamples + excludedUserProfileExamples
    }
  };
}
