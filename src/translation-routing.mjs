export const TRANSLATION_ROUTES = Object.freeze({
  direct: { label: "直接翻译", description: "低风险短文本，单次生成后进入确定性 QA。" },
  reflective: { label: "翻译 + 自检", description: "常规文本，初译后进行独立自检和最小修订。" },
  fact_guarded: { label: "事实保护", description: "事实密集内容，使用高质量模型并加强数字、日期、平台和地区约束。" },
  transcreation: { label: "创译候选", description: "宣发和社媒内容生成多个自然候选，再由模型择优并进入 QA。" },
  mt_post_edit: { label: "机器初译 + LLM 后编辑", description: "先用快速模型生成底稿，再由高质量模型按资产与事实约束后编辑。" },
  multi_candidate: { label: "多候选", description: "生成多个候选供人工选择，同时保留系统推荐。" }
});

const RISK_ORDER = Object.freeze(["low", "medium", "high", "critical"]);
const FACT_GUARDED_TYPES = new Set(["announcement", "store", "rules", "tutorial"]);
const CREATIVE_TYPES = new Set(["marketing", "social"]);
const CONTEXT_HEAVY_TYPES = new Set(["dialogue", "narrative", "codex", "verse", "item_description"]);
const DIRECT_TYPES = new Set(["item_name", "ui"]);

