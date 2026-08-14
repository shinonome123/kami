import { loadProviderConfig, saveProviderConfig } from "./provider-store.mjs";
import { CONTENT_TYPES, LOCALES } from "./config.mjs";

const loadedProvider = loadProviderConfig();
let persistence = loadedProvider.persistence;
let runtimeConfig = {
  baseUrl: process.env.LLM_BASE_URL || loadedProvider.config.baseUrl || "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY || loadedProvider.config.apiKey || "",
  model: process.env.LLM_MODEL || loadedProvider.config.model || "qwen3:14b",
  embeddingModel: process.env.LLM_EMBEDDING_MODEL || loadedProvider.config.embeddingModel || "",
  embeddingBaseUrl: process.env.LLM_EMBEDDING_BASE_URL || loadedProvider.config.embeddingBaseUrl || "",
  embeddingApiKey: process.env.LLM_EMBEDDING_API_KEY || loadedProvider.config.embeddingApiKey || "",
  inputPricePerMTok: process.env.LLM_INPUT_PRICE_PER_MTOK ?? loadedProvider.config.inputPricePerMTok ?? "",
  outputPricePerMTok: process.env.LLM_OUTPUT_PRICE_PER_MTOK ?? loadedProvider.config.outputPricePerMTok ?? ""
};

export function getProviderConfig() {
  return {
    ...runtimeConfig,
    apiKeyConfigured: Boolean(runtimeConfig.apiKey),
    apiKey: undefined,
    embeddingApiKeyConfigured: Boolean(runtimeConfig.embeddingApiKey),
    embeddingApiKey: undefined,
    persistence
  };
}

export function updateProviderConfig(input = {}) {
  const submittedApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const submittedEmbeddingApiKey = typeof input.embeddingApiKey === "string" ? input.embeddingApiKey.trim() : "";
  const nextConfig = {
    baseUrl: String(input.baseUrl || runtimeConfig.baseUrl).replace(/\/$/, ""),
    apiKey: input.clearApiKey === true ? "" : (submittedApiKey || runtimeConfig.apiKey),
    model: String(input.model || runtimeConfig.model),
    embeddingModel: Object.hasOwn(input, "embeddingModel") ? String(input.embeddingModel || "").trim() : runtimeConfig.embeddingModel,
    embeddingBaseUrl: Object.hasOwn(input, "embeddingBaseUrl") ? String(input.embeddingBaseUrl || "").replace(/\/$/, "") : runtimeConfig.embeddingBaseUrl,
    embeddingApiKey: input.clearEmbeddingApiKey === true ? "" : (submittedEmbeddingApiKey || runtimeConfig.embeddingApiKey),
    inputPricePerMTok: Object.hasOwn(input, "inputPricePerMTok") ? String(input.inputPricePerMTok ?? "").trim() : runtimeConfig.inputPricePerMTok,
    outputPricePerMTok: Object.hasOwn(input, "outputPricePerMTok") ? String(input.outputPricePerMTok ?? "").trim() : runtimeConfig.outputPricePerMTok
  };
  if (input.persist !== false) persistence = saveProviderConfig(nextConfig);
  runtimeConfig = nextConfig;
  return getProviderConfig();
}

function finitePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

/** True when both input and output prices are configured, so real cost gating can engage. */
export function costPricingConfigured(config = runtimeConfig) {
  return finitePrice(config.inputPricePerMTok) !== null && finitePrice(config.outputPricePerMTok) !== null;
}

/**
 * Estimate USD cost from normalized usage and per-million-token prices.
 * Returns null when usage or pricing is unavailable — cost is then "unmeasured",
 * never faked as zero.
 */
export function estimateUsageCost(usage, config = runtimeConfig) {
  const inputPrice = finitePrice(config.inputPricePerMTok);
  const outputPrice = finitePrice(config.outputPricePerMTok);
  const promptTokens = Number(usage?.promptTokens);
  const completionTokens = Number(usage?.completionTokens);
  if (inputPrice === null || outputPrice === null) return null;
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || promptTokens < 0 || completionTokens < 0) return null;
  return (promptTokens / 1_000_000) * inputPrice + (completionTokens / 1_000_000) * outputPrice;
}

