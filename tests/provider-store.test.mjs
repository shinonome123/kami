import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderConfig, saveProviderConfig } from "../src/provider-store.mjs";

test("模型配置使用 Windows 当前用户 DPAPI 加密后可跨进程恢复", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "kami-provider-"));
  try {
    const secret = "test-provider-key-not-a-real-secret";
    const saved = saveProviderConfig({ baseUrl: "https://provider.test/v1", model: "model-v1", apiKey: secret }, directory);
    assert.equal(saved.apiKeyPersisted, true);
    assert.equal(readFileSync(join(directory, "provider-key.dpapi"), "utf8").includes(secret), false);

    const loaded = loadProviderConfig(directory);
    assert.equal(loaded.config.baseUrl, "https://provider.test/v1");
    assert.equal(loaded.config.model, "model-v1");
    assert.equal(loaded.config.apiKey, secret);
    assert.equal(loaded.persistence.apiKeyPersisted, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
