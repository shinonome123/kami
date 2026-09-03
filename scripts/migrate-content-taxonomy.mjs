import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inferContentTags } from "../src/classifier.mjs";
import { aggregateScope, classifyExistingAsset, inferStyleScopeFromText, inferTermScopes } from "../src/content-taxonomy-migration.mjs";

const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
const token = process.env.DIRECTUS_ADMIN_TOKEN || process.env.DIRECTUS_TOKEN;
const apply = process.argv.includes("--apply");
if (!token) throw new Error("DIRECTUS_ADMIN_TOKEN or DIRECTUS_TOKEN is required");

const localeCollections = {
  "ja-JP": { terms: "terms_ja_jp", memories: "translation_memory_ja_jp" },
  "ko-KR": { terms: "terms_ko_kr", memories: "translation_memory_ko_kr" },
  "zh-Hant-TW": { terms: "terms_zh_hant_tw", memories: "translation_memory_zh_hant_tw" },
  "th-TH": { terms: "terms_th_th", memories: "translation_memory_th_th" }
};

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const details = payload?.errors?.map((item) => item.message).join("; ") || response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${details}`);
  }
  return payload?.data ?? payload;
}

async function list(collection) {
  return api(`/items/${collection}?limit=-1&fields=*`);
}

async function patchInChunks(collection, updates, size = 100) {
  for (let index = 0; index < updates.length; index += size) {
    await api(`/items/${collection}`, { method: "PATCH", body: updates.slice(index, index + size) });
  }
}

function countTypes(items, field = "content_type") {
  const counts = {};
  for (const item of items) {
    const value = item[field] || "general";
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function normalizedClassified(record) {
  const result = classifyExistingAsset(record);
  return { ...record, content_type: result.contentType, content_tags: result.contentTags, contentType: result.contentType, contentTags: result.contentTags, migration: result };
}

function changesForClassified(items) {
  return items.filter((item) => item.migration.changed).map((item) => ({
    id: item.id,
    content_type: item.content_type,
    content_tags: item.content_tags
  }));
}

function profileEvidence(profile, evidence) {
  const ids = new Set(Array.isArray(profile.evidence_ids) ? profile.evidence_ids.map(String) : []);
  if (ids.size) return evidence.filter((item) => ids.has(String(item.id)));
  if (profile.source_batch_id) return evidence.filter((item) => String(item.batch_id || "") === String(profile.source_batch_id));
  return [];
}

function learningEvidence(run, evidence) {
  return evidence.filter((item) => String(item.target_locale || "") === String(run.target_locale || "")
    && String(item.batch_id || "") === String(run.batch_id || ""));
}

function migratedProfileName(profile, contentType) {
  const current = String(profile.name || "");
  if ((profile.content_type || "general") === contentType) return current;
  const shortLabels = { verse: "诗词", narrative: "叙事", codex: "图鉴", dialogue: "对白", store: "商店", tutorial: "教程", marketing: "宣发", announcement: "公告", general: "待分类" };
  return /(general|通用|待分类|图鉴|商店|宣发|公告|item_description)/i.test(current)
    ? current.replace(/general|通用|待分类|图鉴|商店|宣发|公告|item_description/ig, shortLabels[contentType] || contentType)
    : current;
}

function profileText(profile) {
  return [profile.instructions || "", JSON.stringify(profile.rules || []), JSON.stringify(profile.examples || [])].join("\n");
}

const raw = {};
for (const { terms, memories } of Object.values(localeCollections)) {
  raw[terms] = await list(terms);
  raw[memories] = await list(memories);
}
for (const collection of ["term_candidates", "style_evidence", "style_profiles", "style_learning_runs"]) raw[collection] = await list(collection);

const classifiedEvidence = raw.style_evidence.map(normalizedClassified);
const classifiedMemories = {};
const updates = {};
const report = { mode: apply ? "apply" : "dry-run", taxonomyVersion: 1, collections: {}, ambiguousStyleProfiles: [], styleProfileChanges: [], styleLearningRunChanges: [] };

for (const [locale, collections] of Object.entries(localeCollections)) {
  const memories = raw[collections.memories].map(normalizedClassified);
  classifiedMemories[locale] = memories;
  updates[collections.memories] = changesForClassified(memories);
  report.collections[collections.memories] = {
    total: memories.length,
    updates: updates[collections.memories].length,
    before: countTypes(raw[collections.memories]),
    after: countTypes(memories)
  };

  const evidenceForLocale = classifiedEvidence.filter((item) => item.target_locale === locale);
  const scopeRows = [...memories, ...evidenceForLocale].map((item) => ({ ...item, normalizedSource: undefined }));
  const termUpdates = [];
  const afterTerms = raw[collections.terms].map((term) => {
    const inferred = inferTermScopes(term, scopeRows);
    const beforeTypes = JSON.stringify([...(term.content_types || [])].sort());
    const beforeTags = JSON.stringify([...(term.content_tags || [])].sort());
    const changed = beforeTypes !== JSON.stringify([...inferred.contentTypes].sort()) || beforeTags !== JSON.stringify([...inferred.contentTags].sort());
    if (changed) termUpdates.push({ id: term.id, content_types: inferred.contentTypes, content_tags: inferred.contentTags });
    return { ...term, content_types: changed ? inferred.contentTypes : (term.content_types || ["general"]), content_tags: changed ? inferred.contentTags : (term.content_tags || []) };
  });
  updates[collections.terms] = termUpdates;
  report.collections[collections.terms] = { total: afterTerms.length, updates: termUpdates.length, before: countTypes(raw[collections.terms], "content_types"), taggedAfter: afterTerms.filter((item) => item.content_tags?.length).length };
}

updates.style_evidence = changesForClassified(classifiedEvidence);
report.collections.style_evidence = { total: classifiedEvidence.length, updates: updates.style_evidence.length, before: countTypes(raw.style_evidence), after: countTypes(classifiedEvidence) };

const classifiedCandidates = raw.term_candidates.map(normalizedClassified);
updates.term_candidates = changesForClassified(classifiedCandidates);
report.collections.term_candidates = { total: classifiedCandidates.length, updates: updates.term_candidates.length, before: countTypes(raw.term_candidates), after: countTypes(classifiedCandidates) };

updates.style_profiles = [];
for (const profile of raw.style_profiles) {
  const evidence = profileEvidence(profile, classifiedEvidence);
  const scope = aggregateScope(evidence);
  const text = profileText(profile);
  const textScope = inferStyleScopeFromText(profile.instructions || JSON.stringify(profile.rules || []));
  let contentType = profile.content_type || "general";
  const strongTextType = textScope.total >= 2 && textScope.dominantShare >= 0.55 ? textScope.dominantType : "";
  if (contentType === "general" && strongTextType) {
    contentType = strongTextType;
  } else if (contentType === "general" && evidence.length && scope.dominantType !== "general" && scope.dominantShare >= 0.75) {
    contentType = scope.dominantType;
  } else if (contentType === "codex" && textScope.total >= 2 && !textScope.typeCounts.codex) {
    // A profile linked to a codex batch can still contain mixed or promotional rules.
    // Its own production instruction is the final authority for where it may apply.
    contentType = strongTextType || "general";
  } else if (contentType === "item_description" && strongTextType === "store") {
    contentType = "store";
  }
  const sameTypeEvidence = evidence.filter((item) => item.content_type === contentType);
  const contentTags = sameTypeEvidence.length
    ? aggregateScope(sameTypeEvidence).contentTags
    : inferContentTags(text, contentType);
  const name = migratedProfileName(profile, contentType);
  if (contentType !== profile.content_type || name !== profile.name || JSON.stringify([...(contentTags || [])].sort()) !== JSON.stringify([...(profile.content_tags || [])].sort())) {
    updates.style_profiles.push({ id: profile.id, name, content_type: contentType, content_tags: contentTags });
    report.styleProfileChanges.push({ id: profile.id, nameBefore: profile.name, nameAfter: name, locale: profile.target_locale, status: profile.status, before: profile.content_type || "general", after: contentType, tags: contentTags, evidence: evidence.length, evidenceDominantShare: Number(scope.dominantShare.toFixed(3)), textSignals: textScope });
  }
}

// When migration reunites a parent/child pair into the same scope, preserve the newer
// child as active and retire only its direct ancestor. Unrelated active profiles are
// never auto-disabled.
const movedStyleIds = new Set(report.styleProfileChanges.filter((item) => item.before !== item.after).map((item) => item.id));
const projectedProfiles = raw.style_profiles.map((profile) => ({
  ...profile,
  ...(updates.style_profiles.find((update) => update.id === profile.id) || {})
}));
const activeGroups = new Map();
for (const profile of projectedProfiles.filter((item) => item.status === "active")) {
  const key = [profile.target_locale, profile.domain || "general", profile.content_type || "general"].join("\u0000");
  if (!activeGroups.has(key)) activeGroups.set(key, []);
  activeGroups.get(key).push(profile);
}
report.lineageDeactivations = [];
for (const [scopeKey, group] of activeGroups) {
  if (group.length < 2 || !group.some((item) => movedStyleIds.has(item.id))) continue;
  const groupIds = new Set(group.map((item) => String(item.id)));
  for (const child of group) {
    if (!child.parent_id || !groupIds.has(String(child.parent_id))) continue;
    const parent = group.find((item) => String(item.id) === String(child.parent_id));
    const existingUpdate = updates.style_profiles.find((item) => item.id === parent.id);
    if (existingUpdate) existingUpdate.status = "inactive";
    else updates.style_profiles.push({ id: parent.id, status: "inactive" });
    parent.status = "inactive";
    report.lineageDeactivations.push({ scope: scopeKey, parentId: parent.id, childId: child.id, reason: "newer-child-in-same-migrated-scope" });
  }
  const remaining = group.filter((item) => item.status === "active");
  if (remaining.length > 1) report.ambiguousStyleProfiles.push({ scope: scopeKey, ids: remaining.map((item) => item.id), reason: "unrelated-active-scope-collision" });
}
report.collections.style_profiles = {
  total: raw.style_profiles.length,
  updates: updates.style_profiles.length,
  before: countTypes(raw.style_profiles),
  after: countTypes(raw.style_profiles.map((item) => ({ ...item, ...(updates.style_profiles.find((update) => update.id === item.id) || {}) }))),
  ambiguous: report.ambiguousStyleProfiles.length
};

updates.style_learning_runs = [];
for (const run of raw.style_learning_runs) {
  const evidence = learningEvidence(run, classifiedEvidence);
  const scope = aggregateScope(evidence);
  const contentType = evidence.length && scope.dominantShare >= 0.6 ? scope.dominantType : (run.content_type || "general");
  const sameTypeEvidence = evidence.filter((item) => item.content_type === contentType);
  const contentTags = sameTypeEvidence.length ? aggregateScope(sameTypeEvidence).contentTags : (run.content_tags || []);
  if (contentType !== run.content_type || JSON.stringify([...(contentTags || [])].sort()) !== JSON.stringify([...(run.content_tags || [])].sort())) {
    updates.style_learning_runs.push({ id: run.id, content_type: contentType, content_tags: contentTags });
    report.styleLearningRunChanges.push({ id: run.id, filename: run.filename, locale: run.target_locale, before: run.content_type || "general", after: contentType, tags: contentTags, evidence: evidence.length, dominantShare: Number(scope.dominantShare.toFixed(3)) });
  }
}
report.collections.style_learning_runs = {
  total: raw.style_learning_runs.length,
  updates: updates.style_learning_runs.length,
  before: countTypes(raw.style_learning_runs),
  after: countTypes(raw.style_learning_runs.map((item) => ({ ...item, ...(updates.style_learning_runs.find((update) => update.id === item.id) || {}) })))
};

if (apply) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = resolve("data/backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `content-taxonomy-${timestamp}.json`);
  const reportPath = resolve(backupDir, `content-taxonomy-${timestamp}-report.json`);
  await writeFile(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), taxonomyVersion: 1, collections: raw }, null, 2)}\n`, "utf8");
  for (const [collection, collectionUpdates] of Object.entries(updates)) {
    if (collectionUpdates.length) await patchInChunks(collection, collectionUpdates);
  }
  report.backupPath = backupPath;
  report.reportPath = reportPath;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));
