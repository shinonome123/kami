import { loadProviderConfig, saveProviderConfig } from "./provider-store.mjs";

const loadedProvider = loadProviderConfig();
let persistence = loadedProvider.persistence;
let runtimeConfig = {
  baseUrl: process.env.LLM_BASE_URL || loadedProvider.config.baseUrl || "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY || loadedProvider.config.apiKey || "",
  model: process.env.LLM_MODEL || loadedProvider.config.model || "qwen3:14b"
};

export function getProviderConfig() {
  return { ...runtimeConfig, apiKeyConfigured: Boolean(runtimeConfig.apiKey), apiKey: undefined, persistence };
}

export function updateProviderConfig(input = {}) {
  const submittedApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const nextConfig = {
    baseUrl: String(input.baseUrl || runtimeConfig.baseUrl).replace(/\/$/, ""),
    apiKey: input.clearApiKey === true ? "" : (submittedApiKey || runtimeConfig.apiKey),
    model: String(input.model || runtimeConfig.model)
  };
  if (input.persist !== false) persistence = saveProviderConfig(nextConfig);
  runtimeConfig = nextConfig;
  return getProviderConfig();
}

function formatNeighborContext(context = {}) {
  if (typeof context === "string") return context || "无";
  const lines = [];
  if (context.document) lines.push(`文档：${context.document}`);
  if (context.sheet) lines.push(`工作表：${context.sheet}${context.row ? ` · 第 ${context.row} 行` : ""}${context.sourceColumn ? ` · 正文列：${context.sourceColumn}` : ""}`);
  if (context.segmentIndex && context.segmentCount) lines.push(`位置：第 ${context.segmentIndex} / ${context.segmentCount} 段`);
  if (context.previous) lines.push(`上文：${context.previous}`);
  if (context.next) lines.push(`下文：${context.next}`);
  if (Array.isArray(context.metadata) && context.metadata.length) {
    lines.push("该行补充信息与约束（只用于理解和执行要求，不得作为正文翻译）：");
    for (const item of context.metadata) lines.push(`- [${item.role === "constraint" ? "约束" : "上下文"}] ${item.label}：${item.value}`);
  }
  if (Array.isArray(context.referenceTranslations) && context.referenceTranslations.length) {
    lines.push("该行已有参考译文（仅供语义参考，不得直接当作当前目标语言答案）：");
    for (const item of context.referenceTranslations) lines.push(`- ${item.label}：${item.value}`);
  }
  if (context.note) lines.push(`补充：${context.note}`);
  return lines.join("\n") || "无";
}

function packPrompt(contextPack) {
  return `你是专业的亚洲语言游戏本地化译者。请严格从简体中文翻译到 ${contextPack.targetLanguage}。\n\n` +
    `内容类型：${contextPack.contentTypeLabel}\n` +
    `语体要求：${contextPack.register}\n` +
    `翻译风格：${contextPack.styleProfile?.name || contextPack.contentTypeLabel} · 版本 ${contextPack.styleProfile?.version || 1} · ${contextPack.styleProfile?.instruction || contextPack.register}\n` +
    `风格正反例：${JSON.stringify(contextPack.styleProfile?.examples || [])}\n` +
    `历史 AIQA 反例与修订：${JSON.stringify(contextPack.qaGuidance || [])}\n` +
    `目标语言要求：${contextPack.localeInstruction}\n` +
    `领域：${contextPack.domain}\n` +
    `文档上下文（仅用于理解，不得翻译进结果）：\n${formatNeighborContext(contextPack.neighborContext)}\n\n` +
    `强制术语：${JSON.stringify(contextPack.requiredTerms, null, 2)}\n` +
    `参考术语：${JSON.stringify(contextPack.preferredTerms, null, 2)}\n` +
    `必须原样保留：${JSON.stringify(contextPack.protectedTokens)}\n\n` +
    `规则：\n1. 不得使用其他目标语言的表达。\n2. 不漏译、不增译、不改变数值与事实。\n3. 强制术语必须逐字采用指定目标译法。\n4. 上下文只用于消歧和保持连贯，不得把上文或下文混入译文。\n5. 只翻译“当前原文”，只输出译文，不解释。\n\n当前原文：\n${contextPack.source}`;
}

async function chat(messages, config = runtimeConfig) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.25 }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败 (${response.status})：${detail.slice(0, 500)}`);
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

export async function reviewTermCandidatesWithModel(locale, candidates) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactCandidates = candidates.slice(0, 160).map((candidate, index) => ({
    index,
    assetType: candidate.assetType,
    source: candidate.source,
    target: candidate.target,
    ruleScore: candidate.score,
    ruleReasons: candidate.reasons
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是游戏本地化资产清洗员，审核简体中文到${language}的候选对照。assetType=term 时只保留专名、系统名、功能名、道具名、角色名、地点名、技能名及稳定复用短语；assetType=memory 时保留语义对齐的完整中外文句段，用于翻译记忆和风格证据。两类都必须排除数字、网址、错列、元数据和明显误译。不要改写文本。输出严格 JSON：{"decisions":[{"index":0,"keep":true,"confidence":0.9,"reason":"简短理由"}]}`
    },
    { role: "user", content: JSON.stringify(compactCandidates) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语清洗模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.decisions)) throw new Error("术语清洗模型返回格式无效");
  return payload.decisions;
}

