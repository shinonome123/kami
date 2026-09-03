export const FACT_SCHEMA_VERSION = "1.0";

const PLATFORM_DEFINITIONS = [
  ["playstation_store", "PlayStation Store", ["PlayStation Store", "PS Store", "プレイステーションストア", "플레이스테이션 스토어"]],
  ["playstation", "PlayStation", ["PlayStation", "プレイステーション", "플레이스테이션"]],
  ["ps5", "PS5", ["PS5", "PlayStation 5"]],
  ["ps4", "PS4", ["PS4", "PlayStation 4"]],
  ["microsoft_store", "Microsoft Store", ["Microsoft Store", "微软商店", "微軟商店", "マイクロソフトストア", "마이크로소프트 스토어"]],
  ["epic_games_store", "Epic Games Store", ["Epic Games Store", "Epic游戏商城", "Epic遊戲商城", "Epic Gamesストア", "에픽게임즈 스토어"]],
  ["nintendo_switch", "Nintendo Switch", ["Nintendo Switch", "任天堂Switch", "任天堂 Switch", "ニンテンドースイッチ", "닌텐도 스위치"]],
  ["google_play", "Google Play", ["Google Play", "Google Play 商店", "Google Playストア", "구글 플레이"]],
  ["app_store", "App Store", ["App Store", "苹果商店", "蘋果商店", "アップストア", "앱스토어"]],
  ["steam", "Steam", ["Steam"]],
  ["xbox", "Xbox", ["Xbox"]],
  ["wegame", "WeGame", ["WeGame"]],
  ["ios", "iOS", ["iOS"]],
  ["android", "Android", ["Android"]],
  ["youtube", "YouTube", ["YouTube", "油管"]],
  ["tiktok", "TikTok", ["TikTok", "抖音国际版", "抖音國際版"]],
  ["bilibili", "Bilibili", ["Bilibili", "哔哩哔哩", "嗶哩嗶哩", "B站"]],
  ["taptap", "TapTap", ["TapTap"]]
].map(([canonical, label, aliases]) => ({ canonical, label, aliases }));

const REGION_DEFINITIONS = [
  ["CN-MAINLAND", "中国大陆", ["中国大陆", "中國大陸", "大陆地区", "大陸地區", "Mainland China", "中国本土", "中國本土"]],
  ["CN-HK", "中国香港", ["中国香港", "中國香港", "香港地区", "香港地區", "Hong Kong", "香港"]],
  ["CN-MO", "中国澳门", ["中国澳门", "中國澳門", "澳门地区", "澳門地區", "Macao", "Macau", "澳门", "澳門"]],
  ["CN-TW", "中国台湾", ["中国台湾", "中國台灣", "台湾地区", "台灣地區", "Taiwan", "台湾", "台灣"]],
  ["JP", "日本", ["日本地区", "日本地區", "Japan", "日本"]],
  ["KR", "韩国", ["韩国地区", "韓國地區", "South Korea", "Republic of Korea", "韩国", "韓國", "한국"]],
  ["TH", "泰国", ["泰国地区", "泰國地區", "Thailand", "泰国", "泰國", "ประเทศไทย"]],
  ["SG", "新加坡", ["Singapore", "新加坡", "シンガポール", "싱가포르"]],
  ["MY", "马来西亚", ["Malaysia", "马来西亚", "馬來西亞", "マレーシア", "말레이시아"]],
  ["SEA", "东南亚", ["Southeast Asia", "东南亚", "東南亞", "東南アジア", "동남아시아", "เอเชียตะวันออกเฉียงใต้"]],
  ["NA", "北美", ["North America", "北美", "北米", "북미", "อเมริกาเหนือ"]],
  ["EUROPE", "欧洲", ["Europe", "欧洲", "歐洲", "ヨーロッパ", "유럽", "ยุโรป"]],
  ["GLOBAL", "全球", ["Worldwide", "Global", "全球", "全世界", "ワールドワイド", "전 세계", "ทั่วโลก"]]
].map(([canonical, label, aliases]) => ({ canonical, label, aliases }));

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const FRENCH_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const CURRENCY_ALIASES = {
  USD: ["$", "USD", "美元", "米ドル", "달러", "ดอลลาร์"],
  CNY: ["CNY", "RMB", "人民币", "人民幣", "元", "人民币元", "人民幣元"],
  JPY: ["JPY", "日元", "円", "圓", "엔", "เยน"],
  KRW: ["KRW", "₩", "韩元", "韓元", "원", "วอน"],
  THB: ["THB", "฿", "泰铢", "泰銖", "บาท"],
  YEN_OR_YUAN: ["¥", "￥", "元", "円"]
};

