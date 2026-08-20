import { runQa } from "./qa.mjs";
import { normalizeSource } from "./text.mjs";

export const AUTO_QA_DIMENSIONS = Object.freeze(["basic", "fidelity", "nuance"]);

/** 逐句切分：CJK 句末标点、换行，以及“句号/叹号/问号 + 空格 + 字母/谚文”的韩文/西文句界。 */
export function splitQaSegments(text = "") {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/(?<=\n)|(?<=[。！？!?；;])(?=[^”’」』【】）)])|(?<=[.!?])\s+(?=[A-Za-z\uac00-\ud7af])/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** 余弦相似度（已归一化向量）。 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Math.min(1, dot));
}

const ALIGN_GAP_PENALTY = 0.16;
/** 匹配本身要付费：相似度过低的“硬配对”不如跳过，从而暴露漏译/增译。 */
const ALIGN_MATCH_COST = 0.3;
/** 并入相邻句的最低相似度：低于它宁可标记为疑似增译，也不硬塞进旁边句子。 */
const ALIGN_REASSIGN_THRESHOLD = ALIGN_MATCH_COST - ALIGN_GAP_PENALTY;

/**
 * 把原文句与译文句做单调对齐，支持 1:N / N:1 合并（译文把长句拆开、或多句并成一句）。
 * score(i,j) 提供原文第 i 句与译文第 j 句的语义相似度（0-1）；为 null 时按位置比例近似配对。
 * 返回 { pairs, unmatchedSource, unmatchedTranslation }，索引均为 0 基。
 */
export function alignSegmentPairs(sourceCount, translationCount, score = null) {
  const n = Number(sourceCount) || 0;
  const m = Number(translationCount) || 0;
  const unmatchedSource = Array.from({ length: n }, (_, i) => i);
  const unmatchedTranslation = Array.from({ length: m }, (_, j) => j);
  if (!n || !m) return { pairs: [], unmatchedSource, unmatchedTranslation };

  if (!score) {
    // 位置比例回退：把小的一侧按位置比例映射到大的一侧
    const group = (smallCount, largeCount) => Array.from(
      { length: largeCount },
      (_, j) => Math.min(smallCount - 1, Math.round((j + 0.5) * smallCount / largeCount))
    );
    if (n === m) {
      return { pairs: Array.from({ length: n }, (_, i) => ({ sourceIndices: [i], translationIndices: [i] })), unmatchedSource: [], unmatchedTranslation: [] };
    }
    if (n < m) {
      const mapping = group(n, m);
      const pairs = Array.from({ length: n }, (_, i) => ({ sourceIndices: [i], translationIndices: [] }));
      mapping.forEach((i, j) => pairs[i].translationIndices.push(j));
      return { pairs, unmatchedSource: [], unmatchedTranslation: [] };
    }
    const mapping = group(m, n);
    const pairs = Array.from({ length: m }, (_, j) => ({ sourceIndices: [], translationIndices: [j] }));
    mapping.forEach((j, i) => pairs[j].sourceIndices.push(i));
    return { pairs, unmatchedSource: [], unmatchedTranslation: [] };
  }

  // DP：diag 匹配 + 跳过原文 + 跳过译文，跳过扣 GAP 分
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-Infinity));
  const trace = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  dp[0][0] = 0;
  for (let j = 1; j <= m; j += 1) { dp[0][j] = -j * ALIGN_GAP_PENALTY; trace[0][j] = 2; }
  for (let i = 1; i <= n; i += 1) { dp[i][0] = -i * ALIGN_GAP_PENALTY; trace[i][0] = 1; }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diag = dp[i - 1][j - 1] + Math.max(0, Number(score(i - 1, j - 1)) || 0) - ALIGN_MATCH_COST;
      const up = dp[i - 1][j] - ALIGN_GAP_PENALTY;
      const left = dp[i][j - 1] - ALIGN_GAP_PENALTY;
      if (diag >= up && diag >= left) { dp[i][j] = diag; trace[i][j] = 0; }
      else if (up >= left) { dp[i][j] = up; trace[i][j] = 1; }
      else { dp[i][j] = left; trace[i][j] = 2; }
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = trace[i][j];
    if (step === 0) { ops.push({ type: "match", i: i - 1, j: j - 1 }); i -= 1; j -= 1; }
    else if (step === 1) { ops.push({ type: "skipSource", i: i - 1, j: null }); i -= 1; }
    else { ops.push({ type: "skipTranslation", i: null, j: j - 1 }); j -= 1; }
  }
  ops.reverse();
  const pairs = [];
  const skippedSource = [];
  const skippedTranslation = [];
  for (const op of ops) {
    if (op.type === "match") pairs.push({ sourceIndices: [op.i], translationIndices: [op.j], anchorSource: op.i, anchorTranslation: op.j });
    else if (op.type === "skipSource") skippedSource.push(op.i);
    else skippedTranslation.push(op.j);
  }
  // 被跳过的译文句并入相似度更高的相邻原文句（常见于译文把一句拆成多句）。
  // 用原始匹配锚点判断相邻关系，合并结果不改变锚点，避免先合并的句子挡住后续判断。
  const stillUnmatched = [];
  for (const jIndex of skippedTranslation) {
    const prev = [...pairs].reverse().find((pair) => pair.anchorTranslation < jIndex);
    const next = pairs.find((pair) => pair.anchorTranslation > jIndex);
    const prevScore = prev ? score(prev.anchorSource, jIndex) : -Infinity;
    const nextScore = next ? score(next.anchorSource, jIndex) : -Infinity;
    if (Math.max(prevScore, nextScore) >= ALIGN_REASSIGN_THRESHOLD) {
      if (prev && prevScore >= nextScore) prev.translationIndices.push(jIndex);
      else if (next) next.translationIndices.push(jIndex);
      else stillUnmatched.push(jIndex);
    } else {
      stillUnmatched.push(jIndex);
    }
  }
  pairs.sort((a, b) => Math.min(...a.sourceIndices) - Math.min(...b.sourceIndices));
  for (const pair of pairs) {
    pair.sourceIndices.sort((a, b) => a - b);
    pair.translationIndices.sort((a, b) => a - b);
    delete pair.anchorSource;
    delete pair.anchorTranslation;
  }
  return { pairs, unmatchedSource: skippedSource, unmatchedTranslation: stillUnmatched };
}

