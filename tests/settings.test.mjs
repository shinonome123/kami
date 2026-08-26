import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTING_SPECS, TITLE_BRACKET_CHOICES, defaultSettings, sanitizeSettings, settingGroups } from "../src/settings.mjs";

process.env.KAMI_PROVIDER_DIRECTORY = mkdtempSync(join(tmpdir(), "kami-settings-"));
delete process.env.KAMI_STYLE_DISTILL_THRESHOLD;
delete process.env.KAMI_AUTO_PROPOSE_THRESHOLD;
const store = await import("../src/settings-store.mjs");

test("出厂值覆盖每一个声明字段，且都落在自己的区间内", () => {
  const settings = defaultSettings();
  for (const [path, spec] of Object.entries(SETTING_SPECS)) {
    const value = path.split(".").reduce((carry, key) => carry?.[key], settings);
    assert.equal(value, spec.default, `${path} 缺少出厂值`);
    assert.ok(value >= spec.min && value <= spec.max, `${path} 的出厂值不在区间内`);
  }
  assert.ok(settings.orthography.titleBrackets["ja-JP"]);
});

test("越界数值被夹紧而不是被接受，并且报告校正原因", () => {
  const { settings, notes } = sanitizeSettings({ quality: { qaPassScore: 999, penaltyMinor: -5 } });
  assert.equal(settings.quality.qaPassScore, 100);
  assert.equal(settings.quality.penaltyMinor, SETTING_SPECS["quality.penaltyMinor"].min);
  assert.equal(notes.length, 2, "两处越界必须各有一条可见的校正说明");
});

test("非数值输入回落出厂值而不是变成 NaN", () => {
  const { settings } = sanitizeSettings({ quality: { qaPassScore: "还行吧" } });
  assert.equal(settings.quality.qaPassScore, 90);
});

test("Auto QA 三维权重之和必须为 100，否则整组回落", () => {
  // 权重不归一等于悄悄改变满分刻度，分数将不可跨文档比较。
  const { settings, notes } = sanitizeSettings({ quality: { weightBasic: 10, weightFidelity: 10, weightNuance: 10 } });
  assert.deepEqual(
    [settings.quality.weightBasic, settings.quality.weightFidelity, settings.quality.weightNuance],
    [20, 50, 30]
  );
  assert.ok(notes.some((note) => /必须等于 100/.test(note.note)));
});

test("合法的自定义权重被保留", () => {
  const { settings, notes } = sanitizeSettings({ quality: { weightBasic: 30, weightFidelity: 40, weightNuance: 30 } });
  assert.equal(settings.quality.weightFidelity, 40);
  assert.equal(notes.filter((note) => note.path === "quality.weights").length, 0);
});

test("增长窗口大于阈值会把功能配死，自动收敛到阈值", () => {
  const { settings, notes } = sanitizeSettings({
    learning: { styleDistillThreshold: 8, styleDistillGrowthWindow: 50, autoProposeThreshold: 10, autoProposeGrowthWindow: 99 }
  });
  assert.equal(settings.learning.styleDistillGrowthWindow, 8);
  assert.equal(settings.learning.autoProposeGrowthWindow, 10);
  assert.equal(notes.filter((note) => /不应大于阈值/.test(note.note)).length, 2);
});

test("作品名括号只接受受支持的括号对，空串表示不检查", () => {
  const { settings, notes } = sanitizeSettings({ orthography: { titleBrackets: { "ko-KR": "「」", "ja-JP": "【】", "th-TH": "" } } });
  assert.equal(settings.orthography.titleBrackets["ko-KR"], "「」");
  assert.equal(settings.orthography.titleBrackets["ja-JP"], "『』", "非法括号对回落默认");
  assert.equal(settings.orthography.titleBrackets["th-TH"], "");
  assert.ok(notes.some((note) => /不是受支持的括号对/.test(note.note)));
  assert.ok(TITLE_BRACKET_CHOICES.includes(""));
});

test("未知字段被丢弃，不会污染设置结构", () => {
  const { settings } = sanitizeSettings({ quality: { qaPassScore: 88, 后门: 1 }, 未知分组: { a: 1 } });
  assert.equal(settings.quality.qaPassScore, 88);
  assert.equal(settings.quality.后门, undefined);
  assert.equal(settings.未知分组, undefined);
});

test("分组信息供界面渲染，字段不落在两个分组里", () => {
  const groups = settingGroups();
  const paths = groups.flatMap((group) => group.fields.map((field) => field.path));
  assert.equal(paths.length, new Set(paths).size);
  assert.equal(paths.length, Object.keys(SETTING_SPECS).length);
});

test("保存后立即生效，重新读取拿到的是新值", () => {
  store.invalidateSettingsCache();
  assert.equal(store.getSettings().quality.qaPassScore, 90);
  store.saveSettings({ quality: { qaPassScore: 82, weightBasic: 20, weightFidelity: 50, weightNuance: 30 } });
  assert.equal(store.getSettings().quality.qaPassScore, 82);
  store.resetSettings();
  assert.equal(store.getSettings().quality.qaPassScore, 90);
});

test("环境变量优先于面板设置，并在覆盖清单里标注", () => {
  process.env.KAMI_STYLE_DISTILL_THRESHOLD = "17";
  store.invalidateSettingsCache();
  try {
    store.saveSettings({ learning: { styleDistillThreshold: 5 } });
    assert.equal(store.getSettings().learning.styleDistillThreshold, 17, "环境变量必须压过面板值");
    assert.equal(store.environmentOverrides()["learning.styleDistillThreshold"].variable, "KAMI_STYLE_DISTILL_THRESHOLD");
  } finally {
    delete process.env.KAMI_STYLE_DISTILL_THRESHOLD;
    store.invalidateSettingsCache();
    store.resetSettings();
  }
});

test("环境变量本身越界时同样被夹紧", () => {
  process.env.KAMI_STYLE_DISTILL_THRESHOLD = "9999";
  store.invalidateSettingsCache();
  try {
    assert.equal(store.getSettings().learning.styleDistillThreshold, SETTING_SPECS["learning.styleDistillThreshold"].max);
  } finally {
    delete process.env.KAMI_STYLE_DISTILL_THRESHOLD;
    store.invalidateSettingsCache();
  }
});
