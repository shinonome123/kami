import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KAMI_DATA_DIR = mkdtempSync(join(tmpdir(), "kami-quality-asset-"));
delete process.env.KAMI_STORE; // 隔离到临时 JSON 库：继承 directus 会把测试夹具写进生产库

const {
  getQualityAsset,
  listQualityAssets,
  listQualityRuns,
  saveQualityAsset,
  saveQualityRun,
  updateQualityAsset
} = await import("../src/store.mjs");
const { normalizeGoldSet } = await import("../src/gold-regression.mjs");

const SCOPE = { locale: "ja-JP", contentType: "announcement", domain: "game", project: "default" };

function goldSetPayload(version, { status = "draft" } = {}) {
  return normalizeGoldSet({
    id: `gold:series#v${version}`,
    seriesId: "gold:series",
    version,
    scope: SCOPE,
    name: "发布 Gold Set",
    status,
    enabled: status === "active",
    samples: [{
      id: `sample-${version}`,
      source: "8月20日にセールを開始します。",
      referenceTargets: ["8月20日よりセールを開始いたします。"]
    }]
  });
}

test("资产的语义版本 id 不会顶替存储层的行 id", async () => {
  const payload = goldSetPayload(1);
  const saved = await saveQualityAsset({ kind: "gold_set", scope: SCOPE, payload, status: payload.status });
  assert.notEqual(saved.id, payload.id, "行 id 必须由存储层生成，语义 id 只留在 payload 里");
  assert.equal(saved.payload.id, "gold:series#v1");
  assert.equal(saved.seriesId, "gold:series");
  assert.equal(saved.version, 1);
  assert.equal(saved.itemCount, 1);
  assert.ok(saved.fingerprint);

  const fetched = await getQualityAsset(saved.id);
  assert.equal(fetched.id, saved.id);
  assert.equal(fetched.payload.id, payload.id);
});

test("同一版本族的两个版本各占一行，不会互相覆盖", async () => {
  const first = await saveQualityAsset({ kind: "gold_set", scope: SCOPE, payload: goldSetPayload(2) });
  const second = await saveQualityAsset({ kind: "gold_set", scope: SCOPE, payload: goldSetPayload(3) });
  assert.notEqual(first.id, second.id);
  const listed = await listQualityAssets({ ...SCOPE, kind: "gold_set", seriesId: "gold:series", limit: 50 });
  const versions = listed.map((item) => item.version).sort((left, right) => left - right);
  assert.deepEqual(versions, [1, 2, 3]);
});

test("补丁只改生命周期字段，改不动已落库的内容", async () => {
  const payload = goldSetPayload(4);
  const saved = await saveQualityAsset({ kind: "gold_set", scope: SCOPE, payload });
  const activated = await updateQualityAsset(saved.id, {
    status: "active",
    enabled: true,
    payload: { ...saved.payload, status: "active", enabled: true }
  });
  assert.equal(activated.status, "active");
  assert.equal(activated.enabled, true);
  assert.equal(activated.payload.samples.length, 1, "补丁不应丢掉样本内容");
  assert.equal(activated.seriesId, saved.seriesId);
});

test("未知资产类型直接拒收", async () => {
  await assert.rejects(
    () => saveQualityAsset({ kind: "whatever", scope: SCOPE, payload: goldSetPayload(9) }),
    /quality asset kind/
  );
});

test("门禁运行按作用域与技能落档，结论只认三种取值", async () => {
  const run = await saveQualityRun({
    ...SCOPE,
    skillId: "skill-1",
    decision: "block",
    regressionTotal: 3,
    regressionPassed: 2,
    regressionPassRate: 2 / 3,
    goldTotal: 5,
    goldTermAccuracy: 0.9,
    blocking: [{ code: "regression_failed", message: "1 个历史失败复发" }],
    triggeredBy: "test"
  });
  assert.equal(run.decision, "block");
  assert.equal(run.regressionPassed, 2);
  assert.deepEqual(run.blocking, [{ code: "regression_failed", message: "1 个历史失败复发" }]);

  const runs = await listQualityRuns({ ...SCOPE, skillId: "skill-1", limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, run.id);

  await assert.rejects(
    () => saveQualityRun({ ...SCOPE, skillId: "skill-1", decision: "approved" }),
    /quality gate decision/
  );
});
