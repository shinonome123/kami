/**
 * Single-case skill benchmark shared by background evaluation jobs.
 *
 * Runs one holdout case against one skill variant (champion or challenger)
 * with clean-room retrieval isolation and real token-usage capture, so the
 * promotion gates see measured cost instead of a fake zero.
 */

import { assertLocale } from "./config.mjs";
import { classifyContent } from "./classifier.mjs";
import { getAssets, getMemories, getQaCases, getStyleProfile, getUserProfile } from "./store.mjs";
import { matchTerms } from "./matcher.mjs";
import { embedSource } from "./embedding.mjs";
import { rankQaCases, rankTranslationMemories, splitReferenceAuthority } from "./translation-memory.mjs";
import { buildContextPack } from "./context-pack.mjs";
import { createUsageCollector, estimateUsageCost, evaluateTranslationWithModel, getProviderConfig, translateWithReflection } from "./provider.mjs";
import { calculateQaScore, runQa } from "./qa.mjs";
import { normalizedEditDistance } from "./learning-engine.mjs";
import { isolateBenchmarkAssets } from "./benchmark-isolation.mjs";
import { benchmarkSnapshotFingerprint } from "./evaluation-policy.mjs";

function benchmarkScope(skill) {
  const source = skill?.scope && skill.scope.locale ? skill.scope : skill;
  return {
    locale: assertLocale(source.locale),
    contentType: String(source.contentType || "general"),
    domain: String(source.domain || "general"),
    project: String(source.project || "default")
  };
}

function snapshotProvider(config = {}) {
  return {
    baseUrl: String(config.baseUrl || ""),
    model: String(config.model || ""),
    embeddingModel: String(config.embeddingModel || ""),
    inputPricePerMTok: config.inputPricePerMTok ?? "",
    outputPricePerMTok: config.outputPricePerMTok ?? ""
  };
}

/**
 * Materialize every mutable retrieval input before the first model call. Both
 * variants and every repetition then see the same term library, memories, QA
 * cases, profiles and query embeddings even if Directus changes mid-run.
 */
export async function createBenchmarkSnapshot(scope, trajectories = [], { promptVersion = "" } = {}) {
  const normalizedScope = benchmarkScope(scope);
  const [assets, styleProfile, qaCases, memories, userProfile] = await Promise.all([
    getAssets(normalizedScope.locale),
    getStyleProfile(normalizedScope.locale, normalizedScope.contentType, normalizedScope.domain),
    getQaCases(normalizedScope.locale, { contentType: normalizedScope.contentType, domain: normalizedScope.domain, limit: -1 }),
    getMemories(normalizedScope.locale, { contentType: normalizedScope.contentType, domain: normalizedScope.domain, limit: -1, exactContentType: true }),
    getUserProfile(normalizedScope.locale)
  ]);
  const queryEmbeddings = {};
  // Local embeddings are the normal fallback and are cheap; keeping this
  // sequential also avoids a snapshot creation burst against a remote service.
  for (const trajectory of trajectories) {
    const caseId = String(trajectory?.id || "");
    if (caseId) queryEmbeddings[caseId] = await embedSource(String(trajectory?.source || ""));
  }
  const frozen = {
    scope: normalizedScope,
    assets,
    styleProfile,
    qaCases,
    memories,
    userProfile,
    queryEmbeddings,
    provider: snapshotProvider(getProviderConfig()),
    promptVersion: String(promptVersion || "")
  };
  return {
    ...frozen,
    createdAt: new Date().toISOString(),
    fingerprint: benchmarkSnapshotFingerprint(frozen)
  };
}

/**
 * @param options.styleProfileOverride  Use this style profile for translation
 *   instead of the scope's active one — this is what makes a style-profile
 *   draft an actual variable in a paired benchmark instead of a constant.
 * @param options.qaStyleProfile  Style profile the AIQA judge sees. When a
 *   style draft is under test the judge must keep reading the CURRENT active
 *   profile, otherwise each variant is graded by its own yardstick and the
 *   comparison measures nothing.
 */