/** Accumulator for per-operation usage collection across several model calls. */
export function createUsageCollector() {
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  return {
    onUsage: (usage) => {
      if (!usage) return;
      const prompt = Number(usage.promptTokens);
      const completion = Number(usage.completionTokens);
      if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return;
      promptTokens += prompt;
      completionTokens += completion;
      calls += 1;
    },
    snapshot() {
      return calls ? { promptTokens, completionTokens, calls } : null;
    }
  };
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
  const translationSkill = contextPack.translationSkill;
  const rhymeHint = contextPack.rhymeLike
    ? "⚠️ 本条原文带有顺口溜/韵文结构（短句对仗 + 长句收尾，可能押韵）：必须用目标语言自然重现节奏与押韵，可以调整语序、换用拟态词、谚语与地道说法，严禁机械逐字重复原文的字数结构。\n"
    : "";
  const batchVerseHint = contextPack.batchVerse?.active
    ? `⚠️ 本批为排比韵文：所有行共用「${contextPack.batchVerse.shape}」句式（短句 + 长句）。每一行都必须使用同一句式、节奏、语体与韵脚风格；如果本批已有定稿译文，后续各行必须严格仿照其句式与用词。\n`
    : "";
  const batchReferenceHint = contextPack.batchReferences?.length
    ? `本批已定稿译文（必须保持句式与风格完全一致，可参考其用词与语气）：${JSON.stringify(contextPack.batchReferences)}\n`
    : "";
  const localeExamples = LOCALES[contextPack.targetLocale]?.localizationExamples || [];
  const exampleHint = localeExamples.length
    ? `本地化示范（左：原文 → 直译，右：合格的地道译法。请达到右侧的水平）：\n${localeExamples.map((item) => `· ${item.source} → ${item.literal} ✗ / ${item.idiomatic} ✓（${item.note}）`).join("\n")}\n`
    : "";
  return `你是资深游戏本地化写手。你的任务不是逐字翻译，而是把简体中文文案用 ${contextPack.targetLanguage} 玩家最自然的方式重新表达：先读懂这句话在游戏场景里的意图、情绪与角色，再用目标语言母语者会用的说法写出来。只改变表达方式，不改变信息。\n\n` +
    `内容类型：${contextPack.contentTypeLabel}\n` +
    `语体要求：${contextPack.register}\n` +
    `翻译风格：${contextPack.styleProfile?.name || contextPack.contentTypeLabel} · 版本 ${contextPack.styleProfile?.version || 1} · ${contextPack.styleProfile?.instruction || contextPack.register}\n` +
    `风格正反例：${JSON.stringify(contextPack.styleProfile?.examples || [])}\n` +
    `翻译技能：${translationSkill ? `${translationSkill.name} · v${translationSkill.version} · ${translationSkill.instruction || "沿用当前稳定流程"}` : "默认稳定流程"}\n` +
    `技能增量规则：${JSON.stringify(translationSkill?.additionalRules || [])}\n` +
    `译者长期偏好画像（跨语体全局习惯，版本 ${contextPack.userProfile?.version || "无"}）：${contextPack.userProfile ? JSON.stringify({ instruction: contextPack.userProfile.instruction, examples: contextPack.userProfile.examples }) : "无"}\n` +
    `历史译例（同语言、相似度与人工可信度排序）：${JSON.stringify(contextPack.translationReferences || [])}\n` +
    `历史 AIQA 反例与修订：${JSON.stringify(contextPack.qaGuidance || [])}\n` +
    batchVerseHint +
    batchReferenceHint +
    exampleHint +
    `目标语言要求：${contextPack.localeInstruction}\n` +
    `领域：${contextPack.domain}\n` +
    `文档上下文（仅用于理解，不得翻译进结果）：\n${formatNeighborContext(contextPack.neighborContext)}\n\n` +
    `强制术语：${JSON.stringify(contextPack.requiredTerms, null, 2)}\n` +
    `参考术语：${JSON.stringify(contextPack.preferredTerms, null, 2)}\n` +
    `必须原样保留：${JSON.stringify(contextPack.protectedTokens)}\n\n` +
    `规则：\n1. 不得使用其他目标语言的表达。\n2. 信息保真：数字、日期、名称、占位符、强制术语和事实必须完整保留；除此之外，语序、句式、用词、修辞都可以自由改写为地道说法——换一种地道表达不等于漏译或增译。\n3. 强制术语必须逐字采用指定目标译法。\n4. 上下文只用于消歧和保持连贯，不得把上文或下文混入译文。\n5. 标有 contextualFallback 或 contentType 不同的历史译例只用于稳定术语与基础表达，不得覆盖当前语体要求。\n6. 拒绝翻译腔：成语、习语、重复、语气词、客套话一律换成目标语言中语义与语气对等的自然说法；译文读起来必须像目标语言原生文案，而不是中文的逐字影子。\n7. 原文含押韵、对仗、重复或口号结构时，必须在目标语言中重现节奏与韵律，允许换用地道表达；语气要与原句一致（如闲散自嘲不得译成命令口吻）。\n8. 只翻译“当前原文”，只输出译文，不解释。\n\n${rhymeHint}当前原文：\n${contextPack.source}`;
}

/**
 * Fetch with full-lifecycle timeout safety.
 *
 * AbortSignal.timeout covers the ENTIRE request, including body reads. A
 * timeout can therefore fire while reading the response body — outside the
 * initial fetch() call — and must be converted to a labeled error here,
 * otherwise a raw DOMException escapes to the user as "The operation was
 * aborted due to timeout". Optional retries only apply to timeouts.
 */
