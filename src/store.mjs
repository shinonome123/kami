import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertLocale, LOCALES } from "./config.mjs";
import { embedSource, embeddingModelName } from "./embedding.mjs";
import {
  deleteDirectusAsset,
  getDirectusAssets,
  getDirectusAssetStats,
  getDirectusMetadata,
  getDirectusMemories,
  getDirectusQaCases,
  getDirectusStyleProfile,
  getDirectusStyleEvidence,
  getDirectusQaRuns,
  getDirectusUserProfile,
  saveDirectusUserProfile,
  listDirectusStyleProfiles,
  activateDirectusStyleProfile,
  rejectDirectusStyleProfile,
  listDirectusPendingQaCases,
  disposeDirectusQaCase,
  initializeDirectusStore,
  completeDirectusImport,
  rebuildDirectusEmbeddings,
  demoteDirectusMemories,
  approveDirectusQaCase,
  saveDirectusBatchRun,
  getDirectusBatchRun,
  listDirectusBatchRuns,
  saveDirectusQaTask,
  getDirectusQaTask,
  listDirectusQaTasks,
  deleteDirectusQaTask,
  saveDirectusShare,
  getDirectusShare,
  listDirectusShares,
  updateDirectusShare,
  saveDirectusMemory,
  saveDirectusQaCase,
  saveDirectusQaRun,
  saveDirectusAsset,
  saveDirectusCorpus,
  saveDirectusImportPreview,
  saveDirectusStyleEvidence,
  saveDirectusStyleLearningRun,
  getDirectusStyleLearningRuns,
  saveDirectusStyleProfile,
  saveDirectusLearningTrajectory,
  listDirectusLearningTrajectories,
  getDirectusLearningTrajectory,
  updateDirectusLearningTrajectory,
  saveDirectusTranslationSkill,
  listDirectusTranslationSkills,
  getDirectusTranslationSkill,
  updateDirectusTranslationSkill,
  activateDirectusTranslationSkill,
  rollbackDirectusTranslationSkill,
  saveDirectusSkillEvaluation,
  listDirectusSkillEvaluations,
  getDirectusSkillEvaluation,
  updateDirectusSkillEvaluation
} from "./directus-store.mjs";

const ROOT = process.env.KAMI_DATA_DIR || fileURLToPath(new URL("../data", import.meta.url));

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

const jsonFileLocks = new Map();

async function withJsonFileLock(path, operation) {
  const previous = jsonFileLocks.get(path) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  jsonFileLocks.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (jsonFileLocks.get(path) === tail) jsonFileLocks.delete(path);
  }
}

function assetPath(locale) {
  assertLocale(locale);
  return join(ROOT, "assets", `${locale}.json`);
}

async function initializeJsonStore() {
  await mkdir(join(ROOT, "assets"), { recursive: true });
  await mkdir(join(ROOT, "corpora"), { recursive: true });
  await mkdir(join(ROOT, "memories"), { recursive: true });
  await mkdir(join(ROOT, "styles"), { recursive: true });
  await mkdir(join(ROOT, "qa"), { recursive: true });
  await mkdir(join(ROOT, "batches"), { recursive: true });
  await mkdir(join(ROOT, "learning"), { recursive: true });
  for (const locale of Object.keys(LOCALES)) {
    const path = assetPath(locale);
    const current = await readJson(path, null);
    if (!current) {
      await writeJsonAtomic(path, { locale, revision: 1, terms: [], memories: [], styleExamples: [] });
    }
  }
}

async function getJsonMemories(locale, options = {}) {
  assertLocale(locale);
  const items = await readJson(join(ROOT, "memories", `${locale}.json`), []);
  return items.filter((item) =>
    (!options.contentType || options.contentType === "general" || item.contentType === options.contentType || item.contentType === "general")
    && (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general")
  );
}

async function saveJsonMemory(locale, input) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  const source = String(input.source || "").trim();
  const target = String(input.target || "").trim();
  const embedding = input.embedding ?? await embedSource(source);
  const existing = items.find((item) => item.source === source && item.target === target);
  const item = { id: existing?.id || randomUUID(), ...existing, ...input, locale, source, target, ...(embedding ? { embedding } : {}), updatedAt: new Date().toISOString(), createdAt: existing?.createdAt || new Date().toISOString() };
  if (existing) items[items.indexOf(existing)] = item;
  else items.unshift(item);
  await writeJsonAtomic(path, items);
  return item;
}

async function getJsonStyleProfile(locale, contentType, domain = "general") {
  const profiles = await readJson(join(ROOT, "styles", `${assertLocale(locale)}.json`), []);
  const candidates = profiles.filter((item) => item.status === "active" && item.contentType === contentType).sort((a, b) => b.version - a.version);
  return candidates.find((item) => item.domain === domain) || candidates.find((item) => item.domain === "general") || candidates[0] || null;
}