function compact(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEntries(value, defaultRole) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item == null) return [];
      if (typeof item !== "object") return [{ label: "", value: compact(item), role: defaultRole }];
      const text = compact(item.value ?? item.text ?? item.content);
      return text ? [{ label: compact(item.label ?? item.key ?? item.name), value: text, role: compact(item.role || defaultRole) }] : [];
    });
  }
  if (typeof value === "object") return Object.entries(value).flatMap(([label, item]) => compact(item) ? [{ label: compact(label), value: compact(item), role: defaultRole }] : []);
  return compact(value) ? [{ label: "", value: compact(value), role: defaultRole }] : [];
}

function rangesOverlap(left, right) {
  return left[0] < right[1] && right[0] < left[1];
}

function pushUnique(items, item) {
  const key = `${item.type}|${item.normalized}|${item.origin}|${item.scope}`;
  if (!items.some((existing) => existing._key === key)) items.push({ ...item, _key: key });
}

function matchControlled(text, definitions) {
  const candidates = [];
  for (const definition of definitions) {
    for (const alias of definition.aliases) {
      const latinEdges = /^[A-Za-z0-9]/.test(alias) && /[A-Za-z0-9]$/.test(alias);
      const body = escapeRegExp(alias).replace(/\\ /g, "\\s+");
      const expression = new RegExp(`${latinEdges ? "(?<![A-Za-z0-9])" : ""}${body}${latinEdges ? "(?![A-Za-z0-9])" : ""}`, "giu");
      for (const match of text.matchAll(expression)) {
        if (["JP", "KR", "TH"].includes(definition.canonical) && /^[\p{Script=Han}]+$/u.test(match[0]) && /[语言語文]/u.test(text.slice(match.index + match[0].length, match.index + match[0].length + 1))) continue;
        candidates.push({ definition, raw: match[0], range: [match.index, match.index + match[0].length] });
      }
    }
  }
  const chosen = [];
  for (const candidate of candidates.sort((left, right) => (right.range[1] - right.range[0]) - (left.range[1] - left.range[0]) || left.range[0] - right.range[0])) {
    if (chosen.some((item) => rangesOverlap(item.range, candidate.range))) continue;
    chosen.push(candidate);
  }
  return chosen.sort((left, right) => left.range[0] - right.range[0]);
}

