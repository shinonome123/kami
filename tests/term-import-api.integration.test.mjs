import test from "node:test";
import assert from "node:assert/strict";
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
  const preview = await request(`${appUrl}/api/term-import/preview`, {
    method: "POST",
    body: JSON.stringify({ filename: "术语闭环测试.xlsx", locale: "auto", useModel: false, base64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64") })
  });
  const imported = [];
  try {
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
