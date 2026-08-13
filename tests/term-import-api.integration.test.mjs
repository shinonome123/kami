import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";

const enabled = process.env.KAMI_API_E2E === "1" && process.env.KAMI_STORE === "directus";
const appUrl = "http://127.0.0.1:4173";
const directusUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data ?? payload;
}

test("表格预览、分语言入库与清理形成完整闭环", { skip: !enabled }, async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("术语表");
  sheet.addRows([
    ["中文", "日语", "韩语", "繁體中文", "泰语"],
    ["星辉徽章测试", "スターライトバッジテスト", "별빛 배지 테스트", "星輝徽章測試", "ตราแสงดาวทดสอบ"]
  ]);
  const progressId = randomUUID();
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({ filename: "术语闭环测试.xlsx", locale: "auto", useModel: false, progressId, base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") })
  });
  const imported = [];
  try {
    const progress = await request(`${appUrl}/api/term-import/progress/${progressId}`);
    assert.equal(progress.status, "completed");
    assert.equal(progress.percent, 100);
    assert.equal(preview.candidates.length, 4);
    assert.equal(new Set(preview.candidates.map((item) => item.locale)).size, 4);
    const committed = await request(`${appUrl}/api/term-import/commit`, {
      method: "POST",
      body: JSON.stringify({
        batchId: preview.batchId,
        filename: preview.filename,
        domain: "test",
        contentType: "item_name",
        enforcement: "required",
        candidates: preview.candidates.map((candidate) => ({ ...candidate, selected: true }))
      })
    });
    imported.push(...committed.imported);
    assert.equal(committed.imported.length, 4);
    for (const item of imported) {
      const assets = await request(`${appUrl}/api/assets?locale=${encodeURIComponent(item.locale)}`);
      assert.ok(assets.terms.some((term) => term.id === item.id));
      assert.equal(assets.terms.some((term) => term.source === item.source && term.target !== item.target), false);
    }
  } finally {
    for (const item of imported) await request(`${appUrl}/api/assets/${item.id}?locale=${encodeURIComponent(item.locale)}`, { method: "DELETE" });
    const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});

test("Directus 候选审核队列接受超过 255 字符的中外文句段", { skip: !enabled }, async () => {
  const adminHeaders = { Authorization: `Bearer ${process.env.DIRECTUS_ADMIN_TOKEN}` };
  const longSource = "长句候选内容".repeat(60);
  const longTarget = "長文翻訳候補です。".repeat(60);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("长句候选");
  sheet.addRows([["中文", "日语"], [longSource, longTarget]]);
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({
      filename: "长句候选容量测试.xlsx",
      locale: "ja-JP",
      useModel: false,
      base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64")
    })
  });
  try {
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0].source.length, longSource.length);
    assert.equal(preview.candidates[0].target.length, longTarget.length);
  } finally {
    const candidateIds = preview.candidates.map((item) => item.candidateId).filter(Boolean);
    if (candidateIds.length) await request(`${directusUrl}/items/term_candidates`, { method: "DELETE", headers: adminHeaders, body: JSON.stringify(candidateIds) });
    await request(`${directusUrl}/items/term_import_batches/${preview.batchId}`, { method: "DELETE", headers: adminHeaders });
  }
});
