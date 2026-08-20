import test from "node:test";
import assert from "node:assert/strict";
import { finalizeShareGlossGeneration, summarizeShareGlossFailures } from "../src/share-gloss.mjs";

test("分享拆解：全部目标段成功后才标记 ready，并清除旧错误", () => {
  const result = finalizeShareGlossGeneration({
    status: "generating",
    meta: { source: "autoqa", generationError: "旧错误", generationFailedSegments: 2 },
    segments: [{ gloss: { tokens: [{}] } }, { gloss: { tokens: [{}] } }],
    totalSegments: 2
  });
  assert.equal(result.status, "ready");
  assert.equal(result.glossedSegments, 2);
  assert.equal(result.meta.source, "autoqa");
  assert.equal(result.meta.generationError, undefined);
  assert.equal(result.meta.generationFailedSegments, undefined);
});

test("分享拆解：模型余额不足且零成功时标记 failed，不再伪装 ready", () => {
  const result = finalizeShareGlossGeneration({
    status: "generating",
    meta: null,
    segments: [{ gloss: null }, { gloss: null }],
    totalSegments: 2
  }, { failures: [new Error('模型请求失败 (402)：{"message":"Insufficient Balance"}')] });
  assert.equal(result.status, "failed");
  assert.equal(result.glossedSegments, 0);
  assert.equal(result.meta.generationFailedSegments, 2);
  assert.match(result.meta.generationError, /余额不足/u);
});

test("分享拆解：部分成功仍标记 failed，并保留真实进度", () => {
  const result = finalizeShareGlossGeneration({
    status: "generating",
    segments: [{ gloss: { tokens: [{}] } }, { gloss: null }, { gloss: null }],
    totalSegments: 3
  }, { failures: ["模型服务请求超时"] });
  assert.equal(result.status, "failed");
  assert.equal(result.glossedSegments, 1);
  assert.equal(result.meta.generationFailedSegments, 2);
  assert.match(result.meta.generationError, /超时/u);
});

test("分享拆解：错误摘要不向公开页倾倒整段供应商响应", () => {
  assert.equal(summarizeShareGlossFailures(["QUOTA: a very long provider response"]), "模型服务余额不足，语素拆解与字面直译未完成。");
});
