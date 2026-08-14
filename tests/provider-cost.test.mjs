import test from "node:test";
import assert from "node:assert/strict";
import { costPricingConfigured, createUsageCollector, estimateUsageCost } from "../src/provider.mjs";

test("estimateUsageCost 按百万 token 单价计算成本", () => {
  const cost = estimateUsageCost(
    { promptTokens: 1_000_000, completionTokens: 2_000_000 },
    { inputPricePerMTok: "0.27", outputPricePerMTok: "1.1" }
  );
  assert.equal(cost, 0.27 + 2.2);
});

test("缺失定价或缺失 usage 时返回 null，不伪造 0", () => {
  assert.equal(estimateUsageCost({ promptTokens: 10, completionTokens: 5 }, { inputPricePerMTok: "0.27" }), null);
  assert.equal(estimateUsageCost({ promptTokens: 10, completionTokens: 5 }, {}), null);
  assert.equal(estimateUsageCost(null, { inputPricePerMTok: "1", outputPricePerMTok: "1" }), null);
  assert.equal(estimateUsageCost({ promptTokens: -1, completionTokens: 5 }, { inputPricePerMTok: "1", outputPricePerMTok: "1" }), null);
  assert.equal(estimateUsageCost({ promptTokens: 10 }, { inputPricePerMTok: "1", outputPricePerMTok: "1" }), null);
});

test("价格为 0 是合法配置（本地免费模型）", () => {
  assert.equal(estimateUsageCost({ promptTokens: 1000, completionTokens: 500 }, { inputPricePerMTok: "0", outputPricePerMTok: "0" }), 0);
  assert.equal(costPricingConfigured({ inputPricePerMTok: "0", outputPricePerMTok: "0" }), true);
});

test("costPricingConfigured 需要输入输出定价齐全", () => {
  assert.equal(costPricingConfigured({ inputPricePerMTok: "1", outputPricePerMTok: "1" }), true);
  assert.equal(costPricingConfigured({ inputPricePerMTok: "1" }), false);
  assert.equal(costPricingConfigured({ inputPricePerMTok: "abc", outputPricePerMTok: "1" }), false);
  assert.equal(costPricingConfigured({}), false);
});

test("usage 收集器累计多次调用，非法值忽略，无调用时返回 null", () => {
  const collector = createUsageCollector();
  assert.equal(collector.snapshot(), null);
  collector.onUsage({ promptTokens: 10, completionTokens: 5 });
  collector.onUsage({ promptTokens: 20, completionTokens: 15 });
  collector.onUsage({ promptTokens: -5, completionTokens: 3 });
  collector.onUsage(null);
  assert.deepEqual(collector.snapshot(), { promptTokens: 30, completionTokens: 20, calls: 2 });
});
