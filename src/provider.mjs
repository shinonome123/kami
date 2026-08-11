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
  if (context.segmentIndex && context.segmentCount) lines.push(`位置：第 ${context.segmentIndex} / ${context.segmentCount} 段`);
  if (context.previous) lines.push(`上文：${context.previous}`);
  if (context.next) lines.push(`下文：${context.next}`);
  if (context.note) lines.push(`补充：${context.note}`);
  return lines.join("\n") || "无";
}

function packPrompt(contextPack) {
  return `你是专业的亚洲语言游戏本地化译者。请严格从简体中文翻译到 ${contextPack.targetLanguage}。\n\n` +
    `内容类型：${contextPack.contentTypeLabel}\n` +
    `语体要求：${contextPack.register}\n` +
    `翻译风格：${contextPack.styleProfile?.name || contextPack.contentTypeLabel} · ${contextPack.styleProfile?.instruction || contextPack.register}\n` +
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
    source: candidate.source,
    target: candidate.target,
    ruleScore: candidate.score,
    ruleReasons: candidate.reasons
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是游戏本地化术语库清洗员，审核简体中文到${language}的候选对照。只保留专名、系统名、功能名、道具名、角色名、地点名、技能名及稳定复用短语；排除完整句子、说明文、数字、占位符、网址、错列和明显误译。不要改写文本。输出严格 JSON：{"decisions":[{"index":0,"keep":true,"confidence":0.9,"reason":"简短理由"}]}`
    },
    { role: "user", content: JSON.stringify(compactCandidates) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语清洗模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.decisions)) throw new Error("术语清洗模型返回格式无效");
  return payload.decisions;
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
