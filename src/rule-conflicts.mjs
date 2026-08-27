/**
 * Contradiction detection across everything that injects instructions into the
 * translation prompt.
 *
 * Three sources write prose into the same prompt and none of them knew about
 * the others:
 *   - `style_profiles.rules[]`      accumulated from evidence, per 语言×语体×领域
 *   - `translation_skills.strategy.prompting.additionalRules[]`  promoted by
 *     paired evaluation, per 语言×语体×领域×项目
 *   - `user_profiles.instruction`   the global translator profile for a locale
 *
 * Nothing checked whether they agree. A skill could be promoted carrying "句尾
 * 用简体" while the style profile says "句尾统一敬体"; the model just picks one,
 * and the evaluation gate only notices indirectly (edit distance gets worse).
 *
 * Detection is two-stage on purpose. A model asked to scan every pair would be
 * expensive and would hallucinate conflicts between unrelated rules, so a
 * deterministic pass first narrows to pairs that actually talk about the same
 * thing; only those go to the model for adjudication.
 *
 * Pure module: no store, provider or clock dependency.
 */

/** 规则谈论的"方面"。同一方面的两条规则才可能矛盾，不同方面的不必比较。 */
const ASPECT_PATTERNS = Object.freeze([
  ["句尾体裁", /敬体|常体|です・ます|ます形|だ・である|반말|해요체|합니다体|终止形|句尾/u],
  ["敬语级别", /敬语|敬語|尊敬语|謙讓|谦让|높임말|尊称|礼貌级别|vouvoiement|tutoiement/u],
  ["称谓", /称谓|稱謂|人称|第二人称|你|您|あなた|君|お前|호칭/u],
  ["句长节奏", /短句|长句|長句|断句|拆句|并句|句长|长度|字数|節奏|节奏/u],
  ["标点", /标点|標點|括号|括號|书名号|書名號|引号|引號|逗号|句号|感叹号|省略号|空格/u],
  ["语气强度", /语气|語氣|口吻|口语|口語|书面|書面|正式|随意|轻快|庄重|莊重|亲切/u],
  ["数字格式", /数字|數字|日期|时间|時間|金额|百分比|阿拉伯数字|汉数字|漢数字/u],
  ["专名处理", /专名|專名|品牌|人名|地名|音译|音譯|意译|保留原文|不翻译|不翻譯/u],
  ["增删改写", /漏译|漏譯|增译|增譯|改写|改寫|意译|直译|直譯|逐字|删减|刪減|补充/u]
]);

/** 表达"要这样"与"不要这样"的方向词。同方面 + 方向相反才是候选冲突。 */
const POSITIVE = /必须|必須|应当|應當|统一|統一|一律|优先|優先|使用|采用|採用|保持|保留|要用/u;
const NEGATIVE = /不得|不要|不可|不能|禁止|避免|不应|不應|切勿|勿|不使用|不采用|不保留/u;
/**
 * 否定词的辖域：中文里「不得使用简体」的「使用」是被否定的，不是一条肯定主张。
 * 先把这种组合从文本中抠掉，剩下的部分再判断有没有独立的肯定主张——
 * 这样「不得使用简体」是纯否定，而「避免使用敬体，保持常体」才真的是双向。
 */
const NEGATED_POSITIVE = /(?:不得|不要|不可|不能|禁止|避免|不应|不應|切勿|勿|不)\s*(?:必须|必須|应当|應當|统一|統一|一律|优先|優先|使用|采用|採用|保持|保留|要用)/gu;

