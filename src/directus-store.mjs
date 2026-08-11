import { randomUUID } from "node:crypto";
import { assertLocale } from "./config.mjs";

export const LOCALE_COLLECTIONS = Object.freeze({
  "ja-JP": "terms_ja_jp",
  "ko-KR": "terms_ko_kr",
  "zh-Hant-TW": "terms_zh_hant_tw",
  "th-TH": "terms_th_th"
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
  await Promise.all(Object.values(LOCALE_COLLECTIONS).map((collection) => request(`/items/${collection}?limit=1&fields=id`)));
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
