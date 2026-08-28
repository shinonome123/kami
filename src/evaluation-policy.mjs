import { createHash } from "node:crypto";

/**
 * Reproducible evaluation policy shared by translation-skill and style-profile
 * benchmarks. Production translation keeps its creative temperatures; only the
 * promotion benchmark is controlled here.
 */
export const EVALUATION_POLICY_VERSION = "kami-evaluation-v2";

const EXPRESSIVE_CONTENT_TYPES = new Set(["dialogue", "marketing", "social"]);

/**
 * Factual/operational text is evaluated deterministically. Expressive text
 * keeps a smaller amount of variation and is sampled twice. Verse keeps the
 * production creative temperature and is sampled three times, because a single
 * draw cannot represent its output distribution honestly.
 */
export function evaluationProfileForContentType(contentType = "general") {
  const normalized = String(contentType || "general");
  if (normalized === "verse") {
    return {
      policyVersion: EVALUATION_POLICY_VERSION,
      mode: "creative-repeated",
      repetitions: 3,
      translationTemperature: 0.85,
      qaTemperature: 0,
      seedRequested: true
    };
  }
  if (EXPRESSIVE_CONTENT_TYPES.has(normalized)) {
    return {
      policyVersion: EVALUATION_POLICY_VERSION,
      mode: "expressive-repeated",
      repetitions: 2,
      translationTemperature: 0.35,
      qaTemperature: 0,
      seedRequested: true
    };
  }
  return {
    policyVersion: EVALUATION_POLICY_VERSION,
    mode: "deterministic",
    repetitions: 1,
    translationTemperature: 0,
    qaTemperature: 0,
    seedRequested: true
  };
}

/** Stable unsigned 31-bit seed. The same case/repetition uses the same seed on
 * both variants and across reruns, while different cases do not share a stream.
 */
export function stableEvaluationSeed({ scope = {}, caseId = "", repetition = 0 } = {}) {
  const value = [
    EVALUATION_POLICY_VERSION,
    scope.locale || "",
    scope.contentType || "general",
    scope.domain || "general",
    scope.project || "default",
    String(caseId || ""),
    Math.max(0, Number(repetition) || 0)
  ].join("\u0000");
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) & 0x7fffffff;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

/** Fingerprint only immutable benchmark inputs; timestamps are deliberately
 * supplied separately by callers and must not be included in `input`.
 */
export function benchmarkSnapshotFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

export function evaluationPolicyAudit(contentTypes = []) {
  return Object.fromEntries(contentTypes.map((contentType) => [contentType, evaluationProfileForContentType(contentType)]));
}