function text(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/** 一条规则涉及哪些方面；一条规则可以同时谈多个方面。 */
export function ruleAspects(rule) {
  const body = `${text(rule?.category)} ${text(rule?.rule ?? rule)}`;
  return ASPECT_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(([aspect]) => aspect);
}

/** 规则的方向：positive（要这样）、negative（不要这样）或 neutral。 */
export function ruleDirection(rule) {
  const body = text(rule?.rule ?? rule);
  const negative = NEGATIVE.test(body);
  const positive = POSITIVE.test(body.replace(NEGATED_POSITIVE, " "));
  if (positive && negative) return "mixed";
  if (negative) return "negative";
  if (positive) return "positive";
  return "neutral";
}

/**
 * Normalize whatever a caller has into one comparable shape.
 * `origin` is what a human needs to know to act on the conflict: which of the
 * three sources the rule came from and how much weight it carries.
 */
export function collectPromptRules({ styleProfile = null, translationSkill = null, userProfile = null } = {}) {
  const rules = [];
  for (const rule of Array.isArray(styleProfile?.rules) ? styleProfile.rules : []) {
    if (rule?.status === "retired" || !text(rule?.rule)) continue;
    rules.push({
      key: `style:${rule.id}`,
      origin: "style",
      originLabel: "风格规范",
      id: rule.id,
      category: text(rule.category) || "其他",
      rule: text(rule.rule),
      evidenceCount: Math.max(0, Number(rule.evidenceCount) || 0),
      rounds: Math.max(0, Number(rule.rounds) || 0)
    });
  }
  const additional = translationSkill?.strategy?.prompting?.additionalRules;
  (Array.isArray(additional) ? additional : []).forEach((rule, index) => {
    if (!text(rule)) return;
    rules.push({
      key: `skill:${index}`,
      origin: "skill",
      originLabel: "技能附加规则",
      id: String(index),
      category: "技能",
      rule: text(rule),
      // 技能规则没有证据计数：它靠配对评测晋升，权重单独处理。
      evidenceCount: 0,
      rounds: 0,
      skillId: String(translationSkill?.id || ""),
      skillVersion: Number(translationSkill?.version) || 0
    });
  });
  if (text(userProfile?.instruction)) {
    rules.push({
      key: "profile:instruction",
      origin: "profile",
      originLabel: "译者画像",
      id: String(userProfile.id || ""),
      category: "画像",
      rule: text(userProfile.instruction),
      evidenceCount: Math.max(0, Number(userProfile.evidenceCount) || 0),
      rounds: 0
    });
  }
  return rules;
}

/**
 * Deterministic first pass.
 *
 * The job here is only to collapse O(n²) unrelated pairs down to pairs that
 * talk about the same aspect — the model does the actual judging. So this is
 * deliberately liberal: any two rules sharing an aspect are candidates, ranked
 * by how likely they are to clash.
 *
 * Being liberal matters because Chinese rule phrasing routinely mixes polarity
 * in one sentence: 「对白避免使用敬体，保持常体口吻」 both forbids and requires.
 * An earlier version required a clean positive/negative pair and therefore
 * missed the single most important case — two style rules in the same scope
 * saying opposite things about 句尾.
 */
function candidatePriority(left, right, shared) {
  const opposed = (left.direction === "positive" && right.direction === "negative")
    || (left.direction === "negative" && right.direction === "positive");
  if (opposed) return { score: 0, reason: "同一方面且方向明确相反" };
  if (left.direction === "mixed" || right.direction === "mixed") {
    return { score: 1, reason: "同一方面，其中一条同时含肯定与否定表述" };
  }
  if (left.origin !== right.origin) return { score: 2, reason: "同一方面但来自不同来源" };
  return { score: 3, reason: `同为${left.originLabel}且都涉及${shared.join("、")}` };
}

export function findConflictCandidates(rules, { maxPairs = 40 } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const enriched = list.map((rule) => ({ ...rule, aspects: ruleAspects(rule), direction: ruleDirection(rule) }));
  const candidates = [];
  for (let left = 0; left < enriched.length; left += 1) {
    for (let right = left + 1; right < enriched.length; right += 1) {
      const a = enriched[left];
      const b = enriched[right];
      const shared = a.aspects.filter((aspect) => b.aspects.includes(aspect));
      if (!shared.length) continue;
      const { score, reason } = candidatePriority(a, b, shared);
      candidates.push({ aspects: shared, reason, priority: score, left: a, right: b });
    }
  }
  return candidates
    .sort((x, y) => x.priority - y.priority)
    .slice(0, Math.max(0, maxPairs));
}

/**
 * Weigh two conflicting rules once a model has confirmed the conflict.
 *
 * Evidence beats assertion: a style rule confirmed by hundreds of accepted
 * translations outranks one seen twice. A skill rule earned its place through a
 * paired evaluation rather than evidence count, so it is treated as roughly
 * equivalent to a mid-weight style rule instead of being ranked last — but it
 * never silently wins, because skills can only change through their own
 * evaluation gate.
 */
export const SKILL_RULE_EQUIVALENT_EVIDENCE = 50;

export function weighConflict(left, right) {
  const weight = (rule) => (rule.origin === "skill" ? SKILL_RULE_EQUIVALENT_EVIDENCE : rule.evidenceCount) + rule.rounds;
  const leftWeight = weight(left);
  const rightWeight = weight(right);
  if (leftWeight === rightWeight) {
    return { winner: null, loser: null, leftWeight, rightWeight, verdict: "势均力敌，需要人工判断" };
  }
  const winner = leftWeight > rightWeight ? left : right;
  const loser = leftWeight > rightWeight ? right : left;
  return {
    winner, loser, leftWeight, rightWeight,
    verdict: `${winner.originLabel}的规则支撑更强（${Math.max(leftWeight, rightWeight)} vs ${Math.min(leftWeight, rightWeight)}）`
  };
}

/**
 * Turn an adjudicated conflict into the action a human can approve.
 *
 * Only style rules can be rewritten here: skill rules change through challenger
 * promotion and the translator profile through its own draft flow, so a
 * conflict involving those is reported for a human to resolve rather than
 * silently patched.
 */
export function planConflictResolution(conflict) {
  const { winner, loser, verdict } = weighConflict(conflict.left, conflict.right);
  if (!winner) return { action: "review", reason: verdict, conflict };
  if (loser.origin !== "style") {
    return {
      action: "review",
      reason: `${verdict}，但需要退让的是${loser.originLabel}，只能人工处理（技能规则须经评测晋升，画像须走草稿流程）`,
      conflict, winner, loser
    };
  }
  return {
    action: "retire-style-rule",
    ruleId: loser.id,
    reason: `与${winner.originLabel}冲突：${winner.rule.slice(0, 60)}；${verdict}`,
    conflict, winner, loser
  };
}
