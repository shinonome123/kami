import test from "node:test";
import assert from "node:assert/strict";
import { assessTranslationRisk, decideQualityRoute, selectTranslationRoute } from "../src/translation-routing.mjs";

test("事实密集公告进入高风险事实保护路线", () => {
  const risk = assessTranslationRisk({
    source: "活动将于 8 月 20 日 10:00 在 Steam 开始，优惠 30%，仅限日本地区。",
    contentType: "announcement",
    facts: { count: 5 }
  });
  assert.equal(risk.tier, "high");
  const route = selectTranslationRoute({ contentType: "announcement", risk, provider: { model: "main", qualityModel: "quality" } });
  assert.equal(route.route, "fact_guarded");
  assert.equal(route.model, "quality");
});

test("短 UI 文本可以走快速直译，人工路线优先", () => {
  const automatic = selectTranslationRoute({ source: "确认", contentType: "ui", provider: { model: "main", fastModel: "fast" } });
  assert.equal(automatic.route, "direct");
  assert.equal(automatic.modelRole, "fast");
  const manual = selectTranslationRoute({ source: "确认", contentType: "ui", manualRoute: "multi_candidate", provider: { model: "main" } });
  assert.equal(manual.route, "multi_candidate");
  assert.equal(manual.manual, true);
  assert.equal(manual.candidateCount, 3);
});

test("AIQA 未完成永不自动放行，低分可升级一次", () => {
  assert.equal(decideQualityRoute({ aiQaUsed: false }).decision, "human_review");
  assert.equal(decideQualityRoute({ qaScore: 89, riskTier: "high", hasQualityUpgrade: true }).decision, "escalate_model");
  assert.equal(decideQualityRoute({ qaScore: 89, riskTier: "high", hasQualityUpgrade: true, alreadyEscalated: true }).decision, "human_review");
  assert.equal(decideQualityRoute({ qaScore: 96, riskTier: "high" }).decision, "auto_pass");
  assert.equal(decideQualityRoute({ qaScore: 99, riskTier: "critical" }).decision, "human_review");
});
