import { createHash, randomUUID } from "node:crypto";
import { assertLocale } from "./config.mjs";
import { embedSource, embeddingModelName } from "./embedding.mjs";
import { fetchWithTimeout } from "./provider.mjs";

export const LOCALE_COLLECTIONS = Object.freeze({
  "ja-JP": "terms_ja_jp",
  "ko-KR": "terms_ko_kr",
  "zh-Hant-TW": "terms_zh_hant_tw",
  "fr-FR": "terms_fr_fr",
  "th-TH": "terms_th_th"
});

export const MEMORY_COLLECTIONS = Object.freeze({
  "ja-JP": "translation_memory_ja_jp",
  "ko-KR": "translation_memory_ko_kr",
  "zh-Hant-TW": "translation_memory_zh_hant_tw",
  "fr-FR": "translation_memory_fr_fr",
  "th-TH": "translation_memory_th_th"
});

// Directus is configured for 128 MB on localhost. There is no arbitrary item
// count limit; the 64 MB fallback only protects a single HTTP request if the
// spreadsheet upload ceiling is raised in the future.
const DIRECTUS_WRITE_CHUNK_BYTES = 64 * 1024 * 1024;
const DIRECTUS_WRITE_CHUNK_ITEMS = Number.POSITIVE_INFINITY;
const DIRECTUS_BULK_WRITE_TIMEOUT_MS = 120_000;

