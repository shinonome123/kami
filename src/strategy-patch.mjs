/**
 * Strategy patch sanitization for model-proposed skill patches.
 *
 * The proposal model's JSON is untrusted input: unknown keys, wrong types and
 * prompt-injection payloads must never reach the production translation prompt.
 * Every value is whitelisted, typed, clamped and length-limited; dropped or
 * altered fields produce warnings that are recorded on the candidate skill.
 *
 * Pure module: never mutates inputs, no store/provider/clock dependencies.
 */

export const STRATEGY_PATCH_LIMITS = Object.freeze({
  includePreviousSegments: Object.freeze({ min: 0, max: 6 }),
  includeNextSegments: Object.freeze({ min: 0, max: 4 }),
  retrievalLimit: Object.freeze({ min: 1, max: 20 }),
  minimumScore: Object.freeze({ min: 70, max: 100 }),
  maximumRevisionAttempts: Object.freeze({ min: 0, max: 4 }),
  additionalRulesMax: 12,
  additionalRuleMaxLength: 300,
  additionalInstructionMaxLength: 600
});

// Prompt-injection signatures that must never enter the production prompt.
const INJECTION_PATTERNS = Object.freeze([
  /(?:忽略|无视|忘记|废止|绕过)(?:以上|之前|先前)?\s*(?:所有|全部|下述|以下|一切)?\s*(?:的)?\s*(?:规则|指令|要求|约束|限制|提示)/iu,
  /ignore\s*(?:all\s*)?(?:previous|prior|above|the\s+above)?\s*instructions?/i,
  /disregard\s*(?:all\s*)?(?:previous|prior|above)?\s*instructions?/i,
  /you\s+are\s+now\s+(?:an?|the)\s+/i,
  /system\s*:/iu,
  /<\|im_start\|>|<\|im_end\|>/i,
  /输出(?:全部|所有)?(?:密钥|token|提示词|系统消息)/iu,
  /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function warn(warnings, path, reason) {
  warnings.push({ path, reason });
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(number) ? number : null;
}

function sanitizeBoundedNumber(value, { min, max, integer = false }, path, warnings) {
  const number = finiteNumber(value);
  if (number === null) {
    warn(warnings, path, "数值无效，已丢弃");
    return null;
  }
  const clamped = Math.min(max, Math.max(min, number));
  if (clamped !== number) warn(warnings, path, `数值越界，已夹紧到 ${clamped}`);
  return integer ? Math.trunc(clamped) : clamped;
}

function sanitizeBoolean(value, path, warnings) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  warn(warnings, path, "布尔值无效，已丢弃");
  return null;
}

function stripControl(text, { allowNewlines = false } = {}) {
  const withoutControl = String(text ?? "").replace(allowNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu : /[\u0000-\u001F\u007F]/gu, "");
  return allowNewlines ? withoutControl.replace(/\n{3,}/gu, "\n\n").trim() : withoutControl.trim();
}

function hasInjectionSignature(text) {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeAdditionalInstruction(value, warnings) {
  const path = "prompting.additionalInstruction";
  const text = stripControl(value, { allowNewlines: true }).slice(0, STRATEGY_PATCH_LIMITS.additionalInstructionMaxLength);
  if (!text) {
    if (String(value ?? "").trim()) warn(warnings, path, "指令为空或仅含控制字符，已丢弃");
    return { instruction: undefined, warning: null };
  }
  if (hasInjectionSignature(text)) {
    warn(warnings, path, "检测到疑似注入指令，已整条丢弃");
    return { instruction: undefined, warning: "疑似注入指令已丢弃" };
  }
  if (text.length !== String(value ?? "").trim().length) warn(warnings, path, `指令超长，已截断到 ${STRATEGY_PATCH_LIMITS.additionalInstructionMaxLength} 字符`);
  return { instruction: text, warning: null };
}

function sanitizeAdditionalRules(value, warnings) {
  const path = "prompting.additionalRules";
  if (value === undefined || value === null) return { rules: undefined };
  if (!Array.isArray(value)) {
    warn(warnings, path, "additionalRules 必须是数组，已丢弃");
    return { rules: undefined };
  }
  const rules = [];
  for (const item of value.slice(0, STRATEGY_PATCH_LIMITS.additionalRulesMax + 20)) {
    if (rules.length >= STRATEGY_PATCH_LIMITS.additionalRulesMax) break;
    if (typeof item !== "string" && typeof item !== "number") {
      warn(warnings, path, "规则条目不是文本，已丢弃");
      continue;
    }
    const rule = stripControl(item, { allowNewlines: false }).slice(0, STRATEGY_PATCH_LIMITS.additionalRuleMaxLength);
    if (!rule) continue;
    if (hasInjectionSignature(rule)) {
      warn(warnings, path, "规则疑似注入指令，已丢弃");
      continue;
    }
    rules.push(rule);
  }
  if (value.length > STRATEGY_PATCH_LIMITS.additionalRulesMax) {
    warn(warnings, path, `规则数量超过 ${STRATEGY_PATCH_LIMITS.additionalRulesMax} 条，已截断`);
  }
  return { rules };
}

function sanitizeRetrievalItem(value, name, path, warnings) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    warn(warnings, path, `${name} 必须是对象，已丢弃`);
    return undefined;
  }
  const output = {};
  for (const key of Object.keys(value)) {
    if (key === "enabled") {
      const enabled = sanitizeBoolean(value.enabled, `${path}.enabled`, warnings);
      if (enabled !== null) output.enabled = enabled;
    } else if (key === "limit") {
      const limit = sanitizeBoundedNumber(value.limit, STRATEGY_PATCH_LIMITS.retrievalLimit, `${path}.limit`, warnings);
      if (limit !== null) output.limit = limit;
    } else {
      warn(warnings, `${path}.${key}`, `${name} 不支持字段 ${key}，已丢弃`);
    }
  }
  return Object.keys(output).length ? output : undefined;
}