async function getJsonStyleEvidence(locale, options = {}) {
  const items = await readJson(join(ROOT, "styles", "evidence.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (options.exactScope
        ? (!options.contentType || item.contentType === options.contentType) && (!options.domain || item.domain === options.domain)
        : (!options.contentType || options.contentType === "general" || item.contentType === options.contentType || item.contentType === "general")
          && (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general"))
      && (!options.batchId || item.batchId === options.batchId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, options.limit || 1_000);
}

async function getJsonQaRuns(locale, options = {}) {
  const items = await readJson(join(ROOT, "qa", "runs.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (!options.contentType || options.contentType === "general" || item.contentType === options.contentType || item.contentType === "general")
      && (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general")
      && (!options.batchId || item.batchId === options.batchId))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, options.limit || 100);
}

async function getJsonUserProfile(locale) {
  const profiles = await readJson(join(ROOT, "styles", "profiles.json"), []);
  return profiles.filter((item) => item.locale === assertLocale(locale) && item.status === "active").sort((a, b) => b.version - a.version)[0] || null;
}

async function saveJsonUserProfile(input) {
  const path = join(ROOT, "styles", "profiles.json");
  const profiles = await readJson(path, []);
  const previous = profiles.filter((item) => item.locale === input.locale).sort((a, b) => b.version - a.version)[0];
  if (previous && input.status !== "draft") previous.status = "inactive";
  const profile = { id: randomUUID(), ...input, version: (previous?.version || 0) + 1, status: input.status || "active", updatedAt: new Date().toISOString() };
  profiles.unshift(profile);
  await writeJsonAtomic(path, profiles);
  return profile;
}

async function saveJsonStyleEvidence(input) {
  const path = join(ROOT, "styles", "evidence.json");
  const items = await readJson(path, []);
  const source = String(input.source || "").trim();
  const embedding = input.embedding ?? await embedSource(source);
  const item = { id: randomUUID(), ...input, ...(embedding ? { embedding } : {}), createdAt: new Date().toISOString() };
  items.push(item);
  await writeJsonAtomic(path, items);
  return item;
}

async function saveJsonStyleProfile(input) {
  const path = join(ROOT, "styles", `${assertLocale(input.locale)}.json`);
  const profiles = await readJson(path, []);
  const previous = profiles.filter((item) => item.contentType === input.contentType && item.domain === input.domain).sort((a, b) => b.version - a.version)[0];
  if (previous && input.status !== "draft") previous.status = "inactive";
  const profile = { id: randomUUID(), ...input, source: "style-library", version: (previous?.version || 0) + 1, parentId: previous?.id || null, status: input.status || "active", updatedAt: new Date().toISOString() };
  profiles.unshift(profile);
  await writeJsonAtomic(path, profiles);
  return profile;
}

async function saveJsonStyleLearningRun(input) {
  const path = join(ROOT, "styles", "learning-runs.json");
  const items = await readJson(path, []);
  const existing = input.id ? items.find((item) => item.id === input.id) : null;
  const run = {
    id: existing?.id || randomUUID(),
    ...existing,
    batchId: String(input.batchId || existing?.batchId || ""),
    filename: String(input.filename || existing?.filename || ""),
    locale: assertLocale(input.locale || existing?.locale),
    contentType: input.contentType || existing?.contentType || "general",
    domain: input.domain || existing?.domain || "general",
    evidenceCount: Number(input.evidenceCount ?? existing?.evidenceCount) || 0,
    summary: String(input.summary ?? existing?.summary ?? ""),
    rules: input.rules || existing?.rules || [],
    examples: input.examples || existing?.examples || [],
    caveat: String(input.caveat ?? existing?.caveat ?? ""),
    confidence: input.confidence == null ? (existing?.confidence ?? null) : Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    status: input.status || existing?.status || "observed",
    promotedProfileId: input.promotedProfileId ?? existing?.promotedProfileId ?? "",
    generatedBy: input.generatedBy || existing?.generatedBy || "",
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  if (existing) items[items.indexOf(existing)] = run;
  else items.unshift(run);
  await writeJsonAtomic(path, items);
  return run;
}

async function getJsonStyleLearningRuns(locale, options = {}) {
  const items = await readJson(join(ROOT, "styles", "learning-runs.json"), []);
  return items
    .filter((item) => item.locale === assertLocale(locale)
      && (!options.batchId || item.batchId === options.batchId)
      && (!options.status || item.status === options.status))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.min(500, Math.max(1, Number(options.limit) || 100)));
}

async function locateJsonStyleProfile(id) {
  for (const locale of Object.keys(LOCALES)) {
    const path = join(ROOT, "styles", `${locale}.json`);
    const profiles = await readJson(path, []);
    const target = profiles.find((item) => item.id === id);
    if (target) return { path, profiles, target };
  }
  const profilePath = join(ROOT, "styles", "profiles.json");
  const profileList = await readJson(profilePath, []);
  const profile = profileList.find((item) => item.id === id);
  if (profile) return { path: profilePath, profiles: profileList, target: profile, kind: "user_profile" };
  return null;
}

async function listJsonStyleProfiles(locale, status) {
  assertLocale(locale);
  const styleProfiles = await readJson(join(ROOT, "styles", `${locale}.json`), []);
  const userProfiles = await readJson(join(ROOT, "styles", "profiles.json"), []);
  const pick = (items) => items.filter((item) => !status || item.status === status).sort((a, b) => b.version - a.version);
  return {
    styleProfiles: pick(styleProfiles),
    userProfiles: pick(userProfiles.filter((item) => item.locale === locale))
  };
}

async function activateJsonStyleProfile(id) {
  const located = await locateJsonStyleProfile(id);
  if (!located) return null;
  if (located.kind === "user_profile") {
    for (const item of located.profiles) {
      if (item.id === id) item.status = "active";
      else if (item.locale === located.target.locale && item.status === "active") item.status = "inactive";
    }
    located.target.status = "active";
    await writeJsonAtomic(located.path, located.profiles);
    return located.target;
  }
  for (const item of located.profiles) {
    if (item.id === id) item.status = "active";
    else if (item.status === "active" && item.contentType === located.target.contentType && item.domain === located.target.domain) item.status = "inactive";
  }
  located.target.status = "active";
  await writeJsonAtomic(located.path, located.profiles);
  return located.target;
}

async function rejectJsonStyleProfile(id) {
  const located = await locateJsonStyleProfile(id);
  if (!located || located.target.status === "active") return null;
  for (const item of located.profiles) if (item.id === id) item.status = "inactive";
  located.target.status = "inactive";
  await writeJsonAtomic(located.path, located.profiles);
  return located.target;
}

async function appendJsonQa(kind, input) {
  const path = join(ROOT, "qa", `${kind}.json`);
  const items = await readJson(path, []);
  const item = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
  items.unshift(item);
  await writeJsonAtomic(path, items);
  return item;
}

async function getJsonQaCases(locale, options = {}) {
  const items = await readJson(join(ROOT, "qa", "cases.json"), []);
  return items.filter((item) => item.locale === assertLocale(locale) && ["machine_verified", "human_approved"].includes(item.status) && (!options.contentType || item.contentType === options.contentType) && (!options.domain || options.domain === "general" || item.domain === options.domain || item.domain === "general"));
}

async function getJsonAssets(locale) {
  const path = assetPath(locale);
  return readJson(path, { locale, revision: 1, terms: [], memories: [], styleExamples: [] });
}

async function saveJsonAsset(locale, input) {
  assertLocale(locale);
  const data = await getJsonAssets(locale);
  const now = new Date().toISOString();
  const term = {
    id: input.id || randomUUID(),
    source: String(input.source || "").trim(),
    aliases: [...new Set((input.aliases || []).map((item) => String(item).trim()).filter(Boolean))],
    target: String(input.target || "").trim(),
    forbidden: [...new Set((input.forbidden || []).map((item) => String(item).trim()).filter(Boolean))],
    domains: [...new Set((input.domains || ["general"]).filter(Boolean))],
    contentTypes: [...new Set((input.contentTypes || ["general"]).filter(Boolean))],
    enforcement: input.enforcement || "required",
    note: String(input.note || "").trim(),
    status: input.status || "approved",
    provenance: input.provenance || "manual",
    createdAt: input.createdAt || now,
    updatedAt: now
  };
  if (!term.source || !term.target) {
    const error = new Error("术语原文和目标译法不能为空");
    error.statusCode = 400;
    throw error;
  }
  const index = data.terms.findIndex((item) => item.id === term.id);
  if (index >= 0) data.terms[index] = term;
  else data.terms.unshift(term);
  data.revision = (data.revision || 0) + 1;
  await writeJsonAtomic(assetPath(locale), data);
  return term;
}

async function deleteJsonAsset(locale, id) {
  const data = await getJsonAssets(locale);
  const before = data.terms.length;
  data.terms = data.terms.filter((item) => item.id !== id);
  if (before === data.terms.length) return false;
  data.revision = (data.revision || 0) + 1;
  await writeJsonAtomic(assetPath(locale), data);
  return true;
}

async function saveJsonCorpus(input) {
  const id = input.id || randomUUID();
  const document = {
    id,
    name: String(input.name || "未命名语料").trim(),
    sourceLanguage: "zh-CN",
    domain: input.domain || "general",
    contentType: input.contentType || "general",
    text: String(input.text || ""),
    segments: input.segments || [],
    candidates: input.candidates || [],
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(join(ROOT, "corpora", `${id}.json`), document);
  return document;
}

async function demoteJsonMemories(locale, source, exceptId) {
  const path = join(ROOT, "memories", `${assertLocale(locale)}.json`);
  const items = await readJson(path, []);
  let demoted = 0;
  for (const item of items) {
    if (item.source !== source || item.id === exceptId || item.qualityStatus === "rejected") continue;
    item.qualityStatus = item.qualityStatus === "human_approved" ? "machine_verified" : "rejected";
    demoted += 1;
  }
  if (demoted) await writeJsonAtomic(path, items);
  return demoted;
}

async function approveJsonQaCase(id) {
  const path = join(ROOT, "qa", "cases.json");
  const items = await readJson(path, []);
  const item = items.find((entry) => entry.id === id);
  if (!item) return false;
  item.status = "human_approved";
  await writeJsonAtomic(path, items);
  return true;
}

async function listJsonPendingQaCases(locale) {
  const items = await readJson(join(ROOT, "qa", "cases.json"), []);
  return items.filter((item) => item.locale === assertLocale(locale) && item.status === "review").slice(0, 20);
}

async function disposeJsonQaCase(id) {
  const path = join(ROOT, "qa", "cases.json");
  const items = await readJson(path, []);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  items.splice(index, 1);
  await writeJsonAtomic(path, items);
  return true;
}

function normalizeBatchSegments(segments = []) {
  return segments.slice(0, 2_000).map((segment) => ({
    id: String(segment.id || ""),
    source: String(segment.source || ""),
    translation: String(segment.translation || ""),
    status: String(segment.status || "pending"),
    selected: segment.selected !== false,
    accepted: Boolean(segment.accepted),
    locator: segment.locator || null,
    context: segment.context || null
  })).filter((segment) => segment.id && segment.source);
}

async function saveJsonBatchRun(input) {
  const batchId = String(input.batchId || randomUUID());
  const existing = await readJson(join(ROOT, "batches", `${batchId}.json`), null);
  await writeJsonAtomic(join(ROOT, "batches", `${batchId}.json`), {
    batchId,
    filename: String(input.filename || ""),
    locale: assertLocale(input.locale),
    contentType: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    format: String(input.format || ""),
    segmentationMode: String(input.segmentationMode || "sentence"),
    structure: input.structure ?? null,
    segments: (input.segments || []).slice(0, 2_000),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { batchId };
}

async function getJsonBatchRun(batchId) {
  return readJson(join(ROOT, "batches", `${String(batchId)}.json`), null);
}

async function listJsonBatchRuns({ locale = "", status = "", search = "", limit = 200 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "batches")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const runs = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "batches", file), null)))).filter(Boolean);
  return runs.map((run) => {
    const selected = (run.segments || []).filter((segment) => segment.selected !== false);
    const completedSegments = selected.filter((segment) => segment.status === "done" && segment.translation).length;
    const failedSegments = selected.filter((segment) => segment.status === "error").length;
    const qaPending = selected.filter((segment) => Boolean(segment.result?.aiQa?.fallbackReason) || (Number.isFinite(segment.result?.qaScore) && segment.result.qaScore < 90) || (segment.result?.issues || []).length > 0).length;
    return { batchId: run.batchId, filename: run.filename || "未命名任务", locale: run.locale, contentType: run.contentType || "general", domain: run.domain || "general", format: run.format || "", segmentationMode: run.segmentationMode || "sentence", status: failedSegments ? "needs_attention" : completedSegments < selected.length ? "in_progress" : qaPending ? "review" : "completed", totalSegments: selected.length, completedSegments, failedSegments, qaPending, createdAt: run.createdAt || run.updatedAt, updatedAt: run.updatedAt };
  }).filter((item) => (!locale || item.locale === locale) && (!status || item.status === status) && (!search || item.filename.toLowerCase().includes(String(search).toLowerCase()))).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit);
}

async function saveJsonQaTask(input) {
  const id = String(input.id || randomUUID());
  const existing = await readJson(join(ROOT, "qa-tasks", `${id}.json`), null);
  const now = new Date().toISOString();
  const item = {
    id,
    title: String(input.title || String(input.sourceText || "").slice(0, 40) || "未命名质检"),
    locale: assertLocale(input.locale),
    contentType: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    sourceText: String(input.sourceText || ""),
    translationText: String(input.translationText || ""),
    segmentCounts: input.segmentCounts ?? { source: 0, translation: 0 },
    overallScore: input.overallScore ?? null,
    dimensionScores: input.dimensionScores ?? null,
    summary: input.summary ?? null,
    alignmentNote: String(input.alignmentNote || ""),
    model: String(input.model || ""),
    report: input.report ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await writeJsonAtomic(join(ROOT, "qa-tasks", `${id}.json`), item);
  return item;
}

async function getJsonQaTask(id) {
  return readJson(join(ROOT, "qa-tasks", `${String(id)}.json`), null);
}

async function listJsonQaTasks({ locale = "", status = "", search = "", limit = 200 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "qa-tasks")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tasks = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "qa-tasks", file), null)))).filter(Boolean);
  return tasks.map((task) => ({
    id: task.id,
    type: "autoqa",
    title: task.title || "未命名质检",
    locale: task.locale,
    contentType: task.contentType || "general",
    domain: task.domain || "general",
    status: Number.isFinite(task.overallScore) ? (task.overallScore >= 90 ? "completed" : "review") : "completed",
    overallScore: Number.isFinite(task.overallScore) ? task.overallScore : null,
    totalSegments: Number(task.segmentCounts?.source) || 0,
    completedSegments: 0,
    failedSegments: 0,
    qaPending: task.summary ? Object.values(task.summary).reduce((sum, item) => sum + (Number(item?.total) || 0), 0) : 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  })).filter((item) => (!locale || item.locale === locale) && (!status || item.status === status) && (!search || item.title.toLowerCase().includes(String(search).toLowerCase()))).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit);
}