function validDate(year, month, day) {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return false;
  if (!year) return true;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateNormalized(year, month, day) {
  return year ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : `--${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function collectDates(text, options = {}) {
  const dates = [];
  const occupied = [];
  const add = (match, year, month, day, certainty = 1) => {
    year = year ? Number(year) : null;
    month = Number(month);
    day = Number(day);
    const range = [match.index, match.index + match[0].length];
    if (!validDate(year, month, day) || occupied.some((item) => rangesOverlap(item, range))) return;
    occupied.push(range);
    dates.push({ raw: match[0], normalized: dateNormalized(year, month, day), details: { year, month, day }, certainty, range });
    const suffix = text.slice(range[1]).match(/^\s*(?:至|到|[-–—~～])\s*(\d{1,2})日/u);
    if (suffix && validDate(year, month, Number(suffix[1]))) {
      const suffixStart = range[1] + suffix.index;
      const suffixRange = [suffixStart, suffixStart + suffix[0].length];
      occupied.push(suffixRange);
      dates.push({ raw: suffix[0].trim(), normalized: dateNormalized(year, month, Number(suffix[1])), details: { year, month, day: Number(suffix[1]) }, certainty, range: suffixRange });
    }
  };
  for (const match of text.matchAll(/(?<!\d)(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?(?!\d)/gu)) add(match, match[1], match[2], match[3]);
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日(?!\d)/gu)) add(match, null, match[1], match[2]);
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})월\s*(\d{1,2})일(?!\d)/gu)) add(match, null, match[1], match[2]);
  const thaiPattern = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${THAI_MONTHS.join("|")})(?:\\s*(\\d{4}))?`, "giu");
  for (const match of text.matchAll(thaiPattern)) add(match, match[3] || null, THAI_MONTHS.findIndex((month) => month.toLowerCase() === match[2].toLowerCase()) + 1, match[1]);
  const frenchPattern = new RegExp(`(?<!\\d)(\\d{1,2})(?:er)?\\s+(${FRENCH_MONTHS.join("|")})(?:\\s+(\\d{4}))?`, "giu");
  for (const match of text.matchAll(frenchPattern)) add(match, match[3] || null, FRENCH_MONTHS.findIndex((month) => month.toLowerCase() === match[2].toLowerCase()) + 1, match[1]);
  if (options.allowNumericPair) {
    for (const match of text.matchAll(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/gu)) add(match, null, match[1], match[2], 0.95);
  }
  return dates;
}

function targetContainsDate(text, fact) {
  const expected = fact.details;
  if (collectDates(text).some((date) => date.details.month === expected.month && date.details.day === expected.day && (!expected.year || !date.details.year || date.details.year === expected.year))) return true;
  const numbers = [...text.matchAll(/(?<!\d)(\d{1,4})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{1,4}))?(?!\d)/gu)];
  return numbers.some((match) => {
    const values = match.slice(1).filter(Boolean).map(Number);
    return values.includes(expected.month) && values.includes(expected.day) && (!expected.year || values.includes(expected.year));
  });
}

function collectUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s)）\]】>，。！？；、“”‘’]+/giu)].map((match) => ({ raw: match[0], normalized: match[0], range: [match.index, match.index + match[0].length] }));
}

function collectPlaceholders(text) {
  const expression = /\{\{[^{}]+\}\}|\{[^{}]+\}|%\([^)]+\)[a-z]|%\d*\$?[a-z]|<%=?[\s\S]*?%>|\[\[[^\]]+\]\]/giu;
  return [...text.matchAll(expression)].map((match) => ({ raw: match[0], normalized: match[0], range: [match.index, match.index + match[0].length] }));
}

function numericValue(value) {
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function collectQuantities(text, blockedRanges = []) {
  const facts = [];
  const occupied = [...blockedRanges];
  const add = (match, type, normalized, details = {}, certainty = 1) => {
    const range = [match.index, match.index + match[0].length];
    if (occupied.some((item) => rangesOverlap(item, range))) return;
    occupied.push(range);
    facts.push({ raw: match[0], type, normalized, details, certainty, range });
  };

  const moneyPattern = /(?:(¥|￥|\$|USD|CNY|RMB|JPY|KRW|THB|₩|฿)\s*(\d+(?:,\d{3})*(?:\.\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?)\s*(美元|人民币元?|人民幣元?|日元|韩元|韓元|泰铢|泰銖|元|円|圓|달러|원|บาท|เยน))/giu;
  for (const match of text.matchAll(moneyPattern)) {
    const marker = match[1] || match[4];
    const amount = numericValue(match[2] || match[3]);
    const currency = Object.entries(CURRENCY_ALIASES).find(([, aliases]) => aliases.some((alias) => alias.toLocaleLowerCase() === marker.toLocaleLowerCase()))?.[0] || "UNKNOWN";
    add(match, "money", `${currency}:${amount}`, { currency, amount });
  }
  for (const match of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*[%％](?!\w)/gu)) {
    const rate = numericValue(match[1]);
    add(match, "percentage", `${rate}%`, { rate });
  }
  const chineseDigits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  for (const match of text.matchAll(/([一二三四五六七八九]|\d(?:\.\d)?)折/gu)) {
    const digit = chineseDigits[match[1]] ?? Number(match[1]);
    const payRate = digit * 10;
    add(match, "discount", `pay:${payRate};off:${100 - payRate}`, { payRate, offRate: 100 - payRate, notation: "pay_rate" }, 0.99);
  }
  for (const match of text.matchAll(/([一二三四五六七八九]|\d(?:\.\d)?)成/gu)) {
    const digit = chineseDigits[match[1]] ?? Number(match[1]);
    const rate = digit * 10;
    add(match, "discount", `rate:${rate}`, { rate, notation: "stated_rate" }, 0.96);
  }
  for (const match of text.matchAll(/半价|半價/gu)) add(match, "discount", "pay:50;off:50", { payRate: 50, offRate: 50, notation: "half_price" });

  for (const match of text.matchAll(/(?<![A-Za-z0-9])\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9%％折成元円圓])/gu)) {
    const value = numericValue(match[0]);
    add(match, "number", String(value), { value }, 0.99);
  }
  return facts;
}

