import { textContainsTerm } from "./asset-governance.mjs";
import { digitSequence, digitsRecoverable, extractProtectedTokens } from "./text.mjs";
import { checkOrthography } from "./orthography.mjs";
import { checkRegisterExpectation } from "./register-classifier.mjs";

export function runQa({ source, translation, matches = [], locale = "", titleOverrides = null, contentType = "general", registerPolicy = null }) {
  const issues = [];
  for (const token of extractProtectedTokens(source)) {
    if (!String(translation).includes(token)) {
      issues.push({ severity: "error", type: "protected_token", message: `受保护内容缺失：${token}` });
    }
  }
  for (const match of matches) {
    const { term, mode = "exact", matchPhrase, caseMismatch = false } = match;
    // 保留原文的术语期望的是原文形态本身；区分大小写的术语按原样比对，不做大小写折叠。
    const caseSensitive = match.caseSensitive ?? Boolean(term.caseSensitive);
    const preserveOriginal = match.preserveOriginal ?? Boolean(term.preserveOriginal);
    const expected = String(match.expectedTarget || (preserveOriginal ? (matchPhrase || term.source) : term.target) || "");
    const adopted = Boolean(expected) && textContainsTerm(translation, expected, { caseSensitive });
    if (mode === "exact" && term.enforcement === "required" && !adopted) {
      issues.push({
        severity: "error",
        type: preserveOriginal ? "preserved_term" : "required_term",
        message: preserveOriginal
          ? `必须保留原文形态：${term.source} → ${expected}`
          : `未使用强制译法：${term.source} → ${expected}${caseSensitive ? "（区分大小写）" : ""}`
      });
    }
    if (mode !== "exact" && !adopted) {
      issues.push({
        severity: "warning",
        type: caseMismatch ? "term_case_mismatch" : "potential_term",
        category: "terminology",
        sourceTerm: term.source,
        matchedSource: matchPhrase || term.source,
        targetTerm: expected,
        message: caseMismatch
          ? `大小写与术语登记不一致，需确认是否同一专名：${matchPhrase || term.source} ≠ ${term.source} → ${expected}`
          : `疑似术语待确认：${matchPhrase || term.source} ≈ ${term.source} → ${expected}`
      });
    }
    for (const forbidden of term.forbidden ?? []) {
      if (forbidden && textContainsTerm(translation, forbidden, { caseSensitive })) {
        issues.push({ severity: "error", type: "forbidden_term", message: `使用了禁用译法：${forbidden}` });
      }
    }
  }
  // 目标语言标点约定是确定性规则，交给本地检查而不是靠模型自觉。
  issues.push(...checkOrthography({ source, translation, locale, titleOverrides }));
  // 语域（太营销 / 太网感 / 太普通）走确定性分类器而不是模型自由判断：
  // 同一段译文每次都得到同一个结论，才谈得上回归。
  issues.push(...checkRegisterExpectation({ translation, locale, contentType, policyOverrides: registerPolicy }).issues);
  // 裸数字按数值等价校验而不是字面包含：8月20日 / 8월 20일 是 820 的正确本地化，
  // 不该判成漏掉受保护内容。仅当数字确实无法从译文还原时提示复核。
  if (!digitsRecoverable(source, translation)) {
    issues.push({
      severity: "warning",
      type: "number_drift",
      category: "number",
      message: `原文中的数字未能在译文中完整还原（原文数字：${digitSequence(source)}，译文数字：${digitSequence(translation) || "无"}），请确认是否漏译或已按目标语言习惯改写`
    });
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