function factCount(facts) {
  if (Number.isFinite(Number(facts?.count))) return Number(facts.count);
  const groups = facts?.groups || facts || {};
  return Object.values(groups).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function metadataRisk(metadata = []) {
  const text = (Array.isArray(metadata) ? metadata : []).map((item) => `${item?.label || ""} ${item?.value || ""}`).join(" ");
  return /DDL|截止|上线|下线|地区|区域|平台|折扣|价格|字数|字符|受众|法务|合规|禁用/i.test(text) ? 1 : 0;
}

export function assessTranslationRisk({ source = "", contentType = "general", facts = null, metadata = [], protectedTokens = [] } = {}) {
  const reasons = [];
  let points = 0;
  const normalizedSource = String(source || "");
  const count = factCount(facts);
  if (FACT_GUARDED_TYPES.has(contentType)) {
    points += 2;
    reasons.push("当前语体包含较高的事实或发布风险");
  } else if (CREATIVE_TYPES.has(contentType) || CONTEXT_HEAVY_TYPES.has(contentType)) {
    points += 1;
    reasons.push("当前语体对自然度、语气或上下文一致性要求较高");
  }
  if (count >= 6) {
    points += 3;
    reasons.push(`识别到 ${count} 个事实锚点`);
  } else if (count >= 2) {
    points += 2;
    reasons.push(`识别到 ${count} 个事实锚点`);
  } else if (count === 1) {
    points += 1;
    reasons.push("识别到 1 个事实锚点");
  }
  const protectedCount = Array.isArray(protectedTokens) ? protectedTokens.length : 0;
  if (protectedCount >= 3) {
    points += 2;
    reasons.push(`包含 ${protectedCount} 个必须原样保留的标记`);
  } else if (protectedCount) {
    points += 1;
    reasons.push("包含必须原样保留的标记");
  }
  const metadataPoints = metadataRisk(metadata);
  if (metadataPoints) {
    points += metadataPoints;
    reasons.push("任务补充信息中存在交付或业务约束");
  }
  if (normalizedSource.length > 1200) {
    points += 2;
    reasons.push("单元文本较长");
  } else if (normalizedSource.length > 350) {
    points += 1;
    reasons.push("单元文本包含较多信息");
  }
  if (/\b(?:必须|严禁|不得|仅限|截止|最终解释权)\b|务必|法律|合规|赔偿|退款/.test(normalizedSource)) {
    points += 2;
    reasons.push("原文含强约束或承诺表达");
  }
  const tier = points >= 7 ? "critical" : points >= 4 ? "high" : points >= 2 ? "medium" : "low";
  return { tier, points, reasons: reasons.length ? reasons : ["短文本且未发现明显事实风险"], factCount: count, protectedTokenCount: protectedCount };
}

function normalizeManualRoute(value) {
  const route = String(value || "auto").trim();
  return route !== "auto" && Object.hasOwn(TRANSLATION_ROUTES, route) ? route : "";
}

export function selectTranslationRoute({ source = "", contentType = "general", risk = null, manualRoute = "auto", provider = {}, candidateCount = null } = {}) {
  const resolvedRisk = risk || assessTranslationRisk({ source, contentType });
  let route = normalizeManualRoute(manualRoute);
  const manual = Boolean(route);
  if (!route) {
    if (CREATIVE_TYPES.has(contentType)) route = "transcreation";
    else if (FACT_GUARDED_TYPES.has(contentType) || ["high", "critical"].includes(resolvedRisk.tier)) route = "fact_guarded";
    else if (DIRECT_TYPES.has(contentType) && resolvedRisk.tier === "low" && String(source).length <= 80) route = "direct";
    else route = "reflective";
  }
  const requestedCandidates = Number.isFinite(Number(candidateCount)) ? Math.trunc(Number(candidateCount)) : null;
  const candidates = Math.min(3, Math.max(1, requestedCandidates || (["transcreation", "multi_candidate"].includes(route) ? 3 : 1)));
  const fastModel = String(provider.fastModel || "").trim();
  const qualityModel = String(provider.qualityModel || "").trim();
  const mainModel = String(provider.model || "").trim();
  const mtModel = String(provider.mtModel || "").trim();
  let modelRole = "main";
  let model = mainModel;
  if (route === "mt_post_edit" && mtModel) {
    modelRole = "mt";
    model = mtModel;
  } else if (["fact_guarded", "transcreation", "multi_candidate"].includes(route) || ["high", "critical"].includes(resolvedRisk.tier)) {
    modelRole = qualityModel ? "quality" : "main";
    model = qualityModel || mainModel;
  } else if (route === "direct" && fastModel) {
    modelRole = "fast";
    model = fastModel;
  }
  return {
    route,
    label: TRANSLATION_ROUTES[route].label,
    description: TRANSLATION_ROUTES[route].description,
    manual,
    candidateCount: candidates,
    model,
    modelRole,
    modelFallback: modelRole === "main" && ((route === "direct" && !fastModel) || (["fact_guarded", "transcreation", "multi_candidate"].includes(route) && !qualityModel)),
    risk: resolvedRisk
  };
}

export function qualityThresholdForRisk(riskTier = "medium") {
  return { low: 88, medium: 90, high: 93, critical: 96 }[riskTier] || 90;
}

export function decideQualityRoute({ qaScore = null, hardErrorCount = 0, riskTier = "medium", hasQualityUpgrade = false, alreadyEscalated = false, aiQaUsed = true } = {}) {
  const threshold = qualityThresholdForRisk(riskTier);
  if (!aiQaUsed || !Number.isFinite(Number(qaScore))) {
    return { decision: "human_review", threshold, reason: "AIQA 未完成，不能自动放行" };
  }
  if (Number(hardErrorCount) > 0) {
    if (hasQualityUpgrade && !alreadyEscalated) return { decision: "escalate_model", threshold, reason: `存在 ${hardErrorCount} 个阻断问题，先升级模型修订` };
    return { decision: "human_review", threshold, reason: `仍存在 ${hardErrorCount} 个阻断问题` };
  }
  if (Number(qaScore) >= threshold && riskTier === "critical") {
    return { decision: "human_review", threshold, reason: `质量分 ${qaScore} 达标，但关键发布风险内容仍需人工确认` };
  }
  if (Number(qaScore) >= threshold) return { decision: "auto_pass", threshold, reason: `质量分 ${qaScore} 达到 ${riskTier} 风险门槛 ${threshold}` };
  if (hasQualityUpgrade && !alreadyEscalated) return { decision: "escalate_model", threshold, reason: `质量分 ${qaScore} 未达到门槛 ${threshold}，升级模型重试` };
  return { decision: "human_review", threshold, reason: `质量分 ${qaScore} 未达到门槛 ${threshold}` };
}

export function compareRiskTier(left, right) {
  return RISK_ORDER.indexOf(left) - RISK_ORDER.indexOf(right);
}