function parseLengthLimit(entry) {
  const combined = `${entry.label} ${entry.value}`.trim();
  if (/无(?:字数|字符|字元|长度)?限制|無(?:字數|字符|字元|長度)?限制|no\s+limit/iu.test(combined)) return null;
  const match = combined.match(/(?:最多|至多|不超过|不超過|限|控制在|maximum|max(?:imum)?|within)?\s*(\d+)\s*(字|字符|字元|文字|词|詞|words?|characters?|chars?|bytes?|バイト|글자|자|단어|คำ)(?:以内|以內|内|內|以下|上限)?/iu);
  if (!match) return null;
  const hasConstraintCue = entry.role === "constraint" || /字数|字數|字符|字元|长度|長度|限制|limit|max|within|以内|以內|上限/iu.test(combined);
  if (!hasConstraintCue) return null;
  const rawUnit = match[2].toLowerCase();
  const unit = /word|词|詞|단어|คำ/u.test(rawUnit) ? "word" : /byte|バイト/u.test(rawUnit) ? "byte" : "character";
  return { max: Number(match[1]), unit, raw: match[0] };
}

function isDeadline(entry) {
  return /(?:^|\b)(?:ddl|deadline)(?:\b|$)|截止|交付日期|发布日期|發布日期/iu.test(`${entry.label} ${entry.value}`);
}

function factCountByType(facts) {
  return Object.fromEntries([...new Set(facts.map((fact) => fact.type))].map((type) => [type, facts.filter((fact) => fact.type === type).length]));
}

