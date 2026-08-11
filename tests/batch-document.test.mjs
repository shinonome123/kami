import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { exportBatchDocument, prepareBatchDocument, segmentLongText } from "../src/batch-document.mjs";

test("批次只按完整句子或自然段切分，不使用固定字数", () => {
  const source = "第一句内容很长。第二句继续说明！第三句作为结尾。";
  const sentences = segmentLongText(source, "sentence");
  assert.deepEqual(sentences, ["第一句内容很长。", "第二句继续说明！", "第三句作为结尾。"]);
  assert.equal(sentences.join(""), source);
  assert.deepEqual(segmentLongText(source, "paragraph"), [source]);
  assert.equal(segmentLongText("没有标点但非常长".repeat(200), "sentence").length, 1);
});

test("TXT 解析、分段和导出保持换行结构", async () => {
  const source = "第一段。\r\n\r\n第二段。";
  const prepared = await prepareBatchDocument({ filename: "story.txt", text: source, segmentationMode: "sentence" });
  assert.equal(prepared.format, "text");
  assert.equal(prepared.segments.length, 2);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "ja-JP",
    format: prepared.format,
    structure: prepared.structure,
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `译${segment.index}` }))
  });
  assert.equal(Buffer.from(exported.base64, "base64").toString("utf8"), "译1\r\n\r\n译2");
  assert.equal(exported.filename, "story.ja-JP.txt");
});

test("同一自然段可选择逐句或整段翻译", async () => {
  const source = "第一句。第二句！第三句？";
  const sentenceMode = await prepareBatchDocument({ filename: "story.md", text: source, segmentationMode: "sentence" });
  const paragraphMode = await prepareBatchDocument({ filename: "story.md", text: source, segmentationMode: "paragraph" });
  assert.equal(sentenceMode.segments.length, 3);
  assert.equal(paragraphMode.segments.length, 1);
  assert.equal(paragraphMode.segments[0].source, source);
});

test("DOCX 翻译导出保留文档容器并替换段落", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段。</w:t></w:r></w:p><w:p><w:r><w:t>第二段。</w:t></w:r></w:p></w:body></w:document>');
  zip.file("[Content_Types].xml", "<Types></Types>");
  const original = await zip.generateAsync({ type: "nodebuffer" });
  const prepared = await prepareBatchDocument({ filename: "story.docx", base64: original.toString("base64") });
  assert.equal(prepared.segments.length, 2);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "ko-KR",
    format: prepared.format,
    structure: prepared.structure,
    base64: original.toString("base64"),
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `번역${segment.index}` }))
  });
  const outputZip = await JSZip.loadAsync(Buffer.from(exported.base64, "base64"));
  const xml = await outputZip.file("word/document.xml").async("string");
  assert.match(xml, /번역1/);
  assert.match(xml, /번역2/);
});

test("XLSX 只抽取中文单元格并在原位置写回译文", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("剧情");
  sheet.getCell("A1").value = "中文原文";
  sheet.getCell("A2").value = "欢迎回来！";
  sheet.getCell("B2").value = "Keep";
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  const prepared = await prepareBatchDocument({ filename: "lines.xlsx", base64: original.toString("base64") });
  assert.equal(prepared.segments.length, 2);

  const exported = await exportBatchDocument({
    filename: prepared.filename,
    locale: "th-TH",
    format: prepared.format,
    structure: prepared.structure,
    base64: original.toString("base64"),
    segments: prepared.segments.map((segment) => ({ ...segment, translation: `แปล${segment.index}` }))
  });
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(Buffer.from(exported.base64, "base64"));
  assert.equal(result.getWorksheet("剧情").getCell("A2").value, "แปล2");
  assert.equal(result.getWorksheet("剧情").getCell("B2").value, "Keep");
});
