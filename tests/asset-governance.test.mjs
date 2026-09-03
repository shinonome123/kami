import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_TIERS,
  MEMORY_PURPOSES,
  deriveTermCandidatesFromHumanFinal,
  evaluateAssetEffectiveness,
  expectedTermTarget,
  filterEffectiveTerms,
  findTermSourceMatch,
  normalizeAssetGovernance,
  partitionTranslationMemories
} from "../src/asset-governance.mjs";
import { rankTranslationMemories } from "../src/translation-memory.mjs";

const NOW = new Date("2026-09-03T10:00:00.000Z");

test("旧数据补齐治理默认值，但缺失批准状态不会被误升为正式资产", () => {
  const legacyHuman = normalizeAssetGovernance({ source: "甲", target: "乙", qualityStatus: "human_approved" }, { kind: "translation_memory" });
  assert.equal(legacyHuman.assetTier, ASSET_TIERS.FORMAL);
  assert.equal(legacyHuman.version, 1);
  assert.equal(legacyHuman.lifecycleStatus, "active");
  assert.equal(legacyHuman.caseSensitive, false);
  assert.equal(legacyHuman.preserveOriginal, false);
  assert.equal(legacyHuman.validFrom, null);
  assert.equal(legacyHuman.validTo, null);

  const unknownMemory = normalizeAssetGovernance({ source: "甲", target: "乙" }, { kind: "translation_memory" });
  assert.equal(unknownMemory.qualityStatus, "provisional");
  assert.equal(unknownMemory.assetTier, ASSET_TIERS.CANDIDATE);

  const unknownTerm = normalizeAssetGovernance({ source: "甲", target: "乙" });
  assert.equal(unknownTerm.approvalStatus, "draft");
  assert.equal(unknownTerm.assetTier, ASSET_TIERS.CANDIDATE);
});

test("正式 TM 只认人工批准，机器通过稿不能充当生产或 QA 权威", () => {
  const memories = [
    { id: "human", source: "活动开始", target: "イベント開始", qualityStatus: "human_approved" },
    { id: "machine", source: "活动开始", target: "イベントが始まる", qualityStatus: "machine_verified", batchId: "batch-1", createdAt: "2026-09-03T09:00:00.000Z" }
  ];
  for (const purpose of [MEMORY_PURPOSES.PRODUCTION, MEMORY_PURPOSES.QA_AUTHORITY]) {
    const result = partitionTranslationMemories(memories, { batchId: "batch-1" }, { purpose, now: NOW });
    assert.deepEqual(result.references.map((item) => item.id), ["human"]);
    assert.deepEqual(result.authority.map((item) => item.id), ["human"]);
    assert.deepEqual(result.working, []);
  }
});

test("机器 TM 仅在显式工作记忆模式和同批/受限短期上下文中可用", () => {
  const memories = [
    { id: "same-batch", source: "甲", target: "A", qualityStatus: "machine_verified", batchId: "b1", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "same-task-recent", source: "乙", target: "B", qualityStatus: "machine_verified", taskId: "t1", createdAt: "2026-09-03T09:30:00.000Z" },
    { id: "same-task-expired", source: "丙", target: "C", qualityStatus: "machine_verified", taskId: "t1", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "other", source: "丁", target: "D", qualityStatus: "machine_verified", batchId: "b2", createdAt: "2026-09-03T09:50:00.000Z" }
  ];
  const result = partitionTranslationMemories(memories, { batchId: "b1", taskId: "t1" }, {
    purpose: MEMORY_PURPOSES.WORKING_CONSISTENCY,
    now: NOW,
    workingWindowMs: 60 * 60 * 1_000
  });
  assert.deepEqual(result.working.map((item) => item.id), ["same-batch", "same-task-recent"]);
  assert.deepEqual(result.authority, []);
  assert.ok(result.excluded.some((item) => item.asset.id === "same-task-expired" && item.reasons.includes("working_scope_mismatch")));
  assert.ok(result.excluded.some((item) => item.asset.id === "other" && item.reasons.includes("working_scope_mismatch")));
});

test("翻译记忆排序默认排除机器稿，显式同批一致性检索才纳入", () => {
  const pool = [
    { id: "human", source: "高级通行证开放购买", target: "プレミアムパスを販売中", qualityStatus: "human_approved" },
    { id: "machine", source: "高级通行证开放购买", target: "高級パスを販売中", qualityStatus: "machine_verified", batchId: "b1" }
  ];
  assert.deepEqual(rankTranslationMemories("高级通行证开放购买", pool).map((item) => item.id), ["human"]);
  assert.deepEqual(rankTranslationMemories("高级通行证开放购买", pool, {
    retrievalPurpose: MEMORY_PURPOSES.WORKING_CONSISTENCY,
    batchId: "b1"
  }).map((item) => item.id).sort(), ["human", "machine"]);
});