export function extractFactSchema(input = {}) {
  const source = String(input.source ?? "");
  const metadata = normalizeEntries(input.metadata, "context");
  const constraints = normalizeEntries(input.constraints, "constraint");
  const facts = [];
  const streams = [
    { text: source, label: "源文", role: "source_text", origin: "source", scope: "translation" },
    ...metadata.map((entry) => ({ text: entry.value, ...entry, origin: "metadata", scope: "task" })),
    ...constraints.map((entry) => ({ text: entry.value, ...entry, origin: "constraint", scope: "task" }))
  ];

  for (const stream of streams) {
    const text = String(stream.text || "");
    const common = { origin: stream.origin, scope: stream.scope, label: stream.label || "", certainty: 1 };
    const urls = collectUrls(text);
    const placeholders = collectPlaceholders(text);
    for (const item of urls) pushUnique(facts, { ...common, type: "url", value: item.raw, normalized: item.normalized, details: { exact: true } });
    for (const item of placeholders) pushUnique(facts, { ...common, type: "placeholder", value: item.raw, normalized: item.normalized, details: { exact: true } });
    for (const item of matchControlled(text, PLATFORM_DEFINITIONS)) pushUnique(facts, { ...common, type: "platform", value: item.raw, normalized: item.definition.canonical, certainty: 0.99, details: { label: item.definition.label, aliases: item.definition.aliases } });
    for (const item of matchControlled(text, REGION_DEFINITIONS)) pushUnique(facts, { ...common, type: "region", value: item.raw, normalized: item.definition.canonical, certainty: 0.98, details: { label: item.definition.label, aliases: item.definition.aliases } });

    const deadline = stream.scope === "task" && isDeadline(stream);
    const dates = collectDates(text, { allowNumericPair: deadline });
    for (const item of dates) pushUnique(facts, { ...common, type: deadline ? "deadline" : "date", value: item.raw, normalized: item.normalized, certainty: item.certainty, details: item.details });

    const limit = stream.scope === "task" ? parseLengthLimit(stream) : null;
    if (limit) pushUnique(facts, { ...common, type: "length_limit", value: limit.raw, normalized: `${limit.unit}:${limit.max}`, details: limit });

    const blocked = [...urls, ...placeholders, ...dates].map((item) => item.range);
    if (limit) {
      const start = text.indexOf(limit.raw);
      if (start >= 0) blocked.push([start, start + limit.raw.length]);
    }
    for (const item of collectQuantities(text, blocked)) pushUnique(facts, { ...common, type: item.type, value: item.raw, normalized: item.normalized, certainty: item.certainty, details: item.details });
  }

  const normalizedFacts = facts.map(({ _key, ...fact }, index) => ({ id: `fact-${index + 1}`, ...fact }));
  const limits = normalizedFacts.filter((fact) => fact.type === "length_limit").map((fact) => ({ factId: fact.id, max: fact.details.max, unit: fact.details.unit, origin: fact.origin, label: fact.label }));
  return {
    version: FACT_SCHEMA_VERSION,
    source,
    facts: normalizedFacts,
    limits,
    summary: { total: normalizedFacts.length, translationFacts: normalizedFacts.filter((fact) => fact.scope === "translation").length, taskFacts: normalizedFacts.filter((fact) => fact.scope === "task").length, byType: factCountByType(normalizedFacts) }
  };
}

function containsAlias(text, aliases = []) {
  return matchControlled(text, [{ canonical: "expected", label: "expected", aliases }]).length > 0;
}

function containsNumber(text, expected) {
  return [...String(text).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/gu)].some((match) => numericValue(match[0]) === Number(expected));
}

function containsMoney(text, details) {
  if (!containsNumber(text, details.amount)) return false;
  return (CURRENCY_ALIASES[details.currency] || []).some((alias) => text.toLocaleLowerCase().includes(alias.toLocaleLowerCase()));
}

function containsDiscount(text, details) {
  const rates = [details.rate, details.payRate, details.offRate].filter(Number.isFinite);
  if (rates.some((rate) => new RegExp(`(?<!\\d)${escapeRegExp(rate)}(?:\\.0+)?\\s*[%％](?!\\d)`, "u").test(text))) return true;
  if (Number.isFinite(details.payRate)) {
    const digit = details.payRate / 10;
    if (Number.isInteger(digit) && new RegExp(`${digit}(?:\\.0+)?\\s*折`, "u").test(text)) return true;
  }
  if (Number.isFinite(details.offRate)) {
    const wari = details.offRate / 10;
    if (Number.isInteger(wari) && new RegExp(`${wari}(?:\\.0+)?\\s*割(?:引|OFF|オフ)`, "iu").test(text)) return true;
  }
  return false;
}

function countWords(text, locale) {
  try {
    return [...new Intl.Segmenter(locale || "zh", { granularity: "word" }).segment(text)].filter((item) => item.isWordLike).length;
  } catch {
    return String(text).trim().split(/\s+/u).filter(Boolean).length;
  }
}