export async function fetchWithTimeout(url, init = {}, { timeoutMs = 30_000, label = "请求", retries = 0, retryDelayMs = 300 } = {}) {
  const attempts = Math.max(1, Math.trunc(retries) + 1);
  const timeoutText = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
  const timeoutMessage = `${label}请求超时（${timeoutText}）`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.name !== "AbortError") throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(timeoutMessage);
    }
    let text = null;
    try {
      text = response.status === 204 ? null : await response.text();
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.name !== "AbortError") throw error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(timeoutMessage);
    }
    return { response, text };
  }
  throw new Error(timeoutMessage);
}

async function chat(messages, config = runtimeConfig, options = {}) {
  const normalizedOptions = typeof options === "number" ? { temperature: options } : options;
  const temperature = normalizedOptions.temperature ?? 0.25;
  const timeoutMs = normalizedOptions.timeoutMs ?? 60_000;
  const requestLabel = normalizedOptions.requestLabel || "模型";
  const { response, text } = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature,
      ...(normalizedOptions.maxTokens ? { max_tokens: normalizedOptions.maxTokens } : {}),
      ...(normalizedOptions.responseFormat ? { response_format: normalizedOptions.responseFormat } : {})
    })
  }, { timeoutMs, label: requestLabel, retries: 1 });
  if (!response.ok) {
    throw new Error(`模型请求失败 (${response.status})：${(text || "").slice(0, 500)}`);
  }
  const payload = JSON.parse(text || "{}");
  if (typeof normalizedOptions.onUsage === "function") {
    const usage = payload.usage
      ? { promptTokens: Number(payload.usage.prompt_tokens) || 0, completionTokens: Number(payload.usage.completion_tokens) || 0 }
      : (Number.isFinite(payload.prompt_eval_count) || Number.isFinite(payload.eval_count))
        ? { promptTokens: Number(payload.prompt_eval_count) || 0, completionTokens: Number(payload.eval_count) || 0 }
        : null;
    if (usage) normalizedOptions.onUsage(usage);
  }
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

export function isEmbeddingConfigured() {
  return Boolean(runtimeConfig.embeddingModel);
}

export async function embed(text, { model: modelOverride, timeoutMs = 30_000 } = {}) {
  const model = modelOverride || runtimeConfig.embeddingModel;
  if (!model) throw new Error("未配置 embedding 模型，向量检索保持禁用");
  const baseUrl = runtimeConfig.embeddingBaseUrl || runtimeConfig.baseUrl;
  const apiKey = runtimeConfig.embeddingApiKey || runtimeConfig.apiKey;
  const { response, text: responseText } = await fetchWithTimeout(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ model, input: String(text).slice(0, 16_000) })
  }, { timeoutMs, label: "embedding" });
  if (!response.ok) {
    throw new Error(`embedding 请求失败 (${response.status})：${(responseText || "").slice(0, 500)}`);
  }
  const payload = JSON.parse(responseText || "{}");
  let vector = payload.data?.[0]?.embedding ?? payload.embedding;
  if (!Array.isArray(vector) || !vector.length || !vector.every((value) => Number.isFinite(value))) {
    throw new Error("embedding 响应缺少有效向量");
  }
  vector = vector.map(Number);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error("embedding 返回零向量");
  return { vector: vector.map((value) => value / norm), model, dimensions: vector.length };
}

