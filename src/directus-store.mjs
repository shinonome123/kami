import { randomUUID } from "node:crypto";
import { assertLocale } from "./config.mjs";

export const LOCALE_COLLECTIONS = Object.freeze({
  "ja-JP": "terms_ja_jp",
  "ko-KR": "terms_ko_kr",
  "zh-Hant-TW": "terms_zh_hant_tw",
  "th-TH": "terms_th_th"
});

export const MEMORY_COLLECTIONS = Object.freeze({
  "ja-JP": "translation_memory_ja_jp",
  "ko-KR": "translation_memory_ko_kr",
  "zh-Hant-TW": "translation_memory_zh_hant_tw",
  "th-TH": "translation_memory_th_th"
});

function config() {
  const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
  const token = process.env.DIRECTUS_TOKEN;
  if (!token) throw new Error("KAMI_STORE=directus requires DIRECTUS_TOKEN");
  return { baseUrl, token };
}

async function request(path, { method = "GET", body } = {}) {
  const { baseUrl, token } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const details = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
    const error = new Error(`Directus ${method} ${path} failed (${response.status}): ${details}`);
    error.statusCode = response.status >= 500 ? 503 : response.status;
    throw error;
  }
  return payload?.data ?? payload;
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
    enforcement: item.enforcement || "required",
    note: item.note || "",
    status: item.status || "draft",
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
    enforcement: input.enforcement || "required",
    note: String(input.note || "").trim(),
    status: input.status || "approved",
    provenance: input.provenance || "kami-workbench"
  };
}