function issueForFact(fact, translation) {
  if (fact.type === "url" && !translation.includes(fact.value)) return { severity: "error", type: "fact_url_missing", category: "fact", message: `网址缺失或被改写：${fact.value}` };
  if (fact.type === "placeholder" && !translation.includes(fact.value)) return { severity: "error", type: "fact_placeholder_missing", category: "format", message: `占位符缺失或被改写：${fact.value}` };
  if (fact.type === "platform" && !containsAlias(translation, fact.details.aliases)) return { severity: "error", type: "fact_platform_missing", category: "platform", message: `平台信息缺失：${fact.details.label}` };
  if (fact.type === "region" && !containsAlias(translation, fact.details.aliases)) return { severity: "error", type: "fact_region_missing", category: "locale", message: `地区信息缺失：${fact.details.label}` };
  if (fact.type === "date" && !targetContainsDate(translation, fact)) return { severity: "error", type: "fact_date_missing", category: "fact", message: `日期缺失或发生变化：${fact.value}` };
  if (fact.type === "money" && !containsMoney(translation, fact.details)) return { severity: "error", type: "fact_money_mismatch", category: "number", message: `金额或币种缺失：${fact.value}` };
  if (fact.type === "percentage" && !new RegExp(`(?<!\\d)${escapeRegExp(fact.details.rate)}(?:\\.0+)?\\s*[%％](?!\\d)`, "u").test(translation)) return { severity: "error", type: "fact_percentage_mismatch", category: "number", message: `百分比缺失或发生变化：${fact.value}` };
  if (fact.type === "discount" && !containsDiscount(translation, fact.details)) return { severity: "error", type: "fact_discount_mismatch", category: "number", message: `折扣信息缺失或发生变化：${fact.value}` };
  if (fact.type === "number" && !containsNumber(translation, fact.details.value)) return { severity: "warning", type: "fact_number_missing", category: "number", message: `数字未在译文中找到：${fact.value}` };
  return null;
}

/**
 * Derive the delivery context (which platforms and regions this text is for)
 * from the controlled platform and region vocabularies. Asset governance uses
 * it to decide which terms and memories are even admissible, so it must stay
 * deterministic: only controlled-vocabulary hits count, never a guess.
 */
export function detectDeliveryContext(input = {}) {
  const streams = typeof input === "string"
    ? [{ text: input }]
    : [
      { text: String(input.source ?? input.text ?? "") },
      ...(Array.isArray(input.metadata) ? input.metadata.map((item) => ({ text: `${item?.label || ""} ${item?.value || ""}` })) : [])
    ];
  const platforms = new Set();
  const regions = new Set();
  for (const stream of streams) {
    const text = String(stream.text || "");
    if (!text.trim()) continue;
    for (const item of matchControlled(text, PLATFORM_DEFINITIONS)) platforms.add(item.definition.canonical);
    for (const item of matchControlled(text, REGION_DEFINITIONS)) regions.add(item.definition.canonical);
  }
  return { platforms: [...platforms], regions: [...regions] };
}

export function checkFactSchema(input = {}) {
  const schema = input.schema || extractFactSchema(input);
  const translation = String(input.translation ?? "");
  const locale = String(input.locale || "");
  const issues = [];
  for (const fact of schema.facts || []) {
    if (fact.scope !== "translation") continue;
    const issue = issueForFact(fact, translation);
    if (issue) issues.push({ ...issue, factId: fact.id, fact });
  }
  for (const limit of schema.limits || []) {
    const actual = limit.unit === "byte" ? Buffer.byteLength(translation, "utf8") : limit.unit === "word" ? countWords(translation, locale) : Array.from(translation).length;
    if (actual > limit.max) {
      const unitLabel = limit.unit === "byte" ? "字节" : limit.unit === "word" ? "词" : "字符";
      issues.push({ severity: "error", type: "length_limit_exceeded", category: "constraint", factId: limit.factId, message: `译文长度 ${actual} ${unitLabel}，超过上限 ${limit.max} ${unitLabel}`, expected: limit.max, actual, unit: limit.unit });
    }
  }
  return issues;
}

export function runFactQa(input = {}) {
  const schema = input.schema || extractFactSchema(input);
  return { schema, issues: checkFactSchema({ schema, translation: input.translation, locale: input.locale }) };
}
