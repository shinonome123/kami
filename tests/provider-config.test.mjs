import test from "node:test";
import assert from "node:assert/strict";
import { getProviderConfig, updateProviderConfig } from "../src/provider.mjs";

test("模型设置留空时保留现有 API Key", () => {
  updateProviderConfig({ baseUrl: "http://provider.test/v1", model: "test-model", apiKey: "secret-value", persist: false });
  assert.equal(getProviderConfig().apiKeyConfigured, true);

  updateProviderConfig({ baseUrl: "http://provider-2.test/v1", model: "test-model-2", apiKey: "", persist: false });
  const preserved = getProviderConfig();
  assert.equal(preserved.apiKeyConfigured, true);
  assert.equal(preserved.apiKey, undefined);

  updateProviderConfig({ clearApiKey: true, persist: false });
  assert.equal(getProviderConfig().apiKeyConfigured, false);
});