export function chunkDirectusRecords(records, {
  maxBytes = DIRECTUS_WRITE_CHUNK_BYTES,
  maxItems = DIRECTUS_WRITE_CHUNK_ITEMS
} = {}) {
  const chunks = [];
  let chunk = [];
  let chunkBytes = 2;

  for (const record of records || []) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const separatorBytes = chunk.length ? 1 : 0;
    if (chunk.length && (chunk.length >= maxItems || chunkBytes + separatorBytes + recordBytes > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(record);
    chunkBytes += (chunk.length > 1 ? 1 : 0) + recordBytes;
  }

  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function config() {
  const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const token = process.env.DIRECTUS_TOKEN;
  if (!token) throw new Error("KAMI_STORE=directus requires DIRECTUS_TOKEN");
  return { baseUrl, token };
}

async function request(path, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  const { baseUrl, token } = config();
  const { response, text } = await fetchWithTimeout(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }, { timeoutMs, label: "Directus" });
  let payload = null;
  if (response.status !== 204 && text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!response.ok) {
    const details = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
    const error = new Error(`Directus ${method} ${path} failed (${response.status}): ${details}`);
    error.statusCode = response.status >= 500 ? 503 : response.status;
    throw error;
  }
  return payload?.data ?? payload;
}

async function createItemsInChunks(path, records) {
  const saved = [];
  for (const chunk of chunkDirectusRecords(records)) {
    try {
      const result = await request(path, { method: "POST", body: chunk, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
      saved.push(...(Array.isArray(result) ? result : [result]));
    } catch (error) {
      error.createdItems = saved;
      throw error;
    }
  }
  return saved;
}

async function updateItemsInChunks(path, records) {
  for (const chunk of chunkDirectusRecords(records)) {
    await request(path, { method: "PATCH", body: chunk, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
  }
}

async function candidateIdsForBatch(batchId) {
  const params = new URLSearchParams({
    limit: "-1",
    fields: "id",
    filter: JSON.stringify({ batch_id: { _eq: batchId } })
  });
  const items = await request(`/items/term_candidates?${params}`);
  return items.map((item) => item.id).filter(Boolean);
}

function collectionFor(locale) {
  assertLocale(locale);
  return LOCALE_COLLECTIONS[locale];
}

function memoryCollectionFor(locale) {
  assertLocale(locale);
  return MEMORY_COLLECTIONS[locale];
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function toTerm(item) {
  return {
    id: item.id,
    source: item.source,
    aliases: arrayValue(item.aliases),
    target: item.target,
    forbidden: arrayValue(item.forbidden),
    domains: arrayValue(item.domains),
    contentTypes: arrayValue(item.content_types),
    contentTags: arrayValue(item.content_tags),
    enforcement: item.enforcement || "required",
    note: item.note || "",
    status: item.status || "observed",
    provenance: item.provenance || "directus",
    createdAt: item.date_created,
    updatedAt: item.date_updated
  };
}

function toDirectusTerm(input) {
  return {
    ...(input.id ? { id: input.id } : {}),
    source: String(input.source || "").trim(),
    aliases: [...new Set((input.aliases || []).map((item) => String(item).trim()).filter(Boolean))],
    target: String(input.target || "").trim(),
    forbidden: [...new Set((input.forbidden || []).map((item) => String(item).trim()).filter(Boolean))],
    domains: [...new Set((input.domains || ["general"]).filter(Boolean))],
    content_types: [...new Set((input.contentTypes || ["general"]).filter(Boolean))],
    content_tags: [...new Set((input.contentTags || []).filter(Boolean))],
    enforcement: input.enforcement || "required",
    note: String(input.note || "").trim(),
    status: input.status || "approved",
    provenance: input.provenance || "kami-workbench"
  };
}

/**
 * Directus 对"条目不存在"和"无权访问"一律返回 403 FORBIDDEN，从不返回 404
 * ——这是它刻意的设计，避免用 404/403 的差别泄露某个 id 是否存在。
 *
 * 代码里十处"取不到就当没有"的判断原本只认 404，于是全部失效。最直接的后果是
 * 激活译者画像：先查 style_profiles 拿到 403，本该回退去查 user_profiles，
 * 却把 403 当成真错误抛给了用户。
 *
 * 把两者一并视为"没有这条"。代价是真正的权限配置错误也会被当成不存在，因此
 * 服务账号的权限由 provision 统一保证，出问题时看 provision 输出而不是这里。
 */
function isMissingItem(error) {
  return [403, 404].includes(Number(error?.statusCode));
}

export async function initializeDirectusStore() {
  const health = await fetch(`${config().baseUrl}/server/ping`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Directus health check failed (${health.status})`);
  await Promise.all([
    ...Object.values(LOCALE_COLLECTIONS),
    ...Object.values(MEMORY_COLLECTIONS),
    "style_learning_runs",
    "learning_trajectories",
    "translation_skills",
    "skill_evaluations"
  ].map((collection) => request(`/items/${collection}?limit=1&fields=id`)));
}

export async function getDirectusMemories(locale, { contentType = "general", domain = "general", limit = 500, exactContentType = false } = {}) {
  const collection = memoryCollectionFor(locale);
  const directusLimit = Number(limit) <= 0 ? "-1" : String(Math.min(1000, limit));
  const params = new URLSearchParams({ limit: directusLimit, sort: "-date_updated,-date_created", fields: "id,source,target,domain,content_type,content_tags,channel,style_profile_id,quality_status,qa_score,provenance,source_file,batch_id,source_row,embedding,date_created,date_updated" });
  const items = await request(`/items/${collection}?${params}`);
  return items.filter((item) =>
    (!contentType || (exactContentType ? item.content_type === contentType : contentType === "general" || item.content_type === contentType || item.content_type === "general"))
    && (!domain || domain === "general" || item.domain === domain || item.domain === "general")
  ).map((item) => ({
    id: item.id,
    source: item.source,
    target: item.target,
    domain: item.domain || "general",
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    channel: item.channel || "",
    styleProfileId: item.style_profile_id || "",
    qualityStatus: item.quality_status || "provisional",
    qaScore: Number(item.qa_score) || 0,
    provenance: item.provenance || "directus",
    sourceFile: item.source_file || "",
    batchId: item.batch_id || "",
    sourceRow: item.source_row || null,
    embedding: item.embedding || null,
    createdAt: item.date_created,
    updatedAt: item.date_updated
  }));
}

export async function saveDirectusMemory(locale, input) {
  const collection = memoryCollectionFor(locale);
  const source = String(input.source || "").trim();
  const target = String(input.target || "").trim();
  if (!source || !target) throw new Error("翻译记忆的中外文不能为空");
  const embedding = input.embedding ?? await embedSource(source);
  const params = new URLSearchParams({ limit: "1", fields: "id,quality_status,qa_score" });
  params.set("filter[source][_eq]", source);
  params.set("filter[target][_eq]", target);
  const existing = await request(`/items/${collection}?${params}`);
  const body = {
    source,
    target,
    domain: input.domain || "general",
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    channel: input.channel || "",
    style_profile_id: input.styleProfileId || "",
    quality_status: input.qualityStatus || "provisional",
    qa_score: Number(input.qaScore) || null,
    provenance: input.provenance || "kami-workbench",
    source_file: input.sourceFile || "",
    batch_id: input.batchId || "",
    source_row: Number(input.sourceRow) || null,
    ...(embedding ? { embedding } : {})
  };
  const saved = existing[0]
    ? await request(`/items/${collection}/${existing[0].id}`, { method: "PATCH", body })
    : await request(`/items/${collection}`, { method: "POST", body });
  return { id: saved.id, locale, source: saved.source, target: saved.target, qualityStatus: saved.quality_status, qaScore: Number(saved.qa_score) || 0 };
}

export async function getDirectusStyleProfile(locale, contentType, domain = "general") {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,name,target_locale,content_type,content_tags,domain,instructions,examples,rules,version,parent_id,evidence_count,evidence_ids,generated_by,source_batch_id,learning_run_id,status,date_updated" });
  params.set("filter[target_locale][_eq]", locale);
  params.set("filter[content_type][_eq]", contentType || "general");
  params.set("filter[status][_eq]", "active");
  const items = await request(`/items/style_profiles?${params}`);
  const profile = items.find((item) => item.domain === domain) || items.find((item) => item.domain === "general") || items[0];
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    source: "style-library",
    locale: profile.target_locale,
    contentType: profile.content_type,
    contentTags: arrayValue(profile.content_tags),
    domain: profile.domain || "general",
    instruction: profile.instructions,
    examples: arrayValue(profile.examples),
    version: Number(profile.version) || 1,
    evidenceCount: Number(profile.evidence_count) || 0,
    sourceBatchId: profile.source_batch_id || "",
    learningRunId: profile.learning_run_id || "",
    updatedAt: profile.date_updated
  };
}

export async function saveDirectusStyleEvidence(input) {
  const embedding = input.embedding ?? await embedSource(input.source);
  const saved = await request("/items/style_evidence", { method: "POST", body: {
    target_locale: assertLocale(input.locale),
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    source: String(input.source || "").trim(),
    target: String(input.target || "").trim(),
    source_file: input.sourceFile || "",
    source_row: Number(input.sourceRow) || null,
    batch_id: input.batchId || "",
    status: input.status || "accepted",
    provenance: input.provenance || "",
    machine_translation: String(input.machineTranslation || "").trim(),
    polarity: input.polarity === "negative" ? "negative" : "positive",
    note: String(input.note || "").trim(),
    ...(embedding ? { embedding } : {})
  } });
  return { id: saved.id, ...input };
}

export async function getDirectusStyleEvidence(locale, options = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: String(Math.min(1000, options.limit || 1000)), sort: "-date_created", fields: "id,target_locale,content_type,content_tags,domain,source,target,machine_translation,polarity,note,source_file,source_row,batch_id,status,provenance,embedding,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  if (options.contentType) params.set("filter[content_type][_eq]", options.contentType);
  if (options.exactScope && options.domain) params.set("filter[domain][_eq]", options.domain);
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  const items = await request(`/items/style_evidence?${params}`);
  return items
    .filter((item) => options.exactScope
      ? (!options.contentType || item.content_type === options.contentType) && (!options.domain || item.domain === options.domain)
      : (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general"))
    .map((item) => ({
      id: item.id, locale: item.target_locale, contentType: item.content_type || "general", contentTags: arrayValue(item.content_tags), domain: item.domain || "general",
      source: item.source, target: item.target, sourceFile: item.source_file || "", sourceRow: Number(item.source_row) || null,
      machineTranslation: item.machine_translation || "",
      polarity: item.polarity === "negative" ? "negative" : "positive",
      note: item.note || "",
      batchId: item.batch_id || "",
      status: item.status || "accepted", provenance: item.provenance || "",
      embedding: item.embedding || null, createdAt: item.date_created
    }));
}

export async function getDirectusQaRuns(locale, options = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: String(Math.min(500, options.limit || 100)), sort: "-date_created", fields: "id,target_locale,content_type,domain,source,initial_translation,final_translation,score,status,iterations,issues,term_decisions,human_decisions,references,style_profile_id,model,fallback_reason,batch_id,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  if (options.contentType) params.set("filter[content_type][_eq]", options.contentType);
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  const items = await request(`/items/qa_runs?${params}`);
  return items
    .filter((item) => !options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general")
    .map((item) => ({
      id: item.id, locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
      source: item.source, initialTranslation: item.initial_translation, finalTranslation: item.final_translation,
      score: item.score == null ? null : Number(item.score), status: item.status || "review", iterations: Number(item.iterations) || 0,
      issues: arrayValue(item.issues), termDecisions: arrayValue(item.term_decisions), humanDecisions: arrayValue(item.human_decisions), references: arrayValue(item.references), styleProfileId: item.style_profile_id || "",
      model: item.model || "", fallbackReason: item.fallback_reason || "", batchId: item.batch_id || "", createdAt: item.date_created
    }));
}

export async function getDirectusUserProfile(locale) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated" });
  params.set("filter[target_locale][_eq]", locale);
  params.set("filter[status][_eq]", "active");
  const items = await request(`/items/user_profiles?${params}`);
  const profile = items[0];
  if (!profile) return null;
  return {
    id: profile.id, name: profile.name, locale: profile.target_locale, instruction: profile.instructions,
    examples: arrayValue(profile.examples), version: Number(profile.version) || 1,
    evidenceCount: Number(profile.evidence_count) || 0, updatedAt: profile.date_updated
  };
}

export async function saveDirectusUserProfile(input) {
  const locale = assertLocale(input.locale);
  const params = new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "id,version,status" });
  params.set("filter[target_locale][_eq]", locale);
  const existing = await request(`/items/user_profiles?${params}`);
  const previous = existing[0];
  const saved = await request("/items/user_profiles", { method: "POST", body: {
    name: input.name || `${locale} 译者画像`,
    target_locale: locale,
    instructions: input.instruction,
    examples: input.examples || [],
    version: (Number(previous?.version) || 0) + 1,
    parent_id: previous?.id || null,
    evidence_count: Number(input.evidenceCount) || 0,
    status: input.status || "active"
  } });
  if (previous?.id && saved.status === "active") await request(`/items/user_profiles/${previous.id}`, { method: "PATCH", body: { status: "inactive" } });
  return { id: saved.id, name: saved.name, locale, instruction: saved.instructions, examples: saved.examples || [], version: saved.version };
}

export async function saveDirectusStyleProfile(input) {
  const locale = assertLocale(input.locale);
  const params = new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "id,version,status" });
  params.set("filter[target_locale][_eq]", locale);
  params.set("filter[content_type][_eq]", input.contentType || "general");
  params.set("filter[domain][_eq]", input.domain || "general");
  const existing = await request(`/items/style_profiles?${params}`);
  const previous = existing[0];
  const saved = await request("/items/style_profiles", { method: "POST", body: {
    name: input.name,
    target_locale: locale,
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    instructions: input.instruction,
    examples: input.examples || [],
    rules: input.rules || [],
    version: (Number(previous?.version) || 0) + 1,
    parent_id: previous?.id || null,
    evidence_count: Number(input.evidenceCount) || 0,
    evidence_ids: input.evidenceIds || [],
    generated_by: input.generatedBy || "",
    source_batch_id: input.sourceBatchId || "",
    learning_run_id: input.learningRunId || "",
    status: input.status || "active"
  } });
  if (previous?.id && saved.status === "active") await request(`/items/style_profiles/${previous.id}`, { method: "PATCH", body: { status: "inactive" } });
  return { id: saved.id, name: saved.name, source: "style-library", instruction: saved.instructions, examples: saved.examples || [], rules: arrayValue(saved.rules), version: saved.version, locale, contentType: saved.content_type, contentTags: arrayValue(saved.content_tags), domain: saved.domain, sourceBatchId: saved.source_batch_id || "", learningRunId: saved.learning_run_id || "", status: saved.status };
}

function mapStyleLearningRun(item) {
  return {
    id: item.id,
    batchId: item.batch_id || "",
    filename: item.filename || "",
    locale: item.target_locale,
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    domain: item.domain || "general",
    evidenceCount: Number(item.evidence_count) || 0,
    summary: item.summary || "",
    rules: arrayValue(item.rules),
    examples: arrayValue(item.examples),
    caveat: item.caveat || "",
    confidence: item.confidence == null ? null : Number(item.confidence),
    status: item.status || "draft",
    promotedProfileId: item.promoted_profile_id || "",
    generatedBy: item.generated_by || "",
    createdAt: item.date_created || null
  };
}

export async function saveDirectusStyleLearningRun(input) {
  const body = input.id ? {} : {
    batch_id: String(input.batchId || ""),
    filename: String(input.filename || ""),
    target_locale: assertLocale(input.locale),
    content_type: input.contentType || "general",
    content_tags: input.contentTags || [],
    domain: input.domain || "general",
    evidence_count: Number(input.evidenceCount) || 0,
    summary: String(input.summary || ""),
    rules: input.rules || [],
    examples: input.examples || [],
    caveat: String(input.caveat || ""),
    confidence: input.confidence == null ? null : Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    status: input.status || "observed",
    promoted_profile_id: input.promotedProfileId || "",
    generated_by: input.generatedBy || ""
  };
  if (input.id) {
    const fields = {
      batchId: ["batch_id", (value) => String(value || "")],
      filename: ["filename", (value) => String(value || "")],
      locale: ["target_locale", (value) => assertLocale(value)],
      contentType: ["content_type", (value) => value || "general"],
      contentTags: ["content_tags", (value) => value || []],
      domain: ["domain", (value) => value || "general"],
      evidenceCount: ["evidence_count", (value) => Number(value) || 0],
      summary: ["summary", (value) => String(value || "")],
      rules: ["rules", (value) => value || []],
      examples: ["examples", (value) => value || []],
      caveat: ["caveat", (value) => String(value || "")],
      confidence: ["confidence", (value) => value == null ? null : Math.max(0, Math.min(1, Number(value) || 0))],
      status: ["status", (value) => value || "observed"],
      promotedProfileId: ["promoted_profile_id", (value) => value || ""],
      generatedBy: ["generated_by", (value) => value || ""]
    };
    for (const [inputField, [directusField, normalize]] of Object.entries(fields)) {
      if (Object.hasOwn(input, inputField)) body[directusField] = normalize(input[inputField]);
    }
  }
  const saved = input.id
    ? await request(`/items/style_learning_runs/${encodeURIComponent(input.id)}`, { method: "PATCH", body })
    : await request("/items/style_learning_runs", { method: "POST", body });
  return mapStyleLearningRun(saved);
}

export async function getDirectusStyleLearningRuns(locale, options = {}) {
  const params = new URLSearchParams({
    limit: String(Math.min(500, Math.max(1, Number(options.limit) || 100))),
    sort: "-date_created",
    fields: "id,batch_id,filename,target_locale,content_type,content_tags,domain,evidence_count,summary,rules,examples,caveat,confidence,status,promoted_profile_id,generated_by,date_created"
  });
  params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (options.batchId) params.set("filter[batch_id][_eq]", options.batchId);
  if (options.status) params.set("filter[status][_eq]", options.status);
  return (await request(`/items/style_learning_runs?${params}`)).map(mapStyleLearningRun);
}

export async function saveDirectusQaRun(input) {
  return request("/items/qa_runs", { method: "POST", body: {
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, initial_translation: input.initialTranslation, final_translation: input.finalTranslation,
    score: input.score, status: input.status, iterations: input.iterations || 0, issues: input.issues || [], term_decisions: input.termDecisions || [], human_decisions: input.humanDecisions || [], references: input.references || [],
    style_profile_id: input.styleProfileId || "", model: input.model || "", batch_id: input.batchId || "", fallback_reason: input.fallbackReason || ""
  } });
}

export async function saveDirectusQaCase(input) {
  const embedding = input.embedding ?? await embedSource(input.source);
  return request("/items/qa_cases", { method: "POST", body: {
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, rejected_translation: input.rejectedTranslation, corrected_translation: input.correctedTranslation || "",
    issues: input.issues || [], score_before: input.scoreBefore, score_after: input.scoreAfter, status: input.status || "review",
    ...(embedding ? { embedding } : {})
  } });
}

export async function getDirectusQaCases(locale, { contentType = "general", domain = "general", limit = 200 } = {}) {  assertLocale(locale);
  const directusLimit = Number(limit) <= 0 ? "-1" : String(Math.min(500, limit));
  const params = new URLSearchParams({ limit: directusLimit, sort: "-date_created", fields: "id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,embedding,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  if (contentType) params.set("filter[content_type][_eq]", contentType);
  const items = await request(`/items/qa_cases?${params}`);
  return items.filter((item) => (!domain || domain === "general" || item.domain === domain || item.domain === "general") && ["machine_verified", "human_approved"].includes(item.status)).map((item) => ({
    id: item.id, locale: item.target_locale, contentType: item.content_type, domain: item.domain || "general", source: item.source,
    rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation, issues: arrayValue(item.issues),
    scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0, status: item.status, embedding: item.embedding || null, createdAt: item.date_created
  }));
}

export async function getDirectusAssets(locale) {
  const collection = collectionFor(locale);
  const fields = "id,source,aliases,target,forbidden,domains,content_types,content_tags,enforcement,note,status,provenance,date_created,date_updated";
  const items = await request(`/items/${collection}?limit=-1&sort=-date_updated&fields=${fields}`);
  const latest = items.map((item) => item.date_updated || item.date_created).filter(Boolean).sort().at(-1);
  return {
    locale,
    revision: latest ? Date.parse(latest) : 1,
    terms: items.map(toTerm),
    memories: [],
    styleExamples: []
  };
}

export async function getDirectusAssetStats(locale) {
  const collection = collectionFor(locale);
  const result = await request(`/items/${collection}?aggregate[count]=*`);
  return { locale, termCount: Number(result?.[0]?.count ?? 0), revision: Date.now() };
}

export async function saveDirectusAsset(locale, input) {
  const collection = collectionFor(locale);
  const item = toDirectusTerm(input);
  if (!item.source || !item.target) {
    const error = new Error("术语原文和目标译法不能为空");
    error.statusCode = 400;
    throw error;
  }
  const saved = input.id
    ? await request(`/items/${collection}/${encodeURIComponent(input.id)}`, { method: "PATCH", body: item })
    : await request(`/items/${collection}`, { method: "POST", body: item });
  return toTerm(saved);
}

export async function deleteDirectusAsset(locale, id) {
  const collection = collectionFor(locale);
  await request(`/items/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

export async function saveDirectusCorpus(input) {
  const id = input.id || randomUUID();
  const document = {
    id,
    name: String(input.name || "未命名语料").trim(),
    source_language: "zh-CN",
    domain: input.domain || "general",
    content_type: input.contentType || "general",
    text: String(input.text || ""),
    segments: input.segments || [],
    candidates: input.candidates || []
  };
  const saved = await request("/items/corpus_documents", { method: "POST", body: document });
  return {
    id: saved.id,
    name: saved.name,
    sourceLanguage: saved.source_language,
    domain: saved.domain,
    contentType: saved.content_type,
    text: saved.text,
    segments: saved.segments || [],
    candidates: saved.candidates || [],
    createdAt: saved.date_created
  };
}

export async function saveDirectusImportPreview(input) {
  const batch = await request("/items/term_import_batches", {
    method: "POST",
    body: {
      filename: input.filename,
      file_type: input.fileType,
      source_language: "zh-CN",
      requested_locale: input.requestedLocale,
      row_count: input.statistics?.rowsScanned || 0,
      candidate_count: input.candidates.length,
      status: "reviewing",
      ai_used: Boolean(input.ai?.used),
      summary: {
        ...(input.statistics || {}),
        fileMode: input.fileMode || "mixed",
        ai: input.ai || null,
        sheets: input.sheets || []
      }
    }
  });
  const records = input.candidates.map((candidate) => ({
    source: candidate.source,
    target: candidate.target,
    target_locale: candidate.locale,
    asset_type: candidate.assetType || "term",
    content_type: candidate.contentType || "general",
    content_tags: candidate.contentTags || [],
    domain: candidate.domain || "general",
    enforcement: candidate.enforcement || "preferred",
    classification_confidence: Number(candidate.contentTypeConfidence) || Number(candidate.score) || null,
    classification_source: candidate.contentTypeSource || (input.ai?.used ? "ai" : "rules"),
    candidate_key: candidate.candidateKey || "",
    candidate_role: candidate.candidateRole || "full_pair",
    parent_candidate_key: candidate.parentCandidateKey || "",
    parent_row_number: Number(candidate.parentRowNumber) || null,
    parent_candidate_keys: candidate.parentCandidateKeys || (candidate.parentCandidateKey ? [candidate.parentCandidateKey] : []),
    parent_evidence: candidate.parentEvidence || [],
    candidate_origin: candidate.candidateOrigin || candidate.extractionSource || "table-pair",
    term_category: candidate.termCategory || "",
    extraction_confidence: candidate.extractionConfidence == null ? null : Number(candidate.extractionConfidence),
    source_span: candidate.sourceSpan || null,
    target_span: candidate.targetSpan || null,
    frequency: candidate.occurrences || 1,
    score: candidate.score,
    batch_id: batch.id,
    source_file: input.filename,
    row_number: candidate.rowNumber,
    decision: candidate.decision,
    reason: (candidate.reasons || []).join("；"),
    status: "pending"
  }));
  let saved = [];
  try {
    saved = records.length ? await createItemsInChunks("/items/term_candidates", records) : [];
    if (saved.length !== records.length) throw new Error(`Directus candidate write was incomplete (${saved.length}/${records.length})`);
  } catch (error) {
    const knownIds = [...saved, ...(error.createdItems || [])].map((item) => item?.id).filter(Boolean);
    const persistedIds = await candidateIdsForBatch(batch.id).catch(() => []);
    const savedIds = [...new Set([...knownIds, ...persistedIds])];
    if (savedIds.length) {
      await updateItemsInChunks("/items/term_candidates", savedIds.map((id) => ({
        id,
        status: "rejected",
        decision: "excluded"
      }))).catch(() => {});
    }
    await request(`/items/term_import_batches/${encodeURIComponent(batch.id)}`, {
      method: "PATCH",
      body: { status: "cancelled", summary: { ...(input.statistics || {}), partialCandidates: savedIds.length, error: error.message } }
    }).catch(() => {});
    throw error;
  }
  return {
    batchId: batch.id,
    candidates: input.candidates.map((candidate, index) => ({ ...candidate, candidateId: saved[index]?.id }))
  };
}

export async function getDirectusImportPreview(batchId) {
  let batch;
  try {
    batch = await request(`/items/term_import_batches/${encodeURIComponent(String(batchId))}?fields=id,filename,file_type,requested_locale,row_count,candidate_count,status,ai_used,summary,date_created`);
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }

  const params = new URLSearchParams({
    limit: "-1",
    sort: "row_number,target_locale",
    fields: [
      "id", "source", "target", "target_locale", "asset_type", "content_type", "content_tags", "domain", "enforcement",
      "classification_confidence", "classification_source", "candidate_key", "candidate_role", "parent_candidate_key",
      "parent_row_number", "parent_candidate_keys", "parent_evidence", "candidate_origin", "term_category",
      "extraction_confidence", "source_span", "target_span", "frequency", "score", "source_file", "row_number",
      "decision", "reason", "status"
    ].join(","),
    filter: JSON.stringify({ batch_id: { _eq: batch.id } })
  });
  const records = await request(`/items/term_candidates?${params}`, { timeoutMs: 30_000 });
  const summary = batch.summary && typeof batch.summary === "object" ? batch.summary : {};
  const { fileMode = "mixed", ai: savedAi = null, sheets = [], ...statistics } = summary;
  const candidates = records.map((item) => ({
    candidateId: item.id,
    source: item.source || "",
    target: item.target || "",
    locale: item.target_locale || "",
    assetType: item.asset_type || "term",
    contentType: item.content_type || "general",
    contentTags: arrayValue(item.content_tags),
    domain: item.domain || "general",
    enforcement: item.enforcement || "preferred",
    contentTypeConfidence: Number(item.classification_confidence) || Number(item.score) || 0,
    contentTypeSource: item.classification_source || "rules",
    candidateKey: item.candidate_key || "",
    candidateRole: item.candidate_role || "full_pair",
    parentCandidateKey: item.parent_candidate_key || "",
    parentRowNumber: Number(item.parent_row_number) || null,
    parentCandidateKeys: arrayValue(item.parent_candidate_keys),
    parentEvidence: arrayValue(item.parent_evidence),
    candidateOrigin: item.candidate_origin || "table-pair",
    termCategory: item.term_category || "",
    extractionConfidence: item.extraction_confidence == null ? null : Number(item.extraction_confidence),
    sourceSpan: item.source_span || null,
    targetSpan: item.target_span || null,
    occurrences: Number(item.frequency) || 1,
    score: Number(item.score) || 0,
    rowNumber: Number(item.row_number) || null,
    decision: item.decision || "review",
    reasons: String(item.reason || "").split("；").map((reason) => reason.trim()).filter(Boolean),
    nested: item.candidate_origin === "nested-term" || Boolean(item.parent_candidate_key),
    status: item.status || "pending"
  }));

  return {
    batchId: batch.id,
    filename: batch.filename || "术语导入表格",
    fileType: batch.file_type || "xlsx",
    requestedLocale: batch.requested_locale || "",
    fileMode,
    sheets: Array.isArray(sheets) ? sheets : [],
    statistics: { ...statistics, rowsScanned: Number(statistics.rowsScanned) || Number(batch.row_count) || 0 },
    ai: savedAi || { requested: Boolean(batch.ai_used), used: Boolean(batch.ai_used), reviewed: 0, total: candidates.length },
    candidates,
    status: batch.status || "reviewing",
    createdAt: batch.date_created || null
  };
}

export async function completeDirectusImport(batchId, decisions, summary) {
  const updates = decisions.filter((item) => item.candidateId).map((item) => ({
    id: item.candidateId,
    status: item.status,
    decision: item.decision || (item.status === "accepted" ? "ready" : "excluded")
  }));
  if (updates.length) await updateItemsInChunks("/items/term_candidates", updates);
  await request(`/items/term_import_batches/${encodeURIComponent(batchId)}`, {
    method: "PATCH",
    body: { status: "completed", summary }
  });
}

export async function rebuildDirectusEmbeddings(locale, { forceLocal = false } = {}) {
  assertLocale(locale);
  const model = embeddingModelName();
  if (!model) {
    const error = new Error("未配置 embedding 模型，无法重建向量索引");
    error.statusCode = 400;
    throw error;
  }
  const stats = { memories: 0, qaCases: 0, evidence: 0 };
  const collection = memoryCollectionFor(locale);
  const memoryItems = await request(`/items/${collection}?limit=-1&fields=id,source,embedding`);
  for (const item of memoryItems) {
    if (item.embedding?.vector?.length && item.embedding?.model === model) continue;
    const embedding = await embedSource(item.source, { forceLocal });
    if (!embedding) {
      const error = new Error("embedding 服务不可用，重建中断");
      error.statusCode = 503;
      throw error;
    }
    await request(`/items/${collection}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { embedding } });
    stats.memories += 1;
  }
  for (const [collectionName, key] of [["qa_cases", "qaCases"], ["style_evidence", "evidence"]]) {
    const params = new URLSearchParams({ limit: "-1", fields: "id,source,embedding" });
    params.set("filter[target_locale][_eq]", locale);
    const items = await request(`/items/${collectionName}?${params}`);
    for (const item of items) {
      if (item.embedding?.vector?.length && item.embedding?.model === model) continue;
      const embedding = await embedSource(item.source, { forceLocal });
      if (!embedding) {
        const error = new Error("embedding 服务不可用，重建中断");
        error.statusCode = 503;
        throw error;
      }
      await request(`/items/${collectionName}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { embedding } });
      stats[key] += 1;
    }
  }
  return stats;
}

export async function demoteDirectusMemories(locale, source, exceptId) {
  const collection = memoryCollectionFor(locale);
  const params = new URLSearchParams({ limit: "-1", fields: "id,quality_status" });
  params.set("filter[source][_eq]", source);
  const items = await request(`/items/${collection}?${params}`);
  const updates = items
    .filter((item) => item.id !== exceptId && item.quality_status !== "rejected")
    .map((item) => ({ id: item.id, quality_status: item.quality_status === "human_approved" ? "machine_verified" : "rejected" }));
  if (updates.length) await request(`/items/${collection}`, { method: "PATCH", body: updates });
  return updates.length;
}

export async function approveDirectusQaCase(id) {
  const saved = await request(`/items/qa_cases/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "human_approved" } });
  return Boolean(saved?.id);
}

function batchMetrics(segments = []) {
  const selected = segments.filter((segment) => segment.selected !== false);
  const completedSegments = selected.filter((segment) => segment.status === "done" && segment.translation).length;
  const failedSegments = selected.filter((segment) => segment.status === "error").length;
  const qaPending = selected.filter((segment) => {
    const result = segment.result || {};
    return Boolean(result.aiQa?.fallbackReason) || (Number.isFinite(result.qaScore) && result.qaScore < 90) || (result.issues || []).length > 0;
  }).length;
  return {
    totalSegments: selected.length, completedSegments, failedSegments, qaPending,
    status: failedSegments ? "needs_attention" : completedSegments < selected.length ? "in_progress" : qaPending ? "review" : "completed"
  };
}

export async function saveDirectusBatchRun(input) {
  const id = String(input.batchId || randomUUID());
  const metrics = batchMetrics(input.segments || []);
  const body = {
    filename: String(input.filename || ""),
    target_locale: assertLocale(input.locale),
    content_type: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    format: String(input.format || ""),
    segmentation_mode: String(input.segmentationMode || "sentence"),
    structure: input.structure ?? null,
    segments: input.segments || [],
    task_status: metrics.status,
    total_segments: metrics.totalSegments,
    completed_segments: metrics.completedSegments,
    failed_segments: metrics.failedSegments,
    qa_pending: metrics.qaPending
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/batch_runs?${params}`);
  if (existing[0]?.id) await request(`/items/batch_runs/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/batch_runs", { method: "POST", body: { ...body, id } });
  return { batchId: id };
}

export async function getDirectusBatchRun(batchId) {
  try {
    const item = await request(`/items/batch_runs/${encodeURIComponent(String(batchId))}?fields=id,filename,target_locale,content_type,domain,format,segmentation_mode,structure,segments,date_updated`);
    return {
      batchId: item.id,
      filename: item.filename || "",
      locale: item.target_locale || "",
      contentType: item.content_type || "general",
      domain: item.domain || "general",
      format: item.format || "",
      segmentationMode: item.segmentation_mode || "sentence",
      structure: item.structure ?? null,
      segments: arrayValue(item.segments),
      updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

function summarizeBatchRun(item) {
  const fallbackMetrics = item.segments ? batchMetrics(arrayValue(item.segments)) : null;
  const totalSegments = item.total_segments == null ? fallbackMetrics?.totalSegments || 0 : Number(item.total_segments);
  const completedSegments = item.completed_segments == null ? fallbackMetrics?.completedSegments || 0 : Number(item.completed_segments);
  const failedSegments = item.failed_segments == null ? fallbackMetrics?.failedSegments || 0 : Number(item.failed_segments);
  const qaPending = item.qa_pending == null ? fallbackMetrics?.qaPending || 0 : Number(item.qa_pending);
  const status = item.task_status || fallbackMetrics?.status || "in_progress";
  return {
    batchId: item.id, filename: item.filename || "未命名任务", locale: item.target_locale || "",
    contentType: item.content_type || "general", domain: item.domain || "general", format: item.format || "",
    segmentationMode: item.segmentation_mode || "sentence", status,
    totalSegments, completedSegments, failedSegments, qaPending,
    createdAt: item.date_created || null, updatedAt: item.date_updated || item.date_created || null
  };
}

export async function listDirectusBatchRuns({ locale = "", status = "", search = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,filename,target_locale,content_type,domain,format,segmentation_mode,task_status,total_segments,completed_segments,failed_segments,qa_pending,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (search) params.set("filter[filename][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/batch_runs?${params}`);
  for (const item of items.filter((entry) => entry.total_segments == null)) {
    const legacy = await request(`/items/batch_runs/${encodeURIComponent(item.id)}?fields=segments`);
    const metrics = batchMetrics(arrayValue(legacy.segments));
    Object.assign(item, { task_status: metrics.status, total_segments: metrics.totalSegments, completed_segments: metrics.completedSegments, failed_segments: metrics.failedSegments, qa_pending: metrics.qaPending });
    await request(`/items/batch_runs/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { task_status: metrics.status, total_segments: metrics.totalSegments, completed_segments: metrics.completedSegments, failed_segments: metrics.failedSegments, qa_pending: metrics.qaPending } });
  }
  const summaries = items.map(summarizeBatchRun);
  return status ? summaries.filter((item) => item.status === status) : summaries;
}

export async function saveDirectusQaTask(input) {
  const id = String(input.id || randomUUID());
  const body = {
    title: String(input.title || String(input.sourceText || "").slice(0, 40) || "未命名质检"),
    target_locale: assertLocale(input.locale),
    content_type: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    source_text: String(input.sourceText || ""),
    translation_text: String(input.translationText || ""),
    source_count: Number(input.segmentCounts?.source) || 0,
    translation_count: Number(input.segmentCounts?.translation) || 0,
    overall_score: input.overallScore ?? null,
    dimension_scores: input.dimensionScores ?? null,
    summary: input.summary ?? null,
    alignment_note: String(input.alignmentNote || ""),
    model: String(input.model || ""),
    report: input.report ?? null
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/qa_tasks?${params}`);
  if (existing[0]?.id) await request(`/items/qa_tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/qa_tasks", { method: "POST", body: { ...body, id } });
  return { id, ...body };
}

export async function getDirectusQaTask(id) {
  try {
    const item = await request(`/items/qa_tasks/${encodeURIComponent(String(id))}?fields=id,title,target_locale,content_type,domain,source_text,translation_text,source_count,translation_count,overall_score,dimension_scores,summary,alignment_note,model,report,date_created,date_updated`);
    return {
      id: item.id, title: item.title || "", locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
      sourceText: item.source_text || "", translationText: item.translation_text || "",
      segmentCounts: { source: Number(item.source_count) || 0, translation: Number(item.translation_count) || 0 },
      overallScore: item.overall_score ?? null, dimensionScores: item.dimension_scores ?? null,
      summary: item.summary ?? null, alignmentNote: item.alignment_note || "", model: item.model || "",
      report: item.report ?? null, createdAt: item.date_created || null, updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusQaTasks({ locale = "", status = "", search = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,title,target_locale,content_type,domain,source_count,overall_score,summary,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (search) params.set("filter[title][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/qa_tasks?${params}`);
  const summaries = items.map((item) => ({
    id: item.id, type: "autoqa", title: item.title || "未命名质检", locale: item.target_locale || "",
    contentType: item.content_type || "general", domain: item.domain || "general",
    status: Number.isFinite(item.overall_score) ? (item.overall_score >= 90 ? "completed" : "review") : "completed",
    overallScore: Number.isFinite(item.overall_score) ? item.overall_score : null,
    totalSegments: Number(item.source_count) || 0, completedSegments: 0, failedSegments: 0,
    qaPending: Object.values(item.summary || {}).reduce((sum, entry) => sum + (Number(entry?.total) || 0), 0),
    createdAt: item.date_created || null, updatedAt: item.date_updated || item.date_created || null
  }));
  return status ? summaries.filter((item) => item.status === status) : summaries;
}

export async function deleteDirectusQaTask(id) {
  try {
    await request(`/items/qa_tasks/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function saveDirectusShare(input) {
  const token = String(input.token || randomUUID().replace(/-/g, ""));
  const body = {
    token,
    batch_id: String(input.batchId || ""),
    qa_task_id: String(input.qaTaskId || ""),
    filename: String(input.filename || "未命名分享"),
    target_locale: assertLocale(input.locale),
    content_type: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    meta: input.meta ?? null,
    segments: Array.isArray(input.segments) ? input.segments.slice(0, 2_000) : [],
    feedbacks: Array.isArray(input.feedbacks) ? input.feedbacks : [],
    status: String(input.status || "ready"),
    glossed_segments: Number(input.glossedSegments) || 0,
    total_segments: Number(input.totalSegments) || (Array.isArray(input.segments) ? input.segments.length : 0)
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[token][_eq]", token);
  const existing = await request(`/items/shares?${params}`);
  if (existing[0]?.id) await request(`/items/shares/${encodeURIComponent(existing[0].id)}`, { method: "PATCH", body });
  else await request("/items/shares", { method: "POST", body });
  return { token, ...body };
}

export async function getDirectusShare(token) {
  try {
    const params = new URLSearchParams({ limit: "1", fields: "id,token,batch_id,qa_task_id,filename,target_locale,content_type,domain,meta,segments,feedbacks,status,glossed_segments,total_segments,date_created,date_updated" });
    params.set("filter[token][_eq]", String(token));
    const items = await request(`/items/shares?${params}`);
    const item = items[0];
    if (!item) return null;
    return {
      token: item.token, batchId: item.batch_id || "", qaTaskId: item.qa_task_id || "", filename: item.filename || "",
      locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
      meta: item.meta ?? null, segments: arrayValue(item.segments), feedbacks: arrayValue(item.feedbacks),
      status: item.status || "ready", glossedSegments: Number(item.glossed_segments) || 0, totalSegments: Number(item.total_segments) || 0,
      createdAt: item.date_created || null, updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusShares({ batchId = "", qaTaskId = "", limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 100))), sort: "-date_updated", fields: "id,token,batch_id,qa_task_id,filename,target_locale,content_type,domain,meta,segments,feedbacks,status,glossed_segments,total_segments,date_created,date_updated" });
  if (batchId) params.set("filter[batch_id][_eq]", String(batchId));
  if (qaTaskId) params.set("filter[qa_task_id][_eq]", String(qaTaskId));
  const items = await request(`/items/shares?${params}`);
  return items.map((item) => ({
    token: item.token, batchId: item.batch_id || "", qaTaskId: item.qa_task_id || "", filename: item.filename || "",
    locale: item.target_locale, contentType: item.content_type || "general", domain: item.domain || "general",
    meta: item.meta ?? null, segments: arrayValue(item.segments), feedbacks: arrayValue(item.feedbacks),
    status: item.status || "ready", glossedSegments: Number(item.glossed_segments) || 0, totalSegments: Number(item.total_segments) || 0,
    createdAt: item.date_created || null, updatedAt: item.date_updated || null
  }));
}

export async function updateDirectusShare(token, updater) {
  const current = await getDirectusShare(token);
  if (!current) return null;
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[token][_eq]", String(token));
  const existing = await request(`/items/shares?${params}`);
  if (!existing[0]?.id) return null;
  await request(`/items/shares/${encodeURIComponent(existing[0].id)}`, {
    method: "PATCH",
    body: {
      filename: next.filename,
      meta: next.meta ?? null,
      segments: next.segments,
      feedbacks: next.feedbacks,
      status: next.status ?? "ready",
      glossed_segments: Number(next.glossedSegments) || 0,
      total_segments: Number(next.totalSegments) || 0
    }
  });
  return next;
}

export async function deleteDirectusShare(token) {
  try {
    const params = new URLSearchParams({ limit: "1", fields: "id" });
    params.set("filter[token][_eq]", String(token));
    const existing = await request(`/items/shares?${params}`);
    if (existing[0]?.id) {
      await request(`/items/shares/${encodeURIComponent(existing[0].id)}`, { method: "DELETE" });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function saveDirectusBackgroundTask(input) {
  const id = String(input.id || randomUUID());
  const body = {
    task_type: String(input.type || "term_import"),
    title: String(input.title || "后台任务"),
    target_locale: input.locale ? assertLocale(input.locale) : null,
    status: String(input.status || "in_progress"),
    progress: input.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
    payload: input.payload ?? {}
  };
  const params = new URLSearchParams({ limit: "1", fields: "id" });
  params.set("filter[id][_eq]", id);
  const existing = await request(`/items/background_tasks?${params}`);
  if (existing[0]?.id) await request(`/items/background_tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
  else await request("/items/background_tasks", { method: "POST", body: { ...body, id } });
  return { id, ...body };
}

export async function getDirectusBackgroundTask(id) {
  try {
    const item = await request(`/items/background_tasks/${encodeURIComponent(String(id))}?fields=id,task_type,title,target_locale,status,progress,payload,date_created,date_updated`);
    return {
      id: item.id, type: item.task_type || "term_import", title: item.title || "",
      locale: item.target_locale || "", status: item.status || "in_progress",
      progress: item.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
      payload: item.payload ?? {},
      createdAt: item.date_created || null, updatedAt: item.date_updated || null
    };
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function listDirectusBackgroundTasks({ locale = "", status = "", search = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, Number(limit) || 200))), sort: "-date_updated,-date_created", fields: "id,task_type,title,target_locale,status,progress,payload,date_created,date_updated" });
  if (locale) params.set("filter[target_locale][_eq]", assertLocale(locale));
  if (search) params.set("filter[title][_icontains]", String(search).slice(0, 120));
  const items = await request(`/items/background_tasks?${params}`);
  const tasks = items.map((item) => ({
    id: item.id, type: item.task_type || "term_import", title: item.title || "",
    locale: item.target_locale || "", status: item.status || "in_progress",
    progress: item.progress ?? { percent: 0, phase: "queued", message: "已进入后台队列", completed: 0, total: 0 },
    payload: item.payload ?? {},
    createdAt: item.date_created || null, updatedAt: item.date_updated || null
  }));
  return status ? tasks.filter((item) => item.status === status) : tasks;
}

export async function deleteDirectusBackgroundTask(id) {
  try {
    await request(`/items/background_tasks/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    return true;
  } catch (error) {
    if (isMissingItem(error)) return false;
    throw error;
  }
}

export async function findDirectusStyleProfile(id) {
  const fields = "id,name,target_locale,content_type,domain,instructions,examples,rules,version,parent_id,evidence_count,generated_by,source_batch_id,learning_run_id,evaluation,status,date_updated";
  const shape = (item, kind) => ({
    id: item.id, name: item.name, locale: item.target_locale,
    contentType: item.content_type || "", domain: item.domain || "general",
    instruction: item.instructions, examples: arrayValue(item.examples), rules: arrayValue(item.rules),
    version: Number(item.version) || 1, parentId: item.parent_id || null,
    evidenceCount: Number(item.evidence_count) || 0, evaluation: item.evaluation || null,
    status: item.status, kind, updatedAt: item.date_updated
  });
  try {
    const item = await request(`/items/style_profiles/${encodeURIComponent(id)}?fields=${fields}`);
    if (item) return shape(item, "style");
  } catch { /* 不是风格规范就继续找译者画像 */ }
  try {
    const item = await request(`/items/user_profiles/${encodeURIComponent(id)}?fields=id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated`);
    if (item) return shape(item, "user_profile");
  } catch { /* 两张表都没有就是不存在 */ }
  return null;
}

/**
 * Patch the rules of an existing style profile in place.
 *
 * Distillation always writes a NEW version row; retiring one conflicting rule
 * must not, or every approved conflict resolution would spawn a version that
 * then needs its own evaluation and activation before the contradiction
 * actually leaves the prompt.
 */
export async function updateDirectusStyleProfileRules(id, { rules, instruction }) {
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, {
    method: "PATCH", body: { rules, instructions: instruction }
  });
  return saved ? { id: saved.id, rules: arrayValue(saved.rules), instruction: saved.instructions } : null;
}

export async function saveDirectusStyleProfileEvaluation(id, evaluation) {
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { evaluation } });
  return saved ? { id: saved.id, evaluation: saved.evaluation ?? evaluation } : null;
}

export async function listDirectusStyleProfiles(locale, status, scope = null) {
  assertLocale(locale);
  const styleParams = new URLSearchParams({ limit: "50", sort: "-version,-date_updated", fields: "id,name,target_locale,content_type,content_tags,domain,instructions,examples,rules,version,parent_id,evidence_count,generated_by,source_batch_id,learning_run_id,evaluation,status,date_updated" });
  styleParams.set("filter[target_locale][_eq]", locale);
  if (status) styleParams.set("filter[status][_eq]", status);
  if (scope?.contentType) {
    // Without this the shared 50-row page is sorted by version across all
    // scopes, so a young scope's draft can fall off the end and the distill
    // gate would mistake it for "no draft pending".
    styleParams.set("filter[content_type][_eq]", scope.contentType);
    styleParams.set("filter[domain][_eq]", scope.domain || "general");
  }
  const styleProfiles = await request(`/items/style_profiles?${styleParams}`);
  const profileParams = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,name,target_locale,instructions,examples,version,parent_id,evidence_count,status,date_updated" });
  profileParams.set("filter[target_locale][_eq]", locale);
  if (status) profileParams.set("filter[status][_eq]", status);
  const userProfiles = await request(`/items/user_profiles?${profileParams}`);
  return {
    styleProfiles: styleProfiles.map((item) => ({
      id: item.id, name: item.name, locale: item.target_locale, contentType: item.content_type, contentTags: arrayValue(item.content_tags), domain: item.domain || "general",
      instruction: item.instructions, examples: arrayValue(item.examples), rules: arrayValue(item.rules), version: Number(item.version) || 1,
      parentId: item.parent_id || null, evidenceCount: Number(item.evidence_count) || 0,
      sourceBatchId: item.source_batch_id || "", learningRunId: item.learning_run_id || "",
      evaluation: item.evaluation || null,
      status: item.status, updatedAt: item.date_updated
    })),
    userProfiles: userProfiles.map((item) => ({
      id: item.id, name: item.name, locale: item.target_locale, instruction: item.instructions, examples: arrayValue(item.examples), rules: arrayValue(item.rules),
      version: Number(item.version) || 1, parentId: item.parent_id || null, evidenceCount: Number(item.evidence_count) || 0, status: item.status, updatedAt: item.date_updated
    }))
  };
}

export async function activateDirectusStyleProfile(id) {
  let target;
  try {
    target = await request(`/items/style_profiles/${encodeURIComponent(id)}?fields=id,target_locale,content_type,domain,status`);
  } catch (error) {
    if (isMissingItem(error)) {
      target = await request(`/items/user_profiles/${encodeURIComponent(id)}?fields=id,target_locale,status`);
      const deactivate = await request(`/items/user_profiles?limit=-1&fields=id,status&filter[target_locale][_eq]=${target.target_locale}&filter[status][_eq]=active`);
      if (deactivate.length) await request("/items/user_profiles", { method: "PATCH", body: deactivate.map((item) => ({ id: item.id, status: "inactive" })) });
      const saved = await request(`/items/user_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "active" } });
      return { id: saved.id, kind: "user_profile", status: "active" };
    }
    throw error;
  }
  const params = new URLSearchParams({ limit: "-1", fields: "id,status" });
  params.set("filter[target_locale][_eq]", target.target_locale);
  params.set("filter[content_type][_eq]", target.content_type);
  params.set("filter[status][_eq]", "active");
  const activeOthers = await request(`/items/style_profiles?${params}`);
  const updates = activeOthers.filter((item) => item.domain === target.domain && item.id !== id).map((item) => ({ id: item.id, status: "inactive" }));
  if (updates.length) await request("/items/style_profiles", { method: "PATCH", body: updates });
  const saved = await request(`/items/style_profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "active" } });
  return { id: saved.id, kind: "style_profile", status: "active" };
}

export async function rejectDirectusStyleProfile(id) {
  for (const collection of ["style_profiles", "user_profiles"]) {
    try {
      const saved = await request(`/items/${collection}/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "inactive" } });
      return { id: saved.id, kind: collection === "style_profiles" ? "style_profile" : "user_profile", status: "inactive" };
    } catch (error) {
      // Directus deliberately returns 403 for a missing id as well as for an
      // inaccessible one. An id from user_profiles therefore gets 403 on the
      // first style_profiles probe and must continue to the second collection.
      if (!isMissingItem(error)) throw error;
    }
  }
  const error = new Error("未找到该风格规范");
  error.statusCode = 404;
  throw error;
}