async function deleteJsonQaTask(id) {
  try {
    await rm(join(ROOT, "qa-tasks", `${String(id)}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function saveJsonShare(input) {
  const token = String(input.token || randomUUID().replace(/-/g, ""));
  const existing = await readJson(join(ROOT, "shares", `${token}.json`), null);
  const now = new Date().toISOString();
  const item = {
    token,
    batchId: String(input.batchId || ""),
    qaTaskId: String(input.qaTaskId || ""),
    filename: String(input.filename || "未命名分享"),
    locale: assertLocale(input.locale),
    contentType: String(input.contentType || "general"),
    domain: String(input.domain || "general"),
    meta: input.meta ?? null,
    segments: Array.isArray(input.segments) ? input.segments.slice(0, 2_000) : [],
    feedbacks: Array.isArray(existing?.feedbacks) ? existing.feedbacks : [],
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await writeJsonAtomic(join(ROOT, "shares", `${token}.json`), item);
  return item;
}

async function getJsonShare(token) {
  return readJson(join(ROOT, "shares", `${String(token)}.json`), null);
}

async function listJsonShares({ batchId = "", qaTaskId = "", limit = 100 } = {}) {
  let files = [];
  try { files = await readdir(join(ROOT, "shares")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const shares = (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(join(ROOT, "shares", file), null)))).filter(Boolean);
  return shares.filter((share) => (!batchId || share.batchId === batchId) && (!qaTaskId || share.qaTaskId === qaTaskId)).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit);
}

async function updateJsonShare(token, updater) {
  const path = join(ROOT, "shares", `${String(token)}.json`);
  const item = await readJson(path, null);
  if (!item) return null;
  const next = typeof updater === "function" ? updater(item) : { ...item, ...updater };
  const updated = { ...next, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path, updated);
  return updated;
}

async function rebuildJsonEmbeddings(locale, currentModel) {  const stats = { memories: 0, qaCases: 0, evidence: 0, errors: [] };  const targets = [
    { path: join(ROOT, "memories", `${assertLocale(locale)}.json`), kind: "memories" },
    { path: join(ROOT, "qa", "cases.json"), kind: "qaCases", filter: (item) => item.locale === locale },
    { path: join(ROOT, "styles", "evidence.json"), kind: "evidence", filter: (item) => item.locale === locale }
  ];
  for (const target of targets) {
    const items = await readJson(target.path, []);
    const scoped = target.filter ? items.map((item) => ({ item, index: items.indexOf(item) })).filter(({ item }) => target.filter(item)) : items.map((item) => ({ item, index: items.indexOf(item) }));
    for (const { item, index } of scoped) {
      if (!item.source) continue;
      if (item.embedding?.vector?.length && item.embedding?.model === currentModel) continue;
      const embedding = await embedSource(item.source);
      if (!embedding) {
        stats.errors.push(`${target.kind}: ${item.source.slice(0, 30)}`);
        break;
      }
      items[index] = { ...item, embedding };
      stats[target.kind] += 1;
    }
    await writeJsonAtomic(target.path, items);
  }
  return stats;
}

async function saveJsonImportPreview(input) {
  const batchId = randomUUID();
  const candidates = input.candidates.map((candidate) => ({ ...candidate, candidateId: randomUUID() }));
  await writeJsonAtomic(join(ROOT, "imports", `${batchId}.json`), {
    ...input,
    batchId,
    candidates,
    status: "reviewing",
    createdAt: new Date().toISOString()
  });
  return { batchId, candidates };
}

async function completeJsonImport(batchId, decisions, summary) {
  const path = join(ROOT, "imports", `${batchId}.json`);
  const batch = await readJson(path, null);
  if (!batch) return;
  batch.status = "completed";
  batch.decisions = decisions;
  batch.summary = summary;
  batch.completedAt = new Date().toISOString();
  await writeJsonAtomic(path, batch);
}

const LEARNING_TRAJECTORY_STATUSES = new Set(["running", "completed", "review", "failed"]);
const TRANSLATION_SKILL_STATUSES = new Set(["champion", "challenger", "draft", "inactive", "rejected"]);
const SKILL_EVALUATION_DECISIONS = new Set(["pending", "promote", "reject", "needs_review"]);

function learningPath(filename) {
  return join(ROOT, "learning", filename);
}

function cleanScope(input, fallback = {}) {
  return {
    locale: assertLocale(input.locale ?? fallback.locale),
    contentType: String(input.contentType ?? fallback.contentType ?? "general").trim() || "general",
    domain: String(input.domain ?? fallback.domain ?? "general").trim() || "general",
    project: String(input.project ?? fallback.project ?? "default").trim() || "default"
  };
}

function matchesLearningScope(item, filters = {}) {
  return (!filters.locale || item.locale === assertLocale(filters.locale))
    && (!filters.contentType || item.contentType === filters.contentType)
    && (!filters.domain || item.domain === filters.domain)
    && (!filters.project || item.project === filters.project);
}

function normalizedLimit(value, fallback = 100) {
  return Math.min(1_000, Math.max(1, Number(value) || fallback));
}

function assertChoice(value, allowed, label) {
  if (!allowed.has(value)) {
    const error = new Error(`Unsupported ${label}: ${value}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function jsonObject(value, fallback = {}) {
  return value && typeof value === "object" ? structuredClone(value) : structuredClone(fallback);
}

function sameLearningScope(left, right) {
  return left.locale === right.locale
    && left.contentType === right.contentType
    && left.domain === right.domain
    && left.project === right.project;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertImmutableLearningIdentity(existing, input, fields) {
  for (const field of fields) {
    if (Object.hasOwn(input, field) && input[field] != null && String(input[field]) !== String(existing[field] ?? "")) {
      throw conflict(`${field} is immutable after creation`);
    }
  }
}

async function saveJsonLearningTrajectory(input) {
  const path = learningPath("trajectories.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "batchId", "segmentId", "source"]);
    const now = new Date().toISOString();
    const scope = cleanScope(input, existing || {});
    const status = assertChoice(input.status ?? existing?.status ?? "running", LEARNING_TRAJECTORY_STATUSES, "learning trajectory status");
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      batchId: String(input.batchId ?? existing?.batchId ?? ""),
      segmentId: String(input.segmentId ?? existing?.segmentId ?? ""),
      source: String(input.source ?? existing?.source ?? ""),
      initialTranslation: String(input.initialTranslation ?? existing?.initialTranslation ?? ""),
      finalTranslation: String(input.finalTranslation ?? existing?.finalTranslation ?? ""),
      contextPack: jsonObject(input.contextPack ?? existing?.contextPack),
      assetRefs: jsonObject(input.assetRefs ?? existing?.assetRefs, []),
      termDecisions: jsonObject(input.termDecisions ?? existing?.termDecisions, []),
      qaBefore: jsonObject(input.qaBefore ?? existing?.qaBefore),
      qaAfter: jsonObject(input.qaAfter ?? existing?.qaAfter),
      humanDecision: jsonObject(input.humanDecision ?? existing?.humanDecision),
      events: jsonObject(input.events ?? existing?.events, []),
      model: String(input.model ?? existing?.model ?? ""),
      promptVersion: String(input.promptVersion ?? existing?.promptVersion ?? ""),
      status,
      error: String(input.error ?? existing?.error ?? ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (!item.source) {
      const error = new Error("Learning trajectory source cannot be empty");
      error.statusCode = 400;
      throw error;
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    await writeJsonAtomic(path, items);
    return item;
  });
}

async function listJsonLearningTrajectories(filters = {}) {
  const items = await readJson(learningPath("trajectories.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.batchId || item.batchId === filters.batchId)
    && (!filters.status || item.status === filters.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

async function getJsonLearningTrajectory(id) {
  const items = await readJson(learningPath("trajectories.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function updateJsonLearningTrajectory(id, patch) {
  return saveJsonLearningTrajectory({ ...patch, id: String(id), _mustExist: true });
}

function activateJsonSkillInItems(items, target, { rollback = false } = {}) {
  if (target.status === "rejected") throw conflict("Rejected translation skill cannot be activated");
  const scope = cleanScope(target);
  const current = items.filter((item) => item.id !== target.id && item.status === "champion" && matchesLearningScope(item, scope));
  if (current.length) {
    const isChildOfCurrent = current.some((item) => target.parentId === item.id);
    const isRollbackTarget = rollback && current.some((item) => item.parentId === target.id);
    if (!isChildOfCurrent && !isRollbackTarget) throw conflict("Translation skill was not evaluated against the current champion");
  }
  const now = new Date().toISOString();
  for (const item of current) {
    item.status = "inactive";
    item.updatedAt = now;
  }
  target.status = "champion";
  target.updatedAt = now;
  return target;
}

async function saveJsonTranslationSkill(input) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) {
      assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "version", "parentId"]);
      if (existing.status === "champion" && Object.hasOwn(input, "status") && input.status !== "champion") {
        throw conflict("The current champion must be replaced or rolled back, not directly deactivated");
      }
      if (existing.status === "rejected" && Object.hasOwn(input, "status") && input.status !== "rejected") {
        throw conflict("Rejected translation skill cannot be reactivated through update");
      }
    }
    const scope = cleanScope(input, existing || {});
    const scoped = items.filter((item) => matchesLearningScope(item, scope));
    const previous = scoped.sort((a, b) => Number(b.version) - Number(a.version))[0] || null;
    const status = assertChoice(input.status ?? existing?.status ?? "draft", TRANSLATION_SKILL_STATUSES, "translation skill status");
    const version = existing?.version || Math.max(1, Number(input.version) || (Number(previous?.version) || 0) + 1);
    if (!existing && scoped.some((item) => Number(item.version) === version)) throw conflict(`Translation skill version ${version} already exists in this scope`);
    const now = new Date().toISOString();
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      name: String(input.name ?? existing?.name ?? `${scope.locale} ${scope.contentType} translation skill`).trim(),
      description: String(input.description ?? existing?.description ?? ""),
      changeReason: String(input.changeReason ?? existing?.changeReason ?? ""),
      version,
      parentId: input.parentId === null ? null : String(input.parentId ?? existing?.parentId ?? previous?.id ?? "") || null,
      status,
      strategy: jsonObject(input.strategy ?? existing?.strategy),
      evidenceIds: jsonObject(input.evidenceIds ?? existing?.evidenceIds, []),
      promptVersion: String(input.promptVersion ?? existing?.promptVersion ?? ""),
      metrics: jsonObject(input.metrics ?? existing?.metrics),
      metadata: jsonObject(input.metadata ?? existing?.metadata),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (item.parentId) {
      const parent = items.find((entry) => entry.id === item.parentId);
      if (!parent || !sameLearningScope(parent, item)) throw conflict("Translation skill parent must exist in the same scope");
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    if (status === "champion") activateJsonSkillInItems(items, item);
    await writeJsonAtomic(path, items);
    return item;
  });
}

async function listJsonTranslationSkills(filters = {}) {
  const items = await readJson(learningPath("skills.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.status || item.status === filters.status))
    .sort((a, b) => Number(b.version) - Number(a.version) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

async function getJsonTranslationSkill(id) {
  const items = await readJson(learningPath("skills.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function updateJsonTranslationSkill(id, patch) {
  return saveJsonTranslationSkill({ ...patch, id: String(id), _mustExist: true });
}

async function activateJsonTranslationSkill(id) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const skill = items.find((item) => item.id === String(id));
    if (!skill) return null;
    activateJsonSkillInItems(items, skill);
    await writeJsonAtomic(path, items);
    return skill;
  });
}

async function rollbackJsonTranslationSkill(id) {
  const path = learningPath("skills.json");
  return withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const current = items.find((item) => item.id === String(id));
    if (!current) return null;
    if (current.status !== "champion") throw conflict("Only the current champion translation skill can be rolled back");
    const scope = cleanScope(current);
    const parent = (current.parentId && items.find((item) => item.id === current.parentId && item.status !== "rejected" && matchesLearningScope(item, scope)))
      || items.filter((item) => item.id !== current.id && item.status !== "rejected" && Number(item.version) < Number(current.version) && matchesLearningScope(item, scope)).sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (!parent) throw conflict("No previous translation skill version is available for rollback");
    activateJsonSkillInItems(items, parent, { rollback: true });
    await writeJsonAtomic(path, items);
    return { rolledBack: current, champion: parent };
  });
}

async function saveJsonSkillEvaluation(input) {
  const path = learningPath("evaluations.json");
  const skillsPath = learningPath("skills.json");
  return withJsonFileLock(skillsPath, () => withJsonFileLock(path, async () => {
    const items = await readJson(path, []);
    const existing = input.id ? items.find((item) => item.id === input.id) : null;
    if (!existing && input._mustExist) return null;
    if (existing) assertImmutableLearningIdentity(existing, input, ["locale", "contentType", "domain", "project", "championSkillId", "challengerSkillId"]);
    const now = new Date().toISOString();
    const scope = cleanScope(input, existing || {});
    const decision = assertChoice(input.decision ?? existing?.decision ?? "pending", SKILL_EVALUATION_DECISIONS, "skill evaluation decision");
    const item = {
      id: existing?.id || input.id || randomUUID(),
      ...scope,
      championSkillId: String(input.championSkillId ?? existing?.championSkillId ?? ""),
      challengerSkillId: String(input.challengerSkillId ?? existing?.challengerSkillId ?? ""),
      sampleCount: Math.max(0, Number(input.sampleCount ?? existing?.sampleCount) || 0),
      championMetrics: jsonObject(input.championMetrics ?? existing?.championMetrics),
      challengerMetrics: jsonObject(input.challengerMetrics ?? existing?.challengerMetrics),
      metricDeltas: jsonObject(input.metricDeltas ?? existing?.metricDeltas),
      decision,
      report: jsonObject(input.report ?? existing?.report),
      evaluator: String(input.evaluator ?? existing?.evaluator ?? ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (!item.championSkillId || !item.challengerSkillId || item.championSkillId === item.challengerSkillId) {
      const error = new Error("Skill evaluation requires distinct championSkillId and challengerSkillId");
      error.statusCode = 400;
      throw error;
    }
    if (!existing || decision === "promote") {
      const skills = await readJson(skillsPath, []);
      const champion = skills.find((skill) => skill.id === item.championSkillId);
      const challenger = skills.find((skill) => skill.id === item.challengerSkillId);
      if (!champion || champion.status !== "champion" || !sameLearningScope(champion, item)) throw conflict("Skill evaluation champion is not the current champion in this scope");
      if (!challenger || !["challenger", "draft"].includes(challenger.status) || !sameLearningScope(challenger, item)) throw conflict("Skill evaluation challenger is not an active candidate in this scope");
    }
    if (existing) items[items.indexOf(existing)] = item;
    else items.unshift(item);
    await writeJsonAtomic(path, items);
    return item;
  }));
}

async function listJsonSkillEvaluations(filters = {}) {
  const items = await readJson(learningPath("evaluations.json"), []);
  return items.filter((item) => matchesLearningScope(item, filters)
    && (!filters.decision || item.decision === filters.decision)
    && (!filters.championSkillId || item.championSkillId === filters.championSkillId)
    && (!filters.challengerSkillId || item.challengerSkillId === filters.challengerSkillId))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, normalizedLimit(filters.limit));
}

async function getJsonSkillEvaluation(id) {
  const items = await readJson(learningPath("evaluations.json"), []);
  return items.find((item) => item.id === String(id)) || null;
}

async function updateJsonSkillEvaluation(id, patch) {
  return saveJsonSkillEvaluation({ ...patch, id: String(id), _mustExist: true });
}

export const DATA_ROOT = ROOT;

// Directus 启动检查失败后的回退状态：仅在进程内生效，重启后重新尝试 Directus。
let directusFallback = null;

function usesDirectus() {
  return process.env.KAMI_STORE === "directus" && !directusFallback;
}

/** 启动回退状态，供 health/bootstrap 接口与界面告警使用。 */
export function getStoreFallbackInfo() {
  if (directusFallback) {
    return {
      active: true,
      requestedMode: "directus",
      activeMode: "json",
      reason: directusFallback.reason,
      at: directusFallback.at
    };
  }
  return { active: false, activeMode: usesDirectus() ? "directus" : "json" };
}

export async function initializeStore() {
  if (process.env.KAMI_STORE !== "directus") return initializeJsonStore();
  try {
    await initializeDirectusStore();
    return;
  } catch (error) {
    directusFallback = { reason: error.message, at: new Date().toISOString() };
    console.error(`[Kami] Directus 不可用（${error.message}），已自动回退到本地 JSON 存储。Directus 恢复后重启服务即可回到资产后台模式；回退期间的写入保存在 data/ 下，不会自动同步回 Directus。`);
    await initializeJsonStore();
  }
}

export async function getAssets(locale) {
  return usesDirectus() ? getDirectusAssets(locale) : getJsonAssets(locale);
}

export async function getAssetStats(locale) {
  if (usesDirectus()) return getDirectusAssetStats(locale);
  const assets = await getJsonAssets(locale);
  return { locale, revision: assets.revision, termCount: assets.terms.length };
}

export async function saveAsset(locale, input) {
  return usesDirectus() ? saveDirectusAsset(locale, input) : saveJsonAsset(locale, input);
}

export async function deleteAsset(locale, id) {
  return usesDirectus() ? deleteDirectusAsset(locale, id) : deleteJsonAsset(locale, id);
}

export async function saveCorpus(input) {
  return usesDirectus() ? saveDirectusCorpus(input) : saveJsonCorpus(input);
}

export async function saveImportPreview(input) {
  return usesDirectus() ? saveDirectusImportPreview(input) : saveJsonImportPreview(input);
}

export async function completeImport(batchId, decisions, summary) {
  return usesDirectus() ? completeDirectusImport(batchId, decisions, summary) : completeJsonImport(batchId, decisions, summary);
}

export async function getMemories(locale, options) {
  return usesDirectus() ? getDirectusMemories(locale, options) : getJsonMemories(locale, options);
}

export async function saveMemory(locale, input) {
  return usesDirectus() ? saveDirectusMemory(locale, input) : saveJsonMemory(locale, input);
}

export async function getStyleProfile(locale, contentType, domain) {
  return usesDirectus() ? getDirectusStyleProfile(locale, contentType, domain) : getJsonStyleProfile(locale, contentType, domain);
}

export async function getStyleEvidence(locale, options) {
  return usesDirectus() ? getDirectusStyleEvidence(locale, options) : getJsonStyleEvidence(locale, options);
}

export async function getQaRuns(locale, options) {
  return usesDirectus() ? getDirectusQaRuns(locale, options) : getJsonQaRuns(locale, options);
}

export async function getUserProfile(locale) {
  return usesDirectus() ? getDirectusUserProfile(locale) : getJsonUserProfile(locale);
}

export async function saveUserProfile(input) {
  return usesDirectus() ? saveDirectusUserProfile(input) : saveJsonUserProfile(input);
}

export async function saveStyleEvidence(input) {
  return usesDirectus() ? saveDirectusStyleEvidence(input) : saveJsonStyleEvidence(input);
}

export async function saveStyleProfile(input) {
  return usesDirectus() ? saveDirectusStyleProfile(input) : saveJsonStyleProfile(input);
}

export async function saveStyleLearningRun(input) {
  return usesDirectus() ? saveDirectusStyleLearningRun(input) : saveJsonStyleLearningRun(input);
}

export async function getStyleLearningRuns(locale, options) {
  return usesDirectus() ? getDirectusStyleLearningRuns(locale, options) : getJsonStyleLearningRuns(locale, options);
}

export async function saveQaRun(input) {
  return usesDirectus() ? saveDirectusQaRun(input) : appendJsonQa("runs", input);
}

export async function saveQaCase(input) {
  if (usesDirectus()) return saveDirectusQaCase(input);
  const embedding = input.embedding ?? await embedSource(input.source);
  return appendJsonQa("cases", { ...input, ...(embedding ? { embedding } : {}) });
}

export async function rebuildEmbeddings(locale) {
  const model = embeddingModelName();
  if (!model) {
    const error = new Error("未配置 embedding 模型，无法重建向量索引");
    error.statusCode = 400;
    throw error;
  }
  if (usesDirectus()) return rebuildDirectusEmbeddings(locale);
  return rebuildJsonEmbeddings(locale, model);
}

export async function demoteMemories(locale, source, exceptId) {
  return usesDirectus() ? demoteDirectusMemories(locale, source, exceptId) : demoteJsonMemories(locale, source, exceptId);
}

export async function approveQaCase(id) {
  return usesDirectus() ? approveDirectusQaCase(id) : approveJsonQaCase(id);
}

export async function saveBatchRun(input) {
  return usesDirectus() ? saveDirectusBatchRun(input) : saveJsonBatchRun(input);
}

export async function getBatchRun(batchId) {
  return usesDirectus() ? getDirectusBatchRun(batchId) : getJsonBatchRun(batchId);
}

export async function listBatchRuns(options) {
  return usesDirectus() ? listDirectusBatchRuns(options) : listJsonBatchRuns(options);
}

export async function saveQaTask(input) {
  return usesDirectus() ? saveDirectusQaTask(input) : saveJsonQaTask(input);
}

export async function getQaTask(id) {
  return usesDirectus() ? getDirectusQaTask(id) : getJsonQaTask(id);
}

export async function listQaTasks(options) {
  return usesDirectus() ? listDirectusQaTasks(options) : listJsonQaTasks(options);
}

export async function deleteQaTask(id) {
  return usesDirectus() ? deleteDirectusQaTask(id) : deleteJsonQaTask(id);
}

export async function saveShare(input) {
  return usesDirectus() ? saveDirectusShare(input) : saveJsonShare(input);
}

export async function getShare(token) {
  return usesDirectus() ? getDirectusShare(token) : getJsonShare(token);
}

export async function listShares(options) {
  return usesDirectus() ? listDirectusShares(options) : listJsonShares(options);
}

export async function updateShare(token, updater) {
  return usesDirectus() ? updateDirectusShare(token, updater) : updateJsonShare(token, updater);
}

export async function listStyleProfiles(locale, status) {
  return usesDirectus() ? listDirectusStyleProfiles(locale, status) : listJsonStyleProfiles(locale, status);
}

export async function listPendingQaCases(locale) {
  return usesDirectus() ? listDirectusPendingQaCases(locale) : listJsonPendingQaCases(locale);
}

export async function disposeQaCase(id) {
  return usesDirectus() ? disposeDirectusQaCase(id) : disposeJsonQaCase(id);
}

export async function activateStyleProfile(id) {
  return usesDirectus() ? activateDirectusStyleProfile(id) : activateJsonStyleProfile(id);
}

export async function rejectStyleProfile(id) {
  return usesDirectus() ? rejectDirectusStyleProfile(id) : rejectJsonStyleProfile(id);
}

export async function getQaCases(locale, options) {
  return usesDirectus() ? getDirectusQaCases(locale, options) : getJsonQaCases(locale, options);
}

export async function saveLearningTrajectory(input) {
  return usesDirectus() ? saveDirectusLearningTrajectory(input) : saveJsonLearningTrajectory(input);
}

export async function listLearningTrajectories(filters) {
  return usesDirectus() ? listDirectusLearningTrajectories(filters) : listJsonLearningTrajectories(filters);
}

export async function getLearningTrajectory(id) {
  return usesDirectus() ? getDirectusLearningTrajectory(id) : getJsonLearningTrajectory(id);
}

export async function updateLearningTrajectory(id, patch) {
  return usesDirectus() ? updateDirectusLearningTrajectory(id, patch) : updateJsonLearningTrajectory(id, patch);
}

export async function saveTranslationSkill(input) {
  return usesDirectus() ? saveDirectusTranslationSkill(input) : saveJsonTranslationSkill(input);
}

export async function listTranslationSkills(filters) {
  return usesDirectus() ? listDirectusTranslationSkills(filters) : listJsonTranslationSkills(filters);
}

export async function getTranslationSkill(id) {
  return usesDirectus() ? getDirectusTranslationSkill(id) : getJsonTranslationSkill(id);
}

export async function updateTranslationSkill(id, patch) {
  return usesDirectus() ? updateDirectusTranslationSkill(id, patch) : updateJsonTranslationSkill(id, patch);
}

export async function activateTranslationSkill(id) {
  return usesDirectus() ? activateDirectusTranslationSkill(id) : activateJsonTranslationSkill(id);
}

export async function rollbackTranslationSkill(id) {
  return usesDirectus() ? rollbackDirectusTranslationSkill(id) : rollbackJsonTranslationSkill(id);
}

export async function saveSkillEvaluation(input) {
  return usesDirectus() ? saveDirectusSkillEvaluation(input) : saveJsonSkillEvaluation(input);
}

export async function listSkillEvaluations(filters) {
  return usesDirectus() ? listDirectusSkillEvaluations(filters) : listJsonSkillEvaluations(filters);
}

export async function getSkillEvaluation(id) {
  return usesDirectus() ? getDirectusSkillEvaluation(id) : getJsonSkillEvaluation(id);
}

export async function updateSkillEvaluation(id, patch) {
  return usesDirectus() ? updateDirectusSkillEvaluation(id, patch) : updateJsonSkillEvaluation(id, patch);
}

export function getStoreMetadata() {
  return usesDirectus()
    ? getDirectusMetadata()
    : { type: "json", label: "Local JSON", url: null, adminUrl: null, collections: null };
}
