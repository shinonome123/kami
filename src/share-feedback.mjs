function cleanText(value, limit) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

const CATEGORY_LABELS = Object.freeze({
  grammar: "语法",
  spelling: "拼写",
  punctuation: "标点",
  orthography: "书写规范",
  spacing: "空格",
  date_format: "日期格式",
  date: "日期格式",
  basic: "基础检查",
  fidelity: "忠实性",
  omission: "漏译",
  addition: "增译",
  mistranslation: "错译",
  accuracy: "准确性",
  terminology: "术语",
  naturalness: "地道性",
  unnatural_expression: "地道性",
  unnatural_wording: "地道性",
  awkward_phrasing: "地道性",
  fluency: "流畅度",
  tone: "语气",
  modality_shift: "语气与情态",
  semantic_shift: "语义偏差",
  style: "风格",
  consistency: "一致性",
  format: "格式",
  constraint: "约束",
  nuance: "细微一致性",
  alignment: "整句对齐",
  speaker_label: "说话人标识",
  speaker_label_error: "说话人标识"
});

function categoryKey(value) {
  return cleanText(value, 80).toLowerCase().replace(/[\s-]+/gu, "_");
}

function categoryLabel(value) {
  const key = categoryKey(value);
  if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
  if (key.startsWith("basic_")) return "基础检查";
  if (key.startsWith("aiqa_")) return categoryLabel(key.slice(5));
  return "其他问题";
}

function isClearChineseExplanation(value) {
  const text = cleanText(value, 800);
  const hanCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const visibleLength = (text.match(/[^\s\p{P}\p{S}]/gu) || []).length;
  return hanCount >= 4 && hanCount / Math.max(visibleLength, 1) >= 0.15;
}

function withoutEmbeddedSuggestion(message) {
  return cleanText(message, 800).replace(/[；;]\s*建议\s*[:：].*$/u, "").trim();
}

function fallbackMessage(key) {
  if (["spelling", "orthography"].includes(key)) return "该处译文疑似存在拼写或书写规范问题。";
  if (key === "grammar") return "该处译文疑似存在语法问题，可能影响理解或自然度。";
  if (key === "punctuation") return "该处译文的标点使用疑似不符合目标语言规范。";
  if (key === "spacing") return "该处译文的空格使用疑似不符合目标语言规范。";
  if (["date", "date_format"].includes(key)) return "该处日期或数字表达可能不够明确，或与原文含义不一致。";
  if (key === "omission") return "原文中的部分信息可能没有在译文中完整体现。";
  if (key === "addition") return "译文可能加入了原文没有的信息。";
  if (["accuracy", "mistranslation", "fidelity", "semantic_shift"].includes(key)) return "该处译文可能没有准确表达原文含义。";
  if (key === "terminology") return "该处术语译法可能与当前术语规范不一致。";
  if (["naturalness", "unnatural_expression", "unnatural_wording", "awkward_phrasing", "fluency"].includes(key)) return "该处表达可能不够符合目标语言的自然习惯。";
  if (["tone", "modality_shift", "style", "nuance"].includes(key)) return "该处译文的语气、情态或风格可能与原文或当前规范不一致。";
  if (["speaker_label", "speaker_label_error"].includes(key)) return "该处问答或说话人标识可能被错误替换或额外添加。";
  if (["format", "constraint"].includes(key)) return "该处译文可能不符合规定的格式或内容约束。";
  if (key === "basic" || key.startsWith("basic_")) return "该处译文存在一项需要复核的基础规范问题。";
  return "该处译文存在一项需要进一步复核的问题。";
}

