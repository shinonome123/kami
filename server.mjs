import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_TYPES, LOCALES, assertLocale } from "./src/config.mjs";
import { classifyContent } from "./src/classifier.mjs";
import { buildContextPack } from "./src/context-pack.mjs";
import { refineCorpus } from "./src/corpus.mjs";
import { matchTerms } from "./src/matcher.mjs";
import { alignTermSuggestionsWithModel, classifyWithModel, getProviderConfig, reviewTermCandidatesWithModel, translateWithReflection, updateProviderConfig } from "./src/provider.mjs";
import { runQa } from "./src/qa.mjs";
import { completeImport, deleteAsset, getAssets, getAssetStats, getStoreMetadata, initializeStore, saveAsset, saveCorpus, saveImportPreview } from "./src/store.mjs";
import { applyModelDecisions, extractTermPairs } from "./src/table-term-extractor.mjs";
import { buildSuggestionCandidates, resolveTermSuggestions } from "./src/term-suggestions.mjs";
import { exportBatchDocument, prepareBatchDocument } from "./src/batch-document.mjs";

const PUBLIC_ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求内容超过 15MB 限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求 JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

async function classify(body) {
  const heuristic = classifyContent(body.text, body.hint);
  if (!body.useModel || heuristic.source === "manual" || heuristic.confidence >= 0.86) return heuristic;
  try {
    const model = await classifyWithModel(body.text);
    if (!Object.hasOwn(CONTENT_TYPES, model.contentType)) throw new Error("模型返回不支持的内容类型");
    return model;
  } catch (error) {
    return { ...heuristic, fallbackReason: error.message };
  }
}

function importStatistics(candidates) {
  return {
    candidates: candidates.length,
    ready: candidates.filter((item) => item.decision === "ready").length,
    review: candidates.filter((item) => item.decision === "review").length,
    excluded: candidates.filter((item) => item.decision === "excluded").length,
    existing: candidates.filter((item) => item.existing).length,
    locales: Object.fromEntries(Object.keys(LOCALES).map((locale) => [locale, candidates.filter((item) => item.locale === locale).length]))
  };
}

async function previewTermImport(body) {
  const extracted = await extractTermPairs(body);
  let candidates = extracted.candidates;
  const assetsByLocale = {};
  for (const locale of new Set(candidates.map((candidate) => candidate.locale))) {
    assetsByLocale[locale] = (await getAssets(locale)).terms;
  }
  candidates = candidates.map((candidate) => {
    const sameSource = assetsByLocale[candidate.locale].filter((term) => term.source.trim().toLocaleLowerCase() === candidate.source.toLocaleLowerCase());
    const exact = sameSource.find((term) => term.target.trim().toLocaleLowerCase() === candidate.target.toLocaleLowerCase());
    if (exact) return { ...candidate, existing: true, existingId: exact.id, decision: "excluded", reasons: [...candidate.reasons, "当前语言库已存在相同对照"] };
    if (sameSource.length) return { ...candidate, conflict: true, existingTarget: sameSource[0].target, decision: "review", score: Math.min(candidate.score, 0.67), reasons: [...candidate.reasons, `当前语言库已有译法：${sameSource[0].target}`] };
    return candidate;
  });

  const ai = { requested: Boolean(body.useModel), used: false, reviewed: 0, fallbackReason: "" };
  if (body.useModel) {
    try {
      for (const locale of new Set(candidates.map((candidate) => candidate.locale))) {
        const indexes = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.locale === locale && !candidate.existing);
        if (!indexes.length) continue;
        const decisions = await reviewTermCandidatesWithModel(locale, indexes.map(({ candidate }) => candidate));
        const reviewed = applyModelDecisions(indexes.map(({ candidate }) => candidate), decisions);
        indexes.forEach(({ index }, localIndex) => { candidates[index] = reviewed[localIndex]; });
        ai.reviewed += indexes.length;
      }
      ai.used = ai.reviewed > 0;
    } catch (error) {
      ai.fallbackReason = error.message;
    }
  }
  extracted.candidates = candidates;
  extracted.statistics = { ...extracted.statistics, ...importStatistics(candidates) };
  extracted.ai = ai;
  const saved = await saveImportPreview(extracted);
  return { ...extracted, ...saved };
}

async function commitTermImport(body) {
  if (!body.batchId || !Array.isArray(body.candidates)) {
    const error = new Error("导入批次或候选数据无效");
    error.statusCode = 400;
    throw error;
  }
  const imported = [];
  const skipped = [];
  const decisions = [];
  for (const candidate of body.candidates) {
    const decision = { candidateId: candidate.candidateId, status: "rejected", decision: candidate.decision };
    if (!candidate.selected || candidate.existing || candidate.decision === "excluded") {
      skipped.push({ source: candidate.source, locale: candidate.locale, reason: candidate.existing ? "已存在" : "未选择" });
      decisions.push(decision);
      continue;
    }
    try {
      const locale = assertLocale(candidate.locale);
      const source = String(candidate.source || "").trim();
      const target = String(candidate.target || "").trim();
      if (!source || !target) throw new Error("源词或译法为空");
      const current = (await getAssets(locale)).terms.filter((term) => term.source.toLocaleLowerCase() === source.toLocaleLowerCase());
      if (current.some((term) => term.target.toLocaleLowerCase() === target.toLocaleLowerCase())) {
        skipped.push({ source, locale, reason: "已存在相同对照" });
        decisions.push(decision);
        continue;
      }
      if (current.length) {
        skipped.push({ source, locale, reason: `库内已有译法：${current[0].target}` });
        decisions.push(decision);
        continue;
      }
      const term = await saveAsset(locale, {
        source,
        target,
        aliases: [],
        forbidden: [],
        domains: [body.domain || "game"],
        contentTypes: [body.contentType || "general"],
        enforcement: body.enforcement || "required",
        status: "approved",
        provenance: `table-import:${String(body.filename || "unknown").slice(0, 120)}`,
        note: `批次 ${body.batchId} · 原表第 ${candidate.rowNumber || "?"} 行 · 清洗分 ${candidate.score ?? "-"}`
      });
      imported.push({ id: term.id, source, target, locale });
      decision.status = "accepted";
      decision.decision = "ready";
      decisions.push(decision);
    } catch (error) {
      skipped.push({ source: candidate.source, locale: candidate.locale, reason: error.message });
      decisions.push(decision);
    }
  }
  const summary = { imported: imported.length, skipped: skipped.length, completedAt: new Date().toISOString() };
  await completeImport(body.batchId, decisions, summary);
  return { batchId: body.batchId, imported, skipped, summary };
}

