import { extractProtectedTokens, normalizeSource } from "./text.mjs";

export function runQa({ source, translation, matches = [] }) {
  const issues = [];
  for (const token of extractProtectedTokens(source)) {
    if (!String(translation).includes(token)) {
      issues.push({ severity: "error", type: "protected_token", message: `受保护内容缺失：${token}` });
    }
  }
  for (const { term, mode = "exact", matchPhrase } of matches) {
    const adopted = normalizeSource(translation).includes(normalizeSource(term.target));
    if (mode === "exact" && term.enforcement === "required" && !adopted) {
      issues.push({ severity: "error", type: "required_term", message: `未使用强制译法：${term.source} → ${term.target}` });
    }
    if (mode !== "exact" && !adopted) {
      issues.push({
        severity: "warning",
        type: "potential_term",
        category: "terminology",
        sourceTerm: term.source,
        matchedSource: matchPhrase || term.source,
        targetTerm: term.target,
        message: `疑似术语待确认：${matchPhrase || term.source} ≈ ${term.source} → ${term.target}`
      });
    }
    for (const forbidden of term.forbidden ?? []) {
      if (forbidden && normalizeSource(translation).includes(normalizeSource(forbidden))) {
        issues.push({ severity: "error", type: "forbidden_term", message: `使用了禁用译法：${forbidden}` });
      }
    }
  }
  if (source.trim() && !String(translation).trim()) {
    issues.push({ severity: "error", type: "empty", message: "译文为空" });
  }
  return issues;
}

export function calculateQaScore({ hardIssues = [], aiIssues = [] } = {}) {
  let penalty = 0;
  for (const issue of hardIssues) penalty += issue.severity === "error" ? 35 : 3;
  for (const issue of aiIssues) {
    if (issue.confidence < 0.55) continue;
    penalty += issue.severity === "critical" ? 35 : issue.severity === "major" ? 12 : 3;
  }
  let score = Math.max(0, 100 - penalty);
  if (hardIssues.some((issue) => issue.severity === "error")) score = Math.min(score, 60);
  if (aiIssues.some((issue) => issue.severity === "critical" && issue.confidence >= 0.7)) score = Math.min(score, 65);
  return Math.round(score);
}

export function presentAiQaIssues(aiIssues = []) {
  return aiIssues.filter((issue) => issue.confidence >= 0.55).map((issue) => ({
    ...issue,
    mqmSeverity: issue.severity,
    severity: issue.severity === "minor" ? "warning" : "error",
    type: `aiqa_${issue.category}`,
    message: issue.message
  }));
}
