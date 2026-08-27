/**
 * Workbench tuning parameters.
 *
 * These knobs used to live as constants in source files or as environment
 * variables with no UI: the style distillation threshold, the QA pass score,
 * the Auto QA dimension weights, the per-locale title brackets. Changing any of
 * them meant editing code and restarting, which in practice meant nobody
 * changed them and the defaults silently became policy.
 *
 * Everything here is validated the same way model-proposed strategy patches are
 * (`strategy-patch.mjs`): unknown keys dropped, values clamped to a documented
 * range, no way to persist a combination that puts the pipeline in an invalid
 * state. A settings panel that can brick retrieval or disable a safety gate is
 * worse than no panel.
 *
 * Deliberately NOT exposed, because changing them breaks a guarantee rather
 * than tuning behaviour:
 *   - clean-room isolation similarity (loosening it re-admits gold leakage into
 *     evaluations, which is the defect the whole benchmark exists to prevent)
 *   - local embedding dimensions (invalidates every vector already stored)
 *   - sentence alignment costs (internal to the DP aligner, not a policy)
 *   - upload/segment hard caps (protect the process, not a preference)
 *   - store mode and Directus credentials (startup-time, and secrets)
 *
 * Pure module: no store, provider or clock dependency.
 */

import { LOCALES } from "./config.mjs";

/** 每项都写明区间与含义，界面直接用这份定义渲染，避免说明和校验各写一遍。 */
export const SETTING_SPECS = Object.freeze({
  "quality.qaPassScore": { min: 60, max: 100, step: 1, default: 90, label: "AIQA 通过分", hint: "低于此分自动进入最小修订重审" },
  "quality.maxRevisionAttempts": { min: 0, max: 4, step: 1, default: 2, label: "最大修订轮数", hint: "0 表示不自动修订，只报告问题" },
  "quality.weightBasic": { min: 0, max: 100, step: 5, default: 20, label: "Auto QA 基本检查权重", hint: "三项权重之和必须为 100" },
  "quality.weightFidelity": { min: 0, max: 100, step: 5, default: 50, label: "Auto QA 语义忠实性权重", hint: "着重检查项，建议保持最高" },
  "quality.weightNuance": { min: 0, max: 100, step: 5, default: 30, label: "Auto QA nuance 权重", hint: "语气、敬语级别与风格一致性" },
  "quality.penaltyCritical": { min: 10, max: 100, step: 5, default: 35, label: "critical 扣分", hint: "事实层面的丢失或捏造" },
  "quality.penaltyMajor": { min: 1, max: 50, step: 1, default: 12, label: "major 扣分", hint: "语义范围有出入但信息点仍在" },
  "quality.penaltyMinor": { min: 1, max: 20, step: 1, default: 3, label: "minor 扣分", hint: "措辞偏好" },

  "retrieval.translationMemoryLimit": { min: 1, max: 20, step: 1, default: 5, label: "参考译例条数", hint: "每次翻译注入的相似译例上限" },
  "retrieval.qaCaseLimit": { min: 1, max: 20, step: 1, default: 3, label: "QA 反例条数", hint: "注入的历史问题译文上限" },
  "retrieval.previousSegments": { min: 0, max: 6, step: 1, default: 2, label: "上文段数", hint: "批次翻译携带的前置上下文" },
  "retrieval.nextSegments": { min: 0, max: 4, step: 1, default: 1, label: "下文段数", hint: "批次翻译携带的后续上下文" },

  "learning.styleDistillThreshold": { min: 3, max: 100, step: 1, default: 8, label: "风格蒸馏阈值", hint: "同作用域证据攒够多少条才蒸馏风格草稿" },
  "learning.styleDistillGrowthWindow": { min: 1, max: 100, step: 1, default: 8, label: "风格蒸馏增长窗口", hint: "上次蒸馏后需再新增多少条，防止草稿泛滥" },
  "learning.translatorProfileThreshold": { min: 3, max: 100, step: 1, default: 3, label: "译者画像阈值", hint: "人工采纳证据攒够多少条才蒸馏画像" },
  "learning.autoProposeThreshold": { min: 3, max: 200, step: 1, default: 10, label: "自动提议候选阈值", hint: "人工终稿达到多少条自动生成 challenger" },
  "learning.autoProposeGrowthWindow": { min: 1, max: 200, step: 1, default: 10, label: "自动提议增长窗口", hint: "上次提议后需再新增多少条" },
  "learning.styleEvaluationMinSamples": { min: 5, max: 200, step: 1, default: 12, label: "风格评测最小样本", hint: "留出集不足这么多条时拒绝开始评测" },
  "learning.skillEvaluationMinSamples": { min: 5, max: 200, step: 1, default: 20, label: "技能评测最小样本", hint: "少于此数的评测结论不允许晋升" },
  "learning.distillPositiveSamples": { min: 10, max: 200, step: 5, default: 50, label: "蒸馏取样：正例条数", hint: "每轮喂给模型的双语证据上限；50 条约 3k 字符，200 条约 13k，上限不是上下文而是注意力稀释" },
  "learning.distillNegativeSamples": { min: 0, max: 60, step: 5, default: 15, label: "蒸馏取样：反例条数", hint: "同事否决但尚未改写的译文上限" },
  "learning.ruleStaleRounds": { min: 2, max: 20, step: 1, default: 4, label: "规则退休轮数", hint: "连续多少轮蒸馏没被证据确认才退休。设小了退回滚动重写，设大了过时规则赖着不走" },

  "learning.conflictScanIntervalMinutes": { min: 0, max: 1440, step: 15, default: 0, label: "规则冲突定时扫描（分钟）", hint: "0 表示只在蒸馏沉淀后扫描，不定时。每次扫描最多送 12 对规则给模型" },

  "share.glossLimit": { min: 5, max: 200, step: 5, default: 30, label: "分享页语素拆解上限", hint: "每个分享链接后台生成的逐句拆解段数" }
});