export async function benchmarkTranslationSkill(skill, trajectory, {
  styleProfileOverride = undefined,
  qaStyleProfile = undefined,
  snapshot = null,
  evaluationProfile = null,
  repetition = 0,
  seed = undefined
} = {}) {
  const scope = benchmarkScope(skill);
  if (snapshot?.provider) {
    const liveProvider = getProviderConfig();
    if (String(liveProvider.baseUrl || "") !== String(snapshot.provider.baseUrl || "")
      || String(liveProvider.model || "") !== String(snapshot.provider.model || "")) {
      throw new Error("评测期间模型供应商或模型已变化，禁止把不同模型输出混入同一冻结快照；请重新发起评测");
    }
  }
  const source = String(trajectory.source || "");
  // 评测固定使用本地启发式分类并把语体钉死在技能作用域，避免额外模型调用与分类漂移。
  const classification = classifyContent(source, scope.contentType);
  classification.contentType = scope.contentType;
  const assets = snapshot?.assets || await getAssets(scope.locale);
  const matches = matchTerms(source, assets, { contentType: scope.contentType, domain: scope.domain });
  const queryEmbedding = snapshot?.queryEmbeddings?.[String(trajectory.id || "")] ?? await embedSource(source);
  const [styleProfile, qaCases, memories, userProfile] = snapshot
    ? [snapshot.styleProfile, snapshot.qaCases || [], snapshot.memories || [], snapshot.userProfile]
    : await Promise.all([
      getStyleProfile(scope.locale, scope.contentType, scope.domain),
      getQaCases(scope.locale, { contentType: scope.contentType, domain: scope.domain, limit: -1 }),
      getMemories(scope.locale, { contentType: scope.contentType, domain: scope.domain, limit: -1, exactContentType: true }),
      getUserProfile(scope.locale)
    ]);
  // Clean-room isolation: never feed this holdout case its own final translation
  // back through memories, QA cases or distilled profile examples. The gold must
  // stay invisible to both variants or the benchmark measures copying, not skill.
  const translationStyleProfile = styleProfileOverride === undefined ? styleProfile : styleProfileOverride;
  const isolated = isolateBenchmarkAssets({ source, memories, qaCases, styleProfile: translationStyleProfile, userProfile });
  const memoryLimit = Math.min(10, Math.max(1, Number(skill.strategy?.retrieval?.translationMemory?.limit) || 5));
  const qaCaseLimit = Math.min(10, Math.max(1, Number(skill.strategy?.retrieval?.qaCases?.limit) || 3));
  const translationReferences = rankTranslationMemories(source, isolated.memories, { limit: memoryLimit, queryEmbedding, contentTags: classification.contentTags || [] });
  const qaGuidance = rankQaCases(source, isolated.qaCases, { limit: qaCaseLimit, queryEmbedding });
  const contextPack = buildContextPack({
    source, locale: scope.locale, classification, matches, domain: scope.domain,
    neighborContext: trajectory.contextPack?.neighborContext || "",
    styleProfile: isolated.styleProfile, translationSkill: skill, qaGuidance, userProfile: isolated.userProfile, translationReferences
  });
  // The judge gets its own pack so the style profile under test never becomes
  // the standard it is judged against.
  const judgeStyleProfile = qaStyleProfile === undefined
    ? contextPack.styleProfile
    : isolateBenchmarkAssets({ source, styleProfile: qaStyleProfile }).styleProfile;
  const qaContextPack = judgeStyleProfile === contextPack.styleProfile
    ? contextPack
    : buildContextPack({
      source, locale: scope.locale, classification, matches, domain: scope.domain,
      neighborContext: trajectory.contextPack?.neighborContext || "",
      styleProfile: judgeStyleProfile, translationSkill: skill, qaGuidance, userProfile: isolated.userProfile, translationReferences
    });
  const startedAt = Date.now();
  const usage = createUsageCollector();
  const reproducibilityWarnings = new Set();
  const onSeedUnsupported = (warning) => reproducibilityWarnings.add(String(warning || "固定 seed 未生效"));
  const translated = await translateWithReflection(contextPack, {
    reflect: false,
    onUsage: usage.onUsage,
    temperature: evaluationProfile?.translationTemperature,
    seed,
    onSeedUnsupported
  });
  const hardIssues = runQa({ source, translation: translated.translation, matches, locale: scope.locale });
  // 评测里的裁判同样不能把机器译例当标准，否则两个变体都在向系统自己的历史输出收敛。
  const referenceAuthority = splitReferenceAuthority(translationReferences);
  const aiIssues = await evaluateTranslationWithModel({
    contextPack: qaContextPack, translation: translated.translation,
    references: referenceAuthority.approved, machineDrafts: referenceAuthority.machineDrafts,
    qaCases: qaGuidance, onUsage: usage.onUsage,
    temperature: evaluationProfile?.qaTemperature,
    seed: Number.isInteger(seed) ? ((seed + 104729) & 0x7fffffff) : undefined,
    onSeedUnsupported
  });
  const score = calculateQaScore({ hardIssues, aiIssues });
  const required = matches.filter((item) => item.mode === "exact" && item.term?.enforcement === "required");
  const requiredTermHits = required.filter(({ term }) => String(translated.translation).includes(String(term.target || ""))).length;
  const gold = String(trajectory.humanDecision?.finalTranslation || trajectory.finalTranslation || "");
  const editDistance = normalizedEditDistance(translated.translation, gold);
  const usageSnapshot = usage.snapshot();
  const costUsd = usageSnapshot ? estimateUsageCost(usageSnapshot, snapshot?.provider || getProviderConfig()) : null;
  const repetitions = Math.max(1, Number(evaluationProfile?.repetitions) || 1);
  const caseId = repetitions > 1 ? `${trajectory.id}#r${Number(repetition) + 1}` : trajectory.id;
  return {
    caseId,
    sourceCaseId: trajectory.id,
    repetition: Number(repetition) || 0,
    scope,
    translation: translated.translation,
    requiredTermHits,
    requiredTermTotal: required.length,
    hardErrorCount: hardIssues.filter((issue) => issue.severity === "error").length,
    qaScore: score,
    humanEditDistance: editDistance,
    humanAccepted: editDistance <= 0.12 && score >= 90 && !hardIssues.some((issue) => issue.severity === "error"),
    styleProfileId: String(contextPack.styleProfile?.id || ""),
    qaStyleProfileId: String(qaContextPack.styleProfile?.id || ""),
    isolation: isolated.isolation,
    usage: usageSnapshot || undefined,
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
    latencyMs: Date.now() - startedAt,
    reproducibility: {
      policyVersion: evaluationProfile?.policyVersion || "legacy",
      mode: evaluationProfile?.mode || "production-default",
      temperature: Number.isFinite(Number(evaluationProfile?.translationTemperature)) ? Number(evaluationProfile.translationTemperature) : undefined,
      seedRequested: Number.isInteger(seed),
      seedSupported: reproducibilityWarnings.size === 0,
      warnings: [...reproducibilityWarnings],
      snapshotFingerprint: String(snapshot?.fingerprint || "")
    }
  };
}