test("术语按语言、语体、领域、生效期、废弃状态和最新版本共同过滤", () => {
  const base = {
    source: "高级通行证",
    target: "プレミアムパス",
    status: "approved",
    locale: "ja-JP",
    contentTypes: ["marketing"],
    domains: ["game"]
  };
  const terms = [
    { ...base, id: "current", versionGroupId: "pass", version: 2, validFrom: "2026-01-01", validTo: "2026-12-31" },
    { ...base, id: "old", versionGroupId: "pass", version: 1 },
    { ...base, id: "deprecated", source: "旧赛季", versionGroupId: "old-season", deprecated: true },
    { ...base, id: "future", source: "未来活动", versionGroupId: "future", validFrom: "2027-01-01" },
    { ...base, id: "wrong-locale", source: "错误语言", versionGroupId: "wrong-locale", locale: "ko-KR" },
    { ...base, id: "candidate", source: "待审词", versionGroupId: "candidate", status: "pending" }
  ];
  const selected = filterEffectiveTerms(terms, { locale: "ja-JP", contentType: "marketing", domain: "game" }, { now: NOW });
  assert.deepEqual(selected.map((item) => item.id), ["current"]);
});

test("无效日期不会悄悄变成永久有效", () => {
  const result = evaluateAssetEffectiveness({
    source: "测试", target: "テスト", status: "approved", validTo: "not-a-date"
  }, {}, { kind: "term", now: NOW });
  assert.equal(result.effective, false);
  assert.ok(result.reasons.includes("invalid_valid_to"));
});

test("大小写敏感与保留原文均为可执行规则", () => {
  const sensitive = { source: "KAMI", target: "カミ", status: "approved", caseSensitive: true };
  assert.equal(findTermSourceMatch("欢迎来到 Kami", sensitive).matched, false);
  assert.equal(findTermSourceMatch("欢迎来到 KAMI", sensitive).matched, true);
  assert.equal(findTermSourceMatch("欢迎来到 kami", { ...sensitive, caseSensitive: false }).matched, true);
  assert.equal(expectedTermTarget({ ...sensitive, preserveOriginal: true }, { matchedSource: "KAMI" }), "KAMI");
  assert.equal(expectedTermTarget(sensitive, { matchedSource: "KAMI" }), "カミ");
});

test("人工终稿中的真实术语命中只生成待批准证据候选", () => {
  const candidates = deriveTermCandidatesFromHumanFinal({
    locale: "ja-JP",
    source: "数字豪华版现已推出。",
    finalTranslation: "デジタルデラックス版が登場しました。",
    contentType: "marketing",
    domain: "game",
    batchId: "batch-1",
    matches: [{
      mode: "exact",
      matchPhrase: "数字豪华版",
      score: 1,
      term: { id: "term-1", source: "数字豪华版", target: "デジタルデラックス版", status: "approved" }
    }]
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, "pending");
  assert.equal(candidates[0].assetTier, ASSET_TIERS.CANDIDATE);
  assert.equal(candidates[0].requiresHumanApproval, true);
  assert.equal(candidates[0].proposalAction, "add_usage_evidence");
  assert.equal(candidates[0].provenance, "human-final:confirmed_term_hit");
  assert.equal(candidates[0].batchId, "batch-1");
});

test("人工终稿采用模糊命中的新源文变体时生成别名候选", () => {
  const candidates = deriveTermCandidatesFromHumanFinal({
    locale: "ja-JP",
    source: "豪华数字版现已推出。",
    finalTranslation: "デジタルデラックス版が登場しました。",
    matches: [{
      mode: "smart",
      matchPhrase: "豪华数字版",
      score: 0.91,
      term: { id: "term-1", source: "数字豪华版", target: "デジタルデラックス版", status: "approved" }
    }]
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].proposalAction, "add_alias");
  assert.equal(candidates[0].status, "pending");
});

test("高置信建议必须同时落在真实原文和人工终稿中，且不能夹带自动批准", () => {
  const candidates = deriveTermCandidatesFromHumanFinal({
    locale: "ko-KR",
    source: "完成天命挑战即可获得限定奖励。",
    finalTranslation: "천명 도전을 완료하면 한정 보상을 획득할 수 있습니다.",
    suggestions: [
      { source: "天命挑战", target: "천명 도전", confidence: 0.94, status: "approved", reason: "反复出现的玩法名" },
      { source: "限定奖励", target: "한정 보상", confidence: 0.7 },
      { source: "不存在的词", target: "천명 도전", confidence: 0.99 },
      { source: "天命挑战", target: "不存在的译法", confidence: 0.99 }
    ]
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "天命挑战");
  assert.equal(candidates[0].target, "천명 도전");
  assert.equal(candidates[0].status, "pending");
  assert.equal(candidates[0].approvalStatus, "pending");
  assert.equal(candidates[0].proposalAction, "create_term");
});

test("同目标译法的新源文表达被归类为别名候选，跨语种现有术语不参与判断", () => {
  const candidates = deriveTermCandidatesFromHumanFinal({
    locale: "ja-JP",
    source: "豪华数字版现已推出。",
    finalTranslation: "デジタルデラックス版が登場しました。",
    existingTerms: [
      { locale: "ja-JP", source: "数字豪华版", target: "デジタルデラックス版", status: "approved" },
      { locale: "ko-KR", source: "豪华数字版", target: "디지털 디럭스 에디션", status: "approved" }
    ],
    suggestions: [{ source: "豪华数字版", target: "デジタルデラックス版", confidence: 0.97 }]
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].proposalAction, "add_alias");
  assert.deepEqual(candidates[0].domains, ["general"]);
  assert.deepEqual(candidates[0].contentTypes, ["general"]);
});

test("人工终稿术语提取强制指定目标语种，避免多语资产混库", () => {
  assert.throws(() => deriveTermCandidatesFromHumanFinal({ source: "天命", finalTranslation: "運命" }), /必须指定目标语种/);
});
