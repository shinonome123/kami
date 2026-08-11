import { normalizeSource } from "./text.mjs";

function includesNormalized(text, phrase) {
  return phrase && normalizeSource(text).includes(normalizeSource(phrase));
}

export function buildSuggestionCandidates(translation, matches = []) {
  return matches.filter((match) => match.mode !== "exact" && !includesNormalized(translation, match.term.target)).map((match, index) => ({
    index,
    match,
    sourceTerm: match.term.source,
    matchedSource: match.matchPhrase || match.variant,
    replacement: match.term.target,
    matchMode: match.mode,
    matchScore: match.score
  }));
}

export function resolveTermSuggestions(translation, candidates, modelSuggestions = []) {
  const resolved = [];
  const used = new Set();
  const add = (candidate, currentText, confidence, reason, alignment) => {
    const current = String(currentText || "").trim();
    if (!current || current === candidate.replacement || !String(translation).includes(current)) return;
    const key = `${current}\u0000${candidate.replacement}`;
    if (used.has(key)) return;
    used.add(key);
    resolved.push({
      id: `${candidate.match.term.id || "term"}-${resolved.length + 1}`,
      currentText: current,
      replacement: candidate.replacement,
      sourceTerm: candidate.sourceTerm,
      matchedSource: candidate.matchedSource,
      matchMode: candidate.matchMode,
      matchScore: Number(candidate.matchScore.toFixed(2)),
      confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
      reason,
      alignment
    });
  };

  for (const candidate of candidates) {
    const forbidden = (candidate.match.term.forbidden || []).find((phrase) => String(translation).includes(phrase));
    if (forbidden) add(candidate, forbidden, 0.98, "译文命中了术语库禁用译法", "rule");
  }
  for (const suggestion of modelSuggestions) {
    const candidate = candidates[Number(suggestion.index)];
    const confidence = Number(suggestion.confidence);
    if (!candidate || !Number.isFinite(confidence) || confidence < 0.65) continue;
    add(candidate, suggestion.currentText, confidence, String(suggestion.reason || "模型对齐到疑似术语表达"), "model");
  }
  return resolved;
}
