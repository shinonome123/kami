import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertLocale, LOCALES } from "./config.mjs";
import {
  deleteDirectusAsset,
  getDirectusAssets,
  getDirectusAssetStats,
  getDirectusMetadata,
  initializeDirectusStore,
  completeDirectusImport,
  saveDirectusAsset,
  saveDirectusCorpus,
  saveDirectusImportPreview
} from "./directus-store.mjs";

const ROOT = fileURLToPath(new URL("../data", import.meta.url));

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
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function assetPath(locale) {
  assertLocale(locale);
  return join(ROOT, "assets", `${locale}.json`);
}

async function initializeJsonStore() {
  await mkdir(join(ROOT, "assets"), { recursive: true });
  await mkdir(join(ROOT, "corpora"), { recursive: true });
  for (const locale of Object.keys(LOCALES)) {
    const path = assetPath(locale);
    const current = await readJson(path, null);
    if (!current) {
      await writeJsonAtomic(path, { locale, revision: 1, terms: [], memories: [], styleExamples: [] });
    }
  }
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

export const DATA_ROOT = ROOT;

function usesDirectus() {
  return process.env.KAMI_STORE === "directus";
}

export async function initializeStore() {
  return usesDirectus() ? initializeDirectusStore() : initializeJsonStore();
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

export function getStoreMetadata() {
  return usesDirectus()
    ? getDirectusMetadata()
    : { type: "json", label: "Local JSON", url: null, adminUrl: null, collections: null };
}