export async function analyzeTermTableStructureWithModel(snapshot, requestedLocale) {
  const allowedLocales = requestedLocale ? [requestedLocale] : Object.keys(LOCALE_NAMES);
  const compactSnapshot = {
    requestedLocale: requestedLocale || "auto",
    allowedLocales,
    sheets: snapshot.sheets.map((sheet) => ({
      sheet: sheet.sheet,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      rows: sheet.rows.slice(0, 45)
    }))
  };
  const content = await chat([
    {
      role: "system",
      content: `你是亚洲语言游戏本地化术语表结构分析器。源语言固定为简体中文，允许的目标语言 locale 只有 ${allowedLocales.join(", ")}。你只判断表格结构，绝对不能翻译、改写或补全单元格。

表格可能完全没有表头，也可能前几行是标题、说明或元数据。请根据整列的文字脚本、成对行关系、长度和内容分布，找出一列简体中文源文以及一个或多个目标语言列。纯汉字日文和繁体中文也必须结合对应行语义与整列分布判断，不能因为缺少假名或表头就拒绝。

不要把位置、描述、DDL、字符限制、语种要求、序号或日期列当成中外文对照。headerRow 只有确实存在列名行时才填写，否则必须为 null。输出严格 JSON，不要 Markdown：{"sheets":[{"sheet":"原工作表名","headerRow":null,"sourceColumn":1,"targetColumns":{"ja-JP":2},"confidence":0.9,"reason":"简短依据"}]}`
    },
    { role: "user", content: JSON.stringify(compactSnapshot) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语表结构分析模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.sheets)) throw new Error("术语表结构分析模型返回格式无效");
  return payload;
}

export async function distillStyleProfileWithModel({ locale, contentType, domain, examples, previousProfile = null }) {
  const language = LOCALE_NAMES[locale] || locale;
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化风格资产编辑。请只根据给定的已对齐中外文证据，为“${contentType}”这一种内容语体提炼稳定、可执行的风格规范。不得混入其他语体，不得编造作品设定。规则应覆盖语气、句式、称谓、标点、信息顺序、长度倾向、禁用表达，并提供简短正反例。输出严格 JSON：{"name":"名称","instructions":"详实规则","examples":[{"type":"positive|negative","source":"原文","target":"译文或反例","reason":"原因"}]}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, previousProfile, examples: examples.slice(0, 30) }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("风格精炼模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!payload.instructions || !Array.isArray(payload.examples)) throw new Error("风格精炼模型返回格式无效");
  return { name: String(payload.name || `${language} ${contentType} 风格`), instruction: String(payload.instructions), examples: payload.examples.slice(0, 12) };
}

export async function evaluateTranslationWithModel({ contextPack, translation, references = [], qaCases = [] }) {
  const content = await chat([
    {
      role: "system",
      content: `你是独立于翻译器的亚洲语言本地化 QA 审校员。按照 MQM 思路逐项检查准确性、漏译/增译、术语、语体、流畅度、本地自然度、一致性、格式和约束。数据库译例只是证据，不能盲从；只有同语种、同语体且语义相关时才引用。不要直接给总分，只报告可定位的问题。严重度只能是 critical、major、minor。没有问题返回空数组。输出严格 JSON：{"issues":[{"severity":"major","category":"accuracy","sourceSpan":"原文片段","targetSpan":"译文片段","message":"问题原因","suggestion":"可执行修订意见","evidenceMemoryId":"可选ID","confidence":0.9}]}`
    },
    { role: "user", content: JSON.stringify({ contextPack, translation, references: references.slice(0, 5), qaCases: qaCases.slice(0, 3) }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AIQA 模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.issues)) throw new Error("AIQA 模型返回格式无效");
  return payload.issues.slice(0, 30).map((issue) => ({
    severity: ["critical", "major", "minor"].includes(issue.severity) ? issue.severity : "major",
    category: String(issue.category || "other"),
    sourceSpan: String(issue.sourceSpan || ""),
    targetSpan: String(issue.targetSpan || ""),
    message: String(issue.message || "未说明问题"),
    suggestion: String(issue.suggestion || ""),
    evidenceMemoryId: String(issue.evidenceMemoryId || ""),
    confidence: Math.max(0, Math.min(1, Number(issue.confidence) || 0.5)),
    source: "aiqa"
  }));
}

export async function reviseTranslationWithQa({ contextPack, translation, issues, references = [], qaCases = [] }) {
  return chat([
    { role: "system", content: "你是最终修订译者。只修复 QA 明确指出的问题，保留正确内容、数字、格式、占位符、强制术语和原有信息边界。只输出完整修订译文，不要解释。" },
    { role: "user", content: JSON.stringify({ contextPack, currentTranslation: translation, issues, references: references.slice(0, 5), qaCases: qaCases.slice(0, 3) }) }
  ]);
}

export async function analyzeSpreadsheetStructureWithModel(snapshot, ruleAnalysis, locale) {
  const compactSnapshot = {
    targetLocale: locale,
    sheets: snapshot.sheets.map((sheet) => ({
      sheet: sheet.sheet,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      columns: sheet.columns.map((column) => ({
        column: column.column,
        letter: column.letter,
        nonEmpty: column.nonEmpty,
        averageLength: column.averageLength,
        hanCharacters: column.hanCharacters,
        latinCharacters: column.latinCharacters,
        constraintCells: column.constraintCells,
        sentenceCells: column.sentenceCells,
        samples: column.samples.slice(0, 8)
      })),
      rows: sheet.rows.slice(0, 35)
    })),
    ruleSuggestion: ruleAnalysis.sheets
  };
  const content = await chat([
    {
      role: "system",
      content: `你是本地化项目的 Excel 表格结构分析器。源语言固定为简体中文，目标语言是 ${locale}。你的任务只识别结构，不翻译、不改写任何单元格。

请结合表头、列内样本、文字脚本、文本长度、行列分布和规则建议，为每张表识别表头行及每列角色。即使没有表头也必须根据数据分布推断，不能要求用户添加表头。

列角色只能是：
- source_text：真正需要翻译的简体中文正文、标题、按钮或文案。
- context：位置、渠道、场景、用途、备注等只用于理解的补充信息。
- constraint：DDL、字符限制、语种要求、平台规范等翻译约束。
- existing_translation：英文或其他语言的已有译文/参考译文，不作为中文正文重复翻译。
- ignore：序号、空辅助列或无关数据。

特别注意：含中文不代表需要翻译。诸如“海外社媒”“80字符内”“8月3日”“中英”“游戏内语言”等通常是 context 或 constraint。正文往往是连续文案列，但短标题、按钮也可能是正文，需要结合整列分布判断。一张表允许多个 source_text 列。

输出严格 JSON，不要 Markdown：{"sheets":[{"sheet":"原工作表名","headerRow":1或null,"confidence":0到1,"reason":"简短依据","columns":[{"column":1,"label":"位置","role":"context","confidence":0.95,"reason":"简短依据"}]}]}`
    },
    { role: "user", content: JSON.stringify(compactSnapshot) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("表格结构分析模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.sheets)) throw new Error("表格结构分析模型返回格式无效");
  return payload;
}

export async function alignTermSuggestionsWithModel(locale, translation, candidates) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactCandidates = candidates.map((candidate, index) => ({
    index,
    sourceTerm: candidate.sourceTerm,
    matchedSource: candidate.matchedSource,
    officialTarget: candidate.replacement,
    sourceMatchMode: candidate.matchMode,
    sourceMatchScore: candidate.matchScore
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化术语对齐器。候选中文只是疑似匹配，不一定真是同一术语。请在译文中寻找它当前对应的一个完整、连续、原样子串；只有语义确实对应且置信度至少0.65才返回。不得改写译文，不得返回不存在于译文中的文字。输出严格 JSON：{"suggestions":[{"index":0,"currentText":"译文原样子串","confidence":0.8,"reason":"简短依据"}]}`
    },
    { role: "user", content: JSON.stringify({ translation, candidates: compactCandidates }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语对齐模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.suggestions)) throw new Error("术语对齐模型返回格式无效");
  return payload.suggestions;
}

const LOCALE_NAMES = Object.freeze({
  "ja-JP": "日语",
  "ko-KR": "韩语",
  "zh-Hant-TW": "台湾繁体中文",
  "th-TH": "泰语"
});

export async function classifyWithModel(text) {
  const content = await chat([
    {
      role: "system",
      content: "你是游戏本地化内容分类器。只能从 marketing, announcement, item_name, item_description, ui, rules, dialogue, social, general 中选择一个 contentType。输出严格 JSON：{\"contentType\":\"...\",\"confidence\":0到1,\"evidence\":[\"简短依据\"]}。"
    },
    { role: "user", content: String(text).slice(0, 8000) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("语体分类模型未返回 JSON");
  return { ...JSON.parse(match[0]), source: "model" };
}

export async function translateWithReflection(contextPack, { reflect = true } = {}) {
  const initial = await chat([{ role: "user", content: packPrompt(contextPack) }]);
  if (!reflect) return { initial, translation: initial, reflection: "" };
  const reflection = await chat([
    { role: "system", content: "你是严格的双语本地化审校。只指出漏译、误译、术语、事实、语体和目标语言自然度问题；没有问题则回答 PASS。" },
    { role: "user", content: `上下文要求：${JSON.stringify(contextPack)}\n\n初译：\n${initial}` }
  ]);
  if (/^PASS[。.!]?$/i.test(reflection)) return { initial, translation: initial, reflection };
  const translation = await chat([
    { role: "system", content: "你是最终修订译者。根据审校意见做最小必要修改，严格保留事实、格式和指定术语。只输出最终译文。" },
    { role: "user", content: `上下文要求：${JSON.stringify(contextPack)}\n\n初译：${initial}\n\n审校意见：${reflection}` }
  ]);
  return { initial, translation, reflection };
}