async function apiHandler(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, version: "0.5.2", locales: Object.keys(LOCALES), backend: getStoreMetadata() });
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const assets = {};
    for (const locale of Object.keys(LOCALES)) {
      const stats = await getAssetStats(locale);
      assets[locale] = { revision: stats.revision, termCount: stats.termCount };
    }
    return json(res, 200, { locales: LOCALES, contentTypes: CONTENT_TYPES, provider: getProviderConfig(), backend: getStoreMetadata(), assets });
  }
  if (req.method === "GET" && url.pathname === "/api/assets") {
    const locale = assertLocale(url.searchParams.get("locale"));
    return json(res, 200, await getAssets(locale));
  }
  if (req.method === "POST" && url.pathname === "/api/assets") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    return json(res, 201, await saveAsset(locale, body.term || {}));
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/assets/")) {
    const locale = assertLocale(url.searchParams.get("locale"));
    const id = decodeURIComponent(url.pathname.slice("/api/assets/".length));
    const deleted = await deleteAsset(locale, id);
    return json(res, deleted ? 200 : 404, { deleted });
  }
  if (req.method === "POST" && url.pathname === "/api/classify") {
    return json(res, 200, await classify(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/match") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const assets = await getAssets(locale);
    return json(res, 200, {
      locale,
      matches: matchTerms(body.text, assets, { contentType: body.contentType, domain: body.domain })
    });
  }
  if (req.method === "POST" && url.pathname === "/api/corpus/refine") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 200, refined);
  }
  if (req.method === "POST" && url.pathname === "/api/corpus") {
    const body = await readJsonBody(req);
    const refined = refineCorpus(body.text, body.options);
    return json(res, 201, await saveCorpus({ ...body, ...refined }));
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/preview") {
    return json(res, 200, await previewTermImport(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/term-import/commit") {
    return json(res, 201, await commitTermImport(await readJsonBody(req)));
  }
  if (req.method === "GET" && url.pathname === "/api/provider") {
    return json(res, 200, getProviderConfig());
  }
  if (req.method === "POST" && url.pathname === "/api/provider") {
    return json(res, 200, updateProviderConfig(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/batch/prepare") {
    return json(res, 200, await prepareBatchDocument(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/batch/export") {
    return json(res, 200, await exportBatchDocument(await readJsonBody(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/qa") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    const assets = await getAssets(locale);
    const matches = matchTerms(body.source || "", assets, { contentType: body.contentType || "general", domain: body.domain || "general" });
    return json(res, 200, { matches, issues: runQa({ source: body.source || "", translation: body.translation || "", matches }) });
  }
  if (req.method === "POST" && url.pathname === "/api/translate") {
    const body = await readJsonBody(req);
    const locale = assertLocale(body.locale);
    if (!String(body.source || "").trim()) {
      const error = new Error("请输入中文原文");
      error.statusCode = 400;
      throw error;
    }
    const classification = await classify({ text: body.source, hint: body.contentType, useModel: body.useModelClassification });
    const assets = await getAssets(locale);
    const matches = matchTerms(body.source, assets, {
      contentType: classification.contentType,
      domain: body.domain || "general"
    });
    const contextPack = buildContextPack({
      source: body.source,
      locale,
      classification,
      matches,
      domain: body.domain || "general",
      neighborContext: body.neighborContext || "",
      styleProfile: body.styleProfile || null
    });
    const result = await translateWithReflection(contextPack, { reflect: body.reflect !== false });
    const issues = runQa({ source: body.source, translation: result.translation, matches });
    const suggestionCandidates = buildSuggestionCandidates(result.translation, matches);
    let alignment = { requested: suggestionCandidates.length > 0, used: false, fallbackReason: "" };
    let modelSuggestions = [];
    if (suggestionCandidates.length) {
      try {
        modelSuggestions = await alignTermSuggestionsWithModel(locale, result.translation, suggestionCandidates);
        alignment.used = true;
      } catch (error) {
        alignment.fallbackReason = error.message;
      }
    }
    const termSuggestions = resolveTermSuggestions(result.translation, suggestionCandidates, modelSuggestions);
    return json(res, 200, {
      locale,
      classification,
      matches,
      contextPack,
      ...result,
      issues,
      termSuggestions,
      suggestionAlignment: alignment
    });
  }
  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const path = join(PUBLIC_ROOT, safePath);
  if (!path.startsWith(PUBLIC_ROOT)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(path)] || "application/octet-stream",
      "content-length": body.length
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

await initializeStore();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await apiHandler(req, res, url);
      if (handled === false) json(res, 404, { error: "API not found" });
      return;
    }
    if (!(await serveStatic(req, res, url))) json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Kami Localization Workbench: http://127.0.0.1:${PORT}`);
});
