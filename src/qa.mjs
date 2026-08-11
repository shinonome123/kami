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
      issues.push({ severity: "warning", type: "potential_term", message: `疑似术语待确认：${matchPhrase || term.source} ≈ ${term.source} → ${term.target}` });
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
