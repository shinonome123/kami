import test from "node:test";
import assert from "node:assert/strict";
import { deleteAsset, getAssets, getAssetStats, initializeStore, saveAsset } from "../src/store.mjs";

const enabled = process.env.KAMI_STORE === "directus";

test("Directus 四语集合可读、可统计并保持写入隔离", { skip: !enabled }, async () => {
  await initializeStore();

  const locales = ["ja-JP", "ko-KR", "zh-Hant-TW", "th-TH"];
  const stats = await Promise.all(locales.map((locale) => getAssetStats(locale)));
  assert.deepEqual(stats.map((entry) => entry.locale), locales);
  assert.ok(stats.every((entry) => entry.termCount >= 1));

  const japanese = await getAssets("ja-JP");
  const korean = await getAssets("ko-KR");
  assert.equal(japanese.terms.find((term) => term.source === "高级通行证")?.target, "プレミアムパス");
  assert.equal(korean.terms.find((term) => term.source === "高级通行证")?.target, "프리미엄 패스");
  assert.equal(japanese.terms.some((term) => term.target === "프리미엄 패스"), false);

  const temporary = await saveAsset("th-TH", {
    source: "集成测试术语",
    target: "คำทดสอบการเชื่อมต่อ",
    domains: ["test"],
    contentTypes: ["general"],
    status: "draft",
    provenance: "integration-test"
  });
  try {
    assert.ok(temporary.id);
    const thai = await getAssets("th-TH");
    assert.ok(thai.terms.some((term) => term.id === temporary.id));
    const japaneseAfterWrite = await getAssets("ja-JP");
    assert.equal(japaneseAfterWrite.terms.some((term) => term.source === "集成测试术语"), false);
  } finally {
    await deleteAsset("th-TH", temporary.id);
  }
});