export async function initializeDirectusStore() {
  const health = await fetch(`${config().baseUrl}/server/ping`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Directus health check failed (${health.status})`);
  await Promise.all([...Object.values(LOCALE_COLLECTIONS), ...Object.values(MEMORY_COLLECTIONS)].map((collection) => request(`/items/${collection}?limit=1&fields=id`)));
}

export async function getDirectusMemories(locale, { contentType = "general", domain = "general", limit = 500 } = {}) {
  const collection = memoryCollectionFor(locale);
  const params = new URLSearchParams({ limit: String(Math.min(1000, limit)), sort: "-date_updated,-date_created", fields: "id,source,target,domain,content_type,channel,style_profile_id,quality_status,qa_score,provenance,source_file,batch_id,source_row,date_created,date_updated" });
  if (contentType) params.set("filter[content_type][_eq]", contentType);
  const items = await request(`/items/${collection}?${params}`);
  return items.filter((item) => !domain || domain === "general" || item.domain === domain || item.domain === "general").map((item) => ({
    id: item.id,
    source: item.source,
    target: item.target,
    domain: item.domain || "general",
    contentType: item.content_type || "general",
    channel: item.channel || "",
    styleProfileId: item.style_profile_id || "",
    qualityStatus: item.quality_status || "provisional",
    qaScore: Number(item.qa_score) || 0,
    provenance: item.provenance || "directus",
    sourceFile: item.source_file || "",
    batchId: item.batch_id || "",
    sourceRow: item.source_row || null,
    createdAt: item.date_created,
    updatedAt: item.date_updated
  }));
}

export async function saveDirectusMemory(locale, input) {
  const collection = memoryCollectionFor(locale);
  const source = String(input.source || "").trim();
  const target = String(input.target || "").trim();
  if (!source || !target) throw new Error("翻译记忆的中外文不能为空");
  const params = new URLSearchParams({ limit: "1", fields: "id,quality_status,qa_score" });
  params.set("filter[source][_eq]", source);
  params.set("filter[target][_eq]", target);
  const existing = await request(`/items/${collection}?${params}`);
  const body = {
    source,
    target,
    domain: input.domain || "general",
    content_type: input.contentType || "general",
    channel: input.channel || "",
    style_profile_id: input.styleProfileId || "",
    quality_status: input.qualityStatus || "provisional",
    qa_score: Number(input.qaScore) || null,
    provenance: input.provenance || "kami-workbench",
    source_file: input.sourceFile || "",
    batch_id: input.batchId || "",
    source_row: Number(input.sourceRow) || null
  };
  const saved = existing[0]
    ? await request(`/items/${collection}/${existing[0].id}`, { method: "PATCH", body })
    : await request(`/items/${collection}`, { method: "POST", body });
  return { id: saved.id, locale, source: saved.source, target: saved.target, qualityStatus: saved.quality_status, qaScore: Number(saved.qa_score) || 0 };
}

export async function getDirectusStyleProfile(locale, contentType, domain = "general") {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: "20", sort: "-version,-date_updated", fields: "id,name,target_locale,content_type,domain,instructions,examples,version,parent_id,evidence_count,evidence_ids,generated_by,status,date_updated" });
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
    domain: profile.domain || "general",
    instruction: profile.instructions,
    examples: arrayValue(profile.examples),
    version: Number(profile.version) || 1,
    evidenceCount: Number(profile.evidence_count) || 0,
    updatedAt: profile.date_updated
  };
}

export async function saveDirectusStyleEvidence(input) {
  const saved = await request("/items/style_evidence", { method: "POST", body: {
    target_locale: assertLocale(input.locale),
    content_type: input.contentType || "general",
    domain: input.domain || "general",
    source: String(input.source || "").trim(),
    target: String(input.target || "").trim(),
    source_file: input.sourceFile || "",
    source_row: Number(input.sourceRow) || null,
    status: input.status || "accepted"
  } });
  return { id: saved.id, ...input };
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
    domain: input.domain || "general",
    instructions: input.instruction,
    examples: input.examples || [],
    version: (Number(previous?.version) || 0) + 1,
    parent_id: previous?.id || null,
    evidence_count: Number(input.evidenceCount) || 0,
    evidence_ids: input.evidenceIds || [],
    generated_by: input.generatedBy || "",
    status: input.status || "active"
  } });
  if (previous?.id && saved.status === "active") await request(`/items/style_profiles/${previous.id}`, { method: "PATCH", body: { status: "inactive" } });
  return { id: saved.id, name: saved.name, source: "style-library", instruction: saved.instructions, examples: saved.examples || [], version: saved.version, locale, contentType: saved.content_type, domain: saved.domain };
}

export async function saveDirectusQaRun(input) {
  return request("/items/qa_runs", { method: "POST", body: {
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, initial_translation: input.initialTranslation, final_translation: input.finalTranslation,
    score: input.score, status: input.status, iterations: input.iterations || 0, issues: input.issues || [], references: input.references || [],
    style_profile_id: input.styleProfileId || "", model: input.model || "", batch_id: input.batchId || ""
  } });
}

export async function saveDirectusQaCase(input) {
  return request("/items/qa_cases", { method: "POST", body: {
    target_locale: assertLocale(input.locale), content_type: input.contentType || "general", domain: input.domain || "general",
    source: input.source, rejected_translation: input.rejectedTranslation, corrected_translation: input.correctedTranslation || "",
    issues: input.issues || [], score_before: input.scoreBefore, score_after: input.scoreAfter, status: input.status || "review"
  } });
}

export async function getDirectusQaCases(locale, { contentType = "general", domain = "general", limit = 200 } = {}) {
  assertLocale(locale);
  const params = new URLSearchParams({ limit: String(Math.min(500, limit)), sort: "-date_created", fields: "id,target_locale,content_type,domain,source,rejected_translation,corrected_translation,issues,score_before,score_after,status,date_created" });
  params.set("filter[target_locale][_eq]", locale);
  if (contentType) params.set("filter[content_type][_eq]", contentType);
  const items = await request(`/items/qa_cases?${params}`);
  return items.filter((item) => (!domain || domain === "general" || item.domain === domain || item.domain === "general") && ["machine_verified", "human_approved"].includes(item.status)).map((item) => ({
    id: item.id, locale: item.target_locale, contentType: item.content_type, domain: item.domain || "general", source: item.source,
    rejectedTranslation: item.rejected_translation, correctedTranslation: item.corrected_translation, issues: arrayValue(item.issues),
    scoreBefore: Number(item.score_before) || 0, scoreAfter: Number(item.score_after) || 0, status: item.status, createdAt: item.date_created
  }));
}

export async function getDirectusAssets(locale) {
  const collection = collectionFor(locale);
  const fields = "id,source,aliases,target,forbidden,domains,content_types,enforcement,note,status,provenance,date_created,date_updated";
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
      summary: input.statistics || {}
    }
  });
  const records = input.candidates.map((candidate) => ({
    source: candidate.source,
    target: candidate.target,
    target_locale: candidate.locale,
    asset_type: candidate.assetType || "term",
    frequency: candidate.occurrences || 1,
    score: candidate.score,
    batch_id: batch.id,
    source_file: input.filename,
    row_number: candidate.rowNumber,
    decision: candidate.decision,
    reason: (candidate.reasons || []).join("；"),
    status: "pending"
  }));
  const saved = records.length ? await request("/items/term_candidates", { method: "POST", body: records }) : [];
  return {
    batchId: batch.id,
    candidates: input.candidates.map((candidate, index) => ({ ...candidate, candidateId: saved[index]?.id }))
  };
}

export async function completeDirectusImport(batchId, decisions, summary) {
  const updates = decisions.filter((item) => item.candidateId).map((item) => ({
    id: item.candidateId,
    status: item.status,
    decision: item.decision || (item.status === "accepted" ? "ready" : "excluded")
  }));
  if (updates.length) await request("/items/term_candidates", { method: "PATCH", body: updates });
  await request(`/items/term_import_batches/${encodeURIComponent(batchId)}`, {
    method: "PATCH",
    body: { status: "completed", summary }
  });
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