/**
 * 合并多路检查结果时去重：同一维度、同一类别、指向同一译文片段的问题只保留先出现的一条。
 * 语法专项与三层审查可能报告同一条错误，避免重复计分与重复展示。
 */
export function dedupeIssues(issues = []) {
  const seen = new Set();
  return (Array.isArray(issues) ? issues : []).filter((issue) => {
    const key = `${issue.dimension || "basic"}|${issue.category || ""}|${normalizeSource(issue.targetSpan || "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 校验语素拆解：所有词块 surface 按顺序拼接（忽略空白）后必须完整等于译文本身，
 * 防止模型遗漏、增字或改写。literal 不参与校验（模型可自由直译）。
 */
export function validateGlossTokens({ translation = "", tokens = [] }) {
  return glossCoverage({ translation, tokens }) === 1;
}

/** 词块对译文的覆盖率（按字符序比对，0-1）。遗漏与多余字都会拉低覆盖率。 */
export function glossCoverage({ translation = "", tokens = [] }) {
  if (!Array.isArray(tokens) || !tokens.length) return 0;
  const strip = (value) => String(value ?? "").replace(/\s+/gu, "");
  const source = strip(translation);
  if (!source) return 0;
  const covered = strip(tokens.map((token) => token?.surface || "").join(""));
  if (covered === source) return 1;
  let matched = 0;
  let cursor = 0;
  for (const character of [...covered]) {
    const found = source.indexOf(character, cursor);
    if (found >= 0) {
      matched += 1;
      cursor = found + 1;
    }
  }
  return Math.min(matched / [...source].length, [...source].length / Math.max([...covered].length, 1));
}

/**
 * 检测“直译”是否退化成词块释义的拼接（如「最近 游戏 话题助词 《…》」）。
 * 出现语法标签字样或大量空格分隔碎片时视为不合格，需要模型重写或隐藏。
 */
export function isGlossDumpLiteral(literal = "") {
  const text = String(literal || "");
  if (!text) return false;
  const labelHits = (text.match(/(?:助词|语尾|助动词|冠形词|宾格|主格|话题|主题)/gu) || []).length;
  if (labelHits >= 2) return true;
  const spaces = (text.match(/\s/gu) || []).length;
  const length = [...text].length;
  return length > 0 && spaces / length > 0.22;
}

/** 整句级漏译/增译问题（由对齐结果直接判定）。 */
export function buildAlignmentIssues({ sourceSegments = [], translationSegments = [], unmatchedSource = [], unmatchedTranslation = [] }) {  const issues = [];
  for (const index of unmatchedSource) {
    const snippet = String(sourceSegments[index] || "").slice(0, 80);
    issues.push({
      dimension: "fidelity",
      severity: "critical",
      category: "omission",
      sourceSpan: snippet,
      targetSpan: "",
      message: `疑似整句漏译：原文第 ${index + 1} 句在译文中找不到对应内容`,
      suggestion: "补译该句内容",
      confidence: 1
    });
  }
  for (const index of unmatchedTranslation) {
    const snippet = String(translationSegments[index] || "").slice(0, 80);
    issues.push({
      dimension: "fidelity",
      severity: "major",
      category: "addition",
      sourceSpan: "",
      targetSpan: snippet,
      message: `疑似整句增译：译文第 ${index + 1} 句在原文中找不到对应内容`,
      suggestion: "确认该内容是否本应在原文对应位置存在",
      confidence: 0.8
    });
  }
  return issues;
}

/** 拉丁词（品牌名/专名）候选：字母开头，可带数字、点与连字符。 */
const LATIN_WORD = /[A-Za-z][A-Za-z0-9.+-]{1,}/g;

/** 目标语言中常见的英文保留词/缩写，不视为新增拉丁词。 */
const LATIN_ALLOWLIST = new Set([
  "ok", "ng", "pc", "npc", "sns", "dlc", "cd", "hd", "id", "vip", "gps", "cpu", "gpu",
  "rpg", "fps", "mvp", "pvp", "pve", "mmo", "etc", "app", "web", "url", "ui", "ux",
  "ai", "ar", "vr", "ddl", "api", "json", "csv", "pdf", "docx", "ios", "os", "tv"
]);

const QUOTE_PAIRS = [
  ["「", "」", "日式引号"],
  ["『", "』", "双日式引号"],
  ["（", "）", "全角括号"],
  ["(", ")", "半角括号"],
  ["【", "】", "方括号"]
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 基本检查层：确定性本地规则，零模型成本。
 * 复用硬 QA（受保护内容、强制/禁用术语、空译文）并叠加拼写、品牌名、标点与语气启发式。
 * 返回的每条 issue 都带 dimension: "basic"。
 */
export function runBasicQa({ source, translation, matches = [] }) {
  const issues = runQa({ source, translation, matches }).map((issue) => ({
    ...issue,
    dimension: "basic",
    category: issue.category || "basic"
  }));
  const src = String(source || "");
  const tgt = String(translation || "");
  if (!src.trim() || !tgt.trim()) return issues;

  // 未翻译：译文与原文完全相同
  if (normalizeSource(src) === normalizeSource(tgt)) {
    issues.push({ severity: "error", type: "basic_untranslated", category: "basic", message: "译文与原文完全相同，疑似未翻译" });
    return issues;
  }

  const termTargets = matches
    .flatMap((match) => [match.term?.target, ...(Array.isArray(match.term?.aliases) ? match.term.aliases : [])])
    .filter(Boolean)
    .map((value) => normalizeSource(value));
  const brandTerms = matches.map((match) => ({
    sourceNorm: normalizeSource(match.term?.source || match.matchPhrase || ""),
    targets: [match.term?.target, ...(Array.isArray(match.term?.aliases) ? match.term.aliases : [])].filter(Boolean).map(normalizeSource)
  }));
  const srcNorm = normalizeSource(src);
  const tgtNorm = normalizeSource(tgt);

  // 品牌名/专名：原文拉丁词要么原样出现在译文中，要么译文中出现了其术语库登记译法。
  // 只把含大写字母或数字的词当专名，避免把中文文案里夹带的英文虚词（to/of/for）误报。
  const properNoun = (word) => /[A-Z]/u.test(word) || /\d/u.test(word);
  for (const word of [...new Set((src.match(LATIN_WORD) || []))].filter(properNoun)) {
    const normalized = normalizeSource(word);
    if (tgtNorm.includes(normalized)) continue;
    const related = brandTerms.filter((term) => term.sourceNorm && (term.sourceNorm.includes(normalized) || normalized.includes(term.sourceNorm)));
    const covered = related.some((term) => term.targets.some((target) => target && tgtNorm.includes(target)));
    if (!covered) {
      issues.push({ severity: "warning", type: "basic_brand_missing", category: "basic", message: `品牌名/专名「${word}」未出现在译文中，请确认是否误译或遗漏` });
    }
  }

  // 译文新增原文没有的拉丁词（常见缩写白名单与纯小写虚词除外）
  for (const word of new Set((tgt.match(LATIN_WORD) || []))) {
    if (LATIN_ALLOWLIST.has(word.toLowerCase())) continue;
    if (!properNoun(word) && word.length <= 4) continue;
    const normalized = normalizeSource(word);
    if (srcNorm.includes(normalized)) continue;
    if (termTargets.some((term) => term.includes(normalized))) continue;
    issues.push({ severity: "warning", type: "basic_added_latin", category: "basic", message: `译文出现了原文没有的拉丁词「${word}」，请确认为专名保留还是多余增译` });
  }

  // 连续重复字符（拟声拟态词可能误报，故为警告）
  const repeatRun = tgt.match(/([\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af])\1{2,}/u);
  if (repeatRun) {
    issues.push({ severity: "warning", type: "basic_repeated_char", category: "basic", message: `译文出现连续重复字符「${repeatRun[0]}」，疑似拼写错误（拟声拟态词除外）` });
  }

  // 相邻重复的二字假名/谚文词
  const duplicateWord = tgt.match(/([\u3040-\u30ff\uac00-\ud7af]{2})\1/u);
  if (duplicateWord) {
    issues.push({ severity: "warning", type: "basic_duplicate_word", category: "basic", message: `译文出现重复词「${duplicateWord[0]}」，请确认是否误写` });
  }

  // 配对标点平衡
  for (const [open, close, label] of QUOTE_PAIRS) {
    const opens = (tgt.match(new RegExp(escapeRegExp(open), "g")) || []).length;
    const closes = (tgt.match(new RegExp(escapeRegExp(close), "g")) || []).length;
    if (opens !== closes) {
      issues.push({ severity: "warning", type: "basic_unbalanced_quote", category: "basic", message: `译文${label}数量不平衡（左 ${opens} / 右 ${closes}），请检查是否漏了配对标点` });
    }
  }

  // 空白异常
  if (/\s\s+/u.test(tgt) || /^\s|\s$/u.test(tgt)) {
    issues.push({ severity: "warning", type: "basic_whitespace", category: "basic", message: "译文含连续空格或首尾空白，请清理" });
  }

  // 句末语气弱化：原文感叹/疑问，译文以句号或省略号收尾
  const srcTail = src.trim();
  const tone = /[！!]$/u.test(srcTail) ? "!" : /[？?]$/u.test(srcTail) ? "?" : "";
  if (tone) {
    const tgtTail = tgt.trim();
    const keptTone = tone === "!" ? /[！!]$/u.test(tgtTail) : /[？?]$/u.test(tgtTail);
    const softened = /[。…〜~]/u.test(tgtTail);
    if (!keptTone && softened) {
      issues.push({
        severity: "warning",
        type: "basic_tone",
        category: "basic",
        message: `原文以${tone === "!" ? "感叹" : "疑问"}结尾，译文以句号/省略号收尾，语气可能被弱化，请确认`
      });
    }
  }

  return issues;
}

/** 单条问题的扣分：error/critical 35，major 12，minor/warning 3；低置信模型问题不计分。 */
export function issuePenalty(issue) {
  if (issue.confidence !== undefined && Number(issue.confidence) < 0.55) return 0;
  if (issue.severity === "error" || issue.severity === "critical") return 35;
  if (issue.severity === "major") return 12;
  return 3;
}

/**
 * 三层打分：每个维度独立计分并套用阻断封顶，
 * 综合分 = 基本 20% + 语义忠实性 50% + nuance 30%（忠实性为着重项）。
 */
export function calculateAutoQaScores(issues = []) {
  const dimensions = {};
  for (const dimension of AUTO_QA_DIMENSIONS) {
    const list = issues.filter((issue) => (issue.dimension || "basic") === dimension);
    let score = Math.max(0, 100 - list.reduce((sum, issue) => sum + issuePenalty(issue), 0));
    if (list.some((issue) => issue.severity === "error")) score = Math.min(score, 60);
    if (list.some((issue) => issue.severity === "critical" && (issue.confidence === undefined || Number(issue.confidence) >= 0.7))) {
      score = Math.min(score, 65);
    }
    dimensions[dimension] = Math.round(score);
  }
  const overall = Math.round(dimensions.basic * 0.2 + dimensions.fidelity * 0.5 + dimensions.nuance * 0.3);
  return { overall, dimensions };
}

export function groupIssuesByDimension(issues = []) {
  const grouped = { basic: [], fidelity: [], nuance: [] };
  for (const issue of issues) {
    grouped[issue.dimension || "basic"].push(issue);
  }
  return grouped;
}

export function summarizeIssues(issues = []) {
  const grouped = groupIssuesByDimension(issues);
  const summary = {};
  for (const dimension of AUTO_QA_DIMENSIONS) {
    const list = grouped[dimension];
    summary[dimension] = {
      total: list.length,
      error: list.filter((issue) => issue.severity === "error" || issue.severity === "critical").length,
      major: list.filter((issue) => issue.severity === "major").length,
      minor: list.filter((issue) => issue.severity !== "error" && issue.severity !== "critical" && issue.severity !== "major").length
    };
  }
  return summary;
}