export async function listDirectusPendingQaCases(locale) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-date_created", fields: "id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  params.set("filter[status][_eq]", "review");
  const items = await request(`/items/qa_cases?${params}`);
  return items.map((item) => ({
    id: item.id, locale: item.target_locale, contentType: item.content_type, domain: item.domain || "general", source: item.source,
    rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation, issues: arrayValue(item.issues),
    scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0, status: item.status, createdAt: item.date_created
  }));
}

export async function disposeDirectusQaCase(id) {
  await request(`/items/qa_cases/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

const LEARNING_TRAJECTORY_STATUSES = new Set(["running", "completed", "review", "failed"]);
const TRANSLATION_SKILL_STATUSES = new Set(["champion", "challenger", "draft", "inactive", "rejected"]);
const SKILL_EVALUATION_DECISIONS = new Set(["pending", "promote", "reject", "needs_review"]);

function assertLearningChoice(value, allowed, label) {
  if (!allowed.has(value)) {
    const error = new Error(`Unsupported ${label}: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function directusJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return structuredClone(fallback);
}

function directusLearningScope(input, fallback = {}) {
  return {
    locale: assertLocale(input.locale ?? fallback.locale),
    contentType: String(input.contentType ?? fallback.contentType ?? "general").trim() || "general",
    domain: String(input.domain ?? fallback.domain ?? "general").trim() || "general",
    project: String(input.project ?? fallback.project ?? "default").trim() || "default"
  };
}

function sameDirectusLearningScope(left, right) {
  return left.locale === right.locale
    && left.contentType === right.contentType
    && left.domain === right.domain
    && left.project === right.project;
}

function translationSkillScopeKey(scope) {
  const normalized = directusLearningScope(scope);
  return createHash("sha256")
    .update([normalized.locale, normalized.contentType, normalized.domain, normalized.project].join("\u0000"))
    .digest("hex");
}

function translationSkillVersionKey(scope, version) {
  return createHash("sha256")
    .update(`${translationSkillScopeKey(scope)}\u0000${Math.max(1, Number(version) || 1)}`)
    .digest("hex");
}

function directusConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertDirectusImmutable(existing, patch, fields) {
  for (const field of fields) {
    if (Object.hasOwn(patch, field) && patch[field] != null && String(patch[field]) !== String(existing[field] ?? "")) {
      throw directusConflict(`${field} is immutable after creation`);
    }
  }
}

function addLearningScopeFilters(params, filters = {}) {
  if (filters.locale) params.set("filter[target_locale][_eq]", assertLocale(filters.locale));
  if (filters.contentType) params.set("filter[content_type][_eq]", filters.contentType);
  if (filters.domain) params.set("filter[domain][_eq]", filters.domain);
  if (filters.project) params.set("filter[project][_eq]", filters.project);
  return params;
}

function directusListLimit(value, fallback = 100) {
  return String(Math.min(1_000, Math.max(1, Number(value) || fallback)));
}

function mapLearningTrajectory(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    batchId: item.batch_id || "",
    segmentId: item.segment_id || "",
    source: item.source || "",
    initialTranslation: item.initial_translation || "",
    finalTranslation: item.final_translation || "",
    contextPack: directusJson(item.context_pack),
    assetRefs: directusJson(item.asset_refs, []),
    termDecisions: directusJson(item.term_decisions, []),
    qaBefore: directusJson(item.qa_before),
    qaAfter: directusJson(item.qa_after),
    humanDecision: directusJson(item.human_decision),
    events: directusJson(item.events, []),
    model: item.model || "",
    promptVersion: item.prompt_version || "",
    status: item.status || "running",
    error: item.error || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function learningTrajectoryBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  const status = assertLearningChoice(input.status ?? fallback.status ?? "running", LEARNING_TRAJECTORY_STATUSES, "learning trajectory status");
  const source = String(input.source ?? fallback.source ?? "");
  if (!source) {
    const error = new Error("Learning trajectory source cannot be empty");
    error.statusCode = 400;
    throw error;
  }
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    batch_id: String(input.batchId ?? fallback.batchId ?? ""),
    segment_id: String(input.segmentId ?? fallback.segmentId ?? ""),
    source,
    initial_translation: String(input.initialTranslation ?? fallback.initialTranslation ?? ""),
    final_translation: String(input.finalTranslation ?? fallback.finalTranslation ?? ""),
    context_pack: directusJson(input.contextPack ?? fallback.contextPack),
    asset_refs: directusJson(input.assetRefs ?? fallback.assetRefs, []),
    term_decisions: directusJson(input.termDecisions ?? fallback.termDecisions, []),
    qa_before: directusJson(input.qaBefore ?? fallback.qaBefore),
    qa_after: directusJson(input.qaAfter ?? fallback.qaAfter),
    human_decision: directusJson(input.humanDecision ?? fallback.humanDecision),
    events: directusJson(input.events ?? fallback.events, []),
    model: String(input.model ?? fallback.model ?? ""),
    prompt_version: String(input.promptVersion ?? fallback.promptVersion ?? ""),
    status,
    error: String(input.error ?? fallback.error ?? "")
  };
}

function learningTrajectoryPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("initialTranslation", "initial_translation", (value) => String(value ?? ""));
  assign("finalTranslation", "final_translation", (value) => String(value ?? ""));
  assign("contextPack", "context_pack", (value) => directusJson(value));
  assign("assetRefs", "asset_refs", (value) => directusJson(value, []));
  assign("termDecisions", "term_decisions", (value) => directusJson(value, []));
  assign("qaBefore", "qa_before", (value) => directusJson(value));
  assign("qaAfter", "qa_after", (value) => directusJson(value));
  assign("humanDecision", "human_decision", (value) => directusJson(value));
  assign("events", "events", (value) => directusJson(value, []));
  assign("model", "model", (value) => String(value ?? ""));
  assign("promptVersion", "prompt_version", (value) => String(value ?? ""));
  assign("status", "status", (value) => assertLearningChoice(value, LEARNING_TRAJECTORY_STATUSES, "learning trajectory status"));
  assign("error", "error", (value) => String(value ?? ""));
  return body;
}

export async function saveDirectusLearningTrajectory(input) {
  if (input.id) {
    const existing = await getDirectusLearningTrajectory(input.id);
    if (existing) return updateDirectusLearningTrajectory(input.id, input);
  }
  const body = learningTrajectoryBody(input);
  const saved = await request("/items/learning_trajectories", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } });
  return mapLearningTrajectory(saved);
}