function fallbackSuggestion(key) {
  if (["spelling", "orthography"].includes(key)) return "请按照目标语言的标准写法核对并修改该片段。";
  if (key === "grammar") return "请按照目标语言的语法规则改写，并保持原意不变。";
  if (key === "punctuation") return "请按照目标语言的标点规范进行调整。";
  if (key === "spacing") return "请按照目标语言的空格规范进行调整。";
  if (["date", "date_format"].includes(key)) return "请改为明确、无歧义且与原文含义一致的日期写法。";
  if (key === "omission") return "请核对原文信息，并补充译文中缺失的内容。";
  if (key === "addition") return "请删除或改写原文没有依据的内容。";
  if (["accuracy", "mistranslation", "fidelity", "semantic_shift"].includes(key)) return "请依据原文重新核对并修正该处表达。";
  if (key === "terminology") return "请核对术语库和上下文后采用一致译法。";
  if (["naturalness", "unnatural_expression", "unnatural_wording", "awkward_phrasing", "fluency"].includes(key)) return "请在不改变原意的前提下改为更自然的目标语言表达。";
  if (["tone", "modality_shift", "style", "nuance"].includes(key)) return "请结合原文语气、情态和项目风格规范调整表达。";
  if (["speaker_label", "speaker_label_error"].includes(key)) return "请统一保留或规范转换问答及说话人标识，不要额外增加标签。";
  if (["format", "constraint", "basic"].includes(key) || key.startsWith("basic_")) return "请对照原文和项目规范核对并修改。";
  return "请结合原文、译文和项目规范人工核对。";
}

/**
 * 分享页只用中文解释 QA 结论；目标语言片段作为单独证据保留，不能混进原因和建议。
 * 历史报告即使已经保存了泰文/韩文说明，也能通过这个展示层得到清晰中文回退。
 */
export function presentKnownIssue(issue = {}) {
  const savedCategory = cleanText(issue.category, 80);
  const rawCategory = savedCategory && !["other", "qa"].includes(categoryKey(savedCategory))
    ? savedCategory
    : cleanText(issue.type || savedCategory || "qa", 80);
  const key = categoryKey(rawCategory);
  const rawMessage = withoutEmbeddedSuggestion(issue.message);
  const rawSuggestion = cleanText(issue.suggestion, 800);
  return {
    ...issue,
    displayCategory: categoryLabel(rawCategory),
    displayMessage: isClearChineseExplanation(rawMessage) ? rawMessage : fallbackMessage(key),
    displaySuggestion: isClearChineseExplanation(rawSuggestion) ? rawSuggestion : fallbackSuggestion(key),
    sourceSpan: cleanText(issue.sourceSpan, 500),
    targetSpan: cleanText(issue.targetSpan || issue.span, 500)
  };
}

/** 只接受服务端保存的 QA 问题索引，客户端不能自行注入问题正文。 */
export function selectKnownIssues(segmentIssues = [], requestedIndexes = []) {
  const issues = Array.isArray(segmentIssues) ? segmentIssues : [];
  const indexes = Array.isArray(requestedIndexes) ? requestedIndexes : [];
  const unique = [...new Set(indexes.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < issues.length))].slice(0, 30);
  return unique.map((issueIndex) => {
    const issue = presentKnownIssue(issues[issueIndex] || {});
    return {
      issueIndex,
      severity: cleanText(issue.severity, 20),
      category: cleanText(issue.displayCategory, 80),
      message: cleanText(issue.displayMessage, 800),
      suggestion: cleanText(issue.displaySuggestion, 800)
    };
  }).filter((issue) => issue.message);
}

/** 勾选已知问题即可形成可处理的反馈，补充文字保持可选。 */
export function buildKnownIssueFeedbackRequest(knownIssues = [], additionalRequest = "") {
  const selected = Array.isArray(knownIssues) ? knownIssues : [];
  const knownBlock = selected.length
    ? `复核后仍需处理以下已知问题：\n${selected.map((issue, index) => `${index + 1}. [${issue.category || "qa"}] ${issue.message}${issue.suggestion ? `；建议：${issue.suggestion}` : ""}`).join("\n")}`
    : "";
  const note = cleanText(additionalRequest, 2_000);
  return [knownBlock, note ? `补充要求：${note}` : ""].filter(Boolean).join("\n").slice(0, 2_000);
}
