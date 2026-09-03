import { normalizeSource, similarity } from "./text.mjs";
import { MEMORY_PURPOSES, partitionTranslationMemories } from "./asset-governance.mjs";

const QUALITY_RANK = Object.freeze({ human_approved: 2, machine_verified: 1, provisional: 0, rejected: -1 });

function tokenOverlap(left, right) {
  const a = new Set([...normalizeSource(left)]);
  const b = new Set([...normalizeSource(right)]);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function cosineScore(stored, query) {
  const storedVector = stored?.embedding?.vector;
  if (!Array.isArray(storedVector) || !Array.isArray(query?.vector) || !storedVector.length) return null;
  if (Number(stored.embedding?.dimensions) !== Number(query.dimensions)) return null;
  if (stored.embedding?.model && query.model && stored.embedding.model !== query.model) return null;
  let dot = 0;
  for (let index = 0; index < storedVector.length; index += 1) dot += storedVector[index] * query.vector[index];
  return Math.max(0, Math.min(1, dot));
}

function lexicalScore(normalized, memory) {
  const edit = similarity(normalized, normalizeSource(memory.source));
  const overlap = tokenOverlap(normalized, memory.source);
  const exact = normalized === normalizeSource(memory.source) ? 1 : 0;
  return { edit, overlap, exact };
}

function tagOverlap(left = [], right = []) {
  const query = new Set(Array.isArray(left) ? left : []);
  const stored = new Set(Array.isArray(right) ? right : []);
  if (!query.size || !stored.size) return 0;
  let common = 0;
  for (const tag of query) if (stored.has(tag)) common += 1;
  return common / Math.max(query.size, stored.size);
}

/**
 * 投放亲和度：平台、活动、地区、渠道命中程度，加上一条新鲜度衰减。
 *
 * 它只影响同样相关的译例谁排在前面，不参与相关度门槛判定——把它加进相关度会
 * 重蹈"可信度与相关度相加"的覆辙，让同平台但完全无关的译例挤进上下文。
 */
const CONTEXT_RANK_WEIGHT = 0.12;
const RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

function dimensionHit(memoryValue, requested) {
  const wanted = (Array.isArray(requested) ? requested : [requested]).map((value) => String(value ?? "").trim().toLocaleLowerCase()).filter(Boolean);
  if (!wanted.length) return null;
  const stored = String(memoryValue ?? "").trim().toLocaleLowerCase();
  if (!stored) return null;
  return wanted.includes(stored) ? 1 : 0;
}

function recencyScore(memory, nowMs) {
  const stamp = Date.parse(memory?.dateUpdated || memory?.updatedAt || memory?.dateCreated || memory?.createdAt || "");
  if (!Number.isFinite(stamp)) return null;
  const age = Math.max(0, nowMs - stamp);
  return 0.5 ** (age / RECENCY_HALF_LIFE_MS);
}

function contextAffinity(memory, context, nowMs) {
  const parts = [
    { weight: 0.34, value: dimensionHit(memory.platform, context.platform) },
    { weight: 0.26, value: dimensionHit(memory.campaign, context.campaign) },
    { weight: 0.16, value: dimensionHit(memory.region, context.region) },
    { weight: 0.10, value: dimensionHit(memory.channel, context.channel) },
    { weight: 0.14, value: recencyScore(memory, nowMs) }
  ].filter((part) => part.value !== null);
  if (!parts.length) return 0;
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  return parts.reduce((sum, part) => sum + part.weight * part.value, 0) / total;
}

export function rankTranslationMemories(source, memories = [], {
  limit = 5,
  queryEmbedding = null,
  contentTags = [],
  retrievalPurpose = MEMORY_PURPOSES.PRODUCTION,
  locale = "",
  contentType = "",
  domain = "",
  project = "",
  channel = "",
  platform = "",
  region = "",
  campaign = "",
  batchId = "",
  taskId = "",
  sessionId = "",
  now = new Date(),
  workingWindowMs,
  allowRecentWorking = false
} = {}) {
  const normalized = normalizeSource(source);
  const nowMs = now instanceof Date ? now.valueOf() : Date.parse(now);
  // Production and long-term retrieval are formal-only by default. A caller
  // must explicitly request working_consistency and provide a batch/task/session
  // binding before a machine-verified draft can enter the reference list.
  const governed = partitionTranslationMemories(memories, {
    locale, contentType, domain, project, channel, platform, region, batchId, taskId, sessionId
  }, {
    purpose: retrievalPurpose,
    now,
    ...(workingWindowMs === undefined ? {} : { workingWindowMs }),
    allowRecentWorking
  });
  const ranked = governed.references
    .map((memory) => {
      const { edit, overlap, exact } = lexicalScore(normalized, memory);
      // 可信度决定一条译例能不能充当规范，相关度决定它是否属于当前句。
      // 两者不能相加：旧实现把 human_approved 的 0.18 在 lexical 和 blended
      // 中各加一次，导致完全无关的人工译例天然高于 0.28 检索门槛。
      const lexical = Math.min(1, exact * 0.45 + edit * 0.38 + overlap * 0.17);
      const cosine = cosineScore(memory, queryEmbedding);
      const localVector = String(queryEmbedding?.model || "").startsWith("local-");
      const blended = cosine === null
        ? lexical
        : Math.min(1, (localVector ? 0.72 : 0.42) * lexical + (localVector ? 0.28 : 0.58) * cosine);
      const tags = tagOverlap(contentTags, memory.contentTags);
      const score = Math.min(1, Math.max(lexical, blended) + tags * 0.06);
      const affinity = contextAffinity(memory, { platform, region, channel, campaign, project }, nowMs);
      return {
        ...memory,
        similarity: Number(score.toFixed(3)),
        semantic: cosine === null ? null : Number(cosine.toFixed(3)),
        tagMatch: Number(tags.toFixed(3)),
        contextAffinity: Number(affinity.toFixed(3)),
        // 相关度单独保留：投放亲和度只参与排序，绝不把不相关的译例推过检索门槛。
        // 排序分不封顶——原文完全一致时相关度本就是 1，封顶会把投放差异抹平。
        rankScore: Number((score + affinity * CONTEXT_RANK_WEIGHT).toFixed(4))
      };
    })
    .filter((memory) => memory.similarity >= 0.28)
    .sort((a, b) => b.rankScore - a.rankScore
      || b.similarity - a.similarity
      || (QUALITY_RANK[b.qualityStatus] ?? 0) - (QUALITY_RANK[a.qualityStatus] ?? 0)
      || (b.qaScore || 0) - (a.qaScore || 0));
  // 找不到可靠译例时宁可返回空数组，也不为了凑满 UI 数量注入无关内容。
  return ranked.slice(0, limit);
}

export function rankQaCases(source, cases = [], { limit = 3, queryEmbedding = null } = {}) {
  const normalized = normalizeSource(source);
  return cases.map((item) => {
    const edit = similarity(normalized, normalizeSource(item.source));
    const overlap = tokenOverlap(normalized, item.source);
    const lexical = edit * 0.72 + overlap * 0.28;
    const cosine = cosineScore(item, queryEmbedding);
    const blended = cosine === null ? lexical : 0.45 * lexical + 0.55 * cosine;
    const score = Math.max(lexical, blended);
    return { ...item, similarity: Number(score.toFixed(3)), semantic: cosine === null ? null : Number(cosine.toFixed(3)) };
  }).filter((item) => item.similarity >= 0.3).sort((a, b) => b.similarity - a.similarity || b.scoreAfter - a.scoreAfter).slice(0, limit);
}

/**
 * Split retrieved references by whether they may be cited as an authority.
 *
 * A QA-passed machine translation is written straight back into the memory pool
 * as `machine_verified`. If the judge is then handed that memory under the label
 * "已批准译例", one model's output becomes the standard its own successors are
 * measured against — observed in practice within a single session: a machine
 * translation that carried Chinese 《》 brackets into Korean passed QA, entered
 * the pool, and was then cited to mark a professional translator's correct 「」
 * as an inconsistency. Worse, the same phrase was called a semantic narrowing
 * when judging the machine and "the approved rendering" when judging the human.
 *
 * Only human-approved material (human accepts, curated table imports) may be
 * cited as authority. Machine-verified memories stay useful for the TRANSLATOR
 * (cross-segment consistency) but are never evidence of correctness.
 */
export function splitReferenceAuthority(references = []) {
  const list = Array.isArray(references) ? references : [];
  return {
    approved: list.filter((item) => item?.qualityStatus === "human_approved"),
    machineDrafts: list.filter((item) => item?.qualityStatus !== "human_approved")
  };
}

/**
 * 领域是**收窄**维度，不是必要条件。记忆、QA 案例与风格证据都按
 * `item.domain === domain || item.domain === "general"` 严格过滤，而本项目
 * 99% 资产都归在 game 下（风格规范 7/7、记忆 592/597、证据 1951/1966）——
 * 一旦领域判成或选成别的值，检索会静默归零，模型失去全部参考译例。
 *
 * 因此统一用不限领域的一次查询取回，再在内存里收窄；收窄后为空就退回全量，
 * 只保留语体维度。这样领域既能在资产积累起来后真正起作用，也永远不会把
 * 检索打空。返回 relaxed 供界面说明本次是否放宽过。
 */
export function narrowByDomain(items, domain) {
  const list = Array.isArray(items) ? items : [];
  if (!domain || domain === "general") return { items: list, relaxed: false };
  const scoped = list.filter((item) => item?.domain === domain || item?.domain === "general");
  return scoped.length ? { items: scoped, relaxed: false } : { items: list, relaxed: list.length > 0 };
}