/** 作品名括号是风格约定而非语言对错，按语种单独配置。空串表示该语种不做约定检查。 */
export const TITLE_BRACKET_CHOICES = Object.freeze(["", "《》", "「」", "『』", "〈〉", "«»"]);

const TITLE_BRACKET_DEFAULTS = Object.freeze({
  "ja-JP": "『』",
  "ko-KR": "《》",
  "zh-Hant-TW": "《》",
  "fr-FR": "«»",
  "th-TH": ""
});

function pathValue(target, path) {
  return path.split(".").reduce((carry, key) => (carry == null ? undefined : carry[key]), target);
}

function assignPath(target, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((carry, key) => {
    if (!carry[key] || typeof carry[key] !== "object") carry[key] = {};
    return carry[key];
  }, target);
  parent[last] = value;
}

export function defaultSettings() {
  const settings = {};
  for (const [path, spec] of Object.entries(SETTING_SPECS)) assignPath(settings, path, spec.default);
  settings.orthography = { titleBrackets: { ...TITLE_BRACKET_DEFAULTS } };
  return settings;
}

function clampNumber(value, spec) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number)) return { value: spec.default, note: "数值无效，已回落默认值" };
  const stepped = spec.step >= 1 ? Math.round(number) : number;
  const clamped = Math.min(spec.max, Math.max(spec.min, stepped));
  return clamped === stepped ? { value: clamped } : { value: clamped, note: `超出 ${spec.min}~${spec.max}，已夹紧到 ${clamped}` };
}

/**
 * Normalize an arbitrary settings object into a valid one.
 *
 * Returns the sanitized settings plus a per-field list of what was corrected,
 * so the panel can tell the user "this was clamped" instead of silently
 * changing what they typed.
 */
export function sanitizeSettings(input = {}) {
  const settings = defaultSettings();
  const notes = [];

  for (const [path, spec] of Object.entries(SETTING_SPECS)) {
    const raw = pathValue(input, path);
    if (raw === undefined || raw === null || raw === "") continue;
    const { value, note } = clampNumber(raw, spec);
    assignPath(settings, path, value);
    if (note) notes.push({ path, label: spec.label, note });
  }

  // Auto QA 综合分是三维加权平均，权重不归一就等于悄悄改变了满分刻度。
  const weights = ["quality.weightBasic", "quality.weightFidelity", "quality.weightNuance"];
  const total = weights.reduce((sum, path) => sum + pathValue(settings, path), 0);
  if (total !== 100) {
    for (const path of weights) assignPath(settings, path, SETTING_SPECS[path].default);
    notes.push({ path: "quality.weights", label: "Auto QA 三维权重", note: `三项之和为 ${total}，必须等于 100，已整组回落默认 20/50/30` });
  }

  // 增长窗口大于阈值会让第二次蒸馏永远等不到，属于把功能配死。
  for (const [thresholdPath, windowPath, label] of [
    ["learning.styleDistillThreshold", "learning.styleDistillGrowthWindow", "风格蒸馏"],
    ["learning.autoProposeThreshold", "learning.autoProposeGrowthWindow", "自动提议"]
  ]) {
    const threshold = pathValue(settings, thresholdPath);
    const window = pathValue(settings, windowPath);
    if (window > threshold) {
      assignPath(settings, windowPath, threshold);
      notes.push({ path: windowPath, label: `${label}增长窗口`, note: `不应大于阈值 ${threshold}，已收敛到阈值` });
    }
  }

  const brackets = { ...TITLE_BRACKET_DEFAULTS };
  const requested = input?.orthography?.titleBrackets;
  if (requested && typeof requested === "object") {
    for (const locale of Object.keys(LOCALES)) {
      const value = String(requested[locale] ?? "").trim();
      if (!TITLE_BRACKET_CHOICES.includes(value)) {
        if (requested[locale] !== undefined) {
          notes.push({ path: `orthography.titleBrackets.${locale}`, label: `${locale} 作品名括号`, note: "不是受支持的括号对，已回落默认" });
        }
        continue;
      }
      brackets[locale] = value;
    }
  }
  settings.orthography = { titleBrackets: brackets };

  return { settings, notes };
}

/** 界面渲染用：按分组吐出规格，避免前端再抄一份字段表。 */
export function settingGroups() {
  const groups = new Map();
  for (const [path, spec] of Object.entries(SETTING_SPECS)) {
    const [group] = path.split(".");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ path, ...spec });
  }
  return [...groups.entries()].map(([group, fields]) => ({ group, fields }));
}