/**
 * Whitelist, type-check, clamp and sanitize a model-proposed strategy patch.
 * Returns a fresh object; the input is never mutated.
 */
export function sanitizeStrategyPatch(patch) {
  const warnings = [];
  if (!isPlainObject(patch)) return { patch: {}, warnings: [{ path: "strategyPatch", reason: "策略补丁必须是对象，已整体丢弃" }] };
  const output = {};

  for (const [section, value] of Object.entries(patch)) {
    if (section === "context") {
      if (!isPlainObject(value)) { warn(warnings, section, "context 必须是对象，已丢弃"); continue; }
      const context = {};
      for (const key of Object.keys(value)) {
        if (key === "includePreviousSegments" || key === "includeNextSegments") {
          const limits = STRATEGY_PATCH_LIMITS[key];
          const number = sanitizeBoundedNumber(value[key], { ...limits, integer: true }, `${section}.${key}`, warnings);
          if (number !== null) context[key] = number;
        } else if (key === "includeDocumentMetadata") {
          const flag = sanitizeBoolean(value[key], `${section}.${key}`, warnings);
          if (flag !== null) context[key] = flag;
        } else {
          warn(warnings, `${section}.${key}`, `context 不支持字段 ${key}，已丢弃`);
        }
      }
      if (Object.keys(context).length) output.context = context;
      continue;
    }

    if (section === "retrieval") {
      if (!isPlainObject(value)) { warn(warnings, section, "retrieval 必须是对象，已丢弃"); continue; }
      const retrieval = {};
      for (const key of Object.keys(value)) {
        if (["requiredTerms", "translationMemory", "qaCases", "styleProfile"].includes(key)) {
          const item = sanitizeRetrievalItem(value[key], key, `retrieval.${key}`, warnings);
          if (item) retrieval[key] = item;
        } else {
          warn(warnings, `retrieval.${key}`, `retrieval 不支持字段 ${key}，已丢弃`);
        }
      }
      if (Object.keys(retrieval).length) output.retrieval = retrieval;
      continue;
    }

    if (section === "prompting") {
      if (!isPlainObject(value)) { warn(warnings, section, "prompting 必须是对象，已丢弃"); continue; }
      const prompting = {};
      for (const key of Object.keys(value)) {
        if (key === "additionalInstruction" || key === "additionalRules") continue; // 由专用净化函数处理
        if (["preserveMeaningBeforeFluency", "useNeighborContext", "useApprovedAssetsOnly"].includes(key)) {
          const flag = sanitizeBoolean(value[key], `${section}.${key}`, warnings);
          if (flag !== null) prompting[key] = flag;
        } else {
          warn(warnings, `${section}.${key}`, `prompting 不支持字段 ${key}，已丢弃`);
        }
      }
      const instruction = sanitizeAdditionalInstruction(value.additionalInstruction, warnings);
      if (instruction.instruction !== undefined) prompting.additionalInstruction = instruction.instruction;
      const rules = sanitizeAdditionalRules(value.additionalRules, warnings);
      if (rules.rules !== undefined) prompting.additionalRules = rules.rules;
      if (Object.keys(prompting).length) output.prompting = prompting;
      continue;
    }

    if (section === "qa") {
      if (!isPlainObject(value)) { warn(warnings, section, "qa 必须是对象，已丢弃"); continue; }
      const qa = {};
      for (const key of Object.keys(value)) {
        if (key === "enabled" || key === "blockOnHardError") {
          const flag = sanitizeBoolean(value[key], `${section}.${key}`, warnings);
          if (flag !== null) qa[key] = flag;
        } else if (key === "minimumScore") {
          const score = sanitizeBoundedNumber(value[key], STRATEGY_PATCH_LIMITS.minimumScore, `${section}.${key}`, warnings);
          if (score !== null) qa[key] = score;
        } else if (key === "maximumRevisionAttempts") {
          const attempts = sanitizeBoundedNumber(value[key], { ...STRATEGY_PATCH_LIMITS.maximumRevisionAttempts, integer: true }, `${section}.${key}`, warnings);
          if (attempts !== null) qa[key] = attempts;
        } else {
          warn(warnings, `${section}.${key}`, `qa 不支持字段 ${key}，已丢弃`);
        }
      }
      if (Object.keys(qa).length) output.qa = qa;
      continue;
    }

    warn(warnings, section, `策略补丁不支持区块 ${section}，已丢弃`);
  }

  return { patch: output, warnings };
}