export async function listDirectusLearningTrajectories(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-date_updated,-date_created", fields: "*" }), filters);
  if (filters.batchId) params.set("filter[batch_id][_eq]", filters.batchId);
  if (filters.status) params.set("filter[status][_eq]", filters.status);
  return (await request(`/items/learning_trajectories?${params}`)).map(mapLearningTrajectory);
}

export async function getDirectusLearningTrajectory(id) {
  try {
    return mapLearningTrajectory(await request(`/items/learning_trajectories/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function updateDirectusLearningTrajectory(id, patch) {
  const existing = await getDirectusLearningTrajectory(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "batchId", "segmentId", "source"]);
  const body = learningTrajectoryPatch(patch);
  if (!Object.keys(body).length) return existing;
  const saved = await request(`/items/learning_trajectories/${encodeURIComponent(String(id))}`, { method: "PATCH", body });
  return mapLearningTrajectory(saved);
}

function mapTranslationSkill(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    name: item.name || "",
    description: item.description || "",
    changeReason: item.change_reason || "",
    version: Number(item.version) || 1,
    parentId: item.parent_id || null,
    status: item.status || "draft",
    strategy: directusJson(item.strategy),
    evidenceIds: directusJson(item.evidence_ids, []),
    promptVersion: item.prompt_version || "",
    metrics: directusJson(item.metrics),
    metadata: directusJson(item.metadata),
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function translationSkillBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    name: String(input.name ?? fallback.name ?? `${scope.locale} ${scope.contentType} translation skill`).trim(),
    description: String(input.description ?? fallback.description ?? ""),
    change_reason: String(input.changeReason ?? fallback.changeReason ?? ""),
    version: Math.max(1, Number(input.version ?? fallback.version) || 1),
    parent_id: input.parentId === null ? null : String(input.parentId ?? fallback.parentId ?? "") || null,
    status: assertLearningChoice(input.status ?? fallback.status ?? "draft", TRANSLATION_SKILL_STATUSES, "translation skill status"),
    strategy: directusJson(input.strategy ?? fallback.strategy),
    evidence_ids: directusJson(input.evidenceIds ?? fallback.evidenceIds, []),
    prompt_version: String(input.promptVersion ?? fallback.promptVersion ?? ""),
    metrics: directusJson(input.metrics ?? fallback.metrics),
    metadata: directusJson(input.metadata ?? fallback.metadata),
    version_scope_key: translationSkillVersionKey(scope, input.version ?? fallback.version),
    champion_scope_key: input.status === "champion" ? translationSkillScopeKey(scope) : null
  };
}

function translationSkillPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("name", "name", (value) => String(value ?? "").trim());
  assign("description", "description", (value) => String(value ?? ""));
  assign("changeReason", "change_reason", (value) => String(value ?? ""));
  assign("strategy", "strategy", (value) => directusJson(value));
  assign("evidenceIds", "evidence_ids", (value) => directusJson(value, []));
  assign("promptVersion", "prompt_version", (value) => String(value ?? ""));
  assign("metrics", "metrics", (value) => directusJson(value));
  assign("metadata", "metadata", (value) => directusJson(value));
  assign("status", "status", (value) => assertLearningChoice(value, TRANSLATION_SKILL_STATUSES, "translation skill status"));
  return body;
}

async function latestDirectusTranslationSkill(scope) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: "1", sort: "-version,-date_updated", fields: "*" }), scope);
  return mapTranslationSkill((await request(`/items/translation_skills?${params}`))[0]);
}

export async function saveDirectusTranslationSkill(input) {
  if (input.id) {
    const existing = await getDirectusTranslationSkill(input.id);
    if (existing) return updateDirectusTranslationSkill(input.id, input);
  }
  const scope = directusLearningScope(input);
  const previous = await latestDirectusTranslationSkill(scope);
  const version = Math.max(1, Number(input.version) || (Number(previous?.version) || 0) + 1);
  const versionParams = addLearningScopeFilters(new URLSearchParams({ limit: "1", fields: "id" }), scope);
  versionParams.set("filter[version][_eq]", String(version));
  if ((await request(`/items/translation_skills?${versionParams}`))[0]) throw directusConflict(`Translation skill version ${version} already exists in this scope`);
  const parentId = input.parentId === null ? null : input.parentId || previous?.id || null;
  if (parentId) {
    const parent = await getDirectusTranslationSkill(parentId);
    if (!parent || !sameDirectusLearningScope(parent, scope)) throw directusConflict("Translation skill parent must exist in the same scope");
  }
  const requestedStatus = assertLearningChoice(input.status || "draft", TRANSLATION_SKILL_STATUSES, "translation skill status");
  const body = translationSkillBody({
    ...input,
    ...scope,
    version,
    parentId,
    status: requestedStatus === "champion" ? "draft" : requestedStatus
  });
  const saved = mapTranslationSkill(await request("/items/translation_skills", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } }));
  return requestedStatus === "champion" ? activateDirectusTranslationSkill(saved.id) : saved;
}

export async function listDirectusTranslationSkills(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-version,-date_updated", fields: "*" }), filters);
  if (filters.status) params.set("filter[status][_eq]", filters.status);
  return (await request(`/items/translation_skills?${params}`)).map(mapTranslationSkill);
}

export async function getDirectusTranslationSkill(id) {
  try {
    return mapTranslationSkill(await request(`/items/translation_skills/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function updateDirectusTranslationSkill(id, patch) {
  const existing = await getDirectusTranslationSkill(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "version", "parentId"]);
  const requestedStatus = Object.hasOwn(patch, "status") ? assertLearningChoice(patch.status, TRANSLATION_SKILL_STATUSES, "translation skill status") : null;
  if (existing.status === "champion" && requestedStatus && requestedStatus !== "champion") {
    throw directusConflict("The current champion must be replaced or rolled back, not directly deactivated");
  }
  if (existing.status === "rejected" && requestedStatus && requestedStatus !== "rejected") {
    throw directusConflict("Rejected translation skill cannot be reactivated through update");
  }
  const body = translationSkillPatch(patch);
  if (requestedStatus === "champion") delete body.status;
  else if (requestedStatus) body.champion_scope_key = null;
  let saved = existing;
  if (Object.keys(body).length) saved = mapTranslationSkill(await request(`/items/translation_skills/${encodeURIComponent(String(id))}`, { method: "PATCH", body }));
  return requestedStatus === "champion" ? activateDirectusTranslationSkill(saved.id) : saved;
}

export async function activateDirectusTranslationSkill(id, { rollback = false } = {}) {
  const target = await getDirectusTranslationSkill(id);
  if (!target) return null;
  if (target.status === "rejected") throw directusConflict("Rejected translation skill cannot be activated");
  const params = addLearningScopeFilters(new URLSearchParams({ limit: "-1", sort: "-version,-date_updated", fields: "id,target_locale,content_type,domain,project,parent_id,version,status" }), target);
  params.set("filter[status][_eq]", "champion");
  const current = (await request(`/items/translation_skills?${params}`)).map(mapTranslationSkill);
  const otherChampions = current.filter((item) => item.id !== target.id);
  if (otherChampions.length && target.status !== "champion") {
    const isChildOfCurrent = otherChampions.some((item) => target.parentId === item.id);
    const isRollbackTarget = rollback && otherChampions.some((item) => item.parentId === target.id);
    if (!isChildOfCurrent && !isRollbackTarget) throw directusConflict("Translation skill was not evaluated against the current champion");
  }
  const updates = [
    ...otherChampions.map((item) => ({ id: item.id, status: "inactive", champion_scope_key: null })),
    { id: target.id, status: "champion", champion_scope_key: translationSkillScopeKey(target) }
  ];
  try {
    await request("/items/translation_skills", { method: "PATCH", body: updates, timeoutMs: DIRECTUS_BULK_WRITE_TIMEOUT_MS });
  } catch (error) {
    if (/champion_scope_key|unique|duplicate/i.test(error.message)) error.statusCode = 409;
    throw error;
  }
  return getDirectusTranslationSkill(target.id);
}

export async function rollbackDirectusTranslationSkill(id) {
  const current = await getDirectusTranslationSkill(id);
  if (!current) return null;
  if (current.status !== "champion") {
    const error = new Error("Only the current champion translation skill can be rolled back");
    error.statusCode = 409;
    throw error;
  }
  let parent = current.parentId ? await getDirectusTranslationSkill(current.parentId) : null;
  if (parent && (parent.status === "rejected" || parent.locale !== current.locale || parent.contentType !== current.contentType || parent.domain !== current.domain || parent.project !== current.project)) parent = null;
  if (!parent) {
    const candidates = await listDirectusTranslationSkills({ locale: current.locale, contentType: current.contentType, domain: current.domain, project: current.project, limit: 1_000 });
    parent = candidates.filter((item) => item.id !== current.id && item.status !== "rejected" && item.version < current.version).sort((a, b) => b.version - a.version)[0] || null;
  }
  if (!parent) {
    const error = new Error("No previous translation skill version is available for rollback");
    error.statusCode = 409;
    throw error;
  }
  const champion = await activateDirectusTranslationSkill(parent.id, { rollback: true });
  return { rolledBack: await getDirectusTranslationSkill(current.id), champion };
}

function mapSkillEvaluation(item) {
  if (!item) return null;
  return {
    id: item.id,
    locale: item.target_locale,
    contentType: item.content_type || "general",
    domain: item.domain || "general",
    project: item.project || "default",
    championSkillId: item.champion_skill_id || "",
    challengerSkillId: item.challenger_skill_id || "",
    sampleCount: Number(item.sample_count) || 0,
    championMetrics: directusJson(item.champion_metrics),
    challengerMetrics: directusJson(item.challenger_metrics),
    metricDeltas: directusJson(item.metric_deltas),
    decision: item.decision || "pending",
    report: directusJson(item.report),
    evaluator: item.evaluator || "",
    createdAt: item.date_created || null,
    updatedAt: item.date_updated || item.date_created || null
  };
}

function skillEvaluationBody(input, fallback = {}) {
  const scope = directusLearningScope(input, fallback);
  const championSkillId = String(input.championSkillId ?? fallback.championSkillId ?? "");
  const challengerSkillId = String(input.challengerSkillId ?? fallback.challengerSkillId ?? "");
  if (!championSkillId || !challengerSkillId || championSkillId === challengerSkillId) {
    const error = new Error("Skill evaluation requires distinct championSkillId and challengerSkillId");
    error.statusCode = 400;
    throw error;
  }
  return {
    target_locale: scope.locale,
    content_type: scope.contentType,
    domain: scope.domain,
    project: scope.project,
    champion_skill_id: championSkillId,
    challenger_skill_id: challengerSkillId,
    sample_count: Math.max(0, Number(input.sampleCount ?? fallback.sampleCount) || 0),
    champion_metrics: directusJson(input.championMetrics ?? fallback.championMetrics),
    challenger_metrics: directusJson(input.challengerMetrics ?? fallback.challengerMetrics),
    metric_deltas: directusJson(input.metricDeltas ?? fallback.metricDeltas),
    decision: assertLearningChoice(input.decision ?? fallback.decision ?? "pending", SKILL_EVALUATION_DECISIONS, "skill evaluation decision"),
    report: directusJson(input.report ?? fallback.report),
    evaluator: String(input.evaluator ?? fallback.evaluator ?? "")
  };
}

function mapSkillEvaluationBody(body) {
  return {
    locale: body.target_locale,
    contentType: body.content_type,
    domain: body.domain,
    project: body.project,
    championSkillId: body.champion_skill_id,
    challengerSkillId: body.challenger_skill_id,
    decision: body.decision
  };
}

async function validateDirectusSkillEvaluation(input) {
  const [champion, challenger] = await Promise.all([
    getDirectusTranslationSkill(input.championSkillId),
    getDirectusTranslationSkill(input.challengerSkillId)
  ]);
  if (!champion || champion.status !== "champion" || !sameDirectusLearningScope(champion, input)) {
    throw directusConflict("Skill evaluation champion is not the current champion in this scope");
  }
  if (!challenger || !["challenger", "draft"].includes(challenger.status) || !sameDirectusLearningScope(challenger, input)) {
    throw directusConflict("Skill evaluation challenger is not an active candidate in this scope");
  }
}

function skillEvaluationPatch(patch) {
  const body = {};
  const assign = (key, field, normalize = (value) => value) => {
    if (Object.hasOwn(patch, key)) body[field] = normalize(patch[key]);
  };
  assign("sampleCount", "sample_count", (value) => Math.max(0, Number(value) || 0));
  assign("championMetrics", "champion_metrics", (value) => directusJson(value));
  assign("challengerMetrics", "challenger_metrics", (value) => directusJson(value));
  assign("metricDeltas", "metric_deltas", (value) => directusJson(value));
  assign("decision", "decision", (value) => assertLearningChoice(value, SKILL_EVALUATION_DECISIONS, "skill evaluation decision"));
  assign("report", "report", (value) => directusJson(value));
  assign("evaluator", "evaluator", (value) => String(value ?? ""));
  return body;
}

export async function saveDirectusSkillEvaluation(input) {
  if (input.id) {
    const existing = await getDirectusSkillEvaluation(input.id);
    if (existing) return updateDirectusSkillEvaluation(input.id, input);
  }
  const body = skillEvaluationBody(input);
  await validateDirectusSkillEvaluation(mapSkillEvaluationBody(body));
  return mapSkillEvaluation(await request("/items/skill_evaluations", { method: "POST", body: { ...(input.id ? { id: input.id } : {}), ...body } }));
}

export async function listDirectusSkillEvaluations(filters = {}) {
  const params = addLearningScopeFilters(new URLSearchParams({ limit: directusListLimit(filters.limit), sort: "-date_updated,-date_created", fields: "*" }), filters);
  if (filters.decision) params.set("filter[decision][_eq]", filters.decision);
  if (filters.championSkillId) params.set("filter[champion_skill_id][_eq]", filters.championSkillId);
  if (filters.challengerSkillId) params.set("filter[challenger_skill_id][_eq]", filters.challengerSkillId);
  return (await request(`/items/skill_evaluations?${params}`)).map(mapSkillEvaluation);
}

export async function getDirectusSkillEvaluation(id) {
  try {
    return mapSkillEvaluation(await request(`/items/skill_evaluations/${encodeURIComponent(String(id))}?fields=*`));
  } catch (error) {
    if (isMissingItem(error)) return null;
    throw error;
  }
}

export async function updateDirectusSkillEvaluation(id, patch) {
  const existing = await getDirectusSkillEvaluation(id);
  if (!existing) return null;
  assertDirectusImmutable(existing, patch, ["locale", "contentType", "domain", "project", "championSkillId", "challengerSkillId"]);
  const body = skillEvaluationPatch(patch);
  if (body.decision === "promote") await validateDirectusSkillEvaluation({ ...existing, decision: body.decision });
  if (!Object.keys(body).length) return existing;
  return mapSkillEvaluation(await request(`/items/skill_evaluations/${encodeURIComponent(String(id))}`, { method: "PATCH", body }));
}

export function getDirectusMetadata() {
  const { baseUrl } = config();
  return {
    type: "directus",
    label: "Directus + PostgreSQL",
    url: baseUrl,
    adminUrl: `${baseUrl}/admin/content/terms_ja_jp`,
    collections: LOCALE_COLLECTIONS
  };
}