export async function reviewTermCandidatesWithModel(locale, candidates) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactCandidates = candidates.slice(0, 160).map((candidate, index) => ({
    index,
    candidateKey: candidate.candidateKey || "",
    sheet: candidate.sheet || "",
    sheetMode: candidate.sheetMode || "mixed",
    rowNumber: candidate.rowNumber || null,
    assetType: candidate.assetType,
    source: candidate.source,
    target: candidate.target,
    contentTypeHint: candidate.contentType || "general",
    domainHint: candidate.domain || "general",
    enforcementHint: candidate.enforcement || "preferred",
    ruleScore: candidate.score,
    ruleReasons: candidate.reasons
  }));
  const content = await chat([
    {
      role: "system",
      content: `你是游戏本地化资产清洗员。用户只负责上传文件，你必须逐条完成资产归类，不要求用户设置任何参数。审核简体中文到${language}的候选对照。每一个输入 index 都必须且只能返回一次 decision，不能遗漏。

rowKind 只能为 term 或 memory。sheetMode=dialogue 时整行必须保持 memory；不得因为译文长短或目标语言不同将同一句中文改成 term。term 是独立词条中的专名、系统名、功能名、道具名、角色名、地点名、技能名；memory 是语义对齐的台词、句子、UI 文本或完整文案。memory 的 contentType 必须从 ${Object.keys(CONTENT_TYPES).join(", ")} 中选择，term 固定 general。domain 只能为 game、marketing、community、general。

对 keep=true 且 rowKind=memory 的完整句段，同时检查句内术语，放入 nestedTerms，不得用 nestedTerms 替换父 memory。nestedTerms.category 只能是 proper_name、character_name、place_name、item_name、skill_name、system_name、organization_name、species_name、currency_name、lore_concept、fixed_ui_label。必须是专名、官方命名或能稳定复用的固定标签；严禁抽取代词、动词/形容词短语、普通搭配、礼貌套话、一次性修辞和整分句。nestedTerms.source 必须逐字存在于 source，target 必须逐字存在于 target；不得补译、改写或猜测目标词。专名和官方命名 enforcement=required，其他固定标签 preferred。

排除数字、网址、DDL、字符限制、位置说明、语种要求、错列、元数据和明显误译。不要改写父 source 或 target。输出严格 JSON：{"decisions":[{"index":0,"keep":true,"confidence":0.95,"rowKind":"memory","contentType":"dialogue","domain":"game","enforcement":"preferred","reason":"完整对白且语义对齐","nestedTerms":[{"source":"孙悟空","target":"孫悟空","category":"character_name","enforcement":"required","confidence":0.98,"reason":"角色专名"}]}]}`
    },
    { role: "user", content: JSON.stringify(compactCandidates) }
  ], runtimeConfig, {
    temperature: 0,
    timeoutMs: 90_000,
    maxTokens: 8_000,
    requestLabel: "术语与译例清洗",
    responseFormat: { type: "json_object" }
  });
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("术语清洗模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!Array.isArray(payload.decisions)) throw new Error("术语清洗模型返回格式无效");
  const validIndexes = new Set();
  const duplicateIndexes = [];
  for (const decision of payload.decisions) {
    const index = Number(decision?.index);
    if (!Number.isInteger(index) || index < 0 || index >= compactCandidates.length) continue;
    if (validIndexes.has(index)) duplicateIndexes.push(index);
    validIndexes.add(index);
  }
  const missing = compactCandidates.map((_, index) => index).filter((index) => !validIndexes.has(index));
  if (missing.length || duplicateIndexes.length) {
    throw new Error(`术语清洗模型返回不完整：已覆盖 ${validIndexes.size}/${compactCandidates.length} 条${missing.length ? `，缺少 index ${missing.slice(0, 12).join(",")}` : ""}${duplicateIndexes.length ? `，重复 index ${duplicateIndexes.slice(0, 12).join(",")}` : ""}`);
  }
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

不要把位置、描述、DDL、字符限制、语种要求、序号或日期列当成中外文对照。headerRow 只有确实存在列名行时才填写，否则必须为 null。还要只根据工作表名称、表头和中文源列整体分布判断 sheetMode：dialogue=对白/字幕/剧情句段为主，glossary=独立命名词条为主，mixed=两类明显混合。目标语言译文长度不得影响 sheetMode。输出严格 JSON，不要 Markdown：{"sheets":[{"sheet":"原工作表名","headerRow":null,"sourceColumn":1,"targetColumns":{"ja-JP":2},"sheetMode":"dialogue","confidence":0.9,"reason":"简短依据"}]}`
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

export async function distillBatchStyleLearningWithModel({ batchId, filename, locale, contentType, domain, examples = [] }) {
  const language = LOCALE_NAMES[locale] || locale;
  const evidence = examples.slice(0, 40).map((item) => ({
    source: String(item?.source || "").trim(),
    target: String(item?.target || "").trim(),
    rowNumber: Number(item?.rowNumber || item?.sourceRow) || null
  })).filter((item) => item.source && item.target);
  if (!evidence.length) throw new Error("批次风格学习缺少有效中外文证据");
  const messages = [
    {
      role: "system",
      content: `你是${language}游戏本地化风格观察员。请只根据当前这一批已对齐双语句段，说明 AI 从本批“观察到了什么”。这不是已批准的正式风格规范：少量证据只能描述倾向，不能夸大为固定规则。单条证据也可以输出观察，但 caveat 必须明确证据不足，任何 confidence 不得高于 0.65。请归纳语气、句式与节奏、称谓、句尾、标点、信息顺序和长度倾向，并给出可读例子及适用边界。examples 只能逐字引用输入中的真实 source/target，不得改写。输出严格 JSON：{"summary":"本批学习摘要","rules":[{"category":"语气|句式|称谓|句尾|标点|长度|其他","observation":"从证据观察到的现象","guidance":"可供后续审核的建议","confidence":0.8}],"examples":[{"type":"positive","source":"原文","target":"译文","reason":"为何能代表本批风格"}],"caveat":"适用边界","confidence":0.8}`
    },
    { role: "user", content: JSON.stringify({ batchId, filename, locale, contentType, domain, examples: evidence }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0, timeoutMs: 90_000, maxTokens: 3200, requestLabel: "本批风格浓缩", responseFormat: { type: "json_object" } });
  let payload;
  let formatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("未返回 JSON 对象");
      const parsed = JSON.parse(match[0]);
      if (!parsed.summary || !Array.isArray(parsed.rules) || !Array.isArray(parsed.examples)) throw new Error("缺少 summary、rules 或 examples");
      payload = parsed;
      break;
    } catch (error) {
      formatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4_000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请重新输出一个更紧凑的 JSON 对象：最多 6 条 rules、3 条 examples；所有字符串使用合法 JSON 转义；不要 Markdown、代码围栏、注释或尾随逗号。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 2200, requestLabel: "本批风格浓缩格式重试", responseFormat: { type: "json_object" } });
    }
  }
  if (!payload) throw new Error(`本批风格浓缩模型返回格式无效：${formatError || "未知格式错误"}`);
  const confidenceCap = evidence.length === 1 ? 0.65 : 1;
  const evidenceKeys = new Set(evidence.map((item) => `${item.source}\u0000${item.target}`));
  const defaultCaveat = evidence.length === 1
    ? "当前只有一条对齐证据，只能作为本批次观察，尚不能形成正式风格规范。"
    : "当前结论仅代表本批次证据，需结合后续批次与人工审核后再决定是否纳入正式风格规范。";
  return {
    summary: String(payload.summary).trim(),
    rules: payload.rules.slice(0, 12).map((rule) => ({
      category: String(rule.category || "其他").trim(),
      observation: String(rule.observation || "").trim(),
      guidance: String(rule.guidance || "").trim(),
      confidence: Number(Math.min(confidenceCap, Math.max(0, Math.min(1, Number(rule.confidence) || 0))).toFixed(2))
    })).filter((rule) => rule.observation && rule.guidance),
    examples: payload.examples.slice(0, 8).map((item) => ({
      ...(item?.type ? { type: String(item.type) } : {}),
      source: String(item?.source || "").trim(),
      target: String(item?.target || "").trim(),
      reason: String(item?.reason || "支持本批次风格观察").trim()
    })).filter((item) => evidenceKeys.has(`${item.source}\u0000${item.target}`)),
    caveat: String(payload.caveat || defaultCaveat).trim() || defaultCaveat,
    confidence: Number(Math.min(confidenceCap, Math.max(0, Math.min(1, Number(payload.confidence) || 0))).toFixed(2))
  };
}

export async function distillUserProfileWithModel({ locale, examples }) {
  const language = LOCALE_NAMES[locale] || locale;
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化译者画像编辑。请只根据人工采纳的中外文证据，提炼该团队/译者对${language}的全局翻译偏好。只提炼跨语体稳定的习惯：称谓与敬体选择、句尾语气、长度倾向、标点习惯、数字与格式处理、禁用表达，并提供简短正反例。不得把某个语体的临时风格当成全局偏好。输出严格 JSON：{"name":"名称","instructions":"详实规则","examples":[{"type":"positive|negative","source":"原文","target":"译文或反例","reason":"原因"}]}`
    },
    { role: "user", content: JSON.stringify({ locale, examples: examples.slice(0, 30) }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("译者画像模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  if (!payload.instructions || !Array.isArray(payload.examples)) throw new Error("译者画像模型返回格式无效");
  return { name: String(payload.name || `${language} 译者画像`), instruction: String(payload.instructions), examples: payload.examples.slice(0, 8) };
}

export async function reviewEvolutionWithModel({ locale, contentType, domain, qaRuns = [], evidence = [], previousProfile = null }) {
  const language = LOCALE_NAMES[locale] || locale;
  const compactRuns = qaRuns.slice(0, 20).map((run) => ({
    source: run.source,
    initialTranslation: run.initialTranslation,
    finalTranslation: run.finalTranslation,
    score: run.score,
    status: run.status,
    iterations: run.iterations,
    issues: (run.issues || []).slice(0, 6)
  }));
  const compactEvidence = evidence.slice(0, 20).map((item) => ({ source: item.source, target: item.target, provenance: item.provenance }));
  const content = await chat([
    {
      role: "system",
      content: `你是${language}游戏本地化演进复盘员。复盘最近的翻译轨迹与人工采纳证据，判断：(1) 是否存在反复出现的同类风格/术语问题（trend）；(2) 现有风格规范是否需要增量补充（stylePatch，只输出补充规则，不要重写全文）；(3) 人工采纳证据与现有规范是否有冲突。没有发现就不输出对应字段。输出严格 JSON：{"stylePatch":null|{"instructions":"增量规则","examples":[{"type":"positive|negative","source":"原文","target":"译文或反例","reason":"原因"}]},"trend":[{"category":"风格|术语|准确性|格式","observation":"简短说明","count":3}],"reason":"复盘结论"}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, previousProfile, qaRuns: compactRuns, evidence: compactEvidence }) }
  ]);
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("演进复盘模型未返回 JSON");
  const payload = JSON.parse(match[0]);
  return {
    stylePatch: payload.stylePatch && payload.stylePatch.instructions ? { instruction: String(payload.stylePatch.instructions), examples: Array.isArray(payload.stylePatch.examples) ? payload.stylePatch.examples.slice(0, 8) : [] } : null,
    trend: Array.isArray(payload.trend) ? payload.trend.slice(0, 8).map((item) => ({ category: String(item.category || "其他"), observation: String(item.observation || ""), count: Number(item.count) || 1 })) : [],
    reason: String(payload.reason || "")
  };
}

export async function proposeTranslationSkillWithModel({ locale, contentType, domain, project = "default", champion, trajectories = [] }) {
  const compact = trajectories.slice(0, 40).map((item) => ({
    id: item.id,
    source: item.source,
    initialTranslation: item.initialTranslation,
    finalTranslation: item.finalTranslation,
    qaBefore: item.qaBefore,
    qaAfter: item.qaAfter,
    humanDecision: item.humanDecision,
    error: item.error || ""
  }));
  if (!compact.length) throw new Error("尚无可用于生成候选技能的翻译轨迹");
  const messages = [
    {
      role: "system",
      content: `你是本地化翻译流程改进员。你要根据同一目标语言、语体、领域和项目的真实执行轨迹，只提出一份保守、可评测的“候选翻译技能补丁”。不得更改目标语言或把其他语种规则混入；不得发明轨迹中不存在的问题；术语译法仍由术语库负责，不要把个别术语硬编码进技能。重点分析反复出现的准确性、语体、上下文、检索和 QA 修订模式。输出严格 JSON：{"name":"候选技能名","reason":"为什么提出该补丁","strategyPatch":{"prompting":{"additionalInstruction":"整体执行指导","additionalRules":["可执行规则"]},"retrieval":{"translationMemory":{"limit":5},"qaCases":{"limit":3}},"qa":{"minimumScore":90,"maximumRevisionAttempts":2},"context":{"includePreviousSegments":2,"includeNextSegments":1}},"evidenceIds":["轨迹ID"]}`
    },
    { role: "user", content: JSON.stringify({ locale, contentType, domain, project, champion, trajectories: compact }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0.1, timeoutMs: 90_000, maxTokens: 2200, requestLabel: "翻译技能复盘", responseFormat: { type: "json_object" } });
  let payload;
  let formatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("未返回 JSON 对象");
      const parsed = JSON.parse(match[0]);
      if (!parsed.strategyPatch || typeof parsed.strategyPatch !== "object") throw new Error("缺少 strategyPatch");
      payload = parsed;
      break;
    } catch (error) {
      formatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4_000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，必须包含 name、reason、strategyPatch、evidenceIds；不要 Markdown、代码围栏、思考过程、注释或尾随逗号。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "翻译技能复盘格式重试", responseFormat: { type: "json_object" } });
    }
  }
  if (!payload) throw new Error(`翻译技能复盘模型返回格式无效：${formatError || "未知格式错误"}`);
  const validIds = new Set(compact.map((item) => item.id));
  return {
    name: String(payload.name || `${LOCALE_NAMES[locale] || locale} ${contentType} 候选技能`).slice(0, 120),
    reason: String(payload.reason || "根据近期翻译轨迹提出的增量改进").slice(0, 2_000),
    strategyPatch: payload.strategyPatch,
    evidenceIds: [...new Set((Array.isArray(payload.evidenceIds) ? payload.evidenceIds : []).filter((id) => validIds.has(id)))].slice(0, 100)
  };
}

export async function evaluateTranslationWithModel({ contextPack, translation, references = [], qaCases = [], onUsage = null }) {
  const messages = [
    {
      role: "system",
      content: `你是独立于翻译器的亚洲语言本地化 QA 审校员。按照 MQM 思路逐项检查准确性、漏译/增译、术语、语体、流畅度、本地自然度、一致性、格式、约束、韵律与重复、翻译腔。数据库译例只是证据，不能盲从；只有同语种、同语体且语义相关时才引用。不要直接给总分，只报告可定位的问题。严重度只能是 critical、major、minor。特别注意：只有语义确实丢失或凭空添加事实才算漏译/增译；调整语序、换用同义地道表达、重写修辞都不是问题。发现译文逐字直译、翻译腔、不像目标语言原生文案时，记 major（category 用 naturalness）。原文含押韵、对仗、重复或口号结构时，译文必须用目标语言自然重现节奏与韵律；机械逐字重复、把闲散语气译成命令口吻、韵律完全丢失都应记 major。若输入里的 contextPack 携带 batchVerse 或 batchReferences（同批排比韵文），必须检查当前译文与本批已定稿译文的句式、节奏与用词风格是否一致，明显不一致记 major。没有问题返回空数组。输出严格 JSON：{"issues":[{"severity":"major","category":"accuracy","sourceSpan":"原文片段","targetSpan":"译文片段","message":"问题原因","suggestion":"可执行修订意见","evidenceMemoryId":"可选ID","confidence":0.9}]}`
    },
    { role: "user", content: JSON.stringify({ contextPack, translation, references: references.slice(0, 5), qaCases: qaCases.slice(0, 3) }) }
  ];
  let content = await chat(messages, runtimeConfig, { temperature: 0.1, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "AIQA", responseFormat: { type: "json_object" }, onUsage });
  let payload;
  let lastFormatError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      payload = parseAiQaResponse(content);
      break;
    } catch (error) {
      lastFormatError = error.message;
      if (attempt === 1) break;
      content = await chat([
        ...messages,
        { role: "assistant", content: content.slice(0, 4000) },
        { role: "user", content: "上一个回答不是可解析的严格 JSON。请只重新输出一个紧凑 JSON 对象，根字段必须是 issues 数组，不要 Markdown、解释或代码围栏。" }
      ], runtimeConfig, { temperature: 0, timeoutMs: 45_000, maxTokens: 1800, requestLabel: "AIQA 格式重试", responseFormat: { type: "json_object" }, onUsage });
    }
  }
  if (!payload) {
    const lineContent = await chat([
      {
        role: "system",
        content: "你是本地化 QA。不要输出 JSON。若没有问题只输出 PASS；若有问题，每个问题单独一行，严格使用：ISSUE|critical/major/minor|类别|原文片段|译文片段|问题原因|修订建议。不得输出其他内容。"
      },
      { role: "user", content: JSON.stringify({ contextPack, translation, references: references.slice(0, 3), qaCases: qaCases.slice(0, 2) }) }
    ], runtimeConfig, { temperature: 0, timeoutMs: 60_000, maxTokens: 1600, requestLabel: "AIQA 行式降级", onUsage });
    try {
      payload = { issues: parseAiQaLineResponse(lineContent) };
    } catch (error) {
      throw new Error(`AIQA 返回无法解析（JSON：${lastFormatError || "未知"}；行式：${error.message}）`);
    }
  }
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

function noIssueResponse(content) {
  const trimmed = String(content || "").trim();
  if (/^(?:PASS|OK|无问题|問題なし|問題ありません)[。.!！\s]*$/iu.test(trimmed)) return true;
  return trimmed.length <= 240 && /(?:未发现|没有发现|不存在).{0,12}(?:明显|实质性|需要修订的)?问题|无需(?:进行)?修改|符合(?:全部)?要求|問題は(?:見つかり|あり)ません/iu.test(trimmed);
}

export function parseAiQaResponse(content) {
  const trimmed = String(content || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return { issues: [] };
  const candidates = [trimmed];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { issues: parsed };
      if (Array.isArray(parsed?.issues)) return parsed;
    } catch {}
  }
  throw new Error("缺少有效 issues JSON");
}

export function parseAiQaLineResponse(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("模型返回空内容");
  if (noIssueResponse(trimmed)) return [];
  const issues = trimmed.split(/\r?\n/u).map((line) => line.trim().replace(/^[-*•\d.)、\s]+/u, "")).filter((line) => /^ISSUE\s*[|｜]/iu.test(line)).map((line) => {
    const [, severity = "major", category = "other", sourceSpan = "", targetSpan = "", message = "", suggestion = ""] = line.split(/[|｜]/u).map((item) => item.trim());
    return { severity, category, sourceSpan, targetSpan, message, suggestion, confidence: 0.8 };
  }).filter((issue) => issue.message);
  if (issues.length) return issues;
  return [{
    severity: "major",
    category: "unstructured_review",
    sourceSpan: "",
    targetSpan: "",
    message: trimmed.slice(0, 800),
    suggestion: "根据该审校意见进行修订，并再次执行 QA。",
    confidence: 0.65
  }];
}

export async function reviseTranslationWithQa({ contextPack, translation, issues, references = [], qaCases = [], onUsage = null }) {
  return chat([
    { role: "system", content: "你是最终修订译者。只修复 QA 明确指出的问题，保留正确内容、数字、格式、占位符、强制术语和原有信息边界；若问题涉及表达不地道，就用更地道的说法改写，不要退回逐字直译；若原文带韵律结构（contextPack.rhymeLike 为 true），修订必须同时重现节奏与押韵。只输出完整修订译文，不要解释。" },
    { role: "user", content: JSON.stringify({ contextPack, currentTranslation: translation, issues, references: references.slice(0, 5), qaCases: qaCases.slice(0, 3) }) }
  ], runtimeConfig, { temperature: 0.15, timeoutMs: 75_000, requestLabel: "AIQA 修订", onUsage });
}

export async function adjudicatePotentialTermsWithModel({ contextPack, translation, issues, onUsage = null }) {
  const candidates = issues.slice(0, 12).map((issue) => ({
    matchedSource: issue.matchedSource || "",
    officialSource: issue.sourceTerm || "",
    officialTarget: issue.targetTerm || "",
    currentTranslation: translation
  }));
  const content = await chat([
    {
      role: "system",
      content: "你是游戏本地化术语裁决译者。逐项判断当前原文中的疑似表达是否与术语库正式源词表示同一概念。若是，必须在完整译文中自然地采用 officialTarget；若不是，不得强行替换。保留全部事实、格式、数字和其他正确内容。reason 必须使用简体中文，便于中文项目成员审核。输出严格 JSON：{\"translation\":\"裁决后的完整译文\",\"decisions\":[{\"officialSource\":\"正式源词\",\"matchedSource\":\"当前表达\",\"officialTarget\":\"正式译法\",\"decision\":\"apply|not_applicable\",\"reason\":\"简体中文简短理由\"}]}"
    },
    { role: "user", content: JSON.stringify({ contextPack, currentTranslation: translation, candidates }) }
  ], runtimeConfig, { temperature: 0.05, timeoutMs: 75_000, maxTokens: 1800, requestLabel: "术语自动裁决", responseFormat: { type: "json_object" }, onUsage });
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("术语裁决模型未返回 JSON");
  const payload = JSON.parse(content.slice(start, end + 1));
  if (!String(payload.translation || "").trim() || !Array.isArray(payload.decisions)) throw new Error("术语裁决模型返回格式无效");
  return {
    translation: String(payload.translation).trim(),
    decisions: payload.decisions.slice(0, candidates.length).map((decision) => ({
      officialSource: String(decision.officialSource || ""),
      matchedSource: String(decision.matchedSource || ""),
      officialTarget: String(decision.officialTarget || ""),
      decision: decision.decision === "not_applicable" ? "not_applicable" : "apply",
      reason: String(decision.reason || "模型未补充理由")
    }))
  };
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

export async function translateWithReflection(contextPack, { reflect = true, onUsage = null } = {}) {
  const rhymeLike = contextPack?.rhymeLike === true;
  const batchVerse = contextPack?.batchVerse?.active === true;
  // 温度：普通文本 0.6 给地道表达留空间，韵文/批排比 0.85 给节奏与韵脚再创作。
  const initial = await chat([{ role: "user", content: packPrompt(contextPack) }], runtimeConfig, { timeoutMs: 75_000, requestLabel: "翻译", temperature: rhymeLike || batchVerse ? 0.85 : 0.6, onUsage });
  if (!reflect && !rhymeLike) return { initial, translation: initial, reflection: "" };
  if (rhymeLike) {
    // 韵文本地化专用通道：初译只作参考，要求模型以目标语言玩家视角再创作，
    // 而不是修补字对字直译。
    const localized = await chat([
      { role: "system", content: "你是游戏文案韵文本地化师。把简体中文顺口溜/韵文改写为目标语言地道的押韵短句：保留原意与情绪（自嘲、洒脱、吆喝等），重现节奏、叠词与韵脚，允许换用拟态词、惯用句和谚语；严禁机械逐字直译，严禁把闲散语气译成命令口吻。只输出一行最终译文，不解释。\n\n改写示范（达到这个质量才算合格）：\n原文：走走走，游游游，甘为铜钱做马牛。\n译文：とことこ歩いて、ぶらぶら遊んで、銭のためなら馬にも牛にも。" },
      { role: "user", content: `原文：${contextPack.source}\n参考技巧：中文三字重复可译为日语叠词/拟态词（とことこ、ぶらぶら等），尾韵可用同一语尾（〜て、〜で、〜う）呼应。不要参考任何现成译文，直接从原文创作。` }
    ], runtimeConfig, { temperature: 0.85, timeoutMs: 75_000, requestLabel: "韵文本地化", onUsage });
    return { initial, translation: localized, reflection: "rhyme-localized" };
  }
  const reflection = await chat([
    { role: "system", content: "你是严格的双语本地化审校。只指出漏译、误译、术语、事实、语体、翻译腔和韵律/重复结构丢失问题（原文押韵、对仗或口号式重复时，译文须自然重现节奏与语气）；若上下文带有同批已定稿译文，还要检查句式与风格是否保持一致；没有问题则回答 PASS。" },
    { role: "user", content: `上下文要求：${JSON.stringify(contextPack)}\n\n初译：\n${initial}` }
  ], runtimeConfig, { temperature: 0.35, timeoutMs: 60_000, requestLabel: "翻译自检", onUsage });
  if (/^PASS[。.!]?$/i.test(reflection)) return { initial, translation: initial, reflection };
  const translation = await chat([
    { role: "system", content: "你是最终修订译者。根据审校意见做最小必要修改，严格保留事实、格式和指定术语。只输出最终译文。" },
    { role: "user", content: `上下文要求：${JSON.stringify(contextPack)}\n\n初译：${initial}\n\n审校意见：${reflection}` }
  ], runtimeConfig, { temperature: 0.15, timeoutMs: 75_000, requestLabel: "翻译修订", onUsage });
  return { initial, translation, reflection };
}
