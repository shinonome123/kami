/** Pure quality metric aggregation for Gold Set and regression runs. */
export const QUALITY_METRICS_SCHEMA_VERSION = 1;

const OMISSION_CATEGORIES = new Set(["omission", "missing", "missing_translation", "untranslated"]);
const FACT_CATEGORIES = new Set([
  "fact", "factuality", "number", "numeric", "date", "date_format", "url", "platform",
  "region", "locale", "placeholder", "format", "constraint", "addition", "mistranslation"
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value, label) {
  const number = finite(value);
  if (number === null || number < 0 || !Number.isInteger(number)) throw new TypeError(`${label}必须是非负整数`);
  return number;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function codePoints(value) {
  return [...String(value ?? "")];
}

function levenshteinDistance(left, right) {
  const a = codePoints(left);
  const b = codePoints(right);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return { distance: previous[b.length], maximumLength: Math.max(a.length, b.length) };
}

function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function categoryOf(issue) {
  return String(issue?.category || issue?.type || "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function termCounts(sample) {
  if (sample.requiredTermTotal !== undefined || sample.requiredTermHits !== undefined) {
    const total = nonNegativeInteger(sample.requiredTermTotal ?? 0, "requiredTermTotal");
    const hits = nonNegativeInteger(sample.requiredTermHits ?? 0, "requiredTermHits");
    if (hits > total) throw new RangeError("requiredTermHits 不能大于 requiredTermTotal");
    return { total, hits };
  }
  if (!Array.isArray(sample.requiredTerms)) return null;
  const total = sample.requiredTerms.length;
  const hits = sample.requiredTerms.filter((term) => term === true || term?.correct === true || term?.matched === true || term?.adopted === true).length;
  return { total, hits };
}

function factCounts(sample, issues) {
  if (sample.factCheckTotal !== undefined || sample.factErrorCount !== undefined) {
    const total = nonNegativeInteger(sample.factCheckTotal ?? 0, "factCheckTotal");
    const errors = nonNegativeInteger(sample.factErrorCount ?? 0, "factErrorCount");
    if (errors > total) throw new RangeError("factErrorCount 不能大于 factCheckTotal");
    return { total, errors };
  }
  if (Array.isArray(sample.factChecks)) {
    const total = sample.factChecks.length;
    const errors = sample.factChecks.filter((fact) => fact === false || fact?.correct === false || fact?.passed === false).length;
    return { total, errors };
  }
  const errors = issues.filter((issue) => FACT_CATEGORIES.has(categoryOf(issue))).length;
  return errors ? { total: errors, errors } : null;
}

function omissionCounts(sample, issues) {
  const issueCount = issues.filter((issue) => OMISSION_CATEGORIES.has(categoryOf(issue))).length;
  const omittedUnits = sample.omittedUnitCount === undefined
    ? issueCount
    : nonNegativeInteger(sample.omittedUnitCount, "omittedUnitCount");
  const sourceUnits = sample.sourceUnitCount === undefined
    ? null
    : nonNegativeInteger(sample.sourceUnitCount, "sourceUnitCount");
  if (sourceUnits !== null && omittedUnits > sourceUnits) throw new RangeError("omittedUnitCount 不能大于 sourceUnitCount");
  return { issueCount, omittedUnits, sourceUnits };
}

function humanEdit(sample) {
  const explicit = finite(sample.humanEditDistance);
  if (explicit !== null) {
    if (explicit < 0 || explicit > 1) throw new RangeError("humanEditDistance 必须在 0..1 之间");
    const changedCharacters = sample.humanEditedCharacters === undefined ? null : nonNegativeInteger(sample.humanEditedCharacters, "humanEditedCharacters");
    return { rate: explicit, changedCharacters, maximumLength: null };
  }
  const before = sample.machineTranslation ?? sample.candidateTranslation ?? sample.translation;
  const after = sample.humanFinalTranslation ?? sample.finalTranslation;
  if (typeof before !== "string" || typeof after !== "string") return null;
  const edit = levenshteinDistance(before, after);
  return {
    rate: edit.maximumLength ? edit.distance / edit.maximumLength : 0,
    changedCharacters: edit.distance,
    maximumLength: edit.maximumLength
  };
}

function reviewDuration(sample) {
  const explicit = finite(sample.reviewDurationMs);
  if (explicit !== null) {
    if (explicit < 0) throw new RangeError("reviewDurationMs 不能为负数");
    return explicit;
  }
  if (!sample.reviewStartedAt || !sample.reviewCompletedAt) return null;
  const started = Date.parse(sample.reviewStartedAt);
  const completed = Date.parse(sample.reviewCompletedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) throw new TypeError("审阅开始或完成时间无效");
  if (completed < started) throw new RangeError("审阅完成时间不能早于开始时间");
  return completed - started;
}

/**
 * Aggregate five operational KPIs. Omission rate is case incidence; when
 * source-unit counts are supplied, the stricter omitted-unit rate is reported
 * alongside it. Missing observations remain null and are exposed as coverage.
 */
export function calculateQualityMetrics(samples = []) {
  if (!Array.isArray(samples)) throw new TypeError("质量评测样本必须是数组");
  let requiredTermHits = 0;
  let requiredTermTotal = 0;
  let termCases = 0;
  let omissionCases = 0;
  let omissionIssueCount = 0;
  let omittedUnits = 0;
  let sourceUnits = 0;
  let omissionUnitCases = 0;
  let factErrors = 0;
  let factChecks = 0;
  let factCases = 0;
  let editedCharacters = 0;
  let editMaximumLength = 0;
  const editRates = [];
  const editCharacterSamples = [];
  const reviewDurations = [];

  samples.forEach((sample, index) => {
    if (!isPlainObject(sample)) throw new TypeError(`质量评测样本 ${index + 1} 必须是对象`);
    const issues = sample.issues === undefined ? [] : sample.issues;
    if (!Array.isArray(issues)) throw new TypeError(`质量评测样本 ${index + 1} issues 必须是数组`);
    const terms = termCounts(sample);
    if (terms) {
      termCases += 1;
      requiredTermHits += terms.hits;
      requiredTermTotal += terms.total;
    }
    const omission = omissionCounts(sample, issues);
    omissionIssueCount += omission.issueCount;
    omittedUnits += omission.omittedUnits;
    if (omission.issueCount > 0 || omission.omittedUnits > 0) omissionCases += 1;
    if (omission.sourceUnits !== null) {
      omissionUnitCases += 1;
      sourceUnits += omission.sourceUnits;
    }
    const facts = factCounts(sample, issues);
    if (facts) {
      factCases += 1;
      factErrors += facts.errors;
      factChecks += facts.total;
    }
    const edit = humanEdit(sample);
    if (edit) {
      editRates.push(edit.rate);
      if (edit.changedCharacters !== null) {
        editedCharacters += edit.changedCharacters;
        editCharacterSamples.push(edit.changedCharacters);
      }
      if (edit.maximumLength !== null) editMaximumLength += edit.maximumLength;
    }
    const duration = reviewDuration(sample);
    if (duration !== null) reviewDurations.push(duration);
  });

  const sampleSize = samples.length;
  const humanEditAmount = editMaximumLength
    ? editedCharacters / editMaximumLength
    : average(editRates);
  const result = {
    schemaVersion: QUALITY_METRICS_SCHEMA_VERSION,
    sampleSize,
    terminology: {
      accuracy: ratio(requiredTermHits, requiredTermTotal),
      hits: requiredTermHits,
      total: requiredTermTotal,
      caseCoverage: ratio(termCases, sampleSize) ?? 0
    },
    omission: {
      caseRate: ratio(omissionCases, sampleSize),
      casesWithOmission: omissionCases,
      issueCount: omissionIssueCount,
      omittedUnitRate: ratio(omittedUnits, sourceUnits),
      omittedUnits,
      sourceUnits,
      unitCoverage: ratio(omissionUnitCases, sampleSize) ?? 0
    },
    facts: {
      errorRate: ratio(factErrors, factChecks),
      errors: factErrors,
      total: factChecks,
      caseCoverage: ratio(factCases, sampleSize) ?? 0
    },
    humanEditing: {
      amount: humanEditAmount,
      averageNormalizedDistance: average(editRates),
      totalEditedCharacters: editCharacterSamples.length ? editedCharacters : null,
      averageEditedCharacters: average(editCharacterSamples),
      caseCoverage: ratio(editRates.length, sampleSize) ?? 0
    },
    review: {
      totalDurationMs: reviewDurations.length ? reviewDurations.reduce((sum, value) => sum + value, 0) : null,
      averageDurationMs: average(reviewDurations),
      p50DurationMs: percentile(reviewDurations, 0.5),
      p95DurationMs: percentile(reviewDurations, 0.95),
      caseCoverage: ratio(reviewDurations.length, sampleSize) ?? 0
    }
  };
  // Stable top-level names make dashboards and release gates uncomplicated.
  result.terminologyAccuracy = result.terminology.accuracy;
  result.omissionRate = result.omission.caseRate;
  result.factErrorRate = result.facts.errorRate;
  result.humanEditAmount = result.humanEditing.amount;
  result.reviewDurationMs = result.review.averageDurationMs;
  return result;
}
