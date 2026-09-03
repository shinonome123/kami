import test from "node:test";
import assert from "node:assert/strict";
import {
  REGISTER_CLASSIFIER_VERSION,
  checkRegisterExpectation,
  classifyRegister,
  registerPolicyFor
} from "../src/register-classifier.mjs";

const PROMO_JA = "今すぐチェック！史上最強の特別価格！お見逃しなく！絶対にお得です！";
const ON_VOICE_PROMO_JA = "限定セールを開催します。今すぐチェックして、特別価格をお楽しみください！";
const FLAT_JA = "さまざまな機能があります。いろいろな設定があります。とても良い体験です。非常に良い内容です。";
const CASUAL_JA = "めっちゃやばいｗｗ ガチで神ってる 😂😂 じゃんじゃん来てね";
const ON_VOICE_CASUAL_JA = "めっちゃ楽しいイベントだよね😊 ぜひ遊びに来てね";
const NEUTRAL_JA = "本アップデートでは装備の強化上限を引き上げ、報酬の受け取り期限を延長しました。";

test("同一段文案的语域判定对不同语体给出不同结论", () => {
  const asMarketing = checkRegisterExpectation({ translation: ON_VOICE_PROMO_JA, locale: "ja-JP", contentType: "marketing" });
  const asAnnouncement = checkRegisterExpectation({ translation: ON_VOICE_PROMO_JA, locale: "ja-JP", contentType: "announcement" });
  assert.equal(asMarketing.issues.length, 0, "宣发文案本来就该有推销感");
  assert.equal(asAnnouncement.issues.some((issue) => issue.label === "too_promotional"), true, "同一段话放进公告就属于语域偏离");
});

test("推销语域在宣发语体里也有上限，不是无限放行", () => {
  const excessive = checkRegisterExpectation({ translation: PROMO_JA, locale: "ja-JP", contentType: "marketing" });
  assert.equal(excessive.issues.some((issue) => issue.label === "too_promotional"), true, "堆满促销词与感叹号，宣发语体同样该拦");
});

test("太网感只在不允许口语的语体里报", () => {
  const asSocial = checkRegisterExpectation({ translation: ON_VOICE_CASUAL_JA, locale: "ja-JP", contentType: "social" });
  const asRules = checkRegisterExpectation({ translation: ON_VOICE_CASUAL_JA, locale: "ja-JP", contentType: "rules" });
  assert.equal(asSocial.issues.some((issue) => issue.label === "too_casual"), false);
  assert.equal(asRules.issues.some((issue) => issue.label === "too_casual"), true);
  const extreme = checkRegisterExpectation({ translation: CASUAL_JA, locale: "ja-JP", contentType: "social" });
  assert.equal(extreme.issues.some((issue) => issue.label === "too_casual"), true, "社媒也有上限");
});

test("太普通：套话密集、句式整齐、用字重复会被判出来", () => {
  const flat = classifyRegister(FLAT_JA, { locale: "ja-JP", contentType: "marketing" });
  const neutral = classifyRegister(NEUTRAL_JA, { locale: "ja-JP", contentType: "marketing" });
  assert.ok(flat.scores.generic > neutral.scores.generic);
  const issues = checkRegisterExpectation({ translation: FLAT_JA, locale: "ja-JP", contentType: "marketing" }).issues;
  assert.equal(issues.some((issue) => issue.label === "too_generic"), true);
});

test("正常公告文案不产生任何语域问题", () => {
  const result = checkRegisterExpectation({ translation: NEUTRAL_JA, locale: "ja-JP", contentType: "announcement" });
  assert.deepEqual(result.issues, []);
});

test("每条判定都带证据、阈值和分类器版本", () => {
  const [issue] = checkRegisterExpectation({ translation: PROMO_JA, locale: "ja-JP", contentType: "rules" }).issues;
  assert.equal(issue.classifierVersion, REGISTER_CLASSIFIER_VERSION);
  assert.ok(issue.evidence.length > 0);
  assert.ok(issue.score > issue.tolerance);
  assert.equal(issue.severity, "warning", "语域是提示不是阻断");
  assert.equal(issue.category, "style_register");
});

test("结果完全可复现：同输入同输出", () => {
  const first = classifyRegister(PROMO_JA, { locale: "ja-JP", contentType: "marketing" });
  const second = classifyRegister(PROMO_JA, { locale: "ja-JP", contentType: "marketing" });
  assert.deepEqual(first, second);
});

test("过短文本不做判定", () => {
  const result = checkRegisterExpectation({ translation: "確認", locale: "ja-JP", contentType: "rules" });
  assert.equal(result.classification.measurable, false);
  assert.deepEqual(result.issues, []);
});

test("四种目标语言都有各自的语域词表", () => {
  const cases = [
    ["ko-KR", "지금 바로 확인하세요! 역대급 특가! 놓치지 마세요! 무조건 이득입니다!"],
    ["zh-Hant-TW", "立即搶購！史上最強超值優惠！千萬別錯過！絕對必買！"],
    ["th-TH", "ทันที! ลดราคาพิเศษสุดคุ้ม! ห้ามพลาด! ดีที่สุด!"]
  ];
  for (const [locale, text] of cases) {
    const result = checkRegisterExpectation({ translation: text, locale, contentType: "announcement" });
    assert.equal(result.issues.some((issue) => issue.label === "too_promotional"), true, `${locale} 应识别出推销语域`);
  }
});

test("风格档案可以覆盖语体的默认容忍度", () => {
  const strict = checkRegisterExpectation({
    translation: PROMO_JA,
    locale: "ja-JP",
    contentType: "marketing",
    policyOverrides: { promotional: 0.1 }
  });
  assert.equal(strict.issues.some((issue) => issue.label === "too_promotional"), true);
  assert.equal(registerPolicyFor("marketing", { promotional: 0.1 }).promotional, 0.1);
  assert.equal(registerPolicyFor("marketing", { promotional: 9 }).promotional, 0.85, "越界的覆盖值应被忽略");
});
